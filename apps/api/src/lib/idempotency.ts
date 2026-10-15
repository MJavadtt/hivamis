/**
 * Idempotency keys (audit F-7). A device that queued a write while offline sends it again on every
 * reconnect until it hears an answer — and an answer can be lost on the way back. A route that opts
 * in (`preHandler: [..., app.idempotent]`, after authentication) does the work once per key:
 *
 * - the first request with a key is run, and a successful answer kept;
 * - the same key and the same request again gets that answer, marked `Idempotent-Replayed: true`;
 * - the same key on a different request is refused (422 `IDEMPOTENCY_KEY_REUSED`);
 * - while the first is still running, another is told to wait (409 `IDEMPOTENCY_IN_PROGRESS`).
 *
 * A refusal (4xx) or a failure (5xx) is not kept: the key is let go so the person can try again
 * once the reason is gone. The key belongs to the person who sent it; another's is another key.
 */
import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { AppError, badRequest, conflict } from './errors.js';
import { currentUser } from '../auth/plugin.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Honours an `Idempotency-Key` header on this route. Place after authentication. */
    idempotent: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
  interface FastifyRequest {
    idempotency?: { id: string };
  }
}

const KEY = /^[A-Za-z0-9_.:-]{8,100}$/;
/** A first attempt that has said nothing for this long died with its process; the next may take over. */
const STALE_MS = 60_000;
/** How long an answer is kept for a device to ask again. */
export const KEEP_MS = 7 * 86_400_000;

const hashOf = (req: FastifyRequest) =>
  createHash('sha256').update(`${req.method}\n${req.url}\n${JSON.stringify(req.body ?? null)}`).digest('hex');

const idempotencyPlugin: FastifyPluginAsync = async (app) => {
  app.decorate('idempotent', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.headers['idempotency-key'];
    if (raw === undefined) return;
    const key = Array.isArray(raw) ? raw[0]! : raw;
    if (!KEY.test(key)) throw badRequest('IDEMPOTENCY_KEY_INVALID', 'کلید تکرارناپذیری نامعتبر است.');
    const user = currentUser(req);
    const requestHash = hashOf(req);
    const data = { organizationId: user.organizationId, userId: user.sub, key, method: req.method, path: req.url, requestHash };
    const find = () => prisma.idempotencyKey.findUnique({ where: { userId_key: { userId: user.sub, key } } });
    // Looked for first: a replay is the ordinary case, not an error to log. Two arriving together
    // still meet at the unique key.
    let seen = await find();
    if (!seen) {
      try {
        req.idempotency = { id: (await prisma.idempotencyKey.create({ data, select: { id: true } })).id };
        return;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
      seen = await find();
    }
    if (!seen) throw conflict('IDEMPOTENCY_IN_PROGRESS', 'همین درخواست هم‌اکنون در حال انجام است؛ کمی بعد دوباره بفرستید.');
    if (seen.requestHash !== requestHash) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'این کلید پیش‌تر برای درخواست دیگری به کار رفته است.');
    }
    if (seen.completedAt && seen.statusCode) {
      // Answered here, as the first time: the handler does not run again.
      return reply.code(seen.statusCode).header('Idempotent-Replayed', 'true').send(seen.response);
    }
    if (Date.now() - seen.createdAt.getTime() < STALE_MS) {
      throw conflict('IDEMPOTENCY_IN_PROGRESS', 'همین درخواست هم‌اکنون در حال انجام است؛ کمی بعد دوباره بفرستید.');
    }
    // The first attempt never finished: this one takes its place.
    const taken = await prisma.idempotencyKey.updateMany({ where: { id: seen.id, completedAt: null, createdAt: seen.createdAt }, data: { createdAt: new Date() } });
    if (!taken.count) throw conflict('IDEMPOTENCY_IN_PROGRESS', 'همین درخواست هم‌اکنون در حال انجام است؛ کمی بعد دوباره بفرستید.');
    req.idempotency = { id: seen.id };
  });

  // The answer, kept for the key — or the key let go, when the answer was a refusal or a failure.
  app.addHook('onSend', async (req, reply, payload) => {
    const held = req.idempotency;
    if (!held) return payload;
    req.idempotency = undefined;
    if (reply.statusCode >= 400) {
      await prisma.idempotencyKey.delete({ where: { id: held.id } }).catch(() => undefined);
      return payload;
    }
    let response: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
    if (typeof payload === 'string' && payload) {
      try { response = JSON.parse(payload) as Prisma.InputJsonValue; } catch { /* not JSON: kept as nothing */ }
    }
    await prisma.idempotencyKey.update({ where: { id: held.id }, data: { statusCode: reply.statusCode, response, completedAt: new Date() } }).catch(() => undefined);
    return payload;
  });
};

export default fp(idempotencyPlugin, { name: 'idempotency', dependencies: ['auth'] });

/** Kept answers past their week. */
export async function pruneIdempotencyKeys(now = Date.now()): Promise<number> {
  return (await prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(now - KEEP_MS) } } })).count;
}
