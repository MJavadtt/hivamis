import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call, closeApp, get, login, patch, post, upload, tinyPdf, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { composeCorrection, timecode } from '../src/annotations/service.js';

const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  b.writeUInt8(8, 24); b.writeUInt8(2, 25);
  return b;
};
const mp4 = () => { const b = Buffer.alloc(32); b.writeUInt32BE(32, 0); b.write('ftypisom', 4, 'ascii'); return b; };

describe('Where on the file, in words a revision can carry', () => {
  it('writes timecodes and numbered lines in Persian', () => {
    expect(timecode(12.9)).toBe('۰۰:۱۲');
    expect(timecode(3725)).toBe('۰۱:۰۲:۰۵');
    expect(composeCorrection('رنگ‌ها با برند نمی‌خواند.', [
      { kind: 'PIN', number: 3, page: null, timeSec: null, note: 'لوگو کوچک است', fileName: 'poster.png' },
      { kind: 'TIMECODE', number: 1, page: null, timeSec: 12, note: 'زیرنویس جا افتاده', fileName: 'teaser.mp4' },
      { kind: 'HIGHLIGHT', number: 1, page: 2, timeSec: null, note: 'قیمت اشتباه است', fileName: 'deck.pdf' },
    ])).toBe('رنگ‌ها با برند نمی‌خواند.\n\nیادداشت‌های روی فایل:\n۱. [poster.png — نشانهٔ ۳] لوگو کوچک است\n۲. [teaser.mp4 — ۰۰:۱۲] زیرنویس جا افتاده\n۳. [deck.pdf — صفحهٔ ۲] قیمت اشتباه است');
  });
});

describe('Annotating a deliverable, and the revision it becomes', () => {
  let T: Record<string, string>;
  let deliverableId: string, otherId: string;
  const f: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    T = { designer: await login('designer@hiva.local'), creative: await login('creative@hiva.local'), sales: await login('sales@hiva.local') };
    const org = (await prisma.organization.findFirstOrThrow()).id;
    const project = await prisma.project.findFirstOrThrow({ where: { deletedAt: null } });
    const mk = async (name: string) => (await prisma.deliverable.create({ data: { organizationId: org, code: await nextCode(prisma, 'deliverable'), projectId: project.id, name, departmentCode: 'CR', state: 'IN_QC' } })).id;
    deliverableId = await mk('کمپین پاییز');
    // The designer works on it: a task of theirs under it (ADR-127 — they see what they work on).
    const designer = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    await prisma.task.create({ data: { organizationId: org, code: await nextCode(prisma, 'task'), projectId: project.id, deliverableId, title: 'طراحی', departmentCode: 'CR', priority: 'NORMAL', state: 'IN_PROGRESS', sourceType: 'ORDER_FORM', sourceRef: 'test', createdById: designer.id, assigneeId: designer.id } });
    otherId = await mk('خروجی دیگر');
    const up = async (key: string, name: string, type: string, content: Buffer | string, d = deliverableId) => {
      f[key] = expectOk(await upload(T.creative, { name, type, content }, { deliverableId: d }), key).id;
    };
    await up('image', 'poster.png', 'image/png', png(1080, 1350));
    await up('video', 'teaser.mp4', 'video/mp4', mp4());
    await up('pdf', 'deck.pdf', 'application/pdf', tinyPdf('deck'));
    await up('text', 'notes.txt', 'text/plain', 'متن');
    await up('otherImage', 'other.png', 'image/png', png(10, 10), otherId);
  });
  afterAll(async () => { await closeApp(); });

  const add = (body: object, token = T.creative, d = deliverableId) => post(`/deliverables/${d}/annotations`, token, body);

  it('places a pin on an image, a moment in a video and a region of a PDF page — each numbered on its file', async () => {
    const p1 = expectOk(await add({ kind: 'PIN', documentId: f.image, x: 0.82, y: 0.1, note: 'لوگو کوچک است' }), 'pin');
    const p2 = expectOk(await add({ kind: 'PIN', documentId: f.image, x: 0.5, y: 0.9, note: 'شمارهٔ تماس ناخوانا' }), 'pin 2');
    expect([p1.number, p2.number]).toEqual([1, 2]);
    expect(p1).toMatchObject({ kind: 'PIN', status: 'OPEN', author: { fullName: expect.any(String) } });
    ids.pin = p1.id; ids.pin2 = p2.id;
    ids.time = expectOk(await add({ kind: 'TIMECODE', documentId: f.video, timeSec: 12.4, note: 'زیرنویس جا افتاده' }), 'timecode').id;
    ids.region = expectOk(await add({ kind: 'HIGHLIGHT', documentId: f.pdf, page: 2, x: 0.1, y: 0.4, w: 0.5, h: 0.1, note: 'قیمت اشتباه است' }), 'highlight').id;
    const s = await prisma.annotation.findUniqueOrThrow({ where: { id: ids.region } });
    expect(s.documentSha256).toBe((await prisma.document.findUniqueOrThrow({ where: { id: f.pdf } })).checksum);

    const listed = expectOk(await get(`/deliverables/${deliverableId}/annotations`, T.designer), 'list');
    expect(listed.files.map((x: any) => [x.fileName, x.kind, x.annotations]).sort()).toEqual([['deck.pdf', 'pdf', 1], ['notes.txt', null, 0], ['poster.png', 'image', 2], ['teaser.mp4', 'video', 1]]);
  });

  it('refuses what does not fit: the wrong mark for the file, a file it cannot mark, a region off the page, someone outside QC', async () => {
    expect((await add({ kind: 'HIGHLIGHT', documentId: f.image, page: 1, x: 0, y: 0, w: 0.1, h: 0.1, note: 'x' })).body.error.code).toBe('ANNOTATION_KIND');
    expect((await add({ kind: 'PIN', documentId: f.text, x: 0.5, y: 0.5, note: 'x' })).body.error.code).toBe('ANNOTATION_UNSUPPORTED');
    expect((await add({ kind: 'PIN', documentId: f.otherImage, x: 0.5, y: 0.5, note: 'x' })).body.error.code).toBe('ANNOTATION_FILE');
    expect((await add({ kind: 'HIGHLIGHT', documentId: f.pdf, page: 1, x: 0.8, y: 0.1, w: 0.5, h: 0.1, note: 'x' })).status).toBe(400);
    expect((await add({ kind: 'PIN', documentId: f.image, x: 1.4, y: 0.1, note: 'x' })).status).toBe(400);
    expect((await add({ kind: 'PIN', documentId: f.image, x: 0.4, y: 0.1, note: 'x' }, T.sales)).status).toBe(403);
    // And the database says the same, whatever writes to it.
    const d = await prisma.annotation.findUniqueOrThrow({ where: { id: ids.pin } });
    await expect(prisma.annotation.create({ data: { ...d, id: undefined, number: 99, x: 1.5 } as never })).rejects.toThrow(/annotations_place/);
  });

  it('a failed QC carries its annotations into the revision — the required correction lists each one, where it is', async () => {
    const r = expectOk(await post('/qc-reviews', T.designer, { level: 'UNIT', deliverableId, verdict: 'FAILED', annotationIds: [ids.pin, ids.time, ids.region] }), 'qc');
    expect(r.revision).toBeTruthy();
    const correction: string = r.revision.requiredCorrection;
    expect(correction).toContain('یادداشت‌های روی فایل:');
    expect(correction).toContain('[poster.png — نشانهٔ ۱] لوگو کوچک است');
    expect(correction).toContain('[teaser.mp4 — ۰۰:۱۲] زیرنویس جا افتاده');
    expect(correction).toContain('[deck.pdf — صفحهٔ ۲] قیمت اشتباه است');
    const carried = await prisma.annotation.findMany({ where: { id: { in: [ids.pin, ids.time, ids.region] } } });
    expect(carried.every((a) => a.qcReviewId === r.review.id && a.revisionId === r.revision.id)).toBe(true);
    expect((await prisma.annotation.findUniqueOrThrow({ where: { id: ids.pin2 } })).revisionId).toBeNull();

    expect((await post('/qc-reviews', T.designer, { level: 'UNIT', deliverableId, verdict: 'FAILED', annotationIds: [ids.pin] })).body.error.code).toBe('QC_ANNOTATIONS');
    const other = expectOk(await add({ kind: 'PIN', documentId: f.otherImage, x: 0.5, y: 0.5, note: 'روی خروجی دیگر' }, T.creative, otherId), 'other').id;
    expect((await post('/qc-reviews', T.designer, { level: 'UNIT', deliverableId, verdict: 'FAILED', annotationIds: [other] })).body.error.code).toBe('QC_ANNOTATIONS');
    // A failed review still needs something said: words or marks.
    expect((await post('/qc-reviews', T.designer, { level: 'UNIT', deliverableId, verdict: 'FAILED' })).status).toBe(400);
  });

  it('is resolved by whoever works on the deliverable, and can be opened again', async () => {
    expect((await patch(`/annotations/${ids.pin}`, T.sales, { status: 'RESOLVED' })).status).toBe(403);
    expect(expectOk(await patch(`/annotations/${ids.pin}`, T.creative, { status: 'RESOLVED' }), 'resolve')).toMatchObject({ status: 'RESOLVED', resolvedAt: expect.any(String) });
    expect(expectOk(await patch(`/annotations/${ids.pin}`, T.creative, { status: 'OPEN' }), 'reopen')).toMatchObject({ status: 'OPEN', resolvedAt: null });
  });

  it('may be taken back by its author only while no review has carried it', async () => {
    expect((await call('DELETE', `/annotations/${ids.pin2}`, { token: T.designer })).status).toBe(403);
    expect((await call('DELETE', `/annotations/${ids.pin}`, { token: T.creative })).status).toBe(409);
    expect((await call('DELETE', `/annotations/${ids.pin2}`, { token: T.creative })).status).toBe(204);
  });
});
