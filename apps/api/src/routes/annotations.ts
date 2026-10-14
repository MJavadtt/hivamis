import type { FastifyPluginAsync } from 'fastify';
import { annotationStatusSchema, createAnnotationSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { withAvatar } from '../profile/avatars.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { ANNOTATION_FOR, kindOfFile, nextNumber } from '../annotations/service.js';

/** A note with its author as the page shows people: with their photo (audit F-6). */
const authored = <T extends { author: { id: string; fullName: string; avatarDocumentId: string | null } }>(a: T) => ({ ...a, author: withAvatar(a.author) });
const withPlace = { author: { select: { id: true, fullName: true, avatarDocumentId: true } }, revision: { select: { id: true, code: true, state: true } }, qcReview: { select: { id: true, code: true, level: true } } } as const;

/** Annotation on deliverables (roadmap #38). */
const annotationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/deliverables/:id/annotations', { preHandler: [app.authenticate, app.requirePermissions('deliverable.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const d = await prisma.deliverable.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true, code: true, name: true, state: true } });
    if (!d) throw notFound('خروجی');
    const [documents, annotations] = await Promise.all([
      // Older versions stay listed, marked as such: their marks are how the new version is checked.
      prisma.document.findMany({ where: { deliverableId: id, deletedAt: null }, orderBy: [{ supersededAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }], select: { id: true, fileName: true, mimeType: true, sizeBytes: true, checksum: true, createdAt: true, version: true, lineageId: true, supersededAt: true, metadata: true } }),
      prisma.annotation.findMany({ where: { deliverableId: id }, orderBy: [{ documentId: 'asc' }, { number: 'asc' }], include: withPlace }),
    ]);
    return {
      deliverable: d,
      files: documents.map((f) => ({ ...f, current: !f.supersededAt, kind: kindOfFile(f.mimeType), annotations: annotations.filter((a) => a.documentId === f.id).length })),
      annotations: annotations.map(authored),
    };
  });

  app.post('/deliverables/:id/annotations', { preHandler: [app.authenticate, app.requirePermissions('qc.read')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(createAnnotationSchema, req.body);
    const doc = await prisma.document.findFirst({ where: { id: input.documentId, deliverableId: id, organizationId: actor.organizationId, deletedAt: null } });
    if (!doc) throw new AppError(422, 'ANNOTATION_FILE', 'فایل باید از فایل‌های همین خروجی باشد.');
    if (doc.supersededAt) throw new AppError(422, 'ANNOTATION_SUPERSEDED', 'نسخهٔ تازه‌تری از این فایل هست؛ یادداشت را روی آخرین نسخه بگذارید.');
    const kind = kindOfFile(doc.mimeType);
    if (!kind) throw new AppError(422, 'ANNOTATION_UNSUPPORTED', 'روی این نوع فایل نمی‌توان یادداشت گذاشت؛ فقط تصویر، ویدیو و PDF.');
    if (ANNOTATION_FOR[kind] !== input.kind) throw new AppError(422, 'ANNOTATION_KIND', 'نوع یادداشت با نوع فایل نمی‌خواند.');
    const place = input.kind === 'PIN' ? { x: input.x, y: input.y }
      : input.kind === 'TIMECODE' ? { timeSec: input.timeSec, x: input.x ?? null, y: input.y ?? null }
      : { page: input.page, x: input.x, y: input.y, w: input.w, h: input.h };
    const create = () => prisma.$transaction(async (tx) => tx.annotation.create({
      data: {
        organizationId: actor.organizationId, deliverableId: id, documentId: doc.id, documentSha256: doc.checksum ?? '',
        kind: input.kind, number: await nextNumber(tx, doc.id), note: input.note, authorId: actor.id, ...place,
      },
      include: withPlace,
    }));
    // Two reviewers numbering the same file at once: the unique pair refuses one, which takes the next number.
    const a = await create().catch((e: { code?: string }) => (e.code === 'P2002' ? create() : Promise.reject(e)));
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'annotation', entityId: a.id, after: { deliverableId: id, documentId: doc.id, kind: a.kind, number: a.number }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return reply.code(201).send(authored(a));
  });

  /** Resolved when the unit has fixed it — or opened again when it has not. */
  app.patch('/annotations/:id', { preHandler: [app.authenticate, app.requirePermissions('deliverable.write')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { status } = parse(annotationStatusSchema, req.body);
    const a = await prisma.annotation.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!a) throw notFound('یادداشت');
    const updated = await prisma.annotation.update({
      where: { id }, include: withPlace,
      data: status === 'RESOLVED' ? { status, resolvedAt: new Date(), resolvedById: actor.id } : { status, resolvedAt: null, resolvedById: null },
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'annotation', entityId: id, before: { status: a.status }, after: { status }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return authored(updated);
  });

  /** The author may take back a note no review has carried yet. */
  app.delete('/annotations/:id', { preHandler: [app.authenticate, app.requirePermissions('qc.read')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const a = await prisma.annotation.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!a) throw notFound('یادداشت');
    if (a.authorId !== actor.id) throw forbidden('فقط نویسندهٔ یادداشت آن را پاک می‌کند.');
    if (a.qcReviewId) throw conflict('ANNOTATION_CARRIED', 'این یادداشت در یک بررسی QC ثبت شده است و دیگر پاک نمی‌شود.');
    await prisma.annotation.delete({ where: { id } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: 'annotation', entityId: id, before: a, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return reply.code(204).send();
  });
};

export default annotationRoutes;
