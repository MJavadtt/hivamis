import type { FastifyPluginAsync } from 'fastify';
import { ALL_PERMISSIONS, createApiKeySchema, createWebhookSchema, PERMISSIONS, updateWebhookSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { generateKey, grantable } from '../integrations/keys.js';
import { assertWebhookUrl, attempt, eventCatalog, newWebhookSecret, validateEvents } from '../integrations/webhooks.js';

const mask = (s: string) => `${s.slice(0, 10)}…`;

/**
 * Integrations (roadmap #46): API keys and webhooks. Managed only from a person's session — the
 * auth plugin refuses these paths to a key, so a leaked key cannot mint more keys or redirect
 * events.
 */
const integrationRoutes: FastifyPluginAsync = async (app) => {
  /** What the asker holds in their own right — not through a delegation — less what no key may carry. */
  const ownGrantable = (actor: ReturnType<typeof actorFrom>) =>
    grantable(actor.permissions.filter((p) => !actor.delegated[p]));

  /* ── Keys ─────────────────────────────────────────────────────────────── */

  app.get('/admin/api-keys', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req) => {
    const actor = actorFrom(req);
    const keys = await prisma.apiKey.findMany({
      where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, prefix: true, permissions: true, rateLimitPerMinute: true, expiresAt: true, lastUsedAt: true, lastUsedIp: true,
        revokedAt: true, revokeReason: true, createdAt: true, createdBy: { select: { id: true, fullName: true, isActive: true } },
      },
    });
    const now = new Date();
    return keys.map((k) => ({
      ...k, display: `hiva_${k.prefix}_…`,
      status: k.revokedAt ? 'REVOKED' : k.expiresAt && k.expiresAt <= now ? 'EXPIRED' : !k.createdBy.isActive ? 'OWNER_INACTIVE' : 'ACTIVE',
    }));
  });

  /** The permissions this person could give a key, labelled. */
  app.get('/admin/api-keys/grantable', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req) => {
    const actor = actorFrom(req);
    return ownGrantable(actor).map((code) => ({ code, labelFa: (PERMISSIONS as Record<string, string>)[code] ?? code }));
  });

  app.post('/admin/api-keys', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createApiKeySchema, req.body);
    const unknown = input.permissions.filter((p) => !(ALL_PERMISSIONS as readonly string[]).includes(p));
    if (unknown.length) throw badRequest('UNKNOWN_PERMISSION', `دسترسی ناشناخته: ${unknown.join('، ')}`);
    const own = ownGrantable(actor);
    const beyond = input.permissions.filter((p) => !own.includes(p));
    if (beyond.length) {
      throw new AppError(422, 'KEY_PERMISSION_NOT_GRANTABLE', 'کلید نمی‌تواند دسترسی‌ای داشته باشد که شما به نام خود ندارید، یا دسترسی مدیریت کاربران، نقش‌ها، کلیدها و استثناها.', {
        permissions: beyond.map((p) => ({ code: p, labelFa: (PERMISSIONS as Record<string, string>)[p] ?? p })),
      });
    }
    if (input.expiresAt && input.expiresAt <= new Date()) throw badRequest('EXPIRY_IN_PAST', 'تاریخ انقضا گذشته است');
    const { key, prefix, secretHash } = generateKey();
    const created = await prisma.apiKey.create({
      data: {
        organizationId: actor.organizationId, name: input.name, prefix, secretHash, permissions: [...new Set(input.permissions)],
        rateLimitPerMinute: input.rateLimitPerMinute, expiresAt: input.expiresAt ?? null, createdById: actor.id,
      },
      select: { id: true, name: true, prefix: true, permissions: true, rateLimitPerMinute: true, expiresAt: true, createdAt: true },
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'apiKey', entityId: created.id, after: created, ipAddress: actor.ipAddress, requestId: actor.requestId });
    // The only time the key exists outside the caller's hands.
    return reply.code(201).send({ ...created, key });
  });

  app.post('/admin/api-keys/:id/revoke', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason || reason.trim().length < 3) throw badRequest('REASON_REQUIRED', 'دلیل ابطال کلید را بنویسید');
    const key = await prisma.apiKey.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!key) throw notFound('کلید');
    if (key.revokedAt) return { ok: true, alreadyRevoked: true };
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date(), revokedById: actor.id, revokeReason: reason.trim() } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'REVOKE', entityType: 'apiKey', entityId: id, reason: reason.trim(), ipAddress: actor.ipAddress, requestId: actor.requestId });
    return { ok: true };
  });

  /* ── Webhooks ─────────────────────────────────────────────────────────── */

  app.get('/admin/webhooks/events', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req) => {
    const actor = actorFrom(req);
    return eventCatalog().map((e) => ({ ...e, allowed: !e.readPermission || actor.permissions.includes(e.readPermission) }));
  });

  app.get('/admin/webhooks', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req) => {
    const actor = actorFrom(req);
    const subs = await prisma.webhookSubscription.findMany({
      where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { fullName: true } } },
    });
    const counts = await prisma.webhookDelivery.groupBy({ by: ['subscriptionId', 'status'], where: { organizationId: actor.organizationId }, _count: { _all: true } });
    return subs.map(({ secret, ...s }) => ({
      ...s, secret: mask(secret),
      deliveries: Object.fromEntries(counts.filter((c) => c.subscriptionId === s.id).map((c) => [c.status, c._count._all])),
    }));
  });

  app.post('/admin/webhooks', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createWebhookSchema, req.body);
    assertWebhookUrl(input.url);
    const problems = validateEvents(input.events, actor.permissions.filter((p) => !actor.delegated[p]));
    if (problems.length) throw new AppError(422, 'WEBHOOK_EVENTS_INVALID', 'برخی رویدادها پذیرفته نیست', { problems });
    const secret = newWebhookSecret();
    const created = await prisma.webhookSubscription.create({
      data: { organizationId: actor.organizationId, name: input.name, url: input.url, secret, events: [...new Set(input.events)], createdById: actor.id },
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'webhookSubscription', entityId: created.id, after: { ...created, secret: '[redacted]' }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return reply.code(201).send(created);           // the secret, once
  });

  app.patch('/admin/webhooks/:id', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(updateWebhookSchema, req.body);
    const before = await prisma.webhookSubscription.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!before) throw notFound('Webhook');
    if (input.url) assertWebhookUrl(input.url);
    if (input.events) {
      const problems = validateEvents(input.events, actor.permissions.filter((p) => !actor.delegated[p]));
      if (problems.length) throw new AppError(422, 'WEBHOOK_EVENTS_INVALID', 'برخی رویدادها پذیرفته نیست', { problems });
    }
    const reactivating = input.active === true && !before.active;
    const updated = await prisma.webhookSubscription.update({
      where: { id },
      data: {
        ...input,
        // Re-enabled after a failure: it starts again from now, not with a backlog of stale events.
        ...(reactivating ? { consecutiveFailures: 0, disabledAt: null, disabledReason: null, cursorAt: new Date(), cursorId: null } : {}),
      },
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'webhookSubscription', entityId: id, before: { ...before, secret: '[redacted]' }, after: { ...updated, secret: '[redacted]' }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    const { secret, ...rest } = updated;
    return { ...rest, secret: mask(secret) };
  });

  /** A ping, sent now: does the receiver answer, and does it verify the signature? */
  app.post('/admin/webhooks/:id/test', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const sub = await prisma.webhookSubscription.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!sub) throw notFound('Webhook');
    const d = await prisma.webhookDelivery.create({
      data: { organizationId: actor.organizationId, subscriptionId: id, event: 'ping', payload: { event: 'ping', occurredAt: new Date().toISOString(), data: { webhook: sub.name } } },
    });
    return attempt(d.id);
  });

  app.get('/admin/webhooks/:id/deliveries', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    return prisma.webhookDelivery.findMany({ where: { subscriptionId: id, organizationId: actor.organizationId }, orderBy: { createdAt: 'desc' }, take: 50 });
  });

  app.post('/admin/webhooks/deliveries/:id/redeliver', { preHandler: [app.authenticate, app.requirePermissions('admin.keys')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const d = await prisma.webhookDelivery.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!d) throw notFound('تحویل');
    await prisma.webhookDelivery.update({ where: { id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date() } });
    return attempt(id);
  });
};

export default integrationRoutes;
