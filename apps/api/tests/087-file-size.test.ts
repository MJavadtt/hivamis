import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { app, call, closeApp, expectOk, get, login, post, tinyPdf, upload } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { backfillMetadata } from '../src/documents/backfill.js';
import { storageUsed, writeUpload } from '../src/documents/storage.js';

/**
 * ADR-124 (the owner, 2026-11-06): «سقف آپلود نداشته باشد». An attachment or a guide video may be any
 * size; the disk is the limit, and the disk keeps a reserve, because the database is on it too. What a
 * route reads whole into memory stays bounded, and whatever used to assume a small file now asks first.
 */
const MB = 1024 * 1024;
const GIB = 1024 * MB;
const root = path.resolve(env.STORAGE_DIR);
const padded = (head: Buffer | string, mb: number) => Buffer.concat([Buffer.from(head), Buffer.alloc(mb * MB, 32)]);
/** The signature and IHDR of a 640 × 480 PNG: as much as its headers say. */
const png = () => {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(640, 16); b.writeUInt32BE(480, 20); b[24] = 8; b[25] = 2;
  return b;
};

describe('A file has no size limit (ADR-124)', () => {
  let token: string, admin: string;
  let fields: Record<string, string>;
  let org: string, uploader: string, projectId: string;
  const limits = { memory: env.IN_MEMORY_FILE_MB, reserve: env.STORAGE_RESERVE_MB };

  beforeAll(async () => {
    token = await login('account.manager@hiva.local');
    admin = await login('admin@hiva.local');
    const project = await prisma.project.findFirstOrThrow({ where: { deletedAt: null } });
    projectId = project.id;
    fields = { projectId };
    org = project.organizationId;
    uploader = (await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } })).id;
  }, 60_000);
  afterEach(() => { env.IN_MEMORY_FILE_MB = limits.memory; env.STORAGE_RESERVE_MB = limits.reserve; });
  afterAll(closeApp);

  it('takes an attachment past the limit that stood, whole', async () => {
    const content = padded(tinyPdf(), 30);
    const res = expectOk(await upload(token, { name: 'چاپ.pdf', type: 'application/pdf', content }, fields), 'upload');
    expect(res.sizeBytes).toBe(content.length);
    const back = await (await app()).inject({ method: 'GET', url: `/api/v1/documents/${res.id}/download`, headers: { authorization: `Bearer ${token}` } });
    expect(back.statusCode).toBe(200);
    expect(back.rawPayload.equals(content)).toBe(true);
  }, 60_000);

  it('says so, in Persian, when a file is gone from the disk — or was purged — rather than «Route not found»', async () => {
    const res = expectOk(await upload(token, { name: 'گم‌شده.pdf', type: 'application/pdf', content: tinyPdf() }, fields), 'upload');
    const fetch = (what: string) => (async () => (await app()).inject({ method: 'GET', url: `/api/v1/documents/${res.id}/${what}`, headers: { authorization: `Bearer ${token}` } }))();
    unlinkSync(path.join(path.resolve(env.STORAGE_DIR), res.storedName));
    for (const what of ['download', 'preview']) {
      const gone = await fetch(what);
      expect(gone.statusCode).toBe(404);
      expect(gone.json().error).toMatchObject({ code: 'FILE_MISSING', message: expect.stringContaining('روی سرور پیدا نشد') });
    }
    await prisma.document.update({ where: { id: res.id }, data: { purgedAt: new Date() } });
    expect((await fetch('download')).json().error.code).toBe('FILE_PURGED');
  });

  it('takes a guide video past the limit that stood', async () => {
    const webm = padded(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 30);
    const res = await upload(admin, { name: 'tour.webm', type: 'video/webm', content: webm }, {}, '/guide/videos?sectionId=dashboard&locale=fa');
    expect(res.status).toBe(201);
    expect(res.body.sizeBytes).toBe(webm.length);
    expect((await call('DELETE', `/guide/videos/${res.body.id}`, { token: admin })).status).toBe(204);
  }, 60_000);

  it('still stops what a route reads whole into memory', async () => {
    const res = await upload(admin, { name: 'venues.xlsx', type: 'application/octet-stream', content: padded('PK\x03\x04', limits.memory + 1) }, {}, '/site-data/import/VENUES');
    expect(res.status).toBe(413);
  }, 60_000);

  it('holds a size no integer column could, and adds such sizes up', async () => {
    const before = await storageUsed(org);
    const big = await prisma.document.create({
      data: { organizationId: org, fileName: 'campaign-master.mov', storedName: `${randomUUID()}.mov`, mimeType: 'video/quicktime', sizeBytes: 5 * GIB, uploadedById: uploader, projectId },
    });
    try {
      expect(await storageUsed(org)).toBe(before + 5 * GIB);
      const listed = expectOk(await get('/documents', token, { projectId }), 'list').find((d: { id: string }) => d.id === big.id);
      expect(listed.sizeBytes).toBe(5 * GIB);
    } finally {
      await prisma.document.update({ where: { id: big.id }, data: { deletedAt: new Date(), purgedAt: new Date() } });
    }
  });

  it('keeps what the headers say of a file too large to read whole, and does not try again', async () => {
    env.IN_MEMORY_FILE_MB = 0;
    const pdf = expectOk(await upload(token, { name: 'large.pdf', type: 'application/pdf', content: tinyPdf() }, fields), 'pdf');
    const image = expectOk(await upload(token, { name: 'large.png', type: 'image/png', content: png() }, fields), 'png');
    const read = () => prisma.document.findMany({ where: { id: { in: [pdf.id, image.id] } }, orderBy: { fileName: 'asc' }, select: { metadata: true } });
    const skipped = { skipped: 'TOO_LARGE', colours: [], inks: [] };
    const [ofPdf, ofImage] = await read();
    expect(ofPdf!.metadata).toMatchObject({ brand: { ...skipped, kind: 'pdf' } });
    expect(ofImage!.metadata).toMatchObject({ width: 640, height: 480, brand: { ...skipped, kind: 'image' } });
    await backfillMetadata();
    expect((await read()).map((d) => d.metadata)).toEqual([ofPdf!.metadata, ofImage!.metadata]);
  });

  it('leaves a file too large to merge out of a PDF bundle, and says why', async () => {
    const big = expectOk(await upload(token, { name: 'too-big.pdf', type: 'application/pdf', content: tinyPdf() }, fields), 'pdf');
    env.IN_MEMORY_FILE_MB = 0;
    const listing = expectOk(await get(`/pdf/project/${projectId}/attachments`, token), 'attachments');
    const offered = listing.groups.flatMap((g: { items: unknown[] }) => g.items).find((i: { id: string }) => i.id === big.id);
    expect(offered).toMatchObject({ embeddable: false, defaultSelected: false });
    expect((await post(`/pdf/project/${projectId}/bundle`, token, { items: [], fileIds: [big.id] })).status).toBe(200);
    const record = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'EXPORT', entityType: 'project', entityId: projectId }, orderBy: { createdAt: 'desc' } });
    expect(record.after).toMatchObject({ notEmbedded: [{ title: 'too-big.pdf', reason: 'حجم فایل برای گنجاندن در PDF زیاد است' }] });
  }, 90_000);

  it('refuses what the disk cannot keep before reading it, and keeps nothing', async () => {
    const before = await prisma.document.count({ where: { organizationId: org } });
    const onDisk = readdirSync(root).length;
    env.STORAGE_RESERVE_MB = Number.MAX_SAFE_INTEGER;
    const res = await upload(token, { name: 'more.pdf', type: 'application/pdf', content: tinyPdf() }, fields);
    expect(res.status).toBe(507);
    expect(res.body.error.code).toBe('DISK_FULL');
    expect(await prisma.document.count({ where: { organizationId: org } })).toBe(before);
    expect(readdirSync(root).length).toBe(onDisk);
  });

  it('stops an upload the disk cannot finish, and leaves nothing of it', async () => {
    const target = path.join(root, `${randomUUID()}.mov`);
    const block = Buffer.alloc(65 * MB, 1);
    // Declared nothing, and the disk was fine when it began.
    const endless = new Readable({ read() { this.push(block); } });
    env.STORAGE_RESERVE_MB = Number.MAX_SAFE_INTEGER;
    await expect(writeUpload(endless, target)).rejects.toMatchObject({ code: 'DISK_FULL', statusCode: 507 });
    expect(existsSync(target)).toBe(false);
  }, 30_000);
});
