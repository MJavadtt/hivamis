import type { FastifyPluginAsync } from 'fastify';
import { companyTaxIdentifiersSchema, submitTaxSchema, taxProfileSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { validateSeller, type SellerProfile } from '../tax/invoice.js';
import { configuredGateway } from '../tax/gateway.js';
import { capped, LIST_CAP, over } from '../lib/limits.js';
import { inquireSent, prepare, preview, sendQueued } from '../tax/submit.js';

const MODE_FA = {
  off: 'ارسال خاموش است — گزارش‌ها آماده و در صف می‌مانند',
  sandbox: 'حالت آزمایشی — به سازمان امور مالیاتی ارسال نمی‌شود',
  live: 'اتصال مستقیم به سامانهٔ مؤدیان',
} as const;

/** سامانهٔ مؤدیان (roadmap #32): the taxpayer profile, and each invoice's reports. */
const taxRoutes: FastifyPluginAsync = async (app) => {
  app.get('/tax/profile', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    const profile = await prisma.taxProfile.findUnique({ where: { organizationId: actor.organizationId } });
    return { profile, mode: env.MOADIAN_MODE, modeFa: MODE_FA[env.MOADIAN_MODE], configured: !!configuredGateway(), problems: validateSeller(profile as SellerProfile | null) };
  });

  app.put('/tax/profile', { preHandler: [app.authenticate, app.requirePermissions('finance.settle')] }, async (req) => {
    const actor = actorFrom(req);
    const input = parse(taxProfileSchema, req.body);
    const data = { ...input, memoryId: input.memoryId.toUpperCase(), economicCode: input.economicCode ?? null, postalCode: input.postalCode ?? null, branchCode: input.branchCode ?? null, updatedById: actor.id };
    const problems = validateSeller(data as SellerProfile);
    if (problems.length) throw new AppError(422, 'TAX_PROFILE_INVALID', 'مشخصات مؤدی کامل یا درست نیست', { problems });
    const before = await prisma.taxProfile.findUnique({ where: { organizationId: actor.organizationId } });
    const saved = await prisma.taxProfile.upsert({ where: { organizationId: actor.organizationId }, create: { organizationId: actor.organizationId, ...data }, update: data });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: before ? 'UPDATE' : 'CREATE', entityType: 'taxProfile', entityId: saved.id, before, after: saved, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return saved;
  });

  /** The buyer's tax identifiers — finance completes them for e-invoicing, without full client editing rights. */
  app.put('/companies/:id/tax-identifiers', { preHandler: [app.authenticate, app.requirePermissions('finance.invoice')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(companyTaxIdentifiersSchema, req.body);
    const before = await prisma.company.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true, nationalId: true, economicCode: true, postalCode: true } });
    if (!before) throw notFound('مشتری');
    const after = await prisma.company.update({ where: { id }, data: input, select: { id: true, nationalId: true, economicCode: true, postalCode: true } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'company', entityId: id, before, after, reason: 'tax identifiers', ipAddress: actor.ipAddress, requestId: actor.requestId });
    return after;
  });

  /** What would be sent, what is missing, and what was sent before. */
  app.get('/invoices/:id/tax', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    return { ...(await preview(prisma, actor.organizationId, id)), mode: env.MOADIAN_MODE, modeFa: MODE_FA[env.MOADIAN_MODE] };
  });

  /** Report the invoice: prepared now, sent now if sending is on (and by the job otherwise). */
  app.post('/invoices/:id/tax', { preHandler: [app.authenticate, app.requirePermissions('finance.invoice')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { subject } = parse(submitTaxSchema, req.body);
    const submission = await prisma.$transaction((tx) => prepare(tx, actor.organizationId, id, subject, actor.id));
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'TAX_SUBMISSION_PREPARED', entityType: 'invoice', entityId: id, after: { taxId: submission.taxId, subject, serial: submission.serial }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    await sendQueued(undefined, submission.id);
    await inquireSent(undefined, submission.id);
    return reply.code(201).send(await prisma.taxSubmission.findUniqueOrThrow({ where: { id: submission.id } }));
  });

  app.post('/tax/submissions/:id/inquire', { preHandler: [app.authenticate, app.requirePermissions('finance.invoice')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const s = await prisma.taxSubmission.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!s) throw notFound('گزارش');
    if (s.status === 'QUEUED') await sendQueued(undefined, id);
    await inquireSent(undefined, id);
    return prisma.taxSubmission.findUniqueOrThrow({ where: { id } });
  });

  /** Invoices the authority has not accepted yet — the list finance works from. */
  app.get('/reports/tax', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    // Only what the authority has not accepted is read; the accepted are counted (audit PERF-4) — every
    // invoice of every year was read to show the few still pending.
    const issued = { organizationId: actor.organizationId, kind: 'INVOICE', state: { notIn: ['DRAFT', 'CANCELLED'] } };
    const acceptedHere = { status: 'ACCEPTED', subject: { not: 'CANCELLATION' } };
    const [read, acceptedCount] = await Promise.all([
      prisma.invoice.findMany({
        where: { ...issued, taxSubmissions: { none: acceptedHere } },
        select: { id: true, code: true, number: true, issueDate: true, total: true, company: { select: { legalName: true } }, taxSubmissions: { select: { subject: true, status: true, taxId: true, errors: true, createdAt: true }, orderBy: { createdAt: 'desc' } } },
        orderBy: { issueDate: 'asc' }, take: over(LIST_CAP),
      }),
      prisma.invoice.count({ where: { ...issued, taxSubmissions: { some: acceptedHere } } }),
    ]);
    const { rows: invoices, truncated } = capped(read, LIST_CAP);
    const now = Date.now();
    const rows = invoices.map((i) => {
      const latest = i.taxSubmissions[0] ?? null;
      const accepted = i.taxSubmissions.some((s) => s.status === 'ACCEPTED' && s.subject !== 'CANCELLATION');
      return {
        id: i.id, code: i.code, number: i.number, client: i.company.legalName, issueDate: i.issueDate, total: Number(i.total),
        ageDays: Math.floor((now - i.issueDate.getTime()) / 86_400_000),
        status: accepted ? 'ACCEPTED' : latest?.status ?? 'NOT_REPORTED', taxId: latest?.taxId ?? null, errors: latest?.errors ?? null,
      };
    });
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      mode: env.MOADIAN_MODE, modeFa: MODE_FA[env.MOADIAN_MODE],
      totals: { notReported: count('NOT_REPORTED'), queued: count('QUEUED'), sent: count('SENT'), accepted: acceptedCount, rejected: count('REJECTED'), failed: count('FAILED') },
      pending: rows.filter((r) => r.status !== 'ACCEPTED'),
      truncated,
    };
  });
};

export default taxRoutes;
