import type { FastifyPluginAsync } from 'fastify';
import { createEnvelopeSchema, sandboxDeclineSchema, sandboxSignSchema, voidEnvelopeSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { notFound, unauthorized } from '../lib/errors.js';
import { callbackSignatureValid } from '../esign/provider.js';
import { options, publicEnvelope, sandboxAct, sandboxDocument, sandboxView, send, sync, voidEnvelope } from '../esign/service.js';

const PUBLIC_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } };

/** Contract e-signature (roadmap #36). */
const esignRoutes: FastifyPluginAsync = async (app) => {
  const read = [app.authenticate, app.requirePermissions('contract.read')];
  const sign = [app.authenticate, app.requirePermissions('contract.sign')];

  app.get('/contracts/:id/signatures', { preHandler: read }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const rows = await prisma.signatureEnvelope.findMany({
      where: { contractId: id, organizationId: actor.organizationId }, orderBy: { createdAt: 'desc' },
      include: {
        signers: { orderBy: { order: 'asc' } }, events: { orderBy: { seq: 'asc' } },
        document: { select: { id: true, fileName: true } }, signedDocument: { select: { id: true, fileName: true } }, createdBy: { select: { fullName: true } },
      },
    });
    return rows.map(publicEnvelope);
  });

  app.get('/contracts/:id/signature-options', { preHandler: read }, async (req) => options(actorFrom(req), (req.params as { id: string }).id));

  app.post('/contracts/:id/signatures', { preHandler: sign }, async (req, reply) => {
    const input = parse(createEnvelopeSchema, req.body);
    return reply.code(201).send(await send(actorFrom(req), (req.params as { id: string }).id, input));
  });

  app.post('/esign/envelopes/:id/sync', { preHandler: sign }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const e = await prisma.signatureEnvelope.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!e) throw notFound('پاکت امضا');
    return sync(e.id);
  });

  app.post('/esign/envelopes/:id/void', { preHandler: sign }, async (req) => {
    const { reason } = parse(voidEnvelopeSchema, req.body);
    return voidEnvelope(actorFrom(req), (req.params as { id: string }).id, reason);
  });

  /** The provider says "look again" — signed over the exact bytes it sent, and only that. */
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try { done(null, JSON.parse((body as Buffer).toString('utf8') || '{}')); } catch (e) { done(e as Error, undefined); }
    });
    sub.post('/esign/callback', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
      const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
      if (!callbackSignatureValid(raw, req.headers['x-hiva-signature'] as string | undefined)) throw unauthorized('امضای فراخوان معتبر نیست.');
      const { id } = (req.body ?? {}) as { id?: string };
      const e = id ? await prisma.signatureEnvelope.findFirst({ where: { providerRef: String(id), provider: 'http' }, select: { id: true } }) : null;
      if (!e) throw notFound('پاکت امضا');
      return sync(e.id);
    });
  });

  /* ── the sandbox's own signing page (ESIGN_MODE=sandbox only) ── */

  app.get('/esign/sandbox/:token', { config: PUBLIC_LIMIT }, async (req) => sandboxView((req.params as { token: string }).token));

  app.get('/esign/sandbox/:token/document', {
    config: PUBLIC_LIMIT,
    onSend: async (_req, reply, payload) => { reply.header('Content-Type', 'application/octet-stream'); return payload; },
  }, async (req, reply) => {
    const d = await sandboxDocument((req.params as { token: string }).token);
    return reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(d.fileName)}"`).header('X-Content-Type-Options', 'nosniff').send(d.content);
  });

  app.post('/esign/sandbox/:token/sign', { config: PUBLIC_LIMIT }, async (req) => {
    const { signerName } = parse(sandboxSignSchema, req.body);
    return sandboxAct((req.params as { token: string }).token, { sign: signerName }, req.ip ?? null);
  });

  app.post('/esign/sandbox/:token/decline', { config: PUBLIC_LIMIT }, async (req) => {
    const { reason } = parse(sandboxDeclineSchema, req.body);
    return sandboxAct((req.params as { token: string }).token, { decline: reason }, req.ip ?? null);
  });
};

export default esignRoutes;
