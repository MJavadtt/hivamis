import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { isSystemAdmin } from '../auth/grants.js';
import { assertMayNote, targetOf } from '../notes/target.js';

/**
 * Notes on every record, for every colleague (the owner, 2026-11-17; ADR-134): «در هر بخش برای همه
 * همکاران امکان ثبت یادداشت می‌خواهم … می‌تواند به جای فایل پیوست یا همراه با آن قرار بگیرد». A note
 * is a few words, files, or both; it sits beside the record's files, readable by whoever reads them.
 */
const noteSchema = z.object({
  body: z.string().trim().max(5000).default(''),
  documentIds: z.array(z.string().uuid()).max(20).default([]),
}).refine((n) => n.body.length > 0 || n.documentIds.length > 0, { message: 'یادداشت را بنویسید یا فایلی همراهش کنید.' });

const AUTHOR = { select: { id: true, fullName: true } } as const;

const notesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/notes', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const t = targetOf(req.query as Record<string, unknown>);
    await assertMayNote(actor, t);
    const notes = await prisma.comment.findMany({
      where: { entityType: t.entityType, entityId: t.entityId },
      orderBy: { createdAt: 'desc' }, take: 300,
      select: { id: true, body: true, createdAt: true, documentIds: true, author: AUTHOR },
    });
    const ids = [...new Set(notes.flatMap((n) => n.documentIds))];
    const docs = ids.length
      ? await prisma.document.findMany({ where: { id: { in: ids }, organizationId: actor.organizationId, deletedAt: null }, select: { id: true, fileName: true, mimeType: true } })
      : [];
    const byId = new Map(docs.map((d) => [d.id, d]));
    const admin = isSystemAdmin(actor);
    return notes.map(({ documentIds, ...n }) => ({
      ...n, documents: documentIds.map((id) => byId.get(id)).filter(Boolean), mayDelete: admin || n.author.id === actor.id,
    }));
  });

  app.post('/notes', { preHandler: [app.authenticate, app.idempotent] }, async (req, reply) => {
    const actor = actorFrom(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const t = targetOf(raw);
    await assertMayNote(actor, t);
    const { body, documentIds } = parse(noteSchema, raw);
    // Only files of this organisation, uploaded by the writer, and not taken away since.
    if (documentIds.length) {
      const mine = await prisma.document.count({ where: { id: { in: documentIds }, organizationId: actor.organizationId, uploadedById: actor.id, deletedAt: null } });
      if (mine !== documentIds.length) throw badRequest('UNKNOWN_DOCUMENT', 'یکی از فایل‌های همراه یادداشت پیدا نشد.');
    }
    const note = await prisma.$transaction(async (tx) => {
      const c = await tx.comment.create({
        data: {
          entityType: t.entityType, entityId: t.entityId, body, documentIds, authorId: actor.id,
          ...(t.entityType === 'project' ? { projectId: t.entityId } : {}), ...(t.entityType === 'task' ? { taskId: t.entityId } : {}),
        },
        select: { id: true, body: true, createdAt: true, author: AUTHOR },
      });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'comment', entityId: c.id, after: { on: t.entityType, id: t.entityId, files: documentIds.length }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return c;
    });
    return reply.code(201).send(note);
  });

  /** A note is taken back by whoever wrote it, or the system administrator; its files stay on the record. */
  app.delete('/notes/:id', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const note = await prisma.comment.findUnique({ where: { id }, select: { id: true, authorId: true, entityType: true, entityId: true, author: { select: { organizationId: true } } } });
    if (!note || note.author.organizationId !== actor.organizationId) throw notFound('یادداشت');
    if (note.authorId !== actor.id && !isSystemAdmin(actor)) throw forbidden('یادداشت را فقط نویسنده‌اش برمی‌دارد.');
    await prisma.$transaction(async (tx) => {
      await tx.comment.delete({ where: { id } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: 'comment', entityId: id, before: { on: note.entityType, id: note.entityId }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
    });
    return { id };
  });
};

export default notesRoutes;
