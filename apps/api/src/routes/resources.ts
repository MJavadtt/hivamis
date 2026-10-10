import type { FastifyPluginAsync } from 'fastify';
import {
  createSupplierSchema, createOutsourceRequestSchema, createAllocationSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { registerCrud } from '../lib/crud.js';
import { actorFrom, parse } from '../lib/http.js';
import { businessHoursBetween, DEFAULT_CALENDAR } from '../lib/business-calendar.js';
import { loadCalendar } from '../sla/engine.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { assertOwnReferences, organizationWhere } from '../lib/scope.js';
import { personLoads } from '../reports/capacity.js';

const resourceRoutes: FastifyPluginAsync = async (app) => {
  registerCrud(app, {
    path: 'suppliers', model: 'supplier',
    permissions: { read: 'supplier.read', write: 'supplier.write' },
    createSchema: createSupplierSchema, updateSchema: createSupplierSchema.partial(),
    sortable: ['name', 'averageRating', 'createdAt'], searchable: ['name', 'specialty', 'contactName'],
    filter: (req) => {
      const { kind, unit } = req.query as Record<string, string | undefined>;
      return { ...(kind ? { kind } : {}), ...(unit ? { departmentCode: unit } : {}) };
    },
    detailInclude: {
      evaluations: { orderBy: { createdAt: 'desc' } },
      outsourceRequests: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });

  registerCrud(app, {
    path: 'outsource-requests', model: 'outsourceRequest',
    workflowEntity: 'outsourceRequest', codeScope: 'outsourceRequest',
    permissions: { read: 'supplier.read', write: 'supplier.request' },
    createSchema: createOutsourceRequestSchema, updateSchema: createOutsourceRequestSchema.partial(),
    sortable: ['createdAt', 'neededBy', 'estimatedCost'], searchable: ['scopeOfWork', 'proposedSupplierName'],
    filter: (req) => {
      const { state, projectId } = req.query as Record<string, string | undefined>;
      return { ...(state ? { state } : {}), ...(projectId ? { projectId } : {}) };
    },
    listInclude: {
      project: { select: { id: true, code: true, name: true } },
      supplier: { select: { id: true, name: true } },
    },
    toCreate: (input, actor) => ({ ...input, requestedById: actor.id }),
  });

  /**
   * One view of a supplier or freelancer (roadmap #45). Doc_H §5 asks for a database and
   * performance management of freelancers; the rows existed (suppliers, evaluations, outsource
   * requests) and nothing aggregated them. This is the page that does.
   */
  app.get('/suppliers/:id/360', {
    preHandler: [app.authenticate, app.requirePermissions('supplier.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const supplier = await prisma.supplier.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!supplier) throw notFound('تأمین‌کننده');
    return { supplier, ...(await supplierProfile(id)) };
  });

  /**
   * Who to send the next request to. Ranked by evidence — evaluations, on-time fulfilment,
   * whether people said they would work with them again — minus what is already on their
   * plate. A supplier with no history ranks by availability alone, and the response says so.
   */
  app.get('/suppliers/suggest', {
    preHandler: [app.authenticate, app.requirePermissions('supplier.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { departmentCode, kind, limit } = req.query as Record<string, string | undefined>;
    const candidates = await prisma.supplier.findMany({
      where: {
        organizationId: actor.organizationId, isActive: true,
        ...(departmentCode ? { departmentCode } : {}), ...(kind ? { kind } : {}),
      },
    });
    const ranked = [];
    for (const c of candidates) {
      const profile = await supplierProfile(c.id);
      ranked.push({ supplier: c, ...profile, score: suggestionScore(profile) });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, Math.min(Number(limit ?? 5) || 5, 20));
  });

  /**
   * Allocations have no organisation column: they reach one through their project, and every route
   * here scopes through it (audit SEC-2 — before, these served and changed every organisation's).
   */
  app.get('/allocations', {
    preHandler: [app.authenticate, app.requirePermissions('resource.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { projectId, userId, from, to } = req.query as Record<string, string | undefined>;
    return prisma.allocation.findMany({
      where: {
        ...organizationWhere('allocation', actor.organizationId),
        ...(projectId ? { projectId } : {}), ...(userId ? { userId } : {}),
        ...(from && to ? { fromDate: { lte: new Date(to) }, toDate: { gte: new Date(from) } } : {}),
      },
      include: {
        user: { select: { id: true, fullName: true, departmentId: true } },
        project: { select: { id: true, code: true, name: true } },
      },
      orderBy: { fromDate: 'asc' },
    });
  });

  app.post('/allocations', {
    preHandler: [app.authenticate, app.requirePermissions('resource.allocate')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createAllocationSchema, req.body);
    // The person and the project both belong to the caller's organisation, or neither exists for it.
    await assertOwnReferences('allocation', input, actor.organizationId);
    const allocation = await prisma.$transaction(async (tx) => {
      const made = await tx.allocation.create({ data: { ...input, createdById: actor.id } });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'allocation',
        entityId: made.id, after: made, ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      }, tx);
      return made;
    });
    return reply.code(201).send(allocation);
  });

  app.delete('/allocations/:id', {
    preHandler: [app.authenticate, app.requirePermissions('resource.allocate')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await prisma.allocation.findFirst({ where: { id, ...organizationWhere('allocation', actor.organizationId) } });
    if (!before) throw notFound('تخصیص');
    await prisma.$transaction(async (tx) => {
      await tx.allocation.delete({ where: { id } });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: 'allocation',
        entityId: id, before, ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      }, tx);
    });
    return reply.code(204).send();
  });

  /**
   * Traffic board (Doc_H §J.85 — «فرم Traffic پروژه», RACI step 32 «کنترل Traffic»).
   * Per-person capacity against committed work, from the same arithmetic the assignment
   * suggestion uses (roadmap #12) — so the board and the suggestion can never disagree. Each
   * person's own calendar and leave are honoured (#13), and capacity is the smaller of what
   * their calendar holds and what their contract says.
   */
  app.get('/traffic', {
    preHandler: [app.authenticate, app.requirePermissions('traffic.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { from, to, unit } = req.query as Record<string, string | undefined>;
    const window = {
      from: from ? new Date(from) : new Date(),
      to: to ? new Date(to) : new Date(Date.now() + 28 * 86_400_000),
    };
    const cal = await loadCalendar(actor.organizationId).catch(() => DEFAULT_CALENDAR);
    const loads = await personLoads(prisma, actor.organizationId, window, { departmentCode: unit });

    // The projects each person is allocated to, for the board's row detail.
    const allocations = await prisma.allocation.findMany({
      where: { userId: { in: loads.map((l) => l.userId) }, fromDate: { lte: window.to }, toDate: { gte: window.from } },
      select: { userId: true, project: { select: { id: true, code: true, name: true } } },
    });
    const units = await prisma.department.findMany({ where: { organizationId: actor.organizationId }, select: { code: true, nameFa: true } });
    const unitByCode = new Map(units.map((d) => [d.code, d]));

    const rows = loads.map((l) => ({
      user: { id: l.userId, fullName: l.fullName, jobTitle: l.jobTitle },
      department: l.departmentCode ? unitByCode.get(l.departmentCode) ?? { code: l.departmentCode, nameFa: l.departmentCode } : null,
      capacityHours: Math.round(l.capacityHours),
      allocatedHours: Math.round(l.allocatedHours),
      taskHours: Math.round(l.taskHours),
      committedHours: Math.round(l.committedHours),
      availableHours: Math.round(l.remainingHours),
      leaveHours: Math.round(l.leaveHours),
      utilisation: l.utilisation,
      status: l.status,
      openTasks: l.openTasks,
      overdueTasks: l.overdueTasks,
      projects: [...new Map(allocations.filter((a) => a.userId === l.userId).map((a) => [a.project.id, a.project])).values()],
    }));

    const windowHours = businessHoursBetween(window.from, window.to, cal);
    return {
      window: {
        from: window.from, to: window.to,
        workingDays: Math.round(windowHours / (cal.endHour - cal.startHour - cal.breakHours)),
      },
      rows,
      summary: {
        people: rows.length,
        overAllocated: rows.filter((r) => r.status === 'OVER_ALLOCATED').length,
        atCapacity: rows.filter((r) => r.status === 'AT_CAPACITY').length,
        underUtilised: rows.filter((r) => r.status === 'UNDER_UTILISED').length,
        onLeave: rows.filter((r) => r.leaveHours > 0).length,
        averageUtilisation: rows.length
          ? Math.round(rows.reduce((s, r) => s + r.utilisation, 0) / rows.length)
          : 0,
      },
    };
  });
};

export interface SupplierProfile {
  evaluations: {
    count: number;
    quality: number | null; timeliness: number | null; communication: number | null; costValue: number | null;
    overall: number | null;
    /** Share of evaluators who said they would work with this supplier again. */
    reuseRate: number | null;
    latest: { projectId: string | null; comments: string | null; overall: number; createdAt: Date; evaluatedBy: string }[];
  };
  requests: {
    total: number;
    byState: Record<string, number>;
    fulfilled: number;
    /** Of the fulfilled requests, the share fulfilled on or before `neededBy`. */
    onTimeRate: number | null;
    /** Approved, not yet fulfilled: what is on their plate right now. */
    open: number;
    averageCost: number | null;
    projects: number;
  };
  timeline: { at: Date; kind: 'REQUEST' | 'EVALUATION'; code: string | null; label: string; projectId: string | null }[];
}

async function supplierProfile(supplierId: string): Promise<SupplierProfile> {
  const [evaluations, requests] = await Promise.all([
    prisma.supplierEvaluation.findMany({ where: { supplierId }, orderBy: { createdAt: 'desc' } }),
    prisma.outsourceRequest.findMany({ where: { supplierId }, orderBy: { createdAt: 'desc' } }),
  ]);

  // Fulfilment time is the FULFILLED transition, not updatedAt — anything can touch updatedAt.
  const fulfilledIds = requests.filter((r) => r.state === 'FULFILLED').map((r) => r.id);
  const fulfilledAt = new Map<string, Date>();
  if (fulfilledIds.length) {
    const rows = await prisma.stateTransition.findMany({
      where: { entityType: 'outsourceRequest', entityId: { in: fulfilledIds }, toState: 'FULFILLED' },
      select: { entityId: true, createdAt: true }, orderBy: { createdAt: 'desc' },
    });
    for (const r of rows) if (!fulfilledAt.has(r.entityId)) fulfilledAt.set(r.entityId, r.createdAt);
  }

  const evaluators = new Map(
    (await prisma.user.findMany({
      where: { id: { in: [...new Set(evaluations.map((e) => e.evaluatedById))] } }, select: { id: true, fullName: true },
    })).map((u) => [u.id, u.fullName]),
  );

  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  const dims = ['quality', 'timeliness', 'communication', 'costValue'] as const;
  const per = Object.fromEntries(dims.map((d) => [d, avg(evaluations.map((e) => e[d]))])) as Record<(typeof dims)[number], number | null>;
  const overall = avg(evaluations.map((e) => (e.quality + e.timeliness + e.communication + e.costValue) / 4));

  const onTime: number[] = [];
  for (const id of fulfilledIds) {
    const r = requests.find((x) => x.id === id)!;
    const at = fulfilledAt.get(id);
    if (at) onTime.push(at <= r.neededBy ? 1 : 0);
  }

  const byState: Record<string, number> = {};
  for (const r of requests) byState[r.state] = (byState[r.state] ?? 0) + 1;

  const projects = new Set<string>();
  for (const r of requests) if (r.projectId) projects.add(r.projectId);
  for (const e of evaluations) if (e.projectId) projects.add(e.projectId);

  const timeline = [
    ...requests.map((r) => ({ at: r.createdAt, kind: 'REQUEST' as const, code: r.code, label: r.scopeOfWork, projectId: r.projectId })),
    ...evaluations.map((e) => ({
      at: e.createdAt, kind: 'EVALUATION' as const, code: null,
      label: `ارزیابی ${Math.round(((e.quality + e.timeliness + e.communication + e.costValue) / 4) * 10) / 10} از ۵${e.comments ? ` — ${e.comments}` : ''}`,
      projectId: e.projectId,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 20);

  return {
    evaluations: {
      count: evaluations.length, ...per, overall,
      reuseRate: evaluations.length ? Math.round((evaluations.filter((e) => e.wouldReuse).length / evaluations.length) * 100) : null,
      latest: evaluations.slice(0, 5).map((e) => ({
        projectId: e.projectId, comments: e.comments, createdAt: e.createdAt, evaluatedBy: evaluators.get(e.evaluatedById) ?? '—',
        overall: Math.round(((e.quality + e.timeliness + e.communication + e.costValue) / 4) * 10) / 10,
      })),
    },
    requests: {
      total: requests.length, byState, fulfilled: fulfilledIds.length,
      onTimeRate: onTime.length ? Math.round((onTime.reduce((a, b) => a + b, 0) / onTime.length) * 100) : null,
      open: requests.filter((r) => r.state === 'APPROVED').length,
      averageCost: avg(requests.map((r) => Number(r.estimatedCost))),
      projects: projects.size,
    },
    timeline,
  };
}

/**
 * 0–100. Evidence weighs most: the overall evaluation (0–5, scaled to 50), on-time fulfilment
 * (to 25), reuse (to 15), then availability (10 minus 2 per open request). No history scores
 * availability only, so a proven supplier always outranks an unknown one with a free calendar.
 */
export function suggestionScore(p: SupplierProfile): number {
  const evaluation = p.evaluations.overall == null ? 0 : (p.evaluations.overall / 5) * 50;
  const onTime = p.requests.onTimeRate == null ? 0 : (p.requests.onTimeRate / 100) * 25;
  const reuse = p.evaluations.reuseRate == null ? 0 : (p.evaluations.reuseRate / 100) * 15;
  const availability = Math.max(0, 10 - 2 * p.requests.open);
  return Math.round((evaluation + onTime + reuse + availability) * 10) / 10;
}

export default resourceRoutes;
