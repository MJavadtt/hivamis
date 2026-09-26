import type { FastifyPluginAsync } from 'fastify';
import { accountingPeriodSchema, accountingSettingsSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { createExport, DEFAULT_LAYOUT, layoutProblems, plan, settingsFor } from '../accounting/export.js';

const withoutContent = { id: true, number: true, periodTo: true, vouchers: true, lines: true, debitTotal: true, creditTotal: true, fileName: true, createdById: true, createdAt: true } as const;

/** Export to the accounting package (roadmap #33): the chart's codes, a preview, batches and their files. */
const accountingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/accounting/settings', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    const settings = await settingsFor(prisma, actor.organizationId);
    // The clients money has moved with — the ones a detail code is worth setting for.
    const clients = await prisma.company.findMany({
      where: { organizationId: actor.organizationId, OR: [{ invoices: { some: {} } }, { projects: { some: { payments: { some: {} } } } }] },
      select: { id: true, legalName: true }, orderBy: { legalName: 'asc' }, take: 1000,
    });
    return { ...settings, defaultLayout: DEFAULT_LAYOUT, clients };
  });

  app.put('/accounting/settings', { preHandler: [app.authenticate, app.requirePermissions('finance.settle')] }, async (req) => {
    const actor = actorFrom(req);
    const input = parse(accountingSettingsSchema, req.body);
    const problems = layoutProblems(input.layout);
    const accounts = Object.fromEntries(Object.entries(input.accounts).filter(([, v]) => v));
    const ids = Object.keys(input.clientCodes);
    const known = ids.length ? await prisma.company.count({ where: { organizationId: actor.organizationId, id: { in: ids } } }) : 0;
    if (known !== ids.length) problems.push({ code: 'CLIENT_UNKNOWN', message: 'کد تفصیلی برای مشتری‌ای داده شده که در این سازمان نیست.' });
    if (problems.length) throw new AppError(422, 'ACCOUNTING_SETTINGS_INVALID', 'تنظیمات خروجی حسابداری درست نیست', { problems });
    const data = { accounts, clientCodes: input.clientCodes, layout: input.layout, updatedById: actor.id };
    const before = await prisma.accountingSettings.findUnique({ where: { organizationId: actor.organizationId } });
    const saved = await prisma.accountingSettings.upsert({ where: { organizationId: actor.organizationId }, create: { organizationId: actor.organizationId, ...data }, update: data });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: before ? 'UPDATE' : 'CREATE', entityType: 'accountingSettings', entityId: saved.id, before, after: saved, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return saved;
  });

  /** What a batch up to this date would carry — nothing is marked. */
  app.get('/accounting/preview', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { to } = parse(accountingPeriodSchema, req.query);
    const p = await plan(prisma, actor.organizationId, to);
    return {
      to, counts: p.counts, lines: p.lines, debitTotal: p.debitTotal, creditTotal: p.creditTotal,
      problems: p.problems, warnings: p.warnings, vouchers: p.vouchers.slice(0, 50), more: Math.max(0, p.vouchers.length - 50),
      accounts: p.settings.accounts,
    };
  });

  app.post('/accounting/exports', { preHandler: [app.authenticate, app.requirePermissions('finance.settle')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { to } = parse(accountingPeriodSchema, req.body);
    const result = await prisma.$transaction((tx) => createExport(tx, actor.organizationId, to, actor.id));
    const { content: _content, ...exp } = result.export;
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'accountingExport', entityId: exp.id, after: { ...exp, counts: result.counts }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return reply.code(201).send({ ...exp, counts: result.counts, warnings: result.warnings });
  });

  app.get('/accounting/exports', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    const rows = await prisma.accountingExport.findMany({ where: { organizationId: actor.organizationId }, select: withoutContent, orderBy: { number: 'desc' }, take: 200 });
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, fullName: true } });
    return rows.map((r) => ({ ...r, createdBy: users.find((u) => u.id === r.createdById)?.fullName ?? null }));
  });

  /** The file exactly as the batch wrote it — downloading it again gives the same bytes. */
  app.get('/accounting/exports/:id/file', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const exp = await prisma.accountingExport.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!exp) throw notFound('خروجی حسابداری');
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'EXPORT', entityType: 'accountingExport', entityId: exp.id, after: { format: 'csv', number: exp.number, fileName: exp.fileName }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exp.fileName}"`)
      .send(exp.content);
  });
};

export default accountingRoutes;
