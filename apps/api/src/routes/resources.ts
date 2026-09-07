import type { FastifyPluginAsync } from 'fastify';
import {
  createSupplierSchema, createOutsourceRequestSchema, createAllocationSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { registerCrud } from '../lib/crud.js';
import { actorFrom, parse } from '../lib/http.js';
import { businessHoursBetween, DEFAULT_CALENDAR } from '../lib/business-calendar.js';
import { loadCalendar } from '../sla/engine.js';

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

  app.get('/allocations', {
    preHandler: [app.authenticate, app.requirePermissions('resource.read')],
  }, async (req) => {
    const { projectId, userId, from, to } = req.query as Record<string, string | undefined>;
    return prisma.allocation.findMany({
      where: {
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
    const allocation = await prisma.allocation.create({
      data: { ...input, createdById: actor.id },
    });
    return reply.code(201).send(allocation);
  });

  app.delete('/allocations/:id', {
    preHandler: [app.authenticate, app.requirePermissions('resource.allocate')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.allocation.delete({ where: { id } });
    return reply.code(204).send();
  });

  /**
   * Traffic board (Doc_H §J.85 — «فرم Traffic پروژه», RACI step 32 «کنترل Traffic»).
   * Computes per-person capacity vs. committed hours over a window and flags over-allocation,
   * which is the bottleneck signal the PMO needs.
   */
  app.get('/traffic', {
    preHandler: [app.authenticate, app.requirePermissions('traffic.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { from, to, unit } = req.query as Record<string, string | undefined>;
    const fromDate = from ? new Date(from) : new Date();
    const toDate = to ? new Date(to) : new Date(Date.now() + 28 * 86_400_000);
    const cal = await loadCalendar(actor.organizationId).catch(() => DEFAULT_CALENDAR);

    const users = await prisma.user.findMany({
      where: {
        organizationId: actor.organizationId, isActive: true, deletedAt: null,
        ...(unit ? { department: { code: unit } } : {}),
      },
      include: { department: { select: { code: true, nameFa: true } } },
      orderBy: { fullName: 'asc' },
    });

    const [allocations, tasks] = await Promise.all([
      prisma.allocation.findMany({
        where: { fromDate: { lte: toDate }, toDate: { gte: fromDate } },
        include: { project: { select: { id: true, code: true, name: true } } },
      }),
      prisma.task.findMany({
        where: {
          organizationId: actor.organizationId,
          state: { notIn: ['APPROVED', 'CLOSED', 'CANCELLED'] },
          dueDate: { gte: fromDate, lte: toDate },
        },
        include: { project: { select: { id: true, code: true, name: true } } },
      }),
    ]);

    // Working hours available in the window, from the organisation's own calendar.
    const windowHours = businessHoursBetween(fromDate, toDate, cal);
    const workingDays = windowHours / (cal.endHour - cal.startHour - cal.breakHours);

    const rows = users.map((u) => {
      const mine = allocations.filter((a) => a.userId === u.id);
      const myTasks = tasks.filter((t) => t.assigneeId === u.id);
      const allocatedHours = mine.reduce((sum, a) => {
        const start = a.fromDate > fromDate ? a.fromDate : fromDate;
        const end = a.toDate < toDate ? a.toDate : toDate;
        const days = Math.max(0, (end.getTime() - start.getTime()) / 86_400_000);
        // Approximate working days inside the overlap using the calendar's weekly ratio.
        const workingRatio = cal.workingDays.length / 7;
        return sum + days * workingRatio * Number(a.hoursPerDay);
      }, 0);
      const taskHours = myTasks.reduce((s, t) => s + Number(t.estimateHours ?? 0), 0);
      const capacityHours = (Number(u.weeklyCapacityHours) / 5) * workingDays;
      const committed = Math.max(allocatedHours, taskHours);
      const utilisation = capacityHours > 0 ? Math.round((committed / capacityHours) * 100) : 0;

      return {
        user: { id: u.id, fullName: u.fullName, jobTitle: u.jobTitle },
        department: u.department,
        capacityHours: Math.round(capacityHours),
        allocatedHours: Math.round(allocatedHours),
        taskHours: Math.round(taskHours),
        committedHours: Math.round(committed),
        availableHours: Math.round(capacityHours - committed),
        utilisation,
        status: utilisation > 100 ? 'OVER_ALLOCATED' : utilisation >= 85 ? 'AT_CAPACITY' : utilisation >= 40 ? 'HEALTHY' : 'UNDER_UTILISED',
        openTasks: myTasks.length,
        overdueTasks: myTasks.filter((t) => t.dueDate && t.dueDate < new Date()).length,
        projects: [...new Map(mine.map((a) => [a.project.id, a.project])).values()],
      };
    });

    return {
      window: { from: fromDate, to: toDate, workingDays: Math.round(workingDays) },
      rows,
      summary: {
        people: rows.length,
        overAllocated: rows.filter((r) => r.status === 'OVER_ALLOCATED').length,
        atCapacity: rows.filter((r) => r.status === 'AT_CAPACITY').length,
        underUtilised: rows.filter((r) => r.status === 'UNDER_UTILISED').length,
        averageUtilisation: rows.length
          ? Math.round(rows.reduce((s, r) => s + r.utilisation, 0) / rows.length)
          : 0,
      },
    };
  });
};

export default resourceRoutes;
