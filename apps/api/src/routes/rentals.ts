import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  depositDecisionSchema, depositDeductionSchema, IMPORT_KINDS, IMPORT_MODES, OBLIGATION_KIND_LABELS,
  obligationAdjustSchema, obligationCloseSchema, obligationListSchema, obligationSchema, reversalSchema, scheduleSchema,
  siteReportSchema, sitePaymentSchema, type ImportKind, type ObligationKind, type Permission,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { money } from '../lib/money.js';
import { formatJalali } from '../lib/jalali.js';
import { isSystemAdmin } from '../auth/grants.js';
import { assertOptions, settingsOf } from '../sites/options.js';
import { assertBooksOpen, balancesOf, decideDeduction, lockProject, OPEN, proposeDeduction, recordPayment, reversePayment } from '../sites/ledger.js';
import { applySchedule } from '../sites/schedule.js';
import { runReminders } from '../sites/reminders.js';
import { projectReport, rentalReport, venueReport } from '../sites/reports.js';
import { IMPORT_COLUMNS, runImport, streamWorkbook, templateFor, type ExportColumn } from '../sites/excel.js';
import { completenessOf } from '../sites/venues.js';
import { anyOf, overridesRules } from '../sites/access.js';
import { SITE_GUARDS } from '../sites/workflow.js';

/**
 * Rentals (ADR-103, module C): the register of what is owed, its calendar, payments and their
 * reversal, the deposit's deductions and return, the schedule, the closure's statement, reminders,
 * reports and Excel in and out.
 */

const DAY = 86_400_000;
type Actor = ReturnType<typeof actorFrom>;
const auditCtx = (a: Actor) => ({ organizationId: a.organizationId, actorId: a.id, ipAddress: a.ipAddress, requestId: a.requestId });

function obligationWhere(organizationId: string, q: z.infer<typeof obligationListSchema>, now = new Date()): Prisma.SiteObligationWhereInput {
  return {
    organizationId,
    ...(q.siteProjectId ? { siteProjectId: q.siteProjectId } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.status === 'open' ? { status: { in: [...OPEN] } } : q.status === 'overdue' ? { status: { in: [...OPEN] }, dueDate: { lt: now } } : q.status === 'settled' ? { status: { in: ['SETTLED', 'WAIVED'] } } : {}),
    ...(q.from || q.to ? { dueDate: { ...(q.status === 'overdue' ? { lt: now } : {}), ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    siteProject: {
      ...(q.venueId ? { venueId: q.venueId } : {}), ...(q.responsibleId ? { responsibleId: q.responsibleId } : {}),
      ...(q.province || q.city ? { venue: { ...(q.province ? { province: q.province } : {}), ...(q.city ? { city: q.city } : {}) } } : {}),
    },
    ...(q.q ? { OR: [{ description: { contains: q.q, mode: 'insensitive' } }, { siteProject: { name: { contains: q.q, mode: 'insensitive' } } }, { siteProject: { code: { contains: q.q, mode: 'insensitive' } } }, { siteProject: { venue: { name: { contains: q.q, mode: 'insensitive' } } } }] } : {}),
  };
}

const obligationInclude = {
  siteProject: { select: { id: true, code: true, name: true, state: true, responsible: { select: { id: true, fullName: true } }, venue: { select: { id: true, name: true, city: true, province: true } } } },
} as const;

const withOutstanding = <T extends { amount: Prisma.Decimal; settledAmount: Prisma.Decimal; status: string; dueDate: Date }>(o: T, now = new Date()) => ({
  ...o,
  outstanding: OPEN.includes(o.status as never) ? money(o.amount).sub(money(o.settledAmount)).toFixed(2) : '0.00',
  overdue: OPEN.includes(o.status as never) && o.dueDate < now,
});

const rentalRoutes: FastifyPluginAsync = async (app) => {
  const read = { preHandler: [app.authenticate, app.requirePermissions('rental.read')] };
  const manage = { preHandler: [app.authenticate, app.requirePermissions('rental.manage')] };
  const approve = { preHandler: [app.authenticate, app.requirePermissions('rental.approve')] };

  /* ── the dashboard and the register ──────────────────────────────────── */

  app.get('/rentals/dashboard', read, async (req) => {
    const actor = actorFrom(req);
    const now = new Date();
    const org = actor.organizationId;
    const open = { organizationId: org, status: { in: [...OPEN] } };
    const [outstanding, overdue, next30, overdueCount, dueSoonCount, pendingContracts, pendingDeductions, settling, active, failedReminders] = await Promise.all([
      prisma.siteObligation.groupBy({ by: ['currency'], where: open, _sum: { amount: true, settledAmount: true } }),
      prisma.siteObligation.groupBy({ by: ['currency'], where: { ...open, dueDate: { lt: now } }, _sum: { amount: true, settledAmount: true } }),
      prisma.siteObligation.groupBy({ by: ['currency'], where: { ...open, dueDate: { gte: now, lte: new Date(now.getTime() + 30 * DAY) } }, _sum: { amount: true, settledAmount: true } }),
      prisma.siteObligation.count({ where: { ...open, dueDate: { lt: now } } }),
      prisma.siteObligation.count({ where: { ...open, dueDate: { gte: now, lte: new Date(now.getTime() + 7 * DAY) } } }),
      prisma.siteContract.count({ where: { organizationId: org, status: 'PENDING_APPROVAL' } }),
      prisma.siteDepositEntry.count({ where: { organizationId: org, kind: 'DEDUCTION', status: 'PROPOSED' } }),
      prisma.siteProject.count({ where: { organizationId: org, state: { in: ['SETTLING', 'CLOSURE_PENDING'] } } }),
      prisma.siteProject.count({ where: { organizationId: org, state: 'ACTIVE' } }),
      prisma.siteReminder.count({ where: { organizationId: org, status: 'FAILED' } }),
    ]);
    const sums = (rows: typeof outstanding) => rows.map((r) => ({ currency: r.currency, amount: money(r._sum.amount).sub(money(r._sum.settledAmount)).toFixed(2) }));
    const report = await rentalReport(org, {}, now);
    return {
      outstanding: sums(outstanding), overdue: sums(overdue), next30: sums(next30),
      counts: { overdue: overdueCount, dueThisWeek: dueSoonCount, pendingContracts, pendingDeductions, settling, active, failedReminders },
      deposits: report.deposits.byCurrency,
      upcoming: report.upcoming.slice(0, 10), overdueItems: report.overdueItems.slice(0, 10),
    };
  });

  app.get('/site-obligations', read, async (req) => {
    const actor = actorFrom(req);
    const q = parse(obligationListSchema, req.query);
    const where = obligationWhere(actor.organizationId, q);
    const [items, total, sums] = await Promise.all([
      prisma.siteObligation.findMany({ where, include: obligationInclude, orderBy: [{ dueDate: q.status === 'settled' ? 'desc' : 'asc' }, { createdAt: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.siteObligation.count({ where }),
      prisma.siteObligation.groupBy({ by: ['currency'], where, _sum: { amount: true, settledAmount: true } }),
    ]);
    return {
      ...page(items.map((o) => withOutstanding(o)), total, q),
      totals: sums.map((s) => ({ currency: s.currency, amount: money(s._sum.amount).toFixed(2), settled: money(s._sum.settledAmount).toFixed(2), outstanding: money(s._sum.amount).sub(money(s._sum.settledAmount)).toFixed(2) })),
    };
  });

  /** What falls due in a span, and the contracts that end in it — the calendar's month. */
  app.get('/site-obligations/calendar', read, async (req) => {
    const actor = actorFrom(req);
    const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date() }).refine((x) => x.to > x.from && x.to.getTime() - x.from.getTime() <= 62 * DAY, { message: 'بازه حداکثر دو ماه است.' }), req.query);
    const [items, endings] = await Promise.all([
      prisma.siteObligation.findMany({ where: { organizationId: actor.organizationId, status: { not: 'VOID' }, dueDate: { gte: q.from, lt: q.to } }, include: obligationInclude, orderBy: { dueDate: 'asc' }, take: 2000 }),
      prisma.siteProject.findMany({ where: { organizationId: actor.organizationId, contractEnd: { gte: q.from, lt: q.to }, state: { notIn: ['CLOSED', 'CANCELLED'] } }, select: { id: true, code: true, name: true, contractEnd: true, venue: { select: { name: true } } }, take: 500 }),
    ]);
    return { items: items.map((o) => withOutstanding(o)), contractEnds: endings };
  });

  /* ── obligations ─────────────────────────────────────────────────────── */

  app.post('/site-projects/:id/obligations', manage, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(obligationSchema, req.body);
    if (input.categoryCode) await assertOptions(actor.organizationId, [{ list: 'CHARGE_CATEGORY', codes: [input.categoryCode], field: 'categoryCode' }]);
    if (input.periodStart && input.periodEnd && input.periodEnd <= input.periodStart) throw badRequest('VALIDATION_ERROR', 'پایان دوره باید پس از آغاز آن باشد.');
    const made = await prisma.$transaction(async (tx) => {
      const p = await lockProject(tx, actor.organizationId, id);
      assertBooksOpen(p, actor);
      if (p.state === 'CANCELLED' && !overridesRules(actor)) throw conflict('PROJECT_CLOSED', 'پروژه لغو شده است.');
      const row = await tx.siteObligation.create({ data: { ...input, organizationId: actor.organizationId, siteProjectId: id, currency: p.currency, source: 'MANUAL', createdById: actor.id } });
      await audit({ ...auditCtx(actor), action: 'OBLIGATION_ADDED', entityType: 'siteProject', entityId: id, after: row }, tx);
      return row;
    });
    return reply.code(201).send(made);
  });

  /** A change to what is owed, with its reason: never below what was paid against it, never on a closed item. */
  app.patch('/site-obligations/:id', manage, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(obligationAdjustSchema, req.body);
    return prisma.$transaction(async (tx) => {
      const found = await tx.siteObligation.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!found) throw notFound('قلم');
      const p = await lockProject(tx, actor.organizationId, found.siteProjectId);
      assertBooksOpen(p, actor);
      const before = await tx.siteObligation.findUniqueOrThrow({ where: { id } });
      if (!OPEN.includes(before.status as never)) throw conflict('OBLIGATION_CLOSED', 'این قلم بسته است و تغییر نمی‌کند.');
      if (input.amount && money(input.amount).lt(money(before.settledAmount))) throw conflict('BELOW_SETTLED', `مبلغ از آنچه پرداخت شده (${money(before.settledAmount).toFixed(0)}) کمتر نمی‌شود.`);
      const amount = input.amount ? money(input.amount) : money(before.amount);
      const settled = money(before.settledAmount);
      const status = settled.gte(amount) ? 'SETTLED' : settled.gt(0) ? 'PARTIAL' : 'OPEN';
      const after = await tx.siteObligation.update({
        where: { id },
        data: { ...(input.amount ? { amount: input.amount } : {}), ...(input.dueDate ? { dueDate: input.dueDate } : {}), ...('description' in input ? { description: input.description ?? null } : {}), status, closedAt: status === 'SETTLED' ? new Date() : null },
      });
      await audit({ ...auditCtx(actor), action: 'OBLIGATION_ADJUSTED', entityType: 'siteProject', entityId: before.siteProjectId, before, after, reason: input.reason }, tx);
      return after;
    });
  });

  /** Waived by the venue (rental.approve), or void as never owed (only while nothing was paid against it). */
  app.post('/site-obligations/:id/close', manage, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(obligationCloseSchema, req.body);
    if (input.action === 'WAIVE' && !actor.permissions.includes('rental.approve')) throw forbidden('بخشودن بدهی به دسترسی «rental.approve» نیاز دارد.');
    return prisma.$transaction(async (tx) => {
      const found = await tx.siteObligation.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!found) throw notFound('قلم');
      const p = await lockProject(tx, actor.organizationId, found.siteProjectId);
      assertBooksOpen(p, actor);
      const before = await tx.siteObligation.findUniqueOrThrow({ where: { id } });
      if (!OPEN.includes(before.status as never)) throw conflict('OBLIGATION_CLOSED', 'این قلم بسته است.');
      if (input.action === 'VOID' && money(before.settledAmount).gt(0)) throw conflict('OBLIGATION_PAID', 'قلمی که پرداخت دارد باطل نمی‌شود؛ پرداخت را برگردانید یا مانده را ببخشید.');
      if (await tx.siteDepositEntry.count({ where: { obligationId: id, status: 'PROPOSED' } })) throw conflict('DEDUCTION_PENDING', 'کسری از ودیعه بابت این قلم در انتظار تصمیم است.');
      const after = await tx.siteObligation.update({ where: { id }, data: { status: input.action === 'WAIVE' ? 'WAIVED' : 'VOID', closeReason: input.reason, closedAt: new Date() } });
      await audit({ ...auditCtx(actor), action: input.action === 'WAIVE' ? 'OBLIGATION_WAIVED' : 'OBLIGATION_VOIDED', entityType: 'siteProject', entityId: before.siteProjectId, before, after, reason: input.reason }, tx);
      return after;
    });
  });

  app.post('/site-projects/:id/schedule', manage, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(scheduleSchema, req.body ?? {});
    const settings = await settingsOf(actor.organizationId);
    return prisma.$transaction((tx) => applySchedule(tx, actor, id, settings, input.dryRun), { timeout: 30_000 });
  });

  /* ── the ledger: payments and the deposit ────────────────────────────── */

  app.get('/site-projects/:id/ledger', read, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const p = await prisma.siteProject.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!p) throw notFound('پروژهٔ استقرار');
    const [obligations, payments, deposits, balances] = await Promise.all([
      prisma.siteObligation.findMany({ where: { siteProjectId: id }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }], include: { createdBy: { select: { fullName: true } } } }),
      prisma.sitePayment.findMany({
        where: { siteProjectId: id }, orderBy: { paidAt: 'desc' },
        include: { recordedBy: { select: { fullName: true } }, reversedBy: { select: { fullName: true } }, allocations: { select: { obligationId: true, amount: true, reversedAt: true } } },
      }),
      prisma.siteDepositEntry.findMany({ where: { siteProjectId: id }, orderBy: { createdAt: 'desc' }, include: { recordedBy: { select: { id: true, fullName: true } }, decidedBy: { select: { fullName: true } }, obligation: { select: { id: true, kind: true, dueDate: true } } } }),
      balancesOf(prisma, id),
    ]);
    return { obligations: obligations.map((o) => withOutstanding(o)), payments, deposits, balances };
  });

  app.post('/site-projects/:id/payments', manage, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(sitePaymentSchema, req.body);
    if (input.paidAt.getTime() > Date.now() + DAY) throw badRequest('VALIDATION_ERROR', 'تاریخ پرداخت در آینده است.');
    await assertOptions(actor.organizationId, [{ list: 'PAYMENT_METHOD', codes: [input.methodCode], field: 'methodCode' }]);
    const settings = await settingsOf(actor.organizationId);
    const out = await prisma.$transaction((tx) => recordPayment(tx, actor, id, input, settings), { timeout: 30_000 });
    return reply.code(out.replayed ? 200 : 201).header('Idempotent-Replay', out.replayed ? 'true' : 'false').send(out.payment);
  });

  app.post('/site-payments/:id/reverse', manage, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { reason } = parse(reversalSchema, req.body);
    return prisma.$transaction((tx) => reversePayment(tx, actor, id, reason), { timeout: 30_000 });
  });

  app.post('/site-projects/:id/deductions', manage, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(depositDeductionSchema, req.body);
    const settings = await settingsOf(actor.organizationId);
    const row = await prisma.$transaction((tx) => proposeDeduction(tx, actor, id, input, settings), { timeout: 30_000 });
    return reply.code(201).send(row);
  });

  app.post('/site-deposit-entries/:id/decision', approve, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(depositDecisionSchema, req.body);
    return prisma.$transaction((tx) => decideDeduction(tx, actor, id, input.decision, input.comment, { systemAdmin: isSystemAdmin(actor) }), { timeout: 30_000 });
  });

  /**
   * The closure's statement (the document's «فرایند بستن کل پروژه + عودت ودیعه»): each step of closing a
   * project and whether it is done — what is owed by kind, the deposit, what waits for a decision — with
   * the rule's own verdict, as the transition will read it.
   */
  app.get('/site-projects/:id/closure', { preHandler: [app.authenticate, app.requirePermissions('site.read'), app.requirePermissions('rental.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const p = await prisma.siteProject.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!p) throw notFound('پروژهٔ استقرار');
    const [balances, verdict, pendingDeductions, waivers, approvals] = await Promise.all([
      balancesOf(prisma, id),
      prisma.$transaction((tx) => SITE_GUARDS['siteProject.settled']!({ tx, entity: 'siteProject', id, record: p, payload: {}, actorId: actor.id })),
      prisma.siteDepositEntry.findMany({ where: { siteProjectId: id, kind: 'DEDUCTION', status: 'PROPOSED' }, include: { recordedBy: { select: { id: true, fullName: true } } } }),
      prisma.waiver.findMany({ where: { organizationId: actor.organizationId, entityType: 'siteProject', entityId: id, guard: 'siteProject.settled', usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, reason: true, expiresAt: true } }),
      prisma.siteApproval.findMany({ where: { siteProjectId: id }, orderBy: { decidedAt: 'desc' }, take: 50, include: { decidedBy: { select: { fullName: true } } } }),
    ]);
    const kind = (k: string) => balances.byKind[k] ?? { due: '0.00', settled: '0.00', waived: '0.00', outstanding: '0.00', overdue: '0.00' };
    const zero = (v: string) => money(v).eq(0);
    const steps = [
      { key: 'initiated', done: ['SETTLING', 'CLOSURE_PENDING', 'CLOSED'].includes(p.state) },
      { key: 'contract', done: ['SETTLING', 'CLOSURE_PENDING', 'CLOSED'].includes(p.state) && (!p.contractEnd || p.contractEnd <= new Date() || p.state !== 'ACTIVE') },
      { key: 'rent', done: zero(kind('RENT').outstanding), outstanding: kind('RENT').outstanding },
      { key: 'charge', done: zero(kind('CHARGE').outstanding), outstanding: kind('CHARGE').outstanding },
      { key: 'penalties', done: zero(kind('PENALTY').outstanding) && zero(kind('OTHER').outstanding), outstanding: money(kind('PENALTY').outstanding).add(money(kind('OTHER').outstanding)).toFixed(2) },
      { key: 'others', done: ['INSTALLATION', 'TRANSPORT', 'FABRICATION'].every((k) => zero(kind(k).outstanding)) },
      { key: 'deposit', done: balances.deposit.status !== 'HELD' && balances.deposit.status !== 'PARTIAL', remaining: balances.deposit.remaining },
      { key: 'deductions', done: zero(balances.deposit.deductionsPending) },
      { key: 'credit', done: money(balances.credit).lte(0), credit: balances.credit },
      { key: 'settled', done: verdict.ok },
      { key: 'closed', done: p.state === 'CLOSED' },
    ];
    return { state: p.state, steps, verdict, balances, pendingDeductions, waivers, approvals, closureStatement: p.closureStatement };
  });

  /* ── reminders ───────────────────────────────────────────────────────── */

  app.get('/site-reminders', { preHandler: [app.authenticate, anyOf('rental.read', 'site.configure')] }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), status: z.string().max(20).optional(), event: z.string().max(40).optional() }), req.query);
    const where: Prisma.SiteReminderWhereInput = { organizationId: actor.organizationId, ...(q.status ? { status: q.status } : {}), ...(q.event ? { event: q.event } : {}) };
    const [items, total] = await Promise.all([
      prisma.siteReminder.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.siteReminder.count({ where }),
    ]);
    // Whom each went to, by name — colleagues of this organisation only; a number stays a number.
    const users = await prisma.user.findMany({ where: { organizationId: actor.organizationId, id: { in: items.filter((i) => i.channel !== 'SMS').map((i) => i.recipient) } }, select: { id: true, fullName: true } });
    const projects = await prisma.siteProject.findMany({ where: { organizationId: actor.organizationId, id: { in: items.map((i) => i.siteProjectId).filter((x): x is string => !!x) } }, select: { id: true, code: true, name: true } });
    return page(items.map((i) => ({ ...i, recipientName: users.find((u) => u.id === i.recipient)?.fullName ?? null, project: projects.find((p) => p.id === i.siteProjectId) ?? null })), total, q);
  });

  /** The day's run, now, for this organisation — what the job does each morning. */
  app.post('/site-reminders/run', { preHandler: [app.authenticate, app.requirePermissions('site.configure')] }, async (req) => {
    const actor = actorFrom(req);
    const out = await runReminders(new Date(), actor.organizationId);
    await audit({ ...auditCtx(actor), action: 'REMINDERS_RUN', entityType: 'siteSettings', entityId: actor.organizationId, after: out });
    return out;
  });

  /* ── reports ─────────────────────────────────────────────────────────── */

  app.get('/site-reports/venues', { preHandler: [app.authenticate, app.requirePermissions('venue.read')] }, async (req) =>
    venueReport(actorFrom(req).organizationId, parse(siteReportSchema, req.query)));
  app.get('/site-reports/projects', { preHandler: [app.authenticate, app.requirePermissions('site.read')] }, async (req) =>
    projectReport(actorFrom(req).organizationId, parse(siteReportSchema, req.query)));
  app.get('/site-reports/rentals', read, async (req) =>
    rentalReport(actorFrom(req).organizationId, parse(siteReportSchema, req.query)));

  /* ── Excel ───────────────────────────────────────────────────────────── */

  /** Whose import each kind is: venues and contacts the venue keepers', projects Operations', obligations Finance's. */
  const IMPORT_PERMISSION: Record<ImportKind, Permission> = { VENUES: 'venue.manage', CONTACTS: 'venue.write', SITE_PROJECTS: 'site.write', OBLIGATIONS: 'rental.manage' };
  const mayImport = (req: FastifyRequest, kind: ImportKind) => {
    const actor = actorFrom(req);
    if (!actor.permissions.includes(IMPORT_PERMISSION[kind])) throw forbidden(`برای ورود «${kind}» به دسترسی «${IMPORT_PERMISSION[kind]}» نیاز دارید.`);
    return actor;
  };
  const kindParam = (req: FastifyRequest) => {
    const kind = String((req.params as { kind: string }).kind).toUpperCase();
    if (!IMPORT_KINDS.includes(kind as ImportKind)) throw notFound('نوع ورود');
    return kind as ImportKind;
  };
  const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  app.get('/site-data/templates/:kind', { preHandler: [app.authenticate] }, async (req, reply) => {
    const kind = kindParam(req);
    const actor = mayImport(req, kind);
    const buf = await templateFor(actor.organizationId, kind);
    return reply.header('Content-Type', xlsx).header('Content-Disposition', `attachment; filename="hivamis-${kind.toLowerCase()}-template.xlsx"`).send(buf);
  });

  app.get('/site-data/columns/:kind', { preHandler: [app.authenticate] }, async (req) => {
    const kind = kindParam(req);
    mayImport(req, kind);
    return IMPORT_COLUMNS[kind];
  });

  /**
   * A file in: `dryRun=true` (the default) reads and checks it and writes nothing; `dryRun=false`
   * writes the good rows in one transaction, and needs `skipInvalid=true` if any row has an error.
   */
  app.post('/site-data/import/:kind', { preHandler: [app.authenticate] }, async (req) => {
    const kind = kindParam(req);
    const actor = mayImport(req, kind);
    const q = parse(z.object({ mode: z.enum(IMPORT_MODES).default('CREATE'), dryRun: z.enum(['true', 'false']).default('true'), skipInvalid: z.enum(['true', 'false']).default('false') }), req.query);
    const file = await (req as unknown as { file: () => Promise<{ filename: string; mimetype: string; toBuffer: () => Promise<Buffer>; file: { truncated?: boolean }; fields: Record<string, { value?: string } | undefined> } | undefined> }).file();
    if (!file) throw badRequest('NO_FILE', 'فایلی ارسال نشده است.');
    if (!/\.xlsx$/i.test(file.filename)) throw badRequest('UNSUPPORTED_TYPE', 'فقط فایل اکسل xlsx پذیرفته می‌شود.');
    const buffer = await file.toBuffer();
    if (file.file.truncated) throw badRequest('FILE_TOO_LARGE', 'فایل بزرگ‌تر از حد مجاز است.');
    // xlsx is a zip: its first bytes say so, whatever the name.
    if (buffer.subarray(0, 4).toString('hex') !== '504b0304') throw badRequest('UNSUPPORTED_TYPE', 'محتوای فایل اکسل نیست.');
    let mapping: Record<string, string> | undefined;
    const raw = file.fields?.mapping?.value;
    if (raw) {
      const parsed = z.record(z.string().max(120), z.string().max(40)).safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
      if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'نگاشت ستون‌ها نامعتبر است.');
      mapping = parsed.data;
    }
    return runImport(actor, {
      kind, mode: q.mode, dryRun: q.dryRun === 'true', skipInvalid: q.skipInvalid === 'true',
      fileName: file.filename, buffer, mapping, settings: await settingsOf(actor.organizationId),
    });
  });

  app.get('/site-data/imports', { preHandler: [app.authenticate, anyOf('venue.manage', 'venue.write', 'site.write', 'rental.manage')] }, async (req) => {
    const actor = actorFrom(req);
    return prisma.siteImport.findMany({
      where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, kind: true, mode: true, fileName: true, totalRows: true, created: true, updated: true, failed: true, createdAt: true, createdBy: { select: { fullName: true } } },
    });
  });

  app.get('/site-data/imports/:id', { preHandler: [app.authenticate, anyOf('venue.manage', 'venue.write', 'site.write', 'rental.manage')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const row = await prisma.siteImport.findFirst({ where: { id, organizationId: actor.organizationId }, include: { createdBy: { select: { fullName: true } } } });
    if (!row) throw notFound('ورود');
    return row;
  });

  /** A list as the screen filtered it, streamed out page by page. */
  app.get('/site-data/export/:kind', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const kind = String((req.params as { kind: string }).kind);
    const query = req.query as Record<string, string | undefined>;
    const need: Record<string, Permission> = { venues: 'venue.read', contacts: 'venue.read', projects: 'site.read', obligations: 'rental.read', payments: 'rental.read', deposits: 'rental.read' };
    if (!need[kind]) throw notFound('نوع خروجی');
    if (!actor.permissions.includes(need[kind]!)) throw forbidden(`برای این خروجی به دسترسی «${need[kind]}» نیاز دارید.`);
    const org = actor.organizationId;
    const d = (v: Date | null | undefined) => (v ? formatJalali(v).replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))) : null);
    const n = (v: unknown) => (v == null ? null : money(v).toNumber());
    async function* pages<T>(fetch: (skip: number) => Promise<T[]>) {
      for (let skip = 0; ; skip += 500) {
        const rows = await fetch(skip);
        if (rows.length) yield rows;
        if (rows.length < 500) return;
      }
    }
    let stream;
    if (kind === 'venues') {
      const where: Prisma.VenueWhereInput = { organizationId: org, mergedIntoId: null, ...(query.status === 'archived' ? { archivedAt: { not: null } } : query.status === 'all' ? {} : { archivedAt: null }), ...(query.province ? { province: query.province } : {}), ...(query.city ? { city: query.city } : {}), ...(query.typeCode ? { typeCode: query.typeCode } : {}), ...(query.gradeCode ? { gradeCode: query.gradeCode } : {}) };
      type V = Awaited<ReturnType<typeof fetchVenues>>[number];
      const fetchVenues = (skip: number) => prisma.venue.findMany({ where, orderBy: { code: 'asc' }, skip, take: 500, include: { _count: { select: { contacts: { where: { archivedAt: null } }, siteProjects: true, documents: { where: { deletedAt: null, supersededAt: null, mimeType: { startsWith: 'image/' } } } } } } });
      const cols: ExportColumn<V>[] = [
        { header: 'کد مکان', key: 'code', value: (v) => v.code }, { header: 'نام مکان', key: 'name', width: 30, value: (v) => v.name },
        { header: 'استان', key: 'province', value: (v) => v.province }, { header: 'شهر', key: 'city', value: (v) => v.city },
        { header: 'آدرس', key: 'address', width: 40, value: (v) => v.address }, { header: 'نوع مکان', key: 'type', value: (v) => v.typeCode },
        { header: 'گرید', key: 'grade', value: (v) => v.gradeCode }, { header: 'مخاطبان', key: 'audiences', value: (v) => v.audienceCodes.join('، ') },
        { header: 'تلفن', key: 'phone', value: (v) => v.phone }, { header: 'ایمیل', key: 'email', value: (v) => v.email }, { header: 'وب‌سایت', key: 'website', value: (v) => v.website },
        { header: 'فعال', key: 'active', value: (v) => (v.isActive && !v.archivedAt ? 'بله' : 'خیر') },
        { header: 'تعداد مخاطب', key: 'contacts', value: (v) => v._count.contacts }, { header: 'تعداد عکس', key: 'photos', value: (v) => v._count.documents },
        { header: 'تعداد پروژه', key: 'projects', value: (v) => v._count.siteProjects },
        { header: 'کامل بودن (٪)', key: 'completeness', value: (v) => completenessOf(v, v._count.contacts, v._count.documents).score },
        { header: 'یادداشت', key: 'notes', width: 40, value: (v) => v.notes }, { header: 'منشأ', key: 'source', value: (v) => (v.source === 'IMPORT' ? 'ورود از اکسل' : 'دستی') },
      ];
      stream = streamWorkbook('مکان‌ها', cols, pages(fetchVenues));
    } else if (kind === 'contacts') {
      const fetchContacts = (skip: number) => prisma.venueContact.findMany({ where: { organizationId: org, archivedAt: null, venue: { mergedIntoId: null, ...(query.venueId ? { id: query.venueId } : {}) } }, orderBy: [{ venueId: 'asc' }, { fullName: 'asc' }], skip, take: 500, include: { venue: { select: { code: true, name: true } }, channels: true } });
      type C = Awaited<ReturnType<typeof fetchContacts>>[number];
      const cols: ExportColumn<C>[] = [
        { header: 'کد مکان', key: 'venue_code', value: (c) => c.venue.code }, { header: 'مکان', key: 'venue', width: 28, value: (c) => c.venue.name },
        { header: 'نام و نام خانوادگی', key: 'full_name', width: 24, value: (c) => c.fullName }, { header: 'سمت', key: 'role', value: (c) => c.roleCode },
        { header: 'عنوان شغلی', key: 'job_title', value: (c) => c.jobTitle }, { header: 'تلفن', key: 'phone', value: (c) => c.phone }, { header: 'ایمیل', key: 'email', value: (c) => c.email },
        { header: 'مخاطب اصلی', key: 'primary', value: (c) => (c.isPrimary ? 'بله' : 'خیر') },
        { header: 'راه‌های ارتباطی', key: 'channels', width: 40, value: (c) => c.channels.map((x) => `${x.typeCode}: ${x.value}`).join(' | ') },
        { header: 'یادداشت', key: 'notes', width: 30, value: (c) => c.notes },
      ];
      stream = streamWorkbook('مخاطبان', cols, pages(fetchContacts));
    } else if (kind === 'projects') {
      const where: Prisma.SiteProjectWhereInput = { organizationId: org, ...(query.state ? { state: query.state } : {}), ...(query.venueId ? { venueId: query.venueId } : {}), ...(query.province || query.city ? { venue: { ...(query.province ? { province: query.province } : {}), ...(query.city ? { city: query.city } : {}) } } : {}) };
      const fetchProjects = (skip: number) => prisma.siteProject.findMany({ where, orderBy: { code: 'asc' }, skip, take: 500, include: { venue: { select: { code: true, name: true, city: true, province: true } }, responsible: { select: { fullName: true } }, counters: { select: { quantity: true, unitCost: true } }, _count: { select: { assignments: true } } } });
      type P = Awaited<ReturnType<typeof fetchProjects>>[number];
      const cols: ExportColumn<P>[] = [
        { header: 'کد پروژه', key: 'code', value: (p) => p.code }, { header: 'نام پروژه', key: 'name', width: 28, value: (p) => p.name },
        { header: 'کد مکان', key: 'venue_code', value: (p) => p.venue.code }, { header: 'مکان', key: 'venue', width: 26, value: (p) => p.venue.name },
        { header: 'شهر', key: 'city', value: (p) => p.venue.city }, { header: 'وضعیت', key: 'state', value: (p) => p.state },
        { header: 'محل استقرار', key: 'placement', value: (p) => p.placement }, { header: 'مدل همکاری', key: 'cooperation', value: (p) => p.cooperationCode },
        { header: 'مسئول', key: 'responsible', value: (p) => p.responsible?.fullName }, { header: 'ارز', key: 'currency', value: (p) => p.currency },
        { header: 'آغاز قرارداد', key: 'contract_start', value: (p) => d(p.contractStart) }, { header: 'پایان قرارداد', key: 'contract_end', value: (p) => d(p.contractEnd) },
        { header: 'مبلغ ودیعه', key: 'deposit', money: true, value: (p) => n(p.depositAmount) }, { header: 'مبلغ اجاره', key: 'rent', money: true, value: (p) => n(p.rentAmount) },
        { header: 'دورهٔ اجاره', key: 'rent_period', value: (p) => p.rentPeriod }, { header: 'شارژ ماهیانه', key: 'charge', money: true, value: (p) => n(p.chargeAmount) },
        { header: 'تاریخ برنامهٔ نصب', key: 'install_planned', value: (p) => d(p.installPlannedAt) }, { header: 'تاریخ نصب', key: 'installed', value: (p) => d(p.installedAt) },
        { header: 'هزینهٔ نصب', key: 'install_cost', money: true, value: (p) => n(p.installCost) }, { header: 'هزینهٔ حمل', key: 'transport_cost', money: true, value: (p) => n(p.transportCost) },
        { header: 'تعداد کانتر', key: 'counters', value: (p) => p.counters.reduce((s, c) => s + c.quantity, 0) },
        { header: 'هزینهٔ ساخت کانترها', key: 'fabrication', money: true, value: (p) => p.counters.reduce((s, c) => s.add(money(c.unitCost).mul(c.quantity)), money(0)).toNumber() },
        { header: 'نیروهای مستقر', key: 'staff', value: (p) => p._count.assignments },
      ];
      stream = streamWorkbook('پروژه‌های استقرار', cols, pages(fetchProjects));
    } else if (kind === 'obligations') {
      const q = parse(obligationListSchema.extend({ pageSize: z.coerce.number().default(25) }), query);
      const where = obligationWhere(org, q);
      const fetchObligations = (skip: number) => prisma.siteObligation.findMany({ where, include: obligationInclude, orderBy: { dueDate: 'asc' }, skip, take: 500 });
      type O = Awaited<ReturnType<typeof fetchObligations>>[number];
      const cols: ExportColumn<O>[] = [
        { header: 'کد پروژه', key: 'project_code', value: (o) => o.siteProject.code }, { header: 'پروژه', key: 'project', width: 26, value: (o) => o.siteProject.name },
        { header: 'مکان', key: 'venue', width: 24, value: (o) => o.siteProject.venue.name }, { header: 'شهر', key: 'city', value: (o) => o.siteProject.venue.city },
        { header: 'نوع', key: 'kind', value: (o) => OBLIGATION_KIND_LABELS[o.kind as ObligationKind]?.fa ?? o.kind }, { header: 'شرح', key: 'description', width: 30, value: (o) => o.description },
        { header: 'آغاز دوره', key: 'period_start', value: (o) => d(o.periodStart) }, { header: 'پایان دوره', key: 'period_end', value: (o) => d(o.periodEnd) },
        { header: 'سررسید', key: 'due_date', value: (o) => d(o.dueDate) }, { header: 'ارز', key: 'currency', value: (o) => o.currency },
        { header: 'مبلغ', key: 'amount', money: true, value: (o) => n(o.amount) }, { header: 'تسویه‌شده', key: 'settled', money: true, value: (o) => n(o.settledAmount) },
        { header: 'مانده', key: 'outstanding', money: true, value: (o) => (OPEN.includes(o.status as never) ? money(o.amount).sub(money(o.settledAmount)).toNumber() : 0) },
        { header: 'وضعیت', key: 'status', value: (o) => o.status }, { header: 'دلیل بستن', key: 'close_reason', value: (o) => o.closeReason },
      ];
      stream = streamWorkbook('تعهدات اجاره', cols, pages(fetchObligations));
    } else if (kind === 'payments') {
      const where: Prisma.SitePaymentWhereInput = { organizationId: org, ...(query.siteProjectId ? { siteProjectId: query.siteProjectId } : {}), ...(query.from || query.to ? { paidAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}) };
      const fetchPayments = (skip: number) => prisma.sitePayment.findMany({ where, orderBy: { paidAt: 'asc' }, skip, take: 500, include: { siteProject: { select: { code: true, name: true, venue: { select: { name: true } } } }, recordedBy: { select: { fullName: true } } } });
      type Pay = Awaited<ReturnType<typeof fetchPayments>>[number];
      const cols: ExportColumn<Pay>[] = [
        { header: 'تاریخ', key: 'paid_at', value: (x) => d(x.paidAt) }, { header: 'کد پروژه', key: 'project_code', value: (x) => x.siteProject.code },
        { header: 'پروژه', key: 'project', width: 26, value: (x) => x.siteProject.name }, { header: 'مکان', key: 'venue', width: 24, value: (x) => x.siteProject.venue.name },
        { header: 'نوع', key: 'purpose', value: (x) => x.purpose }, { header: 'ارز', key: 'currency', value: (x) => x.currency }, { header: 'مبلغ', key: 'amount', money: true, value: (x) => n(x.amount) },
        { header: 'نحوهٔ پرداخت', key: 'method', value: (x) => x.methodCode }, { header: 'شمارهٔ پیگیری', key: 'reference', value: (x) => x.reference },
        { header: 'شمارهٔ چک', key: 'cheque_number', value: (x) => x.chequeNumber }, { header: 'بانک', key: 'cheque_bank', value: (x) => x.chequeBank }, { header: 'تاریخ چک', key: 'cheque_date', value: (x) => d(x.chequeDate) },
        { header: 'ثبت‌کننده', key: 'recorded_by', value: (x) => x.recordedBy.fullName }, { header: 'برگشت‌خورده', key: 'reversed', value: (x) => (x.reversedAt ? `بله — ${x.reversalReason ?? ''}` : 'خیر') },
      ];
      stream = streamWorkbook('پرداخت‌ها', cols, pages(fetchPayments));
    } else {
      const report = await rentalReport(org, { province: query.province, city: query.city });
      type Dep = (typeof report.deposits.projects)[number];
      const cols: ExportColumn<Dep>[] = [
        { header: 'کد پروژه', key: 'code', value: (x) => x.code }, { header: 'پروژه', key: 'name', width: 26, value: (x) => x.name }, { header: 'مکان', key: 'venue', width: 24, value: (x) => x.venue },
        { header: 'وضعیت', key: 'state', value: (x) => x.state }, { header: 'پایان قرارداد', key: 'contract_end', value: (x) => d(x.contractEnd) }, { header: 'ارز', key: 'currency', value: (x) => x.currency },
        { header: 'ودیعهٔ پرداخت‌شده', key: 'held', money: true, value: (x) => n(x.held) }, { header: 'کسرشده', key: 'deducted', money: true, value: (x) => n(x.deducted) },
        { header: 'عودت‌شده', key: 'refunded', money: true, value: (x) => n(x.refunded) }, { header: 'مانده نزد مکان', key: 'remaining', money: true, value: (x) => n(x.remaining) },
        { header: 'آمادهٔ عودت', key: 'eligible', value: (x) => (x.eligible ? 'بله' : 'خیر') },
      ];
      stream = streamWorkbook('ودیعه‌ها', cols, (async function* () { yield report.deposits.projects; })());
    }
    await audit({ ...auditCtx(actor), action: 'EXPORT', entityType: 'siteData', after: { kind, filters: query } });
    return reply.header('Content-Type', xlsx).header('Content-Disposition', `attachment; filename="hivamis-${kind}.xlsx"`).send(stream);
  });

};

export default rentalRoutes;
