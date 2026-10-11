import type { FastifyPluginAsync } from 'fastify';
import { closeRevenuePeriodSchema, milestoneUpdateSchema, revenueSettingsSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { money, toMoney } from '../lib/money.js';
import {
  closePeriod, cumulativeAt, expectedLoss, frozen, lastMonths, loadRevenueData, METHOD_FA, monthFlows,
  positionAt, revenueReport,
} from '../finance/revenue.js';

const FA = '۰۱۲۳۴۵۶۷۸۹';
const fa = (v: string | number) => String(v).replace(/\d/g, (c) => FA[Number(c)]!);

/** Revenue recognition and work in progress (roadmap #29). */
const revenueRoutes: FastifyPluginAsync = async (app) => {
  /** One project: how it earns, how far it has, what is billed, month by month. */
  app.get('/projects/:id/revenue', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null }, select: { id: true } });
    if (!project) throw notFound('پروژه');
    const now = new Date();
    const data = await loadRevenueData(prisma, actor.organizationId, [id]);
    const fz = await frozen(prisma, actor.organizationId);
    const pos = positionAt(data, id, now);
    const months = lastMonths(12, now).map((m) => {
      const entry = fz.byProject.get(id)?.get(m.period);
      const end = m.end < now ? m.end : now;
      const recognisedToDate = entry ? Number(entry.recognisedToDate) : cumulativeAt(data, fz, id, end);
      const start = cumulativeAt(data, fz, id, m.start);
      return {
        period: m.period, labelFa: m.labelFa, closed: fz.periods.some((p) => p.period === m.period),
        recognised: entry ? Number(entry.amount) : recognisedToDate == null ? null : money(recognisedToDate).sub(money(start)).toNumber(),
        recognisedToDate, invoiced: monthFlows(data, { start: m.start, end }).invoiced,
      };
    });
    return {
      method: pos.method, methodFa: METHOD_FA[pos.method], methods: Object.entries(METHOD_FA).map(([key, labelFa]) => ({ key, labelFa })),
      position: pos, expectedLoss: expectedLoss(data, id),
      milestones: data.milestones.get(id) ?? [],
      months: months.filter((m) => m.recognised || m.invoiced),
      lastClosed: fz.last?.period ?? null,
    };
  });

  /** Choose the method, and set each milestone's share. Takes effect from the next open period. */
  app.patch('/projects/:id/revenue', { preHandler: [app.authenticate, app.requirePermissions('finance.budget')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(revenueSettingsSchema, req.body);
    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null }, include: { milestones: true } });
    if (!project) throw notFound('پروژه');

    if (input.shares) {
      const own = new Map(project.milestones.map((m) => [m.id, m]));
      const foreign = input.shares.filter((s) => !own.has(s.milestoneId));
      if (foreign.length) throw new AppError(422, 'MILESTONE_NOT_IN_PROJECT', 'نقطهٔ عطفی از پروژهٔ دیگری در فهرست است.');
      const next = new Map(project.milestones.map((m) => [m.id, m.revenueShare == null ? 0 : Number(m.revenueShare)]));
      for (const s of input.shares) next.set(s.milestoneId, s.revenueShare ?? 0);
      const total = [...next.values()].reduce((a, b) => a + b, 0);
      if (total > 100.0001) {
        throw new AppError(422, 'REVENUE_SHARES_OVER_100', `جمع سهم درآمد نقاط عطف ${fa(toMoney(total))}٪ می‌شود؛ بیش از صد درصد قرارداد شناسایی نمی‌شود.`, { total });
      }
    }
    const before = { method: project.revenueMethod, shares: project.milestones.map((m) => ({ id: m.id, revenueShare: m.revenueShare })) };
    await prisma.$transaction(async (tx) => {
      if (input.method) await tx.project.update({ where: { id }, data: { revenueMethod: input.method } });
      for (const s of input.shares ?? []) await tx.milestone.update({ where: { id: s.milestoneId }, data: { revenueShare: s.revenueShare } });
    });
    const fz = await frozen(prisma, actor.organizationId);
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'project', entityId: id,
      before, after: { method: input.method ?? project.revenueMethod, shares: input.shares }, reason: input.note ?? 'revenue recognition settings',
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return {
      ok: true,
      noteFa: fz.last ? `ماه‌های بسته‌شده تا ${fz.last.period} تغییر نمی‌کنند؛ اثر این تغییر در نخستین دورهٔ باز به‌صورت اصلاحی می‌نشیند.` : null,
    };
  });

  /** A milestone done — or undone, when it was marked by mistake. */
  app.patch('/projects/:id/milestones/:mid', { preHandler: [app.authenticate, app.requirePermissions('project.plan')] }, async (req) => {
    const actor = actorFrom(req);
    const { id, mid } = req.params as { id: string; mid: string };
    const input = parse(milestoneUpdateSchema, req.body);
    const m = await prisma.milestone.findFirst({ where: { id: mid, projectId: id, project: { organizationId: actor.organizationId } } });
    if (!m) throw notFound('نقطهٔ عطف');
    if (input.completedAt && input.completedAt > new Date()) throw new AppError(422, 'COMPLETED_IN_FUTURE', 'نقطهٔ عطف را نمی‌توان در آینده انجام‌شده ثبت کرد.');
    const updated = await prisma.milestone.update({ where: { id: mid }, data: input });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'milestone', entityId: mid,
      before: m, after: updated, ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return updated;
  });

  app.get('/reports/revenue', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { months } = req.query as { months?: string };
    const count = Math.min(24, Math.max(1, Number(months) || 12));
    return revenueReport(prisma, actor.organizationId, count, new Date());
  });

  app.get('/revenue/periods', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    return prisma.revenuePeriod.findMany({ where: { organizationId: actor.organizationId }, orderBy: { periodEnd: 'desc' } });
  });

  /** Close a month: its recognition is frozen, and later changes land in the next open month. */
  app.post('/revenue/periods/close', { preHandler: [app.authenticate, app.requirePermissions('finance.settle')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { period } = parse(closeRevenuePeriodSchema, req.body);
    const result = await prisma.$transaction((tx) => closePeriod(tx, actor.organizationId, period, actor.id, new Date()), { timeout: 30_000 });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'REVENUE_PERIOD_CLOSED', entityType: 'revenuePeriod',
      entityId: result.period.id, after: { period, totals: result.totals, unmeasured: result.unmeasured },
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(result);
  });
};

export default revenueRoutes;
