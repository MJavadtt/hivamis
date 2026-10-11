import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { closeApp, login, post, tinyPdf, upload } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { purgeDeletedFiles, storageUsed, writeUpload } from '../src/documents/storage.js';
import { run } from '../src/cli.js';

/**
 * Audit LOG-5: an upload that broke off left its half-file on disk; a deleted document's file stayed
 * for ever; and an organisation could fill the disk. Now none of the three.
 */

const root = path.resolve(env.STORAGE_DIR);
const DAY = 86_400_000;

describe('Files on disk (audit LOG-5)', () => {
  let org: string, uploader: string, legal: string, designer: string;
  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    const o = await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    org = o.id;
    if (!o.slug) await prisma.organization.update({ where: { id: org }, data: { slug: 'hiva' } });
    uploader = (await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } })).id;
    legal = await login('legal@hiva.local');
    designer = await login('designer@hiva.local');
  });
  afterAll(async () => {
    await prisma.organization.update({ where: { id: org }, data: { storageQuotaMb: null } });
    await closeApp();
  });

  it('leaves nothing behind when an upload breaks off mid-way', async () => {
    const target = path.join(root, `${randomUUID()}.pdf`);
    let sent = 0;
    const broken = new Readable({
      read() {
        if (sent++ < 3) this.push(Buffer.alloc(64 * 1024, 1));
        else this.destroy(new Error('client went away'));
      },
    });
    await expect(writeUpload(broken, target)).rejects.toThrow('client went away');
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a file that would pass the organisation’s quota, with 413 and what to do — and keeps nothing of it', async () => {
    const am = await login('account.manager@hiva.local');
    const project = await prisma.project.findFirstOrThrow({ where: { organizationId: org } });
    const usedMb = Math.ceil((await storageUsed(org)) / (1024 * 1024));
    // Set by whoever runs the installation, not by the organisation.
    expect(await run(['tenant:update', '--slug', 'hiva', '--quota-mb', String(usedMb + 1)])).toMatchObject({ storageQuotaMb: usedMb + 1 });
    const before = await prisma.document.count({ where: { organizationId: org } });
    const big = Buffer.concat([Buffer.from(tinyPdf()), Buffer.alloc(2 * 1024 * 1024, 32)]);
    const refused = await upload(am, { name: 'big.pdf', type: 'application/pdf', content: big }, { projectId: project.id });
    expect(refused.status).toBe(413);
    expect(refused.body.error).toMatchObject({ code: 'STORAGE_QUOTA', details: { quotaMb: usedMb + 1 } });
    expect(await prisma.document.count({ where: { organizationId: org } })).toBe(before);
    // A small file still fits; with no limit, anything does.
    expect((await upload(am, { name: 'small.pdf', type: 'application/pdf', content: tinyPdf() }, { projectId: project.id })).status).toBe(201);
    await run(['tenant:update', '--slug', 'hiva', '--quota-mb', 'none']);
    expect((await upload(am, { name: 'big.pdf', type: 'application/pdf', content: big }, { projectId: project.id })).status).toBe(201);
  });

  it('removes a deleted document’s file after the retention period — but never one under legal hold', async () => {
    const made = async (name: string, data: Record<string, unknown> = {}) => {
      const storedName = `${randomUUID()}.pdf`;
      writeFileSync(path.join(root, storedName), tinyPdf());
      return prisma.document.create({
        data: { organizationId: org, fileName: name, storedName, mimeType: 'application/pdf', sizeBytes: 100, uploadedById: uploader, deletedAt: new Date(Date.now() - (env.FILE_RETENTION_DAYS + 1) * DAY), ...data },
      });
    };
    const old = await made('قدیمی.pdf');
    const recent = await made('تازه‌حذف.pdf', { deletedAt: new Date(Date.now() - DAY) });
    const held = await made('مورد دعوا.pdf');

    // Placed by the legal team, with a reason; not by anyone else.
    expect((await post(`/documents/${held.id}/legal-hold`, designer, { hold: true, reason: 'دعوای حقوقی' })).status).toBe(403);
    expect((await post(`/documents/${held.id}/legal-hold`, legal, { hold: true })).status).toBe(400);
    expect((await post(`/documents/${held.id}/legal-hold`, legal, { hold: true, reason: 'دعوای حقوقی' })).body).toMatchObject({ legalHold: true });

    const r = await purgeDeletedFiles();
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(root, old.storedName))).toBe(false);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: old.id } })).purgedAt).not.toBeNull();
    expect(await prisma.auditEvent.count({ where: { entityType: 'document', entityId: old.id, action: 'PURGE' } })).toBe(1);
    for (const kept of [recent, held]) {
      expect(existsSync(path.join(root, kept.storedName))).toBe(true);
      expect((await prisma.document.findUniqueOrThrow({ where: { id: kept.id } })).purgedAt).toBeNull();
    }
    expect(await prisma.auditEvent.count({ where: { entityType: 'document', entityId: held.id, action: 'LEGAL_HOLD' } })).toBe(1);

    // The hold lifted, the file goes on the next run.
    await post(`/documents/${held.id}/legal-hold`, legal, { hold: false });
    await purgeDeletedFiles();
    expect(existsSync(path.join(root, held.storedName))).toBe(false);
  });
});
