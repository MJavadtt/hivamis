import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeApp, get, login, move, patch, post, expectOk, directLead } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { KEY_PATTERN } from '../src/integrations/keys.js';
import {
  checkWebhookUrl, dispatchWebhooks, guardedLookup, isPrivateAddress, MAX_ATTEMPTS, sendDue, sign, validateEvents,
} from '../src/integrations/webhooks.js';

let T: Record<string, string>;
beforeAll(async () => {
  T = { admin: await login('admin@hiva.local'), ceo: await login('ceo@hiva.local'), sales: await login('sales@hiva.local') };
});
afterAll(async () => { await closeApp(); });

const makeKey = async (token: string, body: Record<string, unknown>) =>
  expectOk(await post('/admin/api-keys', token, { name: 'یکپارچه‌سازی آزمون', ...body }), 'key');

describe('API keys: a system acting with a narrowed, revocable authority', () => {
  it('shows the key once, keeps only its hash, and lists it without it', async () => {
    const k = await makeKey(T.admin, { permissions: ['project.read', 'task.read'] });
    expect(k.key).toMatch(KEY_PATTERN);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } });
    expect(row.secretHash).not.toContain(k.key.slice(16));
    const list = expectOk(await get('/admin/api-keys', T.admin), 'list');
    const listed = list.find((x: any) => x.id === k.id);
    expect(listed).toMatchObject({ status: 'ACTIVE', display: `hiva_${k.prefix}_…` });
    expect(JSON.stringify(list)).not.toContain(k.key);
    expect(listed.secretHash).toBeUndefined();
  });

  it('does what its permissions allow, is refused the rest, and every refusal names the key', async () => {
    const k = await makeKey(T.admin, { permissions: ['project.read'] });
    expect((await get('/projects', k.key)).status).toBe(200);
    expect((await get('/reports/executive', k.key)).status).toBe(403);
    const denied = await prisma.auditEvent.findFirst({ where: { action: 'PERMISSION_DENIED', apiKeyId: k.id } });
    expect(denied?.actorId).toBe((await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' } })).id);
    // A write through a key is the creator's act, recorded as the key's.
    const writer = await makeKey(T.admin, { permissions: ['project.read', 'meeting.write'] });
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const m = expectOk(await post('/meetings', writer.key, { projectId: project.id, kind: 'INTERNAL', subject: 'همگام‌سازی سامانهٔ بیرونی', heldAt: new Date().toISOString(), attendees: 'سامانه' }), 'meeting via key');
    const created = await prisma.auditEvent.findFirst({ where: { entityType: 'meeting', entityId: m.id, action: 'CREATE' } });
    expect(created?.apiKeyId).toBe(writer.id);
  });

  it('never outgrows its creator, and never carries the powers that would let it multiply', async () => {
    const beyond = await post('/admin/api-keys', T.ceo, { name: 'بیش از اختیار', permissions: ['project.read', 'admin.users'] });
    expect(beyond.body.error.code).toBe('KEY_PERMISSION_NOT_GRANTABLE');               // the CEO does not hold admin.users
    const waive = await post('/admin/api-keys', T.ceo, { name: 'استثنا', permissions: ['governance.waive'] });
    expect(waive.body.error.code).toBe('KEY_PERMISSION_NOT_GRANTABLE');                 // held, but no key may carry it
    const grantable = expectOk(await get('/admin/api-keys/grantable', T.ceo), 'grantable').map((g: any) => g.code);
    expect(grantable).not.toContain('admin.keys');
    expect(grantable).toContain('project.read');
  });

  it('keeps out of the creator’s own account, delegations and key management', async () => {
    const k = await makeKey(T.admin, { permissions: ['project.read', 'admin.audit'] });
    for (const path of ['/auth/me', '/delegations', '/admin/api-keys', '/admin/webhooks']) {
      expect((await get(path, k.key)).status, path).toBe(403);
    }
    // Each attempt is a counted refusal, naming the key.
    expect(await prisma.auditEvent.count({ where: { apiKeyId: k.id, action: 'PERMISSION_DENIED', reason: { startsWith: 'human-only' } } })).toBe(4);
  });

  it('keeps its own rate, and stops when revoked, expired, or its creator is gone', async () => {
    const slow = await makeKey(T.admin, { permissions: ['project.read'], rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await get('/projects', slow.key)).status).toBe(200);
    const limited = await get('/projects', slow.key);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('API_KEY_RATE_LIMITED');

    const k = await makeKey(T.admin, { permissions: ['project.read'] });
    expect((await post(`/admin/api-keys/${k.id}/revoke`, T.admin, {})).body.error.code).toBe('REASON_REQUIRED');
    expectOk(await post(`/admin/api-keys/${k.id}/revoke`, T.admin, { reason: 'پیمانکار یکپارچه‌سازی عوض شد' }), 'revoke');
    expect((await get('/projects', k.key)).status).toBe(401);

    const e = await makeKey(T.admin, { permissions: ['project.read'] });
    await prisma.apiKey.update({ where: { id: e.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await get('/projects', e.key)).status).toBe(401);

    const c = await makeKey(T.ceo, { permissions: ['project.read'] });
    const ceo = await prisma.user.findFirstOrThrow({ where: { email: 'ceo@hiva.local' } });
    await prisma.user.update({ where: { id: ceo.id }, data: { isActive: false } });
    try { expect((await get('/projects', c.key)).status).toBe(401); }
    finally { await prisma.user.update({ where: { id: ceo.id }, data: { isActive: true } }); }
  });
});

describe('Webhooks: thin, signed events from the transition log', () => {
  it('refuses addresses on the internal network — when saved, and again after DNS', async () => {
    expect(checkWebhookUrl('http://example.com/hook', false).ok).toBe(false);          // https only
    expect(checkWebhookUrl('https://127.0.0.1/hook', false).ok).toBe(false);
    expect(checkWebhookUrl('https://10.1.2.3/hook', false).ok).toBe(false);
    expect(checkWebhookUrl('https://localhost/hook', false).ok).toBe(false);
    expect(checkWebhookUrl('https://ops:pw@example.com/hook', false).ok).toBe(false);
    expect(checkWebhookUrl('https://hooks.example.com/hiva', false).ok).toBe(true);
    for (const a of ['169.254.169.254', '::1', '::ffff:127.0.0.1', '192.168.1.3', 'fd00::1']) expect(isPrivateAddress(a), a).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => guardedLookup(false)('localhost', {}, (e: NodeJS.ErrnoException | null) => resolve(e)));
    expect(err?.code).toBe('EBLOCKED');
    expect(validateEvents(['invoice.*'], ['task.read'])[0]).toContain('فقط کسی که آن را می‌بیند');
    expect(validateEvents(['project.fly', 'nonsense.*'], ['project.read'])).toHaveLength(2);
  });

  describe('delivering', () => {
    const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    let status = 200;
    let server: http.Server;
    let url = '';
    const original = env.WEBHOOK_ALLOW_PRIVATE;
    beforeAll(async () => {
      env.WEBHOOK_ALLOW_PRIVATE = true;                  // the receiver below lives on 127.0.0.1
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { received.push({ headers: req.headers, body }); res.writeHead(status).end(status === 200 ? 'ok' : 'down'); });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    });
    afterAll(async () => { env.WEBHOOK_ALLOW_PRIVATE = original; await new Promise((r) => server.close(r)); });

    it('sends each matching transition once, signed, and never the record itself', async () => {
      const bad = await post('/admin/webhooks', T.admin, { name: 'نادرست', url, events: ['lead.fly'] });
      expect(bad.body.error.code).toBe('WEBHOOK_EVENTS_INVALID');
      const sub = expectOk(await post('/admin/webhooks', T.admin, { name: 'سامانهٔ CRM بیرونی', url, events: ['lead.contact'] }), 'webhook');
      expect(sub.secret).toMatch(/^whsec_/);
      const listed = expectOk(await get('/admin/webhooks', T.admin), 'list').find((w: any) => w.id === sub.id);
      expect(listed.secret).not.toBe(sub.secret);

      const lead = expectOk(await post('/leads', T.sales, { name: 'درخواست کمپین پاییز', companyName: 'شرکت نمونهٔ بیرونی', contactName: 'مخاطب محرمانه', ...directLead() }), 'lead');
      expectOk(await move('lead', lead.id, 'contact', T.sales), 'contact');

      const first = await dispatchWebhooks();
      expect(first.delivered).toBeGreaterThanOrEqual(1);
      const got = received.find((r) => JSON.parse(r.body).data?.entityId === lead.id)!;
      expect(got.headers['x-hiva-event']).toBe('lead.contact');
      const ts = Number(got.headers['x-hiva-timestamp']);
      expect(got.headers['x-hiva-signature']).toBe(sign(sub.secret, ts, got.body));
      const payload = JSON.parse(got.body);
      expect(payload.data).toMatchObject({ entity: 'lead', code: lead.code, from: 'NEW', to: 'CONTACTED', action: 'contact' });
      expect(got.body).not.toContain('مخاطب محرمانه');                 // thin: the receiver asks, with a key, for more
      expect((await dispatchWebhooks()).enqueued).toBe(0);               // once
    });

    it('retries with backoff, gives up after the last attempt, and disables a receiver that keeps failing', async () => {
      status = 500;
      const sub = expectOk(await post('/admin/webhooks', T.admin, { name: 'گیرندهٔ از کار افتاده', url, events: ['lead.*'] }), 'webhook');
      const lead = expectOk(await post('/leads', T.sales, { name: 'سرنخ دوم', companyName: 'شرکت دوم', ...directLead() }), 'lead');
      expectOk(await move('lead', lead.id, 'contact', T.sales), 'contact');
      await dispatchWebhooks();
      let d = await prisma.webhookDelivery.findFirstOrThrow({ where: { subscriptionId: sub.id } });
      expect(d).toMatchObject({ status: 'PENDING', attempts: 1, lastStatusCode: 500 });
      expect(d.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(50_000);          // a minute later
      let clock = Date.now();
      for (let i = 1; i < MAX_ATTEMPTS; i++) { clock += 13 * 3_600_000; await sendDue(new Date(clock)); }
      d = await prisma.webhookDelivery.findFirstOrThrow({ where: { id: d.id } });
      expect(d).toMatchObject({ status: 'DEAD', attempts: MAX_ATTEMPTS });

      await prisma.webhookSubscription.update({ where: { id: sub.id }, data: { consecutiveFailures: 19 } });
      expectOk(await post(`/admin/webhooks/deliveries/${d.id}/redeliver`, T.admin, {}), 'redeliver');
      const off = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(off.active).toBe(false);
      expect(off.disabledReason).toContain('۲۰ تحویل ناموفق پیاپی');
      expect(await prisma.notification.count({ where: { kind: 'WEBHOOK_DISABLED', entityId: sub.id } })).toBe(1);

      status = 200;
      expectOk(await patch(`/admin/webhooks/${sub.id}`, T.admin, { active: true }), 'reactivate');
      const ping = expectOk(await post(`/admin/webhooks/${sub.id}/test`, T.admin, {}), 'ping');
      expect(ping.ok).toBe(true);
    });
  });
});
