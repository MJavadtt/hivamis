import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ROLE_PERMISSIONS } from '@hiva/contracts';
import { app, closeApp, expectOk, get, login, post, put } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { ollama } from '../src/ai/ollama.js';
import { imageServer } from '../src/ai/image.js';

/**
 * Audit F-2: writing and pictures with the assistant, for every role by default and withdrawn like
 * any other permission. Both run inside the installation; a picture is filed as a document through
 * the same checks as an upload, with where it came from.
 */

// The smallest PNG there is: one transparent pixel.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let server: http.Server;
let imageAnswer: () => { status: number; body: unknown } = () => ({ status: 200, body: { data: [{ b64_json: PIXEL.toString('base64') }] } });
const asked: { url: string; body: any }[] = [];

async function stream(token: string, payload: unknown) {
  const a = await app();
  const res = await a.inject({ method: 'POST', url: '/api/v1/ai/write', headers: { authorization: `Bearer ${token}` }, payload: payload as object });
  const events = res.body.split('\n\n').filter(Boolean).map((block) => ({
    event: /^event: (\w+)/m.exec(block)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null'),
  }));
  return { status: res.statusCode, events, text: events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('') };
}

describe('Writing and pictures with the assistant (audit F-2)', () => {
  let sales: string, account: string, admin: string;
  const saved = { ollama: { ...ollama }, image: { ...imageServer }, mode: env.IMAGE_MODE };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        asked.push({ url: req.url ?? '', body: body ? JSON.parse(body) : null });
        if (req.url === '/api/chat') {
          res.setHeader('content-type', 'application/x-ndjson');
          res.end([{ message: { content: '<think>…</think>' } }, { message: { content: 'بریف کمپین: ' } }, { message: { content: 'هدف [ ]' } }, { done: true, prompt_eval_count: 40, eval_count: 9 }].map((l) => JSON.stringify(l)).join('\n') + '\n');
          return;
        }
        if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'stablediffusion' }] })); return; }
        if (req.url === '/v1/images/generations') { const a = imageAnswer(); res.statusCode = a.status; res.end(JSON.stringify(a.body)); return; }
        res.statusCode = 404; res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    Object.assign(ollama, { url, model: 'qwen3:8b' });
    Object.assign(imageServer, { url, model: 'stablediffusion' });
    (env as { IMAGE_MODE: string }).IMAGE_MODE = 'local';
    [sales, account, admin] = await Promise.all(['sales@hiva.local', 'account.manager@hiva.local', 'admin@hiva.local'].map((e) => login(e)));
  });
  afterAll(async () => {
    Object.assign(ollama, saved.ollama); Object.assign(imageServer, saved.image);
    (env as { IMAGE_MODE: string }).IMAGE_MODE = saved.mode;
    server.close(); await closeApp();
  });

  it('is every role’s by default', () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      expect(perms, role).toEqual(expect.arrayContaining(['ai.write', 'ai.image']));
    }
  });

  it('writes from what the person gives it — no tools, no records — and hides the model’s thinking', async () => {
    asked.length = 0;
    const r = await stream(sales, { kind: 'brief', instruction: 'بریف کمپین معرفی محصول برای جوانان', locale: 'fa' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('بریف کمپین: هدف [ ]');
    expect(r.events.at(-1)?.event).toBe('done');
    const sent = asked.find((a) => a.url === '/api/chat')!.body;
    expect(sent.tools).toEqual([]);
    expect(sent.messages[0].content).toContain('بریف');
    // The log keeps that it was done, not what was said.
    const log = await prisma.aiInteraction.findFirst({ where: { capability: 'WRITE' }, orderBy: { createdAt: 'desc' } });
    expect(log).toMatchObject({ promptSummary: 'write — brief', succeeded: true, tokensOut: 9 });
  });

  it('rewrites what is already in the field, in the language asked', async () => {
    asked.length = 0;
    await stream(sales, { kind: 'email', instruction: 'more formal', text: 'hey, the files are late', locale: 'en' });
    const sent = asked.find((a) => a.url === '/api/chat')!.body;
    expect(sent.messages[1].content).toContain('hey, the files are late');
    expect(sent.messages[0].content).toMatch(/^You write/);
  });

  it('draws a picture and files it with the project, saying where it came from — in the document and the audit trail', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { organizationId: (await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } })).organizationId } });
    const r = await post('/ai/image', account, { prompt: 'a red bicycle on a Tehran street at dusk', size: '512x512', projectId: project.id });
    const doc = expectOk(r, 'image');
    expect(doc).toMatchObject({ projectId: project.id, mimeType: 'image/png', tags: expect.arrayContaining(['ai-generated']) });
    expect(doc.metadata.generated).toMatchObject({ prompt: 'a red bicycle on a Tehran street at dusk', model: 'stablediffusion', size: '512x512' });
    expect(await prisma.auditEvent.count({ where: { entityType: 'document', entityId: doc.id, action: 'GENERATE' } })).toBe(1);
    expect(asked.find((a) => a.url === '/v1/images/generations')?.body).toMatchObject({ model: 'stablediffusion', size: '512x512', response_format: 'b64_json' });
  });

  it('keeps nothing the image server sends that is not a picture', async () => {
    imageAnswer = () => ({ status: 200, body: { data: [{ b64_json: Buffer.from('<html>not a png</html>').toString('base64') }] } });
    const before = await prisma.document.count();
    const r = await post('/ai/image', account, { prompt: 'anything at all', size: '512x512' });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('IMAGE_FAILED');
    expect(await prisma.document.count()).toBe(before);
    imageAnswer = () => ({ status: 200, body: { data: [{ b64_json: PIXEL.toString('base64') }] } });
  });

  it('files a picture only where the person may: another organisation’s project is not found', async () => {
    const mine = (await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } })).organizationId;
    const elsewhere = await prisma.project.findFirst({ where: { organizationId: { not: mine } } });
    if (!elsewhere) return;
    const r = await post('/ai/image', account, { prompt: 'a poster', size: '512x512', projectId: elsewhere.id });
    expect([404, 400]).toContain(r.status);
  });

  it('is gone for a role the administrator takes it from, and is off where no image server is set up', async () => {
    const without = ROLE_PERMISSIONS.SALES_REP.filter((p) => p !== 'ai.write' && p !== 'ai.image');
    expectOk(await put('/roles/SALES_REP/permissions', admin, { permissions: without }), 'withdraw');
    const fresh = await login('sales@hiva.local');
    expect((await stream(fresh, { kind: 'other', instruction: 'x', locale: 'fa' })).status).toBe(403);
    expect((await get('/ai/image/status', fresh)).status).toBe(403);
    expectOk(await put('/roles/SALES_REP/permissions', admin, { permissions: ROLE_PERMISSIONS.SALES_REP }), 'restore');

    (env as { IMAGE_MODE: string }).IMAGE_MODE = 'off';
    expect(expectOk(await get('/ai/image/status', account), 'status')).toMatchObject({ mode: 'off', ready: false });
    expect((await post('/ai/image', account, { prompt: 'a poster', size: '512x512' })).status).toBe(503);
    (env as { IMAGE_MODE: string }).IMAGE_MODE = 'local';
  });
});
