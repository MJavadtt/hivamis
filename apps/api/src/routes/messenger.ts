import type { FastifyPluginAsync } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { AppError, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { configuredProvider, messengerMode, sandboxProvider } from '../messenger/provider.js';
import { handleUpdate, sandboxChat, startLink, status, unlink, type Update } from '../messenger/service.js';
import { pollingStatus } from '../messenger/polling.js';

const sandboxSendSchema = z.object({ text: z.string().trim().min(1).max(2000) });
const sandboxPressSchema = z.object({ action: z.string().regex(/^[\w-]{6,40}$/) });
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The messenger (roadmap #40): link a chat, the sandbox chat, the bot's webhook, and its status. */
const messengerRoutes: FastifyPluginAsync = async (app) => {
  const signedIn = { preHandler: [app.authenticate] };

  app.get('/messenger/me', signedIn, async (req) => status(actorFrom(req).id));
  app.post('/messenger/link', signedIn, async (req) => startLink(actorFrom(req)));
  app.delete('/messenger/link', signedIn, async (req) => unlink(actorFrom(req)));

  /* ── the sandbox: each person drives only their own chat ── */
  const sandboxOnly = () => { if (messengerMode() !== 'sandbox') throw notFound('گفت‌وگوی آزمایشی'); };

  app.get('/messenger/sandbox/chat', signedIn, async (req) => {
    sandboxOnly();
    const me = actorFrom(req);
    const rows = await prisma.messengerMessage.findMany({ where: { provider: 'sandbox', chatId: sandboxChat(me.id) }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.reverse().map((m) => ({ id: m.id, direction: m.direction, text: m.text, buttons: m.buttons, at: m.createdAt }));
  });

  app.post('/messenger/sandbox/send', signedIn, async (req) => {
    sandboxOnly();
    const me = actorFrom(req);
    const { text } = parse(sandboxSendSchema, req.body);
    return handleUpdate(sandboxProvider, { message: { chat: { id: sandboxChat(me.id) }, text } }, me);
  });

  app.post('/messenger/sandbox/press', signedIn, async (req) => {
    sandboxOnly();
    const me = actorFrom(req);
    const { action } = parse(sandboxPressSchema, req.body);
    return handleUpdate(sandboxProvider, { callback_query: { id: randomBytes(6).toString('hex'), data: `a:${action}`, message: { chat: { id: sandboxChat(me.id) } } } }, me);
  });

  /* ── the bot's webhook: a secret in the path, and the Bot API's secret header when it sends one ── */
  app.post('/messenger/webhook/:secret', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = configuredProvider();
    const { secret } = req.params as { secret: string };
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (!p || p.name === 'sandbox' || !env.MESSENGER_WEBHOOK_SECRET || !same(secret, env.MESSENGER_WEBHOOK_SECRET)
      || (typeof header === 'string' && !same(header, env.MESSENGER_WEBHOOK_SECRET))) {
      return reply.code(404).send();
    }
    // The bot API retries anything but 200: a failure here is logged, not bounced back.
    await handleUpdate(p, req.body as Update).catch((e) => req.log.warn({ err: e }, 'messenger update failed'));
    return { ok: true };
  });

  /* ── administration ── */
  app.get('/admin/messenger', { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] }, async (req) => {
    const actor = actorFrom(req);
    const since = new Date(Date.now() - 86_400_000);
    const [linked, sent, failed, queued] = await Promise.all([
      prisma.messengerLink.count({ where: { organizationId: actor.organizationId, provider: messengerMode() } }),
      prisma.messengerMessage.count({ where: { organizationId: actor.organizationId, direction: 'OUT', status: 'SENT', createdAt: { gt: since } } }),
      prisma.messengerMessage.count({ where: { organizationId: actor.organizationId, direction: 'OUT', status: 'FAILED', createdAt: { gt: since } } }),
      prisma.messengerMessage.count({ where: { organizationId: actor.organizationId, direction: 'OUT', status: 'QUEUED' } }),
    ]);
    const mode = messengerMode();
    const polling = mode === 'bale' || mode === 'telegram' ? await pollingStatus(mode) : null;
    return { mode, configured: !!configuredProvider(), bot: env.MESSENGER_BOT_USERNAME || null, webhookSecretSet: !!env.MESSENGER_WEBHOOK_SECRET, transport: env.MESSENGER_TRANSPORT, polling, linked, last24h: { sent, failed }, queued };
  });

  app.post('/admin/messenger/webhook', { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] }, async (req) => {
    const actor = actorFrom(req);
    const p = configuredProvider();
    if (env.MESSENGER_TRANSPORT === 'polling') throw new AppError(422, 'MESSENGER_POLLING', 'این نصب پیام‌های ربات را خودش می‌گیرد (polling)؛ وب‌هوک لازم نیست و با آن ناسازگار است.');
    if (!p?.setWebhook || !env.MESSENGER_WEBHOOK_SECRET) throw new AppError(422, 'MESSENGER_NOT_CONFIGURED', 'ربات پیام‌رسان یا رمز وب‌هوک آن تنظیم نشده است.');
    const base = (env.PUBLIC_APP_URL || env.CORS_ORIGIN.split(',')[0]!.trim()).replace(/\/+$/, '');
    await p.setWebhook(`${base}/api/v1/messenger/webhook/${env.MESSENGER_WEBHOOK_SECRET}`, env.MESSENGER_WEBHOOK_SECRET);
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'MESSENGER_WEBHOOK_SET', entityType: 'organization', entityId: actor.organizationId, after: { provider: p.name } });
    return { ok: true };
  });
};

export default messengerRoutes;
