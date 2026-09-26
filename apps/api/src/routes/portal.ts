import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import path from 'node:path';
import {
  acceptPortalInviteSchema, clientDecisionSchema, documentVisibilitySchema, invitePortalUserSchema, portalLoginSchema, portalMessageSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { notify } from '../mail/notify.js';
import { renderPdf } from '../pdf/renderer.js';
import { dateTime } from '../pdf/fmt.js';
import { buildClientStatusReport } from '../reports/client-status.js';
import { portalUser } from '../portal/auth.js';
import { accept, disable, home, invite, login, postMessage, project, publicUser, reply as replyToClient, sharedDocument, visibleProject } from '../portal/service.js';
import { byIdForCompany, decide, fileFor, publicView, type ClientContext } from '../approvals/service.js';
import type { Manifest } from '../approvals/evidence.js';

const clientOf = (req: FastifyRequest): ClientContext => ({ ip: req.ip ?? null, userAgent: (req.headers['user-agent'] ?? '').slice(0, 400) || null });
const PORTAL_LIMIT = { rateLimit: { max: 120, timeWindow: '1 minute' } };
const SIGN_IN_LIMIT = { rateLimit: { max: env.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } };
const attachment = (name: string) => `attachment; filename="${encodeURIComponent(name)}"`;

/** The client portal (roadmap #34): the client's side under /portal, Account's under /portal-users and /projects/:id. */
const portalRoutes: FastifyPluginAsync = async (app) => {
  const storageRoot = path.resolve(env.STORAGE_DIR);

  /* ── the client ─────────────────────────────────────────────────────────── */

  app.post('/portal/auth/accept', { config: SIGN_IN_LIMIT }, async (req) => {
    const { token, password } = parse(acceptPortalInviteSchema, req.body);
    return accept(token, password, req.ip);
  });

  app.post('/portal/auth/login', { config: SIGN_IN_LIMIT }, async (req) => {
    const { email, password } = parse(portalLoginSchema, req.body);
    return login(email, password, req.ip, req.headers['user-agent'] ?? null);
  });

  app.get('/portal/home', { config: PORTAL_LIMIT }, async (req) => home(await portalUser(req)));

  app.get('/portal/projects/:id', { config: PORTAL_LIMIT }, async (req) => project(await portalUser(req), (req.params as { id: string }).id));

  app.post('/portal/projects/:id/messages', { config: PORTAL_LIMIT }, async (req, reply) => {
    const p = await portalUser(req);
    const { body } = parse(portalMessageSchema, req.body);
    const r = await postMessage(p, (req.params as { id: string }).id, body);
    await notify({
      userId: r.accountOwnerId, kind: 'PORTAL_MESSAGE', title: `پیام ${p.contact.fullName} دربارهٔ ${r.projectName}`, body: body.slice(0, 300),
      entityType: 'project', entityId: r.message.projectId,
    });
    return reply.code(201).send(r.message);
  });

  app.get('/portal/documents/:id', {
    config: PORTAL_LIMIT,
    onSend: async (_req, reply, payload) => { reply.header('Content-Type', 'application/octet-stream'); return payload; },
  }, async (req, reply) => {
    const p = await portalUser(req);
    const d = await sharedDocument(p, (req.params as { id: string }).id);
    await audit({ organizationId: p.organizationId, actorId: null, action: 'FILE_DOWNLOAD', entityType: 'document', entityId: d.id, after: { portalUserId: p.id }, ipAddress: req.ip });
    return reply.header('Content-Disposition', attachment(d.fileName)).header('X-Content-Type-Options', 'nosniff').sendFile(d.storedName, storageRoot);
  });

  /** The weekly report in the version built for the client (#37) — never the internal one. */
  app.get('/portal/status-reports/:id', { config: PORTAL_LIMIT }, async (req, reply) => {
    const p = await portalUser(req);
    const { id } = req.params as { id: string };
    const r = await prisma.statusReport.findFirst({ where: { id, organizationId: p.organizationId }, select: { projectId: true } });
    if (!r) throw notFound('گزارش وضعیت');
    await visibleProject(p, r.projectId);
    const built = await buildClientStatusReport(prisma, id);
    const pdf = await renderPdf(built.html, { headerRight: built.code, footerNote: `گزارش وضعیت — ${built.companyName} — ${dateTime(new Date())}` });
    await audit({ organizationId: p.organizationId, actorId: null, action: 'EXPORT', entityType: 'statusReport', entityId: id, after: { format: 'pdf', portalUserId: p.id, omitted: built.omitted }, ipAddress: req.ip });
    return reply.header('Content-Type', 'application/pdf').header('Content-Disposition', attachment(`${built.code}.pdf`)).send(pdf);
  });

  /** Approvals (#35) from inside the portal: the company sees them; only the addressee decides. */
  const approvalFor = async (req: FastifyRequest) => {
    const p = await portalUser(req);
    const a = await byIdForCompany((req.params as { id: string }).id, p.companyId, clientOf(req));
    return { p, a };
  };

  app.get('/portal/approvals/:id', { config: PORTAL_LIMIT }, async (req) => {
    const { p, a } = await approvalFor(req);
    const forMe = a.contactId === p.contactId;
    return { ...(await publicView(a, clientOf(req), forMe && a.status === 'PENDING')), verification: 'PORTAL', forMe };
  });

  app.get('/portal/approvals/:id/files/:documentId', {
    config: PORTAL_LIMIT,
    onSend: async (_req, reply, payload) => { reply.header('Content-Type', 'application/octet-stream'); return payload; },
  }, async (req, reply) => {
    const { p, a } = await approvalFor(req);
    // The log counts a download as the addressee's having seen the file, so only the addressee downloads here.
    if (a.contactId !== p.contactId) throw forbidden(`فایل‌های این درخواست برای ${a.contactName} فرستاده شده است.`);
    const f = await fileFor(a, (req.params as { documentId: string }).documentId, clientOf(req), storageRoot);
    return reply.header('Content-Disposition', attachment(f.fileName)).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store').sendFile(f.storedName, storageRoot);
  });

  app.post('/portal/approvals/:id/decision', { config: PORTAL_LIMIT }, async (req) => {
    const { p, a } = await approvalFor(req);
    if (a.contactId !== p.contactId) throw forbidden(`این درخواست برای ${a.contactName} فرستاده شده است؛ تصمیمش با خود اوست.`);
    const input = parse(clientDecisionSchema, req.body);
    const sealed = await decide(a, input, clientOf(req), { portalUserId: p.id });
    const m = sealed.manifest as unknown as Manifest;
    return { code: sealed.code, status: sealed.status, decision: sealed.decision, decidedAt: sealed.decidedAt, subject: m.subject.title, manifestHash: sealed.manifestHash, evidenceHash: sealed.evidenceHash };
  });

  /* ── Account ────────────────────────────────────────────────────────────── */

  const manage = [app.authenticate, app.requirePermissions('portal.manage')];

  app.get('/portal-users', { preHandler: manage }, async (req) => {
    const actor = actorFrom(req);
    const { companyId } = req.query as { companyId?: string };
    if (!companyId) throw badRequest('COMPANY_REQUIRED', 'مشتری را مشخص کنید.');
    const rows = await prisma.portalUser.findMany({
      where: { organizationId: actor.organizationId, companyId }, orderBy: { createdAt: 'asc' },
      include: { contact: { select: { fullName: true, jobTitle: true } }, invitedBy: { select: { fullName: true } } },
    });
    return rows.map(publicUser);
  });

  app.post('/portal-users', { preHandler: manage }, async (req, reply) => {
    const { contactId } = parse(invitePortalUserSchema, req.body);
    return reply.code(201).send(await invite(actorFrom(req), contactId));
  });

  app.post('/portal-users/:id/reinvite', { preHandler: manage }, async (req) => {
    const actor = actorFrom(req);
    const u = await prisma.portalUser.findFirst({ where: { id: (req.params as { id: string }).id, organizationId: actor.organizationId } });
    if (!u) throw notFound('حساب پورتال');
    return invite(actor, u.contactId);
  });

  app.post('/portal-users/:id/disable', { preHandler: manage }, async (req) => disable(actorFrom(req), (req.params as { id: string }).id));

  app.get('/projects/:id/portal-messages', { preHandler: [app.authenticate, app.requirePermissions('project.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const pr = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId }, select: { companyId: true } });
    if (!pr) throw notFound('پروژه');
    const [messages, portalUsers] = await Promise.all([
      prisma.portalMessage.findMany({
        where: { projectId: id }, orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, createdAt: true, portalUser: { select: { contact: { select: { fullName: true } } } }, user: { select: { fullName: true } } },
      }),
      prisma.portalUser.count({ where: { companyId: pr.companyId, status: 'ACTIVE' } }),
    ]);
    return {
      portalUsers,
      messages: messages.map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, fromClient: !!m.portalUser, author: m.portalUser?.contact.fullName ?? m.user?.fullName ?? '' })),
    };
  });

  app.post('/projects/:id/portal-messages', { preHandler: manage }, async (req, reply) => {
    const actor = actorFrom(req);
    const { body } = parse(portalMessageSchema, req.body);
    return reply.code(201).send(await replyToClient(actor, (req.params as { id: string }).id, body));
  });

  /** Every file of a project and its deliverables, with whether the client sees it. */
  app.get('/projects/:id/client-files', { preHandler: [app.authenticate, app.requirePermissions('project.read', 'document.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const pr = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!pr) throw notFound('پروژه');
    return prisma.document.findMany({
      where: { organizationId: actor.organizationId, deletedAt: null, OR: [{ projectId: id }, { deliverable: { projectId: id } }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true, clientVisible: true, deliverable: { select: { code: true, name: true } }, uploadedBy: { select: { fullName: true } } },
    });
  });

  app.patch('/documents/:id/client-visibility', { preHandler: manage }, async (req) => {
    const actor = actorFrom(req);
    const { clientVisible } = parse(documentVisibilitySchema, req.body);
    const { id } = req.params as { id: string };
    const d = await prisma.document.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null }, select: { id: true, projectId: true, deliverableId: true, clientVisible: true } });
    if (!d) throw notFound('سند');
    // Only a project's own files: a contract, a form attachment or a client record is never shown this way.
    if (!d.projectId && !d.deliverableId) throw new AppError(422, 'PORTAL_NOT_PROJECT_FILE', 'فقط فایل‌های پروژه و خروجی‌های آن در پورتال نشان داده می‌شوند.');
    const updated = await prisma.document.update({ where: { id }, data: { clientVisible }, select: { id: true, clientVisible: true } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'document', entityId: id, before: { clientVisible: d.clientVisible }, after: { clientVisible }, reason: 'portal visibility', ipAddress: actor.ipAddress, requestId: actor.requestId });
    return updated;
  });
};

export default portalRoutes;
