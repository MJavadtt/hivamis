import type { FastifyPluginAsync } from 'fastify';
import { pushSubscribeSchema, pushUnsubscribeSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { checkEndpoint, checkKeys, sendTest, subscribe, vapidKeys } from '../push/service.js';

/**
 * Web Push (roadmap #49): each person's own browsers. Everything here is about the signed-in
 * person's devices only — nobody subscribes, lists or removes anyone else's.
 */
/**
 * The push service a subscription names. Every endpoint the API takes is checked first, but one row
 * that is not a URL — restored, imported, hand-written — must not fail the person's whole list
 * (found by the Phase 6 sweep in a second organisation).
 */
const hostOf = (endpoint: string): string => {
  try { return new URL(endpoint).hostname; } catch { return '—'; }
};

const pushRoutes: FastifyPluginAsync = async (app) => {
  const signedIn = { preHandler: [app.authenticate] };

  /** The key a browser subscribes with, and whether this installation sends at all. */
  app.get('/push/key', signedIn, async () => ({
    publicKey: (await vapidKeys()).publicKey,
    delivery: env.PUSH_DELIVERY,
  }));

  /** My browsers — where the notices go, and whether the last one got there. */
  app.get('/push/subscriptions', signedIn, async (req) => {
    const me = actorFrom(req);
    const rows = await prisma.pushSubscription.findMany({ where: { userId: me.id }, orderBy: { lastSeenAt: 'desc' } });
    return rows.map((s) => ({
      id: s.id, host: hostOf(s.endpoint), userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt,
      lastSuccessAt: s.lastSuccessAt, failures: s.failures, disabledAt: s.disabledAt, disabledReason: s.disabledReason,
    }));
  });

  app.post('/push/subscriptions', { ...signedIn, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const me = actorFrom(req);
    const input = parse(pushSubscribeSchema, req.body);
    const endpoint = checkEndpoint(input.endpoint);
    if (!endpoint.ok) throw badRequest('PUSH_ENDPOINT', endpoint.messageFa);
    const keyProblem = checkKeys(input.keys.p256dh, input.keys.auth);
    if (keyProblem) throw badRequest('PUSH_KEYS', keyProblem);
    const before = await prisma.pushSubscription.findUnique({ where: { endpoint: input.endpoint }, select: { userId: true } });
    const s = await subscribe(me, { endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent ?? null });
    // A new browser, or one that changes hands, is worth a line in the trail; a re-announcement is not.
    if (!before || before.userId !== me.id) {
      await audit({
        organizationId: me.organizationId, actorId: me.id, action: 'CREATE', entityType: 'pushSubscription', entityId: s.id,
        after: { host: endpoint.url.hostname, ...(before ? { tookOverFrom: before.userId } : {}) }, ipAddress: me.ipAddress, requestId: me.requestId,
      });
    }
    return reply.code(before ? 200 : 201).send({ id: s.id, host: endpoint.url.hostname });
  });

  /** This browser stops: by its endpoint, which only the browser knows — used when signing out. */
  app.delete('/push/subscriptions', signedIn, async (req) => {
    const me = actorFrom(req);
    const { endpoint } = parse(pushUnsubscribeSchema, req.body);
    const gone = await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: me.id } });
    return { removed: gone.count };
  });

  /** One of my browsers, from the list — a phone I no longer have. */
  app.delete('/push/subscriptions/:id', signedIn, async (req) => {
    const me = actorFrom(req);
    const { id } = req.params as { id: string };
    const gone = await prisma.pushSubscription.deleteMany({ where: { id, userId: me.id } });
    if (!gone.count) throw notFound('اشتراک اعلان');
    await audit({ organizationId: me.organizationId, actorId: me.id, action: 'DELETE', entityType: 'pushSubscription', entityId: id, ipAddress: me.ipAddress, requestId: me.requestId });
    return { removed: 1 };
  });

  /** Sends a test to each of my browsers and says what each push service answered. */
  app.post('/push/test', { ...signedIn, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const me = actorFrom(req);
    return { delivery: env.PUSH_DELIVERY, results: await sendTest(me.id) };
  });
};

export default pushRoutes;
