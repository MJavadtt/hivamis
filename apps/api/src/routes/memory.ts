import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { embeddingServiceConfigured, LOCAL_MODEL } from '../memory/embed.js';
import { lessonsForProject } from '../memory/lessons.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import {
  KIND_LABEL_FA, MEMORY_KINDS, reindexMemory, searchMemory, type MemoryKind,
} from '../memory/index.js';

/**
 * Organisational memory (roadmap #21) — the closure ritual's output, made findable.
 *
 * Everything here reads through the same permissions the records themselves carry: a kind the
 * caller may not read is never searched, so memory can never become a way around a gate.
 */
const memoryRoutes: FastifyPluginAsync = async (app) => {
  /** What the organisation knows about this question. */
  app.get('/memory/search', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const actor = actorFrom(req);
    const { q, kinds, projectId, limit } = req.query as Record<string, string | undefined>;
    const wanted = kinds
      ? (kinds.split(',').map((k) => k.trim()).filter((k) => (MEMORY_KINDS as string[]).includes(k)) as MemoryKind[])
      : undefined;
    const result = await searchMemory(actor.organizationId, q ?? '', {
      kinds: wanted, projectId, limit: limit ? Number(limit) : undefined, permissions: actor.permissions,
    });
    return {
      query: q ?? '',
      ...result,
      // Said plainly rather than implied: a hash embedder is not a language model.
      basisFa: result.usedService
        ? 'بردارها از سرویس embedding پیکربندی‌شده می‌آیند'
        : 'سرویس embedding پیکربندی نشده — بردارها محلی و واژه‌محورند؛ نتایج بیشتر بر پایهٔ شباهت متنی‌اند',
      kinds: MEMORY_KINDS.map((k) => ({ key: k, labelFa: KIND_LABEL_FA[k] })),
    };
  });

  /**
   * "What have we done before that looks like this" for one record — the same retrieval,
   * seeded by the record's own text instead of a typed question. This is what #44 will hang
   * lessons-learned surfacing on.
   */
  app.get('/memory/similar/:entityType/:id', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const actor = actorFrom(req);
    const { entityType, id } = req.params as { entityType: string; id: string };
    if (!(MEMORY_KINDS as string[]).includes(entityType)) throw notFound('نوع رکورد');
    const doc = await prisma.memoryDocument.findFirst({
      where: { organizationId: actor.organizationId, entityType, entityId: id },
    });
    if (!doc) {
      return { source: null, hits: [], noteFa: 'این رکورد هنوز در حافظهٔ سازمان نمایه نشده است.' };
    }
    const result = await searchMemory(actor.organizationId, `${doc.titleFa}\n${doc.body}`, {
      permissions: actor.permissions,
      limit: Number((req.query as { limit?: string }).limit ?? 8) + 1,
      excludeProjectId: doc.projectId ?? undefined,
    });
    return {
      source: { entityType: doc.entityType, entityId: doc.entityId, titleFa: doc.titleFa },
      // A record is always its own nearest neighbour; that is not a finding.
      hits: result.hits.filter((h) => !(h.entityType === doc.entityType && h.entityId === doc.entityId)),
      model: result.model, usedService: result.usedService,
    };
  });

  /**
   * What the organisation already learned that bears on this project (roadmap #44) — asked on
   * the project's behalf rather than waiting for somebody to remember to search.
   */
  app.get('/projects/:id/lessons', {
    preHandler: [app.authenticate, app.requirePermissions('project.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { limit, includeReviewed } = req.query as Record<string, string | undefined>;
    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!project) throw notFound('پروژه');
    return lessonsForProject(prisma, actor.organizationId, id, {
      permissions: actor.permissions,
      limit: limit ? Number(limit) : undefined,
      includeReviewed: includeReviewed === 'true',
    });
  });

  /**
   * What this project did with a lesson. Two answers only — it changed how we work here, or it
   * was considered and set aside — because "seen" is not a decision and would measure nothing.
   */
  app.post('/projects/:id/lessons/:lessonId/review', {
    preHandler: [app.authenticate, app.requirePermissions('project.plan')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id, lessonId } = req.params as { id: string; lessonId: string };
    const { decision, note } = (req.body ?? {}) as { decision?: string; note?: string };
    if (decision !== 'APPLIED' && decision !== 'NOT_RELEVANT') {
      throw badRequest('INVALID_DECISION', 'تصمیم باید «به‌کار گرفته شد» یا «مرتبط نبود» باشد');
    }
    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!project) throw notFound('پروژه');
    const lesson = await prisma.lessonLearned.findFirst({ where: { id: lessonId, organizationId: actor.organizationId }, select: { id: true, title: true } });
    if (!lesson) throw notFound('درس آموخته');
    if (decision === 'NOT_RELEVANT' && !note?.trim()) {
      // Setting a lesson aside is a judgement, and a judgement with no reason teaches nobody.
      throw badRequest('REASON_REQUIRED', 'برای «مرتبط نبود» نوشتن دلیل لازم است');
    }

    const review = await prisma.lessonReview.upsert({
      where: { projectId_lessonId: { projectId: id, lessonId } },
      create: {
        organizationId: actor.organizationId, projectId: id, lessonId,
        decision, note: note?.trim() || null, reviewedById: actor.id,
      },
      update: { decision, note: note?.trim() || null, reviewedById: actor.id },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'LESSON_REVIEWED',
      entityType: 'project', entityId: id,
      after: { lessonId, lessonTitle: lesson.title, decision },
      reason: note?.trim() || null,
      ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
    });
    return reply.code(201).send(review);
  });

  /** What the index holds, and how fresh it is. */
  app.get('/memory/status', {
    preHandler: [app.authenticate, app.requirePermissions('report.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const rows = await prisma.memoryDocument.groupBy({
      by: ['entityType', 'model'],
      where: { organizationId: actor.organizationId },
      _count: { _all: true },
      _max: { indexedAt: true },
    });
    return {
      serviceConfigured: embeddingServiceConfigured(),
      localModel: LOCAL_MODEL,
      total: rows.reduce((s, r) => s + r._count._all, 0),
      byKind: MEMORY_KINDS.map((k) => {
        const mine = rows.filter((r) => r.entityType === k);
        return {
          key: k, labelFa: KIND_LABEL_FA[k],
          count: mine.reduce((s, r) => s + r._count._all, 0),
          models: [...new Set(mine.map((r) => r.model))],
          lastIndexedAt: mine.map((r) => r._max.indexedAt).filter(Boolean).sort().at(-1) ?? null,
        };
      }),
    };
  });

  /** Rebuild the index by hand — after an embedding service is configured, say. */
  app.post('/memory/reindex', {
    preHandler: [app.authenticate, app.requirePermissions('admin.settings')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { force, kinds } = (req.body ?? {}) as { force?: boolean; kinds?: string[] };
    const wanted = kinds?.filter((k) => (MEMORY_KINDS as string[]).includes(k)) as MemoryKind[] | undefined;
    return reindexMemory(actor.organizationId, { force: force === true, kinds: wanted?.length ? wanted : undefined });
  });
};

export default memoryRoutes;
