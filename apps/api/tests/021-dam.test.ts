import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { Prisma } from '@prisma/client';
import { app, call, closeApp, get, login, post, put, upload, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { nextCode } from '../src/lib/codes.js';
import { clientMail } from '../src/mail/client.js';
import { fontFamily, imageMetadata, mp4Metadata, pdfMetadata } from '../src/documents/metadata.js';
import { backfillMetadata } from '../src/documents/backfill.js';
import { newestShared } from '../src/portal/service.js';
import { detectAnomalies } from '../src/security/anomalies.js';

/* ── Files built byte by byte, so what the reader finds is known ─────────────────────────── */

const png = (w: number, h: number, colorType = 6) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  b.writeUInt8(8, 24); b.writeUInt8(colorType, 25);
  return b;
};

/** A JPEG header: an optional Adobe APP14 marker, then a baseline start-of-frame. */
const jpeg = (w: number, h: number, components: number, adobeTransform?: number) => {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (adobeTransform != null) {
    const app14 = Buffer.alloc(16);
    app14.writeUInt16BE(0xffee, 0); app14.writeUInt16BE(14, 2); app14.write('Adobe', 4, 'ascii');
    app14.writeUInt16BE(100, 9); app14.writeUInt8(adobeTransform, 15);
    parts.push(app14);
  }
  const sof = Buffer.alloc(10 + 3 * components);
  sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(8 + 3 * components, 2); sof.writeUInt8(8, 4);
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof.writeUInt8(components, 9);
  parts.push(sof, Buffer.alloc(16), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
};

const box = (type: string, ...body: Buffer[]) => {
  const content = Buffer.concat(body);
  const head = Buffer.alloc(8); head.writeUInt32BE(8 + content.length, 0); head.write(type, 4, 'ascii');
  return Buffer.concat([head, content]);
};
/** ftyp, then the media, then moov at the end — where a camera usually leaves it. */
const mp4 = (seconds: number, w: number, h: number) => {
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(seconds * 1000, 16);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(w * 65536, 76); tkhd.writeUInt32BE(h * 65536, 80);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('mdat', Buffer.alloc(64)), box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd)))]);
};

/** The smallest TrueType font that carries a family name: one `name` table, one record. */
const ttf = (family: string) => {
  const text = Buffer.from(family, 'utf16le').swap16();
  const name = Buffer.alloc(18); name.writeUInt16BE(0, 0); name.writeUInt16BE(1, 2); name.writeUInt16BE(18, 4);
  name.writeUInt16BE(3, 6); name.writeUInt16BE(1, 8); name.writeUInt16BE(0x409, 10); name.writeUInt16BE(1, 12); name.writeUInt16BE(text.length, 14); name.writeUInt16BE(0, 16);
  const header = Buffer.alloc(28); header.writeUInt32BE(0x00010000, 0); header.writeUInt16BE(1, 4);
  header.write('name', 12, 'latin1'); header.writeUInt32BE(28, 20); header.writeUInt32BE(18 + text.length, 24);
  return Buffer.concat([header, name, text]);
};

const a4Pdf = async (pages: number) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]);
  return Buffer.from(await doc.save());
};

describe('What a file says about itself, read from its headers', () => {
  it('reads pixel size and colour space — a CMYK JPEG is known for print artwork', () => {
    expect(imageMetadata(png(1080, 1350))).toEqual({ width: 1080, height: 1350, bitDepth: 8, colorSpace: 'RGBA' });
    expect(imageMetadata(jpeg(2480, 3508, 4, 0))).toEqual({ width: 2480, height: 3508, bitDepth: 8, colorSpace: 'CMYK' });
    expect(imageMetadata(jpeg(2480, 3508, 4, 2))).toMatchObject({ colorSpace: 'YCCK' });
    expect(imageMetadata(jpeg(800, 600, 3))).toMatchObject({ width: 800, height: 600, colorSpace: 'RGB' });
    expect(imageMetadata(jpeg(800, 600, 1))).toMatchObject({ colorSpace: 'GRAYSCALE' });
    expect(imageMetadata(Buffer.from('not an image at all, just words'))).toBeNull();
  });

  it('reads a video’s length and frame, a PDF’s pages and paper, a font’s family', async () => {
    const file = mp4(95, 1920, 1080);
    const moov = file.subarray(file.indexOf('moov') + 4);
    expect(mp4Metadata(moov)).toEqual({ durationSec: 95, width: 1920, height: 1080 });
    expect(await pdfMetadata(await a4Pdf(3))).toEqual({ pageCount: 3, pageSizeMm: { w: 210, h: 297 } });
    expect(await pdfMetadata(Buffer.from('%PDF-1.4 broken'))).toBeNull();
    expect(fontFamily(ttf('Vazirmatn'))).toBe('Vazirmatn');
    expect(fontFamily(ttf('ایران‌سنس'))).toBe('ایران‌سنس');
    expect(fontFamily(Buffer.from('wOFF compressed'))).toBeNull();
  });

  it('shows the client the newest version they were shown of each file, and no other', () => {
    const docs = [
      { id: 'a2', lineageId: 'a1', version: 2 }, { id: 'a1', lineageId: 'a1', version: 1 },
      { id: 'b1', lineageId: 'b1', version: 1 }, { id: 'old', lineageId: null, version: 1 },
    ];
    expect(newestShared(docs)).toEqual([{ id: 'a2', version: 2 }, { id: 'b1', version: 1 }, { id: 'old', version: 1 }]);
  });
});

describe('Versions of a file, and a client’s brand library', () => {
  let T: Record<string, string>;
  let deliverableId: string, companyId: string, contractId: string, contactId: string, legalId: string;
  const f: Record<string, string> = {};
  const original = { mode: env.ESIGN_MODE, mail: { ...clientMail } };

  beforeAll(async () => {
    env.ESIGN_MODE = 'sandbox';
    clientMail.enabled = () => false;
    T = {
      creative: await login('creative@hiva.local'), designer: await login('designer@hiva.local'),
      legal: await login('legal@hiva.local'), sales: await login('sales@hiva.local'), admin: await login('admin@hiva.local'),
    };
    const org = (await prisma.organization.findFirstOrThrow()).id;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
    legalId = (await prisma.user.findFirstOrThrow({ where: { email: 'legal@hiva.local' } })).id;
    const project = await prisma.project.findFirstOrThrow({ where: { deletedAt: null } });
    deliverableId = (await prisma.deliverable.create({ data: { organizationId: org, code: await nextCode(prisma, 'deliverable'), projectId: project.id, name: 'پوستر پاییز', departmentCode: 'CR', state: 'IN_QC' } })).id;
    companyId = (await prisma.company.create({ data: { organizationId: org, legalName: 'شرکت برند آزمون', accountOwnerId: owner.id } })).id;
    contactId = (await prisma.contact.create({ data: { companyId, fullName: 'مریم احمدی', email: 'maryam@brand.example' } })).id;
    contractId = (await prisma.contract.create({
      data: { organizationId: org, code: await nextCode(prisma, 'contract'), companyId, title: 'قرارداد نسخه‌ها', contractValue: 1_000_000_000, startDate: new Date(), endDate: new Date(Date.now() + 90 * 86_400_000), state: 'PENDING_SIGNATURE', createdById: owner.id },
    })).id;
  });
  afterAll(async () => {
    env.ESIGN_MODE = original.mode;
    Object.assign(clientMail, original.mail);
    await closeApp();
  });

  it('keeps what each upload says about itself', async () => {
    const up = async (key: string, name: string, type: string, content: Buffer) => {
      const d = expectOk(await upload(T.creative, { name, type, content }, { deliverableId }), key);
      f[key] = d.id;
      return d.metadata;
    };
    expect(await up('poster', 'poster.png', 'image/png', png(1080, 1350))).toEqual({ width: 1080, height: 1350, bitDepth: 8, colorSpace: 'RGBA' });
    expect(await up('print', 'print.jpg', 'image/jpeg', jpeg(2480, 3508, 4, 0))).toMatchObject({ colorSpace: 'CMYK', width: 2480 });
    expect(await up('teaser', 'teaser.mp4', 'video/mp4', mp4(30, 1080, 1920))).toEqual({ durationSec: 30, width: 1080, height: 1920 });
    expect(await up('deck', 'deck.pdf', 'application/pdf', await a4Pdf(2))).toEqual({ pageCount: 2, pageSizeMm: { w: 210, h: 297 } });
    expect(await up('notes', 'notes.txt', 'text/plain', Buffer.from('متن'))).toBeNull();
  });

  it('takes a new version in the old one’s place: its links, its lineage, the next number — and keeps the old one', async () => {
    // Sent with no links of its own: the replaced file's links are the ones it takes.
    const v2 = expectOk(await upload(T.designer, { name: 'poster-v2.png', type: 'image/png', content: png(1080, 1920) }, { replacesId: f.poster! }), 'v2');
    expect(v2).toMatchObject({ version: 2, lineageId: f.poster, deliverableId, supersededAt: null, metadata: { height: 1920 } });
    f.poster2 = v2.id;
    const v1 = await prisma.document.findUniqueOrThrow({ where: { id: f.poster } });
    expect(v1).toMatchObject({ lineageId: f.poster, version: 1, supersededById: v2.id, deletedAt: null });
    expect(v1.supersededAt).toBeInstanceOf(Date);

    const current = expectOk(await get('/documents', T.designer, { deliverableId }), 'list');
    expect(current.map((d: any) => d.fileName).sort()).toEqual(['deck.pdf', 'notes.txt', 'poster-v2.png', 'print.jpg', 'teaser.mp4']);
    const all = expectOk(await get('/documents', T.designer, { deliverableId, versions: 'all' }), 'all');
    expect(all).toHaveLength(6);

    const v3 = expectOk(await upload(T.creative, { name: 'poster-v3.png', type: 'image/png', content: png(1080, 1080) }, { replacesId: v2.id }), 'v3');
    f.poster3 = v3.id;
    const history = expectOk(await get(`/documents/${f.poster}/versions`, T.designer), 'versions');
    expect(history.map((h: any) => [h.version, h.fileName, h.current])).toEqual([[1, 'poster.png', false], [2, 'poster-v2.png', false], [3, 'poster-v3.png', true]]);
    expect(history[2]).toMatchObject({ metadata: { width: 1080, height: 1080 }, uploadedBy: { fullName: expect.any(String) }, annotations: 0 });
    // Asked from any version, the answer is the same history.
    expect(expectOk(await get(`/documents/${v3.id}/versions`, T.designer), 'from v3').map((h: any) => h.id)).toEqual(history.map((h: any) => h.id));
  });

  it('refuses a version on top of an old one, and lets only one of two racing uploads win', async () => {
    const before = await prisma.document.count();
    const stale = await upload(T.creative, { name: 'late.png', type: 'image/png', content: png(10, 10) }, { replacesId: f.poster2! });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'DOCUMENT_SUPERSEDED']);
    expect(await prisma.document.count()).toBe(before);

    const race = await Promise.all([1, 2].map((n) => upload(T.creative, { name: `race-${n}.png`, type: 'image/png', content: png(n, n) }, { replacesId: f.print! })));
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    const lineage = await prisma.document.findMany({ where: { lineageId: f.print } });
    expect(lineage.filter((d) => !d.supersededAt)).toHaveLength(1);
    expect(lineage).toHaveLength(2);

    expect((await upload(T.creative, { name: 'x.png', type: 'image/png', content: png(1, 1) }, { replacesId: '00000000-0000-4000-8000-000000000000' })).body.error.code).toBe('UNKNOWN_REFERENCE');
  });

  it('marks only the current version, and shows the old ones marked as old', async () => {
    const old = await post(`/deliverables/${deliverableId}/annotations`, T.creative, { kind: 'PIN', documentId: f.poster2, x: 0.5, y: 0.5, note: 'لوگو' });
    expect([old.status, old.body.error.code]).toEqual([422, 'ANNOTATION_SUPERSEDED']);
    expectOk(await post(`/deliverables/${deliverableId}/annotations`, T.creative, { kind: 'PIN', documentId: f.poster3, x: 0.5, y: 0.5, note: 'لوگو' }), 'on current');
    const listed = expectOk(await get(`/deliverables/${deliverableId}/annotations`, T.designer), 'annotator');
    const posters = listed.files.filter((x: any) => x.fileName.startsWith('poster'));
    expect(posters.map((x: any) => [x.version, x.current, x.annotations])).toEqual([[3, true, 1], [2, false, 0], [1, false, 0]]);
  });

  it('sends only the newest contract PDF to be signed', async () => {
    const v1 = expectOk(await upload(T.legal, { name: 'contract.pdf', type: 'application/pdf', content: await a4Pdf(1) }, { contractId }), 'contract v1').id;
    const v2 = expectOk(await upload(T.legal, { name: 'contract-final.pdf', type: 'application/pdf', content: await a4Pdf(2) }, { replacesId: v1 }), 'contract v2').id;
    const o = expectOk(await get(`/contracts/${contractId}/signature-options`, T.legal), 'options');
    expect(o.documents.map((d: any) => [d.id, d.version])).toEqual([[v2, 2]]);
    const body = { documentId: v1, clientContactId: contactId, agencyUserId: legalId, expiresInDays: 7 };
    expect((await post(`/contracts/${contractId}/signatures`, T.legal, body)).body.error.code).toBe('ESIGN_DOCUMENT_SUPERSEDED');
  });

  it('taking back the current version makes the one before it current again', async () => {
    expect((await call('DELETE', `/documents/${f.poster3}`, { token: T.admin })).status).toBe(204);
    const history = expectOk(await get(`/documents/${f.poster}/versions`, T.designer), 'versions');
    expect(history.map((h: any) => [h.version, h.current])).toEqual([[1, false], [2, true]]);
    expect(await prisma.document.findUniqueOrThrow({ where: { id: f.poster2 } })).toMatchObject({ supersededAt: null, supersededById: null });
    // A fresh version now builds on version 2.
    const next = expectOk(await upload(T.creative, { name: 'poster-v4.png', type: 'image/png', content: png(4, 4) }, { replacesId: f.poster2! }), 'after rollback');
    expect(next.version).toBe(3);
  });

  it('keeps the brand library: palette and typefaces by those who keep brands, brand files on a client', async () => {
    const empty = expectOk(await get(`/companies/${companyId}/brand`, T.designer), 'empty');
    expect(empty).toMatchObject({ company: { legalName: 'شرکت برند آزمون' }, kit: { colors: [], fonts: [] }, files: [] });

    const kit = { colors: [{ name: 'سرمه‌ای', hex: '#1a2b3c', role: 'PRIMARY' }, { name: 'طلایی', hex: '#D4AF37', role: 'ACCENT' }], fonts: [{ family: 'Vazirmatn', usage: 'متن' }], notes: 'لوگو روی زمینهٔ تیره سفید است.' };
    expect((await put(`/companies/${companyId}/brand`, T.designer, kit)).status).toBe(403);
    expect((await put(`/companies/${companyId}/brand`, T.creative, { ...kit, colors: [{ name: 'بد', hex: 'blue', role: 'PRIMARY' }] })).status).toBe(400);
    const saved = expectOk(await put(`/companies/${companyId}/brand`, T.creative, kit), 'save');
    expect(saved.colors[0]).toEqual({ name: 'سرمه‌ای', hex: '#1A2B3C', role: 'PRIMARY' });
    expectOk(await put(`/companies/${companyId}/brand`, T.creative, { ...kit, notes: null }), 'update');
    const trail = await prisma.auditEvent.findMany({ where: { entityType: 'brandKit', entityId: saved.id }, orderBy: { createdAt: 'asc' } });
    expect(trail.map((a) => a.action)).toEqual(['CREATE', 'UPDATE']);

    // Brand files: on a client, by someone who keeps brands, in a role the library knows.
    const logo = (fields: Record<string, string>, token = T.creative) => upload(token, { name: 'logo.png', type: 'image/png', content: png(512, 512) }, fields);
    expect((await logo({ brandRole: 'LOGO' })).body.error.code).toBe('BRAND_NEEDS_CLIENT');
    expect((await logo({ brandRole: 'LOGO', companyId }, T.designer)).status).toBe(403);
    expect((await logo({ brandRole: 'MASCOT', companyId })).body.error.code).toBe('BAD_BRAND_ROLE');
    const logoId = expectOk(await logo({ brandRole: 'LOGO', companyId }), 'logo').id;
    const font = expectOk(await upload(T.creative, { name: 'Vazirmatn-Regular.ttf', type: 'application/octet-stream', content: ttf('Vazirmatn') }, { brandRole: 'FONT', companyId }), 'font');
    expect(font).toMatchObject({ mimeType: 'font/ttf', metadata: { fontFamily: 'Vazirmatn' } });
    // A font by its extension still has to be one.
    expect((await upload(T.creative, { name: 'fake.woff', type: 'font/woff', content: Buffer.from('MZ not a font') }, { companyId })).body.error.code).toBe('UNSUPPORTED_TYPE');
    expectOk(await upload(T.creative, { name: 'Vazirmatn.woff2', type: 'application/font-woff2', content: Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40)]) }, { brandRole: 'FONT', companyId }), 'woff2');

    // A new logo is still a brand file — and still needs someone who keeps brands.
    expect((await upload(T.designer, { name: 'logo-2.png', type: 'image/png', content: png(600, 600) }, { replacesId: logoId })).status).toBe(403);
    expectOk(await upload(T.creative, { name: 'logo-2.png', type: 'image/png', content: png(600, 600) }, { replacesId: logoId }), 'logo v2');

    const library = expectOk(await get(`/companies/${companyId}/brand`, T.sales), 'library');
    expect(library.kit.fonts).toEqual([{ family: 'Vazirmatn', usage: 'متن' }]);
    expect(library.files.map((d: any) => [d.brandRole, d.fileName, d.version]).sort()).toEqual([['FONT', 'Vazirmatn-Regular.ttf', 1], ['FONT', 'Vazirmatn.woff2', 1], ['LOGO', 'logo-2.png', 2]]);
  });

  it('shows a file in the app without calling it a download — and a page of thumbnails is not a surge', async () => {
    const a = await app();
    const preview = (id: string, token = T.designer) => a.inject({ method: 'GET', url: `/api/v1/documents/${id}/preview`, headers: { authorization: `Bearer ${token}` } });
    const first = await preview(f.teaser!);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('application/octet-stream');
    expect(first.headers['cache-control']).toBe('private, max-age=300');
    expect(first.rawPayload).toEqual(mp4(30, 1080, 1920));
    expect((await preview(f.teaser!)).statusCode).toBe(200);
    const designerId = (await prisma.user.findUniqueOrThrow({ where: { email: 'designer@hiva.local' } })).id;
    const trail = await prisma.auditEvent.findMany({ where: { actorId: designerId, entityId: f.teaser } });
    expect(trail.map((e) => e.action)).toEqual(['FILE_VIEW']);                  // once in the hour, and not a download
    const text = await preview(f.notes!);
    expect([text.statusCode, text.json().error.code]).toEqual([422, 'PREVIEW_UNSUPPORTED']);
    expect((await preview(f.teaser!, T.sales)).statusCode).toBe(200);           // anyone who reads files

    // Sixty views of three files over a day is someone looking at a page; thirty different files is not.
    const org = (await prisma.organization.findFirstOrThrow()).id;
    const now = new Date();
    const views = (ids: string[]) => prisma.auditEvent.createMany({ data: ids.map((entityId, i) => ({ organizationId: org, actorId: designerId, action: 'FILE_VIEW', entityType: 'document', entityId, createdAt: new Date(now.getTime() - (i + 1) * 60_000) })) });
    await views(Array.from({ length: 60 }, (_, i) => [f.teaser!, f.deck!, f.notes!][i % 3]!));
    const surge = async () => (await detectAnomalies(prisma, org, { now })).find((x) => x.kind === 'DOWNLOAD_SURGE' && x.actorId === designerId);
    expect(await surge()).toBeUndefined();
    await views(Array.from({ length: 30 }, () => crypto.randomUUID()));
    expect(await surge()).toMatchObject({ evidence: { count: 33 } });
  });

  it('reads the files uploaded before any of this, a few at a time', async () => {
    await prisma.document.update({ where: { id: f.teaser }, data: { metadata: Prisma.DbNull } });
    await prisma.document.update({ where: { id: f.deck }, data: { metadata: Prisma.DbNull, storedName: 'missing-file.pdf' } });
    const { read } = await backfillMetadata();
    expect(read).toBeGreaterThanOrEqual(2);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: f.teaser } })).metadata).toEqual({ durationSec: 30, width: 1080, height: 1920 });
    // A file that says nothing readable is marked read, not read again.
    expect((await prisma.document.findUniqueOrThrow({ where: { id: f.deck } })).metadata).toEqual({});
    expect((await backfillMetadata()).read).toBe(0);
  });
});
