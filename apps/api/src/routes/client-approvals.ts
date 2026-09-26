import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import path from 'node:path';
import { cancelClientApprovalSchema, clientDecisionSchema, createClientApprovalSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { renderPdf } from '../pdf/renderer.js';
import { dateTime } from '../pdf/fmt.js';
import {
  byToken, cancel, createRequest, decide, fileFor, linkFor, mailRequest, optionsFor, publicView, sendCode, staffView, subjectPermission, verify,
  type ClientContext,
} from '../approvals/service.js';
import { certificateHtml } from '../approvals/certificate.js';
import type { Manifest } from '../approvals/evidence.js';

const clientOf = (req: FastifyRequest): ClientContext => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] ?? '').slice(0, 400) || null });
/** The link is the only credential the client holds: a tight budget per address, well under the general one. */
const PUBLIC_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } };

/** Client approval as evidence (roadmap #35): staff ask, the client decides on a public page. */
const clientApprovalRoutes: FastifyPluginAsync = async (app) => {
  const storageRoot = path.resolve(env.STORAGE_DIR);

  const loadForStaff = async (req: FastifyRequest, need: 'read' | 'write') => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const a = await prisma.clientApproval.findFirst({ where: { id, organizationId: actor.organizationId }, include: { events: { orderBy: { seq: 'asc' } }, requestedBy: { select: { fullName: true } } } });
    if (!a) throw notFound('درخواست تأیید');
    const p = subjectPermission(a.subjectType, need)!;
    if (!actor.permissions.includes(p)) throw forbidden(`به دسترسی «${p}» نیاز دارید.`);
    return { actor, a };
  };

  app.post('/client-approvals', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createClientApprovalSchema, req.body);
    const { approval, token, manifest } = await prisma.$transaction((tx) => createRequest(tx, actor, storageRoot, input), { timeout: 60_000 });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'CLIENT_APPROVAL_REQUESTED', entityType: input.subjectType === 'DELIVERABLE' ? 'deliverable' : 'proposal', entityId: input.subjectId,
      after: { approval: approval.code, contact: approval.contactEmail, files: manifest.files.length, manifestHash: approval.manifestHash, channel: approval.channel },
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    if (approval.channel === 'EMAIL') await mailRequest(approval, manifest, token);
    // With mail off the link is handed to the person who asked, once; it is never shown again.
    return reply.code(201).send({ ...staffView(approval), link: approval.channel === 'MANUAL' ? linkFor(token) : null });
  });

  app.get('/client-approvals', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { subjectType, subjectId } = req.query as { subjectType?: string; subjectId?: string };
    const p = subjectType ? subjectPermission(subjectType, 'read') : undefined;
    if (!p || !subjectId) throw badRequest('SUBJECT_REQUIRED', 'موضوع درخواست‌ها را مشخص کنید.');
    if (!actor.permissions.includes(p)) throw forbidden(`به دسترسی «${p}» نیاز دارید.`);
    const rows = await prisma.clientApproval.findMany({
      where: { organizationId: actor.organizationId, subjectType, subjectId },
      include: { events: { orderBy: { seq: 'asc' } }, requestedBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    return rows.map((r) => ({ ...staffView(r), status: r.status === 'PENDING' && r.expiresAt <= now ? 'EXPIRED' : r.status }));
  });

  app.get('/client-approvals/options', { preHandler: [app.authenticate] }, async (req) => {
    const { subjectType, subjectId } = req.query as { subjectType?: string; subjectId?: string };
    if (!subjectId || !subjectPermission(subjectType ?? '', 'write')) throw badRequest('SUBJECT_REQUIRED', 'موضوع درخواست را مشخص کنید.');
    return optionsFor(actorFrom(req), subjectType as 'DELIVERABLE' | 'PROPOSAL', subjectId);
  });

  app.get('/client-approvals/:id', { preHandler: [app.authenticate] }, async (req) => staffView((await loadForStaff(req, 'read')).a));

  app.post('/client-approvals/:id/cancel', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { reason } = parse(cancelClientApprovalSchema, req.body);
    const updated = await cancel((req.params as { id: string }).id, actor, reason);
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CLIENT_APPROVAL_CANCELLED', entityType: 'clientApproval', entityId: updated.id, reason, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return staffView(updated);
  });

  /** Recompute every hash — files from storage, manifest, decision, the chain link — and say what does not match. */
  app.get('/client-approvals/:id/verify', { preHandler: [app.authenticate] }, async (req) => {
    const { actor, a } = await loadForStaff(req, 'read');
    return verify(a.id, actor.organizationId, storageRoot);
  });

  app.get('/client-approvals/:id/certificate', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { actor, a } = await loadForStaff(req, 'read');
    const checked = await verify(a.id, actor.organizationId, storageRoot);
    const pdf = await renderPdf(certificateHtml(a, checked), { headerRight: a.code, footerNote: `گواهی تأیید مشتری — ${a.code} — ${dateTime(new Date())}` });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'EXPORT', entityType: 'clientApproval', entityId: a.id, after: { format: 'pdf', code: a.code, verified: checked.ok }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${a.code}-certificate.pdf"`)
      .send(pdf);
  });

  /* ── public: the client's page. No session — the link's secret is the credential. ── */

  app.get('/public/approvals/:token', { config: PUBLIC_LIMIT }, async (req) => {
    const ctx = clientOf(req);
    const a = await byToken((req.params as { token: string }).token, ctx);
    return publicView(a, ctx, a.status === 'PENDING');
  });

  app.get('/public/approvals/:token/files/:documentId', {
    config: PUBLIC_LIMIT,
    onSend: async (_req, reply, payload) => { reply.header('Content-Type', 'application/octet-stream'); return payload; },
  }, async (req, reply) => {
    const ctx = clientOf(req);
    const { token, documentId } = req.params as { token: string; documentId: string };
    const a = await byToken(token, ctx);
    const f = await fileFor(a, documentId, ctx, storageRoot);
    return reply
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(f.fileName)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store')
      .sendFile(f.storedName, storageRoot);
  });

  app.post('/public/approvals/:token/code', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const ctx = clientOf(req);
    return sendCode(await byToken((req.params as { token: string }).token, ctx), ctx);
  });

  app.post('/public/approvals/:token/decision', { config: PUBLIC_LIMIT }, async (req) => {
    const ctx = clientOf(req);
    const input = parse(clientDecisionSchema, req.body);
    const a = await byToken((req.params as { token: string }).token, ctx);
    const sealed = await decide(a, input, ctx);
    const m = sealed.manifest as unknown as Manifest;
    return { code: sealed.code, status: sealed.status, decision: sealed.decision, decidedAt: sealed.decidedAt, subject: m.subject.title, manifestHash: sealed.manifestHash, evidenceHash: sealed.evidenceHash };
  });
};

export default clientApprovalRoutes;
