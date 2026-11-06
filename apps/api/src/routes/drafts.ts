import type { FastifyPluginAsync } from 'fastify';
import { saveDraftSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { AppError, notFound } from '../lib/errors.js';

/**
 * What a person typed and has not saved (the owner, 2026-11-06, ADR-122). Kept for them until the form
 * is saved or they delete it, and only for them: every route here is the caller's own rows, and nobody
 * else — no role — reads another's drafts.
 */
const MAX_BYTES = 256 * 1024;
const MAX_DRAFTS = 500;

const draftRoutes: FastifyPluginAsync = async (app) => {
  const own = { preHandler: [app.authenticate] };

  app.get('/me/drafts', own, async (req) => {
    const actor = actorFrom(req);
    return prisma.userDraft.findMany({
      where: { userId: actor.id, organizationId: actor.organizationId }, orderBy: { updatedAt: 'desc' }, take: MAX_DRAFTS,
      select: { id: true, key: true, title: true, path: true, fields: true, updatedAt: true },
    });
  });

  app.put('/me/drafts', own, async (req) => {
    const actor = actorFrom(req);
    const input = parse(saveDraftSchema, req.body);
    if (Buffer.byteLength(JSON.stringify(input.fields)) > MAX_BYTES) throw new AppError(413, 'DRAFT_TOO_LARGE', 'این پیش‌نویس بزرگ‌تر از آن است که نگه داشته شود.');
    const where = { userId_key: { userId: actor.id, key: input.key } };
    if (!(await prisma.userDraft.count({ where: { userId: actor.id, key: input.key } })) && (await prisma.userDraft.count({ where: { userId: actor.id } })) >= MAX_DRAFTS) {
      throw new AppError(409, 'TOO_MANY_DRAFTS', 'پیش‌نویس‌های شما زیاد شده است؛ چندتا را حذف کنید.');
    }
    const data = { title: input.title, path: input.path, fields: input.fields as object };
    return prisma.userDraft.upsert({
      where, update: data, create: { ...data, key: input.key, userId: actor.id, organizationId: actor.organizationId },
      select: { id: true, key: true, updatedAt: true },
    });
  });

  app.delete('/me/drafts/:id', own, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { count } = await prisma.userDraft.deleteMany({ where: { id, userId: actor.id } });
    if (!count) throw notFound('پیش‌نویس');
    return reply.code(204).send();
  });
};

export default draftRoutes;
