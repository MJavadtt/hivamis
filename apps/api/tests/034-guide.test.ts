import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { GUIDE, guideFor, searchGuide } from '@hiva/contracts';
import { app, call, closeApp, expectOk, get, login } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { runTool, systemPrompt, type AgentContext } from '../src/ai/agent.js';

/**
 * Hivamis task 8: the owl's guide — a section for every page, in both languages, pointing at
 * elements the pages really have; answers to "how do I…" from it; and the organisation's own videos,
 * played through a link that opens that one video for a few hours.
 */

const WEB = path.resolve(__dirname, '../../web/src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
});

/** A video as far as the signature check goes: an MP4 box header, then anything. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(2000, 7)]);

async function uploadVideo(token: string, query: string, file: { name: string; type: string; content: Buffer }) {
  const boundary = `----owl${Math.random().toString(36).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await (await app()).inject({
    method: 'POST', url: `/api/v1/guide/videos?${query}`, payload,
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  return { status: res.statusCode, body: JSON.parse(res.body || 'null') };
}

describe('The guide', () => {
  it('has a section for every page of the application, in both languages', () => {
    const ids = GUIDE.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of GUIDE) {
      for (const text of [s.title, s.summary, ...s.steps.flatMap((st) => [st.title, st.body])]) {
        expect(text.fa.trim(), `${s.id} fa`).not.toBe('');
        expect(text.en.trim(), `${s.id} en`).not.toBe('');
        // The English names the English screen; the language button's own label is the one exception.
        expect(text.en.replace('EN / فا', ''), `${s.id}: English without Persian`).not.toMatch(/[؀-ۿ]/);
      }
      expect(s.steps.length, s.id).toBeGreaterThan(0);
      if (s.path) expect(guideFor(s.path)?.id, `${s.id}'s own page`).toBe(s.id);
    }
    // Every route of the application, with an id in place of its parameter, finds its section.
    const routes = [...readFileSync(path.join(WEB, 'App.tsx'), 'utf8').matchAll(/<Route path="([^"*]+)"/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(30);
    const missing = routes.map((r) => r.replace(/:\w+/g, '00000000-0000-4000-8000-000000000001')).filter((r) => !guideFor(r));
    expect(missing).toEqual([]);
  });

  it('points only at anchors the pages really carry', () => {
    const source = files(WEB).map((f) => readFileSync(f, 'utf8')).join('\n');
    const anchors = new Set([...source.matchAll(/(?:data-tour|\btour)="([\w-]+)"/g)].map((m) => m[1]!));
    const wanted = new Set(GUIDE.flatMap((s) => s.steps.flatMap((st) => [...(st.target ?? '').matchAll(/data-tour="([\w-]+)"/g)].map((m) => m[1]!))));
    expect([...wanted].filter((w) => !anchors.has(w))).toEqual([]);
    // A step that names a menu item names one that exists.
    for (const s of GUIDE) for (const st of s.steps) {
      const href = /a\[href="([^"]+)"\]/.exec(st.target ?? '')?.[1];
      if (href) expect(source, href).toContain(`to: '${href}'`);
    }
  });

  it('answers "how do I…" in either language', () => {
    expect(searchGuide('چطور فرمی را تأیید کنم؟', 'fa')[0]?.section.id).toBe('forms');
    expect(searchGuide('how do I log my hours', 'en')[0]?.section.id).toBe('task');
    expect(searchGuide('قرارداد را چطور امضای الکترونیکی کنم؟', 'fa')[0]?.step?.title.en).toBe('Electronic signature');
    expect(searchGuide('ثبت سرنخ جدید', 'fa')[0]?.section.id).toBe('leads');
    expect(searchGuide('می‌خواهم مرخصی بروم', 'fa')[0]?.section.id).toBe('delegations');
    // Letters typed the Arabic way still match.
    expect(searchGuide('كارهاي من', 'fa')[0]?.section.id).toBe('my-work');
    expect(searchGuide('چطور', 'fa')).toEqual([]);
  });

  it('gives the assistant the guide: the page it was opened on, and a search', async () => {
    const ctx = { locale: 'fa', currency: 'IRR', person: { fullName: 'x', jobTitle: null, unit: null, roles: [] }, page: { path: '/forms' } } as unknown as AgentContext;
    expect(systemPrompt(ctx)).toContain('«فرم‌ها»');
    const r = await runTool({ function: { name: 'search_guide', arguments: { query: 'چطور ساعت کارم را ثبت کنم' } } }, ctx);
    expect(r.content).toContain('ثبت زمان');
    const none = await runTool({ function: { name: 'search_guide', arguments: { query: 'زرافه' } } }, ctx);
    expect(none.content).toMatch(/nothing in the guide/);
  });
});

describe('The guide’s videos', () => {
  let admin: string, sales: string;
  const storage = path.resolve(env.STORAGE_DIR);
  beforeAll(async () => {
    admin = await login('admin@hiva.local');
    sales = await login('sales@hiva.local');
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    for (const v of await prisma.guideVideo.findMany()) await call('DELETE', `/guide/videos/${v.id}`, { token: admin });
    await closeApp();
  });

  it('are added by the system administrator only, and only as real MP4 or WebM', async () => {
    expect((await uploadVideo(sales, 'sectionId=dashboard&locale=fa', { name: 'a.mp4', type: 'video/mp4', content: MP4 })).status).toBe(403);
    expect((await uploadVideo(admin, 'sectionId=nowhere&locale=fa', { name: 'a.mp4', type: 'video/mp4', content: MP4 })).body.error.code).toBe('UNKNOWN_SECTION');
    expect((await uploadVideo(admin, 'sectionId=dashboard&locale=de', { name: 'a.mp4', type: 'video/mp4', content: MP4 })).body.error.code).toBe('BAD_LOCALE');
    expect((await uploadVideo(admin, 'sectionId=dashboard&locale=fa', { name: 'a.mp4', type: 'video/mp4', content: Buffer.from('<html>not a video</html>') })).body.error.code).toBe('UNSUPPORTED_TYPE');
    expect((await uploadVideo(admin, 'sectionId=dashboard&locale=fa', { name: 'a.pdf', type: 'application/pdf', content: Buffer.from('%PDF-1.4') })).body.error.code).toBe('UNSUPPORTED_TYPE');
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(500, 1)]);
    expect((await uploadVideo(admin, 'sectionId=dashboard&locale=en', { name: 'b.webm', type: 'video/webm', content: webm })).status).toBe(201);
  });

  it('keep one per section and language: a new one replaces the old, file and all', async () => {
    const first = await uploadVideo(admin, 'sectionId=projects&locale=fa&title=نخست', { name: 'a.mp4', type: 'video/mp4', content: MP4 });
    expect(first.status).toBe(201);
    const firstFile = (await prisma.guideVideo.findUniqueOrThrow({ where: { id: first.body.id } })).storedName;
    const second = await uploadVideo(admin, 'sectionId=projects&locale=fa', { name: 'b.mp4', type: 'video/mp4', content: MP4 });
    expect(second.body).toMatchObject({ sectionId: 'projects', locale: 'fa', title: 'پروژه‌ها', mimeType: 'video/mp4', sizeBytes: MP4.length });
    expect(await prisma.guideVideo.count({ where: { sectionId: 'projects', locale: 'fa' } })).toBe(1);
    expect(existsSync(path.join(storage, firstFile))).toBe(false);
    // Everyone signed in sees which exist.
    expect(expectOk(await get('/guide/videos', sales), 'list').map((v: { sectionId: string }) => v.sectionId)).toContain('projects');
    expect(await prisma.auditEvent.count({ where: { action: 'GUIDE_VIDEO_UPLOAD', entityId: second.body.id } })).toBe(1);
  });

  it('play through a signed link — in ranges, as the video it was checked to be — that expires and opens nothing else', async () => {
    const v = await uploadVideo(admin, 'sectionId=forms&locale=fa', { name: 'a.mp4', type: 'video/mp4', content: MP4 });
    const { url } = expectOk(await get(`/guide/videos/${v.body.id}/link`, sales), 'link');
    const a = await app();
    const part = await a.inject({ method: 'GET', url, headers: { range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-type']).toBe('video/mp4');
    expect(part.headers['content-range']).toBe(`bytes 0-99/${MP4.length}`);
    expect(part.headers['x-content-type-options']).toBe('nosniff');
    expect(part.rawPayload.subarray(4, 8).toString()).toBe('ftyp');

    // Another video's id with this signature, a forged signature, no signature: refused.
    const other = await uploadVideo(admin, 'sectionId=leads&locale=fa', { name: 'a.mp4', type: 'video/mp4', content: MP4 });
    expect((await a.inject({ method: 'GET', url: url.replace(v.body.id, other.body.id) })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: url.replace(/sig=[^&]+/, 'sig=AAAA') })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: `/api/v1/guide/videos/${v.body.id}/stream` })).statusCode).toBe(403);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 3_600_000);
    expect((await a.inject({ method: 'GET', url })).statusCode).toBe(403);
  });

  it('are removed by the administrator, file and all', async () => {
    const v = await uploadVideo(admin, 'sectionId=qc&locale=en', { name: 'a.mp4', type: 'video/mp4', content: MP4 });
    const stored = (await prisma.guideVideo.findUniqueOrThrow({ where: { id: v.body.id } })).storedName;
    expect((await call('DELETE', `/guide/videos/${v.body.id}`, { token: sales })).status).toBe(403);
    expect((await call('DELETE', `/guide/videos/${v.body.id}`, { token: admin })).status).toBe(204);
    expect(existsSync(path.join(storage, stored))).toBe(false);
    expect((await get(`/guide/videos/${v.body.id}/link`, admin)).status).toBe(404);
  });
});
