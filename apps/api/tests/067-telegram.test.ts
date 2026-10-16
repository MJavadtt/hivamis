import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { call, closeApp, expectOk, get, login, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { botApiProvider, keyboard, type MessengerProvider } from '../src/messenger/provider.js';
import { handleUpdate, type Update } from '../src/messenger/service.js';
import { INIT_DATA_TTL_S, verifyInitData } from '../src/auth/telegram-webapp.js';
import { claimLease, pollOnce } from '../src/messenger/polling.js';

/**
 * Audit F-9, step 1: Telegram as a way in, and the one bot.
 *
 * A Telegram account is linked only by the code its owner asked for from a signed-in session and sent
 * to the bot from their own private chat — never by an email. The Mini App's signed launch data is
 * checked with the bot token from the environment, taken for an hour, not a day, and once. The bot
 * can read its updates by long polling, one reader at a time, where no webhook can reach the server.
 */

// A stand-in token for the test only; the real one lives in the environment and nowhere else.
const TOKEN = 'test-only:not-a-real-bot-token';
const now = () => Math.floor(Date.now() / 1000);

function sign(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
const launch = (telegramId: number, at = now(), token = TOKEN) => sign({
  auth_date: String(at), query_id: `AA${randomBytes(6).toString('hex')}`,
  user: JSON.stringify({ id: telegramId, first_name: 'Behrad', username: 'behrad_tg' }),
}, token);

describe('The Mini App’s launch data', () => {
  it('checks only when Telegram signed it, within the hour', () => {
    const good = verifyInitData(launch(5550001), TOKEN);
    expect(good).toMatchObject({ ok: true, telegramId: '5550001', username: 'behrad_tg' });
    // Signed with another bot's token, or changed after signing.
    expect(verifyInitData(launch(5550001, now(), 'another-bot'), TOKEN)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    const changed = new URLSearchParams(launch(5550001));
    changed.set('user', JSON.stringify({ id: 5550002, first_name: 'Behrad' }));
    expect(verifyInitData(changed.toString(), TOKEN)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    // Telegram would honour a day; an hour is enough to open the app.
    expect(verifyInitData(launch(5550001, now() - INIT_DATA_TTL_S - 5), TOKEN)).toEqual({ ok: false, reason: 'STALE' });
    expect(verifyInitData(launch(5550001, now() + 600), TOKEN)).toEqual({ ok: false, reason: 'STALE' });
    expect(verifyInitData('user=%7B%7D&auth_date=1', TOKEN)).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verifyInitData(`${launch(5550001)}&hash=${'0'.repeat(64)}`, TOKEN)).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('A malformed request', () => {
  afterAll(async () => { await closeApp(); });
  it('is the client’s to fix — 400, not a server fault', async () => {
    const token = await login('designer@hiva.local');
    const empty = await call('POST', '/messenger/link', { token, headers: { 'content-type': 'application/json' } });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('BAD_REQUEST');
    const broken = await call('POST', '/auth/telegram/webapp', { headers: { 'content-type': 'application/json' }, payload: '{"initData":' });
    expect(broken.status).toBe(400);
    const unknownType = await call('POST', '/auth/telegram/webapp', { headers: { 'content-type': 'application/x-unknown' }, payload: 'x' });
    expect(unknownType.status).toBe(415);
  });
});

describe('Telegram as a way in', () => {
  const saved = { mode: env.MESSENGER_MODE, token: env.MESSENGER_BOT_TOKEN, transport: env.MESSENGER_TRANSPORT, api: env.MESSENGER_API_URL, app: env.PUBLIC_APP_URL };
  const sent: { method: string; body: any }[] = [];
  let bot: MessengerProvider;
  let T: Record<string, string>;
  let designerId: string;

  beforeAll(async () => {
    env.MESSENGER_MODE = 'telegram';
    env.MESSENGER_BOT_TOKEN = TOKEN;
    bot = botApiProvider({
      name: 'telegram', token: TOKEN,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        sent.push({ method: String(input).split('/').at(-1)!, body: JSON.parse(String(init!.body)) });
        return Response.json({ ok: true, result: { message_id: sent.length } });
      }) as typeof fetch,
    });
    T = { designer: await login('designer@hiva.local'), sales: await login('sales@hiva.local'), admin: await login('admin@hiva.local') };
    designerId = (await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } })).id;
  });
  afterAll(async () => {
    env.MESSENGER_MODE = saved.mode; env.MESSENGER_BOT_TOKEN = saved.token; env.MESSENGER_TRANSPORT = saved.transport;
    env.MESSENGER_API_URL = saved.api; env.PUBLIC_APP_URL = saved.app;
    await closeApp();
  });

  const linkFrom = async (token: string, telegramId: number, type = 'private') => {
    const { code } = expectOk(await post('/messenger/link', token), 'link');
    const update: Update = { update_id: telegramId, message: { chat: { id: type === 'private' ? telegramId : -100123, type }, from: { id: telegramId, username: 'behrad_tg' }, text: `/start ${code}` } };
    return (await handleUpdate(bot, update)).reply ?? '';
  };
  const signInWith = (initData: string) => call('POST', '/auth/telegram/webapp', { payload: { initData } });

  it('links the Telegram account with the chat, by the code from a signed-in session, and records it', async () => {
    // A group chat is not a person: it can receive notifications, but signs nobody in.
    expect(await linkFrom(T.designer, 5550001, 'group')).toContain('اتصال برقرار شد');
    expect(await prisma.userIdentity.count({ where: { userId: designerId, provider: 'telegram' } })).toBe(0);

    expect(await linkFrom(T.designer, 5550001)).toContain('اتصال برقرار شد');
    const identity = await prisma.userIdentity.findUniqueOrThrow({ where: { provider_subject: { provider: 'telegram', subject: '5550001' } } });
    expect(identity.userId).toBe(designerId);
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'MESSENGER_LINKED', entityId: designerId }, orderBy: { createdAt: 'desc' } });
    expect(row.after).toMatchObject({ provider: 'telegram', signInIdentity: true });
    expect(expectOk(await get('/messenger/me', T.designer), 'status')).toMatchObject({ linked: true, miniAppSignIn: true });
    // The reply opens the Mini App, from a button only Telegram shows.
    const welcome = sent.filter((m) => m.method === 'sendMessage' && String(m.body.text).includes('اتصال برقرار شد')).at(-1)!;
    expect(welcome.body.reply_markup.inline_keyboard[0][0].web_app.url).toMatch(/\/tg$/);
    expect(keyboard([[{ text: 'x', webApp: 'https://h.example/tg' }]])).toEqual({ inline_keyboard: [[{ text: 'x', web_app: { url: 'https://h.example/tg' } }]] });

    // Someone else cannot take the same Telegram account with a code of their own.
    expect(await linkFrom(T.sales, 5550001)).toContain('به حساب دیگری در هیوامیس وصل است');
  });

  it('signs the linked person in once per launch, and nobody else at all', async () => {
    const data = launch(5550001);
    const first = await signInWith(data);
    expect(first.status).toBe(200);
    expect(first.body.user.email).toBe('designer@hiva.local');
    expect(String(first.headers['set-cookie'])).toContain('hiva_refresh=');
    const login = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'LOGIN', actorId: designerId }, orderBy: { createdAt: 'desc' } });
    expect(login.reason).toBe('telegram');

    // The same launch again is a copy: refused, and recorded as a failed try on the account.
    const again = await signInWith(data);
    expect(again.status).toBe(401);
    expect(again.body.error.message).toContain('پیش‌تر به کار رفته');
    expect(await prisma.auditEvent.count({ where: { action: 'LOGIN_FAILED', actorId: designerId, reason: 'telegram-replayed' } })).toBe(1);

    const stale = await signInWith(launch(5550001, now() - 2 * 3600));
    expect(stale.status).toBe(401);
    expect(stale.body.error.message).toContain('کهنه');
    expect((await signInWith(launch(5550001, now(), 'another-bot'))).status).toBe(401);

    // A Telegram account nobody linked gets how to link it, and nothing else.
    const stranger = await signInWith(launch(5559999));
    expect(stranger.status).toBe(401);
    expect(stranger.body.error.code).toBe('TELEGRAM_NOT_LINKED');
    expect(stranger.body.error.message).toContain('اتصال پیام‌رسان');
  });

  it('is off unless the installation runs the Telegram bot with its token', async () => {
    env.MESSENGER_BOT_TOKEN = '';
    expect((await signInWith(launch(5550001))).body.error.code).toBe('TELEGRAM_OFF');
    env.MESSENGER_BOT_TOKEN = TOKEN;
    env.MESSENGER_MODE = 'sandbox';
    expect((await signInWith(launch(5550001))).status).toBe(503);
    env.MESSENGER_MODE = 'telegram';
  });

  it('is shown among the ways in, is not counted as the last one, and goes with the chat', async () => {
    const profile = expectOk(await get('/me/profile', T.designer), 'profile');
    expect(profile.identities.map((i: { provider: string }) => i.provider)).toContain('telegram');

    expectOk(await call('DELETE', '/messenger/link', { token: T.designer }), 'unlink');
    expect(await prisma.userIdentity.count({ where: { userId: designerId, provider: 'telegram' } })).toBe(0);
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'MESSENGER_UNLINKED', entityId: designerId }, orderBy: { createdAt: 'desc' } });
    expect(row.after).toMatchObject({ signInIdentityRemoved: true });
    expect((await signInWith(launch(5550001))).body.error.code).toBe('TELEGRAM_NOT_LINKED');

    // Linked again, then removed from the profile: allowed even beside the password alone.
    await linkFrom(T.designer, 5550001);
    const id = (await prisma.userIdentity.findFirstOrThrow({ where: { userId: designerId, provider: 'telegram' } })).id;
    expectOk(await call('DELETE', `/me/identities/${id}`, { token: T.designer }), 'remove');
  });

  it('reads the bot’s updates by long polling, one reader at a time, from where it left off', async () => {
    const asked: number[] = [];
    const inbox: Update[] = [
      { update_id: 900, message: { chat: { id: 5557001, type: 'private' }, from: { id: 5557001 }, text: 'سلام' } },
      { update_id: 901, message: { chat: { id: 5557001, type: 'private' }, from: { id: 5557001 }, text: 'کمک' } },
    ];
    const poller: MessengerProvider = {
      ...bot,
      async getUpdates(offset) { asked.push(offset); return inbox.filter((u) => u.update_id! >= offset); },
      async deleteWebhook() {},
    };
    expect(await pollOnce(poller, 'host-a')).toBe(2);
    // Another process finds the lease held, and waits.
    expect(await pollOnce(poller, 'host-b')).toBe('NOT_HOLDER');
    let state = await prisma.messengerPollState.findUniqueOrThrow({ where: { provider: 'telegram' } });
    expect(state).toMatchObject({ holder: 'host-a', nextOffset: 902n, lastError: null });
    expect(state.lastPollAt).not.toBeNull();

    // The first falls silent; when its lease lapses the other takes over, from the same place.
    await prisma.messengerPollState.update({ where: { provider: 'telegram' }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    inbox.push({ update_id: 902, message: { chat: { id: 5557001, type: 'private' }, from: { id: 5557001 }, text: '/start' } });
    expect(await pollOnce(poller, 'host-b')).toBe(1);
    expect(asked).toEqual([0, 902]);
    expect(await claimLease('telegram', 'host-a')).toBeNull();
    state = await prisma.messengerPollState.findUniqueOrThrow({ where: { provider: 'telegram' } });
    expect(state).toMatchObject({ holder: 'host-b', nextOffset: 903n });
    // Each was answered, as the webhook would have answered it.
    expect(sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === '5557001')).toHaveLength(3);
  });

  it('sets the bot’s menu button to open the Mini App, only at an https address', async () => {
    const calls: { path: string; body: any }[] = [];
    const standIn = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { calls.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') }); res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"result":true}'); });
    });
    await new Promise<void>((r) => standIn.listen(0, '127.0.0.1', r));
    try {
      env.MESSENGER_API_URL = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`;
      env.PUBLIC_APP_URL = 'http://localhost:5173';
      expect((await post('/admin/messenger/menu-button', T.admin)).body.error.code).toBe('MINI_APP_NEEDS_HTTPS');
      env.PUBLIC_APP_URL = 'https://hivamis.example';
      expectOk(await post('/admin/messenger/menu-button', T.admin), 'menu');
      expect(calls.at(-1)!.path).toMatch(/\/setChatMenuButton$/);
      expect(calls.at(-1)!.body).toEqual({ menu_button: { type: 'web_app', text: 'هیوامیس', web_app: { url: 'https://hivamis.example/tg' } } });
      expect(await prisma.auditEvent.count({ where: { action: 'MESSENGER_MENU_SET' } })).toBe(1);
      expect((await post('/admin/messenger/menu-button', T.designer)).status).toBe(403);
    } finally {
      standIn.close();
      env.MESSENGER_API_URL = saved.api; env.PUBLIC_APP_URL = saved.app;
    }
  });

  it('tells the administrator how the bot listens, and refuses a webhook while it polls', async () => {
    env.MESSENGER_TRANSPORT = 'polling';
    const status = expectOk(await get('/admin/messenger', T.admin), 'admin');
    expect(status).toMatchObject({ transport: 'polling', polling: { transport: 'polling', stalled: false } });
    const refused = await post('/admin/messenger/webhook', T.admin);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('MESSENGER_POLLING');
  });
});
