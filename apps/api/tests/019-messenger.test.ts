import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { app, call, closeApp, get, login, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { botApiProvider, keyboard } from '../src/messenger/provider.js';
import { handleUpdate, sandboxChat } from '../src/messenger/service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('The Bot API adapter', () => {
  it('speaks the Telegram-compatible shape — inline buttons, edits, callback answers — and never repeats the token', async () => {
    const seen: { url: string; body: any }[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init!.body)) });
      if (String(input).endsWith('/editMessageText')) return Response.json({ ok: false, description: 'message is not modified' }, { status: 400 });
      return Response.json({ ok: true, result: { message_id: 77 } });
    }) as typeof fetch;
    const bot = botApiProvider({ name: 'bale', token: 'SECRET-TOKEN', fetchImpl: fake });
    expect(await bot.send('42', 'سلام', [[{ text: 'تأیید', action: 'tok1' }], [{ text: 'باز کردن', url: 'https://hiva.example/x' }]])).toEqual({ messageId: '77' });
    expect(seen[0]).toEqual({
      url: 'https://tapi.bale.ai/botSECRET-TOKEN/sendMessage',
      body: { chat_id: '42', text: 'سلام', reply_markup: { inline_keyboard: [[{ text: 'تأیید', callback_data: 'a:tok1' }], [{ text: 'باز کردن', url: 'https://hiva.example/x' }]] } },
    });
    await bot.answerCallback('cb1', 'انجام شد');
    expect(seen.at(-1)!.body).toEqual({ callback_query_id: 'cb1', text: 'انجام شد' });
    const err = await bot.edit('42', '77', 'x').catch((e: Error) => e.message);
    expect(err).toBe('editMessageText: message is not modified');
    expect(err).not.toContain('SECRET-TOKEN');
    expect(keyboard(undefined)).toBeUndefined();
  });
});

describe('Approving from the messenger', () => {
  let T: Record<string, string>;
  let managerId: string, salesId: string;
  const original = env.MESSENGER_MODE;
  const chat = (id: string) => ({ chat: { id } });

  beforeAll(async () => {
    env.MESSENGER_MODE = 'sandbox';
    T = { manager: await login('sales.manager@hiva.local'), sales: await login('sales@hiva.local'), designer: await login('designer@hiva.local') };
    managerId = (await prisma.user.findFirstOrThrow({ where: { email: 'sales.manager@hiva.local' } })).id;
    salesId = (await prisma.user.findFirstOrThrow({ where: { email: 'sales@hiva.local' } })).id;
  });
  afterAll(async () => { env.MESSENGER_MODE = original; await closeApp(); });

  const sandboxMessages = async (token: string) => expectOk(await get('/messenger/sandbox/chat', token), 'chat') as { direction: string; text: string; buttons: any }[];
  const lastButtons = async (token: string) => {
    for (let i = 0; i < 40; i++) {
      const out = (await sandboxMessages(token)).filter((m) => m.direction === 'OUT' && m.buttons?.[0]?.[0]?.action);
      if (out.length) return out.at(-1)!;
      await sleep(50);
    }
    throw new Error('no message with buttons');
  };

  it('links a chat only with the code its owner asked for, once', async () => {
    const link = expectOk(await post('/messenger/link', T.manager), 'link');
    expect(link.code).toMatch(/^HV-[A-Z2-9]{6}$/);
    // In the sandbox, the chat is the signed-in person's own.
    expect(expectOk(await post('/messenger/sandbox/send', T.manager, { text: `/start ${link.code}` }), 'send').reply).toContain('اتصال برقرار شد');
    expect(expectOk(await get('/messenger/me', T.manager), 'me')).toMatchObject({ mode: 'sandbox', linked: true, link: { chatId: sandboxChat(managerId) } });
    // The same code, from another chat: refused.
    expect(expectOk(await post('/messenger/sandbox/send', T.designer, { text: link.code }), 'reuse').reply).toContain('معتبر نیست');
    expect(await prisma.auditEvent.count({ where: { action: 'MESSENGER_LINKED', actorId: managerId } })).toBe(1);
  });

  it('brings an approval request with «تأیید / رد / باز کردن», and approving goes through decideForm as that person', async () => {
    const s = expectOk(await post('/forms/submissions', T.sales, { formCode: 'A01_LEAD', data: { name: 'سرنخ پیام‌رسان', companyName: 'شرکت پیام‌رسان', source: 'REFERRAL' } }), 'submit');
    const m = await lastButtons(T.manager);
    expect(m.text).toContain('فرم در انتظار تأیید');
    expect(m.buttons[0].map((b: any) => b.text)).toEqual(['تأیید', 'رد']);
    expect(m.buttons[1][0]).toMatchObject({ text: 'باز کردن در سیستم', url: expect.stringContaining(`/forms?submission=${s.id}`) });

    // Someone else's chat pressing the manager's button: refused.
    expect(expectOk(await post('/messenger/sandbox/press', T.designer, { action: m.buttons[0][0].action }), 'foreign').answer).toBe('این دکمه برای شما نیست.');

    const pressed = expectOk(await post('/messenger/sandbox/press', T.manager, { action: m.buttons[0][0].action }), 'approve');
    expect(pressed.answer).toBe('✅ تأیید شد.');
    const form = await prisma.formSubmission.findUniqueOrThrow({ where: { id: s.id } });
    expect(form.state).toBe('APPROVED');
    const approval = await prisma.formApproval.findFirstOrThrow({ where: { submissionId: s.id } });
    expect(approval).toMatchObject({ approverId: managerId, decision: 'APPROVE' });
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: s.id, action: 'APPROVE' } });
    expect(row).toMatchObject({ actorId: managerId, userAgent: 'messenger:sandbox' });
    // Once: both buttons are spent, and the message now says what happened.
    expect(expectOk(await post('/messenger/sandbox/press', T.manager, { action: m.buttons[0][1].action }), 'again').answer).toBe('این دکمه پیش‌تر به کار رفته است.');
    const edited = (await sandboxMessages(T.manager)).find((x) => x.text.includes('✅ تأیید شد. (از پیام‌رسان)'))!;
    expect(edited.buttons).toEqual([[{ text: 'باز کردن در سیستم', url: expect.stringContaining(s.id) }]]);
  });

  it('asks for the reason before rejecting, as the app does', async () => {
    const s = expectOk(await post('/forms/submissions', T.sales, { formCode: 'A01_LEAD', data: { name: 'سرنخ رد', companyName: 'شرکت رد', source: 'OUTBOUND' } }), 'submit');
    const m = await lastButtons(T.manager);
    expect(expectOk(await post('/messenger/sandbox/press', T.manager, { action: m.buttons[0][1].action }), 'reject').answer).toBe('دلیل رد را بنویسید.');
    expect((await prisma.formSubmission.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('PENDING_APPROVAL');
    expect(expectOk(await post('/messenger/sandbox/send', T.manager, { text: 'مشتری در فهرست سیاه است' }), 'reason').reply).toBe('⛔️ رد شد.');
    const form = await prisma.formSubmission.findUniqueOrThrow({ where: { id: s.id } });
    expect(form).toMatchObject({ state: 'REJECTED', returnReason: 'مشتری در فهرست سیاه است' });
  });

  it('keeps the engine’s rules: the submitter cannot approve their own form from the messenger either', async () => {
    const link = expectOk(await post('/messenger/link', T.sales), 'link');
    expectOk(await post('/messenger/sandbox/send', T.sales, { text: link.code }), 'linked');
    const s = expectOk(await post('/forms/submissions', T.sales, { formCode: 'A01_LEAD', data: { name: 'سرنخ خودتأیید', companyName: 'شرکت خود', source: 'EVENT' } }), 'submit');
    // An approval button addressed to the submitter — as if a rule had put them in the loop.
    const org = (await prisma.organization.findFirstOrThrow()).id;
    await prisma.messengerAction.createMany({ data: [
      { organizationId: org, userId: salesId, kind: 'FORM_DECISION', token: 'selfapprove1', expiresAt: new Date(Date.now() + 60_000), payload: { submissionId: s.id, decision: 'APPROVE', pair: 'selfreject01' }, chatId: sandboxChat(salesId) },
      { organizationId: org, userId: salesId, kind: 'FORM_DECISION', token: 'selfreject01', expiresAt: new Date(Date.now() + 60_000), payload: { submissionId: s.id, decision: 'REJECT', pair: 'selfapprove1' }, chatId: sandboxChat(salesId) },
    ] });
    const r = expectOk(await post('/messenger/sandbox/press', T.sales, { action: 'selfapprove1' }), 'self');
    expect(r.answer).toMatch(/^انجام نشد: /);
    expect((await prisma.formSubmission.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('PENDING_APPROVAL');
  });

  it('through a live bot: the webhook takes only its secret, and answers the button through the Bot API', async () => {
    env.MESSENGER_MODE = 'bale'; env.MESSENGER_BOT_TOKEN = 'T0KEN'; env.MESSENGER_WEBHOOK_SECRET = 'hook-secret-123';
    const calls: { method: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: String(input).split('/').pop()!, body: JSON.parse(String(init!.body)) });
      return Response.json({ ok: true, result: { message_id: calls.length } });
    }));
    try {
      const a = await app();
      const hook = (secret: string, update: object, header?: string) => a.inject({
        method: 'POST', url: `/api/v1/messenger/webhook/${secret}`, payload: update,
        headers: { 'content-type': 'application/json', ...(header ? { 'x-telegram-bot-api-secret-token': header } : {}) },
      });
      expect((await hook('wrong', { message: { ...chat('900'), text: 'hi' } })).statusCode).toBe(404);
      expect((await hook('hook-secret-123', { message: { ...chat('900'), text: 'hi' } }, 'bad')).statusCode).toBe(404);

      const code = expectOk(await post('/messenger/link', T.manager), 'link').code;
      expect((await hook('hook-secret-123', { message: { ...chat('900'), text: `/start ${code}`, from: { username: 'mgr' } } }, 'hook-secret-123')).statusCode).toBe(200);
      expect(await prisma.messengerLink.findUniqueOrThrow({ where: { userId: managerId } })).toMatchObject({ provider: 'bale', chatId: '900', username: 'mgr' });
      expect(calls.find((c) => c.method === 'sendMessage')!.body).toMatchObject({ chat_id: '900', text: expect.stringContaining('اتصال برقرار شد') });

      const s = expectOk(await post('/forms/submissions', T.sales, { formCode: 'A01_LEAD', data: { name: 'سرنخ بله', companyName: 'شرکت بله', source: 'REFERRAL' } }), 'submit');
      let sent: any;
      for (let i = 0; i < 40 && !sent; i++) { sent = calls.find((c) => c.method === 'sendMessage' && c.body.reply_markup); if (!sent) await sleep(50); }
      const approve = sent.body.reply_markup.inline_keyboard[0][0].callback_data;
      expect(approve).toMatch(/^a:[\w-]+$/);
      await hook('hook-secret-123', { callback_query: { id: 'cb-9', data: approve, message: { message_id: 1, ...chat('900') } } });
      expect(calls.find((c) => c.method === 'answerCallbackQuery')!.body).toEqual({ callback_query_id: 'cb-9', text: '✅ تأیید شد.' });
      expect(calls.some((c) => c.method === 'editMessageText')).toBe(true);
      expect((await prisma.formSubmission.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('APPROVED');
      expect((await prisma.auditEvent.findFirstOrThrow({ where: { entityId: s.id, action: 'APPROVE' } })).userAgent).toBe('messenger:bale');
    } finally {
      env.MESSENGER_MODE = 'sandbox'; env.MESSENGER_BOT_TOKEN = ''; env.MESSENGER_WEBHOOK_SECRET = '';
      vi.unstubAllGlobals();
    }
  });

  it('cannot be linked through an API key — a linked chat decides with the person’s whole authority', async () => {
    const admin = await login('admin@hiva.local');
    const key = expectOk(await post('/admin/api-keys', admin, { name: 'کلید آزمون پیام‌رسان', permissions: ['form.approve', 'form.read'] }), 'key').key;
    const r = await call('POST', '/messenger/link', { token: key });
    expect(r.status).toBe(403);
  });

  it('can be unlinked, after which its buttons no longer work', async () => {
    await prisma.messengerLink.update({ where: { userId: managerId }, data: { provider: 'sandbox', chatId: sandboxChat(managerId) } });
    expectOk(await call('DELETE', '/messenger/link', { token: T.manager }), 'unlink');
    expect(expectOk(await get('/messenger/me', T.manager), 'me').linked).toBe(false);
    const r = await handleUpdate((await import('../src/messenger/provider.js')).sandboxProvider, { callback_query: { id: 'x', data: 'a:whatever1', message: { chat: { id: sandboxChat(managerId) } } } });
    expect(r.answer).toBe('این دکمه برای شما نیست.');
  });
});
