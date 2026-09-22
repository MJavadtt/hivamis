import type { FastifyPluginAsync } from 'fastify';
import {
  createBriefSchema, updateBriefSchema, createProposalSchema, updateProposalSchema,
  setPricingSchema, declareCostSchema, createProjectSchema, updateProjectSchema,
  authorizeProjectSchema, createWorkOrderSchema, createTaskSchema, updateTaskSchema,
  createDeliverableSchema, createRaciSchema, createMilestoneSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { registerCrud } from '../lib/crud.js';
import { actorFrom, parse } from '../lib/http.js';
import { badRequest, forbidden, notFound, GovernanceError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { hasPermission } from '../auth/plugin.js';
import { nextCode } from '../lib/codes.js';
import { briefCompleteness } from '../workflow/guards.js';
import { allowedFor } from '../workflow/engine.js';
import { startSla } from '../sla/engine.js';
import { checkWorkOrderBudget, projectBudget } from '../reports/budget.js';
import { logTime, recomputeActual } from '../reports/time.js';
import { scheduleProject } from '../reports/schedule.js';
import { forecastProject } from '../reports/forecast.js';
import { suggestAssignees } from '../reports/capacity.js';

const deliveryRoutes: FastifyPluginAsync = async (app) => {
  /* ── Briefs ──────────────────────────────────────────────────────────── */
  registerCrud(app, {
    path: 'briefs', model: 'brief', workflowEntity: 'brief', codeScope: 'brief',
    permissions: { read: 'brief.read', write: 'brief.write' },
    createSchema: createBriefSchema, updateSchema: updateBriefSchema,
    sortable: ['createdAt', 'completenessScore'], searchable: ['title', 'scope'],
    filter: (req) => {
      const { state, opportunityId } = req.query as Record<string, string | undefined>;
      return { ...(state ? { state } : {}), ...(opportunityId ? { opportunityId } : {}) };
    },
    listInclude: {
      opportunity: { select: { id: true, code: true, title: true, company: { select: { legalName: true } } } },
    },
    detailInclude: {
      opportunity: { include: { company: true } },
      proposals: { select: { id: true, code: true, title: true, state: true, version: true } },
    },
    toCreate: (input, actor) => ({ ...input, submittedById: actor.id }),
    softDelete: true,
  });

  /** Recompute the Doc_H completeness score after any edit so the guard sees fresh data. */
  app.post('/briefs/:id/recalculate', {
    preHandler: [app.authenticate, app.requirePermissions('brief.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const brief = await prisma.brief.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!brief) throw notFound('بریف');
    const { score, missing } = briefCompleteness(brief as unknown as Record<string, unknown>);
    return prisma.brief.update({
      where: { id }, data: { completenessScore: score, missingItems: missing },
    });
  });

  /* ── Proposals & pricing ─────────────────────────────────────────────── */
  registerCrud(app, {
    path: 'proposals', model: 'proposal', workflowEntity: 'proposal', codeScope: 'proposal',
    permissions: { read: 'proposal.read', write: 'proposal.write' },
    createSchema: createProposalSchema, updateSchema: updateProposalSchema,
    sortable: ['createdAt', 'salePrice'], searchable: ['title', 'executiveSummary'],
    filter: (req) => {
      const { state, briefId } = req.query as Record<string, string | undefined>;
      return { ...(state ? { state } : {}), ...(briefId ? { briefId } : {}) };
    },
    listInclude: {
      brief: { select: { id: true, code: true, title: true, opportunity: { select: { company: { select: { legalName: true } } } } } },
    },
    detailInclude: {
      brief: { include: { opportunity: { include: { company: true } } } },
      workOrders: true, costDeclarations: true,
      qcReviews: { orderBy: { reviewedAt: 'desc' } },
      versions: { orderBy: { version: 'desc' } },
    },
    softDelete: true,
  });

  /**
   * Doc_H §12 — cost is declared by the executing unit. Sale price is NOT settable here;
   * the `pricing.declare_cost` permission granted to units deliberately excludes it.
   */
  app.post('/proposals/:id/costs', {
    preHandler: [app.authenticate, app.requirePermissions('pricing.declare_cost')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(declareCostSchema, req.body);

    const proposal = await prisma.proposal.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!proposal) throw notFound('پروپوزال');

    const declaration = await prisma.$transaction(async (tx) => {
      const created = await tx.costDeclaration.create({
        data: {
          organizationId: actor.organizationId,
          proposalId: id,
          workOrderId: input.workOrderId ?? null,
          departmentCode: input.departmentCode,
          internalCost: input.internalCost,
          externalCost: input.externalCost,
          items: input.items as object,
          assumptions: input.assumptions ?? null,
          declaredById: actor.id,
        },
      });
      const agg = await tx.costDeclaration.aggregate({
        where: { proposalId: id }, _sum: { internalCost: true, externalCost: true },
      });
      await tx.proposal.update({
        where: { id },
        data: { totalCost: Number(agg._sum.internalCost ?? 0) + Number(agg._sum.externalCost ?? 0) },
      });
      return created;
    });

    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE',
      entityType: 'costDeclaration', entityId: declaration.id, after: declaration,
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(declaration);
  });

  /** Doc_H §12 — the sale price gate. Account/Finance set it; management approves it. */
  app.post('/proposals/:id/pricing', {
    preHandler: [app.authenticate, app.requirePermissions('pricing.set_price')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(setPricingSchema, req.body);

    const proposal = await prisma.proposal.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!proposal) throw notFound('پروپوزال');
    if (proposal.totalCost == null) {
      throw new GovernanceError(
        'Doc_H §12 — اعلام قیمت تمام‌شده',
        'قیمت فروش پیش از اعلام قیمت تمام‌شده توسط واحدها قابل تعیین نیست.',
      );
    }

    const cost = Number(proposal.totalCost);
    const margin = input.marginPercent ?? (input.salePrice > 0
      ? ((input.salePrice - cost) / input.salePrice) * 100
      : 0);

    const updated = await prisma.proposal.update({
      where: { id },
      data: {
        salePrice: input.salePrice,
        marginPercent: Number(margin.toFixed(2)),
        paymentTerms: input.paymentTerms ?? proposal.paymentTerms,
        contractScaleBand: input.contractScaleBand ?? proposal.contractScaleBand,
        pricingRationale: input.rationale,
        pricedById: actor.id,
        pricedAt: new Date(),
        // Setting a new price invalidates any previous management approval.
        pricingApprovedById: null,
        pricingApprovedAt: null,
      },
    });

    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
      entityType: 'proposal', entityId: id,
      before: { salePrice: proposal.salePrice, marginPercent: proposal.marginPercent },
      after: { salePrice: updated.salePrice, marginPercent: updated.marginPercent },
      reason: input.rationale, ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return updated;
  });

  app.post('/proposals/:id/pricing/approve', {
    preHandler: [app.authenticate, app.requirePermissions('pricing.approve')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const proposal = await prisma.proposal.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!proposal) throw notFound('پروپوزال');
    if (proposal.salePrice == null) {
      throw badRequest('NO_PRICE', 'قیمتی برای تأیید ثبت نشده است.');
    }
    if (proposal.pricedById === actor.id) {
      throw forbidden('تأیید قیمت توسط همان فردی که آن را تعیین کرده مجاز نیست.');
    }
    const updated = await prisma.proposal.update({
      where: { id }, data: { pricingApprovedById: actor.id, pricingApprovedAt: new Date() },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'APPROVE',
      entityType: 'proposal', entityId: id, after: { salePrice: updated.salePrice },
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return updated;
  });

  /* ── Projects ────────────────────────────────────────────────────────── */
  registerCrud(app, {
    path: 'projects', model: 'project', workflowEntity: 'project', codeScope: 'project',
    permissions: { read: 'project.read', write: 'project.write' },
    createSchema: createProjectSchema, updateSchema: updateProjectSchema,
    sortable: ['createdAt', 'plannedEnd', 'name'], searchable: ['name', 'objective'],
    filter: (req) => {
      const { state, companyId, accountOwnerId, health } = req.query as Record<string, string | undefined>;
      return {
        ...(state ? { state } : {}), ...(companyId ? { companyId } : {}),
        ...(accountOwnerId ? { accountOwnerId } : {}), ...(health ? { healthStatus: health } : {}),
      };
    },
    listInclude: {
      company: { select: { id: true, legalName: true, brandName: true } },
      accountOwner: { select: { id: true, fullName: true } },
      _count: { select: { tasks: true, deliverables: true, changeRequests: true, risks: true } },
    },
    softDelete: true,
  });

  /** Doc_H §13 — record one of the three authorisation bases. */
  app.post('/projects/:id/authorize', {
    preHandler: [app.authenticate, app.requirePermissions('project.authorize')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(authorizeProjectSchema, req.body);

    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!project) throw notFound('پروژه');

    if (input.basis === 'CONTRACT') {
      if (!input.contractId) {
        throw new GovernanceError('Doc_H §13', 'مبنای «قرارداد» بدون انتخاب قرارداد معتبر نیست.');
      }
      const contract = await prisma.contract.findFirst({ where: { id: input.contractId, organizationId: actor.organizationId } });
      if (!contract || !['SIGNED', 'REGISTERED'].includes(contract.state)) {
        throw new GovernanceError('Doc_H §13', 'قرارداد انتخاب‌شده هنوز امضا/ثبت نشده است.');
      }
    }
    if (input.basis === 'INVOICED_EXECUTION_ORDER' && !input.invoiceId) {
      throw new GovernanceError(
        'Doc_H §G — پروژه فاکتوری',
        'دستور اجرای فاکتوری باید به پیش‌فاکتور یا فاکتور متصل باشد.',
      );
    }

    const authorization = await prisma.executionAuthorization.create({
      data: {
        projectId: id, basis: input.basis, contractId: input.contractId ?? null,
        invoiceId: input.invoiceId ?? null, referenceDocument: input.referenceDocument,
        notes: input.notes ?? null, authorizedById: actor.id,
      },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'APPROVE',
      entityType: 'executionAuthorization', entityId: authorization.id, after: authorization,
      reason: `basis=${input.basis}`, ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(authorization);
  });

  app.post('/projects/:id/raci', {
    preHandler: [app.authenticate, app.requirePermissions('project.raci')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(createRaciSchema, { ...(req.body as object), projectId: id });

    const entries = await prisma.$transaction(async (tx) => {
      await tx.raciAssignment.deleteMany({ where: { projectId: id } });
      await tx.raciAssignment.createMany({
        data: input.entries.map((e) => ({
          projectId: id, activity: e.activity, departmentCode: e.departmentCode,
          raciRole: e.raciRole, userId: e.userId ?? null,
        })),
      });
      return tx.raciAssignment.findMany({ where: { projectId: id } });
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
      entityType: 'raciAssignment', entityId: id, after: { count: entries.length },
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(entries);
  });

  app.post('/projects/:id/milestones', {
    preHandler: [app.authenticate, app.requirePermissions('project.plan')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = parse(createMilestoneSchema, { ...(req.body as object), projectId: id });
    const m = await prisma.milestone.create({ data: input });
    return reply.code(201).send(m);
  });

  /** Doc_H §15 — the eight closure conditions, readable and updatable as a checklist. */
  app.get('/projects/:id/closure', {
    preHandler: [app.authenticate, app.requirePermissions('project.read')],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const checklist = await prisma.closureChecklist.findUnique({ where: { projectId: id } });
    const labels: Record<string, string> = {
      allDeliverablesDelivered: 'تحویل تمام خروجی‌ها',
      finalQcDone: 'انجام QC نهایی',
      clientApprovalRecorded: 'ثبت تأیید مشتری',
      closureReportDone: 'تکمیل گزارش پایان پروژه',
      financialStatusClear: 'مشخص بودن وضعیت مالی',
      feedbackRecorded: 'ثبت Feedback مشتری',
      lessonsLearnedRecorded: 'ثبت Lessons Learned',
      closedInSystem: 'بستن پروژه در سیستم',
    };
    const items = Object.entries(labels).map(([key, labelFa]) => ({
      key, labelFa, done: checklist ? Boolean((checklist as Record<string, any>)[key]) : false,
    }));
    return {
      checklist,
      items,
      complete: items.filter((i) => i.key !== 'closedInSystem').every((i) => i.done),
    };
  });

  app.patch('/projects/:id/closure', {
    preHandler: [app.authenticate, app.requirePermissions('project.close')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, boolean | string>;
    const allowed = [
      'allDeliverablesDelivered', 'finalQcDone', 'clientApprovalRecorded', 'closureReportDone',
      'financialStatusClear', 'feedbackRecorded', 'lessonsLearnedRecorded',
    ];
    const data: Record<string, unknown> = { updatedById: actor.id };
    for (const key of allowed) if (key in body) data[key] = Boolean(body[key]);
    if (typeof body.notes === 'string') data.notes = body.notes;

    return prisma.closureChecklist.upsert({
      where: { projectId: id },
      create: { projectId: id, ...data } as never,
      update: data,
    });
  });

  /** Project 360 — the unified project view. */
  app.get('/projects/:id/360', {
    preHandler: [app.authenticate, app.requirePermissions('project.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const canSeeFinance = actor.permissions.includes('finance.read');

    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId },
      include: {
        company: true,
        accountOwner: { select: { id: true, fullName: true, email: true } },
        brief: { select: { id: true, code: true, title: true, completenessScore: true } },
        proposal: { select: { id: true, code: true, title: true, salePrice: true, marginPercent: true } },
        authorizations: { orderBy: { authorizedAt: 'desc' } },
        milestones: { orderBy: { dueDate: 'asc' } },
        raciAssignments: { include: { user: { select: { id: true, fullName: true } } } },
        closureChecklist: true,
      },
    });
    if (!project) throw notFound('پروژه');

    const [workOrders, tasks, deliverables, changeRequests, risks, issues, decisions, meetings,
           statusReports, revisions, invoices, payments, allocations, documents, slaClocks] =
      await Promise.all([
        prisma.workOrder.findMany({ where: { projectId: id }, include: { owner: { select: { fullName: true } } } }),
        prisma.task.findMany({
          where: { projectId: id },
          include: { assignee: { select: { id: true, fullName: true } } },
          orderBy: { dueDate: 'asc' },
        }),
        prisma.deliverable.findMany({ where: { projectId: id }, orderBy: { dueDate: 'asc' } }),
        prisma.changeRequest.findMany({ where: { projectId: id }, orderBy: { createdAt: 'desc' } }),
        prisma.risk.findMany({ where: { projectId: id }, orderBy: { createdAt: 'desc' } }),
        prisma.issue.findMany({ where: { projectId: id }, orderBy: { createdAt: 'desc' } }),
        prisma.decision.findMany({ where: { projectId: id }, orderBy: { decidedAt: 'desc' } }),
        prisma.meeting.findMany({ where: { projectId: id }, orderBy: { heldAt: 'desc' }, take: 30 }),
        prisma.statusReport.findMany({ where: { projectId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
        prisma.revision.findMany({
          where: { deliverable: { projectId: id } }, orderBy: { createdAt: 'desc' },
        }),
        canSeeFinance ? prisma.invoice.findMany({ where: { projectId: id } }) : Promise.resolve([]),
        canSeeFinance ? prisma.payment.findMany({ where: { projectId: id } }) : Promise.resolve([]),
        prisma.allocation.findMany({
          where: { projectId: id }, include: { user: { select: { id: true, fullName: true } } },
        }),
        prisma.document.findMany({ where: { projectId: id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
        prisma.slaClock.findMany({
          where: { entityType: { in: ['project', 'task', 'deliverable', 'workOrder'] }, state: { in: ['RUNNING', 'AT_RISK', 'BREACHED'] } },
          include: { policy: true }, take: 100,
        }),
      ]);

    const actualCost = canSeeFinance
      ? (await prisma.costDeclaration.aggregate({
          where: { workOrder: { projectId: id } }, _sum: { internalCost: true, externalCost: true },
        }))
      : null;

    const doneTasks = tasks.filter((t) => ['APPROVED', 'CLOSED'].includes(t.state)).length;
    const overdue = tasks.filter(
      (t) => t.dueDate && t.dueDate < new Date() && !['APPROVED', 'CLOSED', 'CANCELLED'].includes(t.state),
    ).length;

    const cost = actualCost
      ? Number(actualCost._sum.internalCost ?? 0) + Number(actualCost._sum.externalCost ?? 0)
      : 0;
    const revenue = Number(project.contractValue ?? 0);

    return {
      project, workOrders, tasks, deliverables, changeRequests, risks, issues, decisions,
      meetings, statusReports, revisions, allocations, documents,
      slaClocks: slaClocks.filter((c) => c.entityId === id || tasks.some((t) => t.id === c.entityId)),
      finance: canSeeFinance
        ? {
            invoices, payments,
            budget: Number(project.plannedBudget ?? 0),
            actualCost: cost,
            revenue,
            margin: revenue - cost,
            marginPercent: revenue > 0 ? Number((((revenue - cost) / revenue) * 100).toFixed(2)) : null,
            invoiced: invoices.reduce((s, i) => s + Number(i.total), 0),
            received: invoices.reduce((s, i) => s + Number(i.paidAmount), 0),
          }
        : null,
      metrics: {
        taskCount: tasks.length,
        tasksDone: doneTasks,
        taskCompletion: tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0,
        overdueTasks: overdue,
        openRisks: risks.filter((r) => r.state === 'OPEN').length,
        openIssues: issues.filter((i) => ['OPEN', 'IN_PROGRESS'].includes(i.state)).length,
        openChangeRequests: changeRequests.filter((c) => !['CLOSED', 'REJECTED'].includes(c.state)).length,
        revisionCount: revisions.length,
        deliverablesAccepted: deliverables.filter((d) => d.state === 'ACCEPTED').length,
      },
      availableTransitions: allowedFor('project', project.state, actor.permissions),
    };
  });

  /* ── Work orders ─────────────────────────────────────────────────────── */
  registerCrud(app, {
    path: 'work-orders', model: 'workOrder', workflowEntity: 'workOrder', codeScope: 'workOrder',
    permissions: { read: 'workorder.read', write: 'workorder.issue' },
    createSchema: createWorkOrderSchema, updateSchema: createWorkOrderSchema.partial(),
    sortable: ['createdAt', 'deadline'], searchable: ['title', 'scopeOfWork'],
    filter: (req) => {
      const { state, projectId, unit } = req.query as Record<string, string | undefined>;
      return {
        ...(state ? { state } : {}), ...(projectId ? { projectId } : {}),
        ...(unit ? { targetDepartmentCode: unit } : {}),
      };
    },
    listInclude: {
      project: { select: { id: true, code: true, name: true } },
      owner: { select: { id: true, fullName: true } },
    },
    detailInclude: {
      project: { include: { company: { select: { legalName: true } } } },
      owner: { select: { id: true, fullName: true } },
      tasks: true, deliverables: true, costDeclarations: true,
    },
  });

  /** Doc_H §12 — unit-level cost declaration attached to a work order. */
  app.post('/work-orders/:id/cost', {
    preHandler: [app.authenticate, app.requirePermissions('pricing.declare_cost')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(declareCostSchema, req.body);
    const wo = await prisma.workOrder.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!wo) throw notFound('سفارش کار');

    const declaration = await prisma.costDeclaration.create({
      data: {
        organizationId: actor.organizationId, workOrderId: id, proposalId: wo.proposalId,
        departmentCode: input.departmentCode, internalCost: input.internalCost,
        externalCost: input.externalCost, items: input.items as object,
        assumptions: input.assumptions ?? null, declaredById: actor.id,
      },
    });
    if (wo.proposalId) {
      const agg = await prisma.costDeclaration.aggregate({
        where: { proposalId: wo.proposalId }, _sum: { internalCost: true, externalCost: true },
      });
      await prisma.proposal.update({
        where: { id: wo.proposalId },
        data: { totalCost: Number(agg._sum.internalCost ?? 0) + Number(agg._sum.externalCost ?? 0) },
      });
    }
    // Budget control happens here, while the unit can still act — not in the monthly report.
    const budget = await checkWorkOrderBudget(prisma, id, actor.id);
    return reply.code(201).send({ ...declaration, budget });
  });

  /** Budget against declared cost, per work order and per unit — where control is possible. */
  app.get('/projects/:id/budget', {
    preHandler: [app.authenticate, app.requirePermissions('project.read', 'pricing.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!project) throw notFound('پروژه');
    return projectBudget(prisma, id);
  });

  /* ── Schedule and dependencies (roadmap #10) ─────────────────────────── */

  app.get('/projects/:id/schedule', {
    preHandler: [app.authenticate, app.requirePermissions('project.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!project) throw notFound('پروژه');
    return scheduleProject(prisma, actor.organizationId, id);
  });

  /**
   * Who has room for this work (roadmap #12). Takes the unit, the hours and the due date —
   * or a task, and reads all three from it — and ranks the unit's people by free capacity on
   * their own calendar, then by how their finished tasks actually went. Advisory: the warnings
   * travel beside the names, and nothing here refuses an assignment.
   */
  app.get('/tasks/suggest-assignee', {
    preHandler: [app.authenticate, app.requirePermissions('task.assign')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { taskId, unit, hours, by, limit } = req.query as Record<string, string | undefined>;
    let input: { departmentCode?: string; hours?: number; by?: Date; limit?: number } = {
      departmentCode: unit, hours: hours ? Number(hours) : undefined,
      by: by ? new Date(by) : undefined, limit: limit ? Number(limit) : undefined,
    };
    let task = null;
    if (taskId) {
      task = await prisma.task.findFirst({
        where: { id: taskId, organizationId: actor.organizationId },
        select: { id: true, code: true, title: true, departmentCode: true, estimateHours: true, dueDate: true, assigneeId: true },
      });
      if (!task) throw notFound('وظیفه');
      input = {
        ...input,
        departmentCode: unit ?? task.departmentCode,
        hours: input.hours ?? (task.estimateHours == null ? undefined : Number(task.estimateHours)),
        by: input.by ?? task.dueDate ?? undefined,
      };
    }
    return { task, ...(await suggestAssignees(prisma, actor.organizationId, input)) };
  });

  /** A distribution of finishes rather than one date (roadmap #11). `seed` reproduces a run. */
  app.get('/projects/:id/forecast', {
    preHandler: [app.authenticate, app.requirePermissions('project.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { runs, seed } = req.query as { runs?: string; seed?: string };
    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!project) throw notFound('پروژه');
    return forecastProject(prisma, actor.organizationId, id, {
      runs: runs ? Number(runs) : undefined, seed: seed ? Number(seed) : undefined,
    });
  });

  /** "B cannot start until A is finished." Refused if it would close a loop. */
  app.post('/tasks/:id/dependencies', {
    preHandler: [app.authenticate, app.requirePermissions('task.write')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { prerequisiteId } = (req.body ?? {}) as { prerequisiteId?: string };
    if (!prerequisiteId) throw badRequest('PREREQUISITE_REQUIRED', 'وظیفهٔ پیش‌نیاز مشخص نشده است');
    if (prerequisiteId === id) throw badRequest('SELF_DEPENDENCY', 'وظیفه نمی‌تواند پیش‌نیاز خودش باشد');
    const [task, pre] = await Promise.all([
      prisma.task.findFirst({ where: { id, organizationId: actor.organizationId } }),
      prisma.task.findFirst({ where: { id: prerequisiteId, organizationId: actor.organizationId } }),
    ]);
    if (!task || !pre) throw notFound('وظیفه');
    if (task.projectId !== pre.projectId) throw badRequest('CROSS_PROJECT', 'پیش‌نیاز باید در همان پروژه باشد');
    // Would `id` be reachable from `prerequisiteId` by following prerequisites upward? Then a loop.
    const seen = new Set<string>();
    const frontier = [prerequisiteId];
    while (frontier.length) {
      const cur = frontier.pop()!;
      if (cur === id) throw badRequest('CYCLE', 'این وابستگی یک حلقه می‌سازد', { via: [...seen] });
      if (seen.has(cur)) continue;
      seen.add(cur);
      const ups = await prisma.taskDependency.findMany({ where: { taskId: cur }, select: { prerequisiteId: true } });
      frontier.push(...ups.map((u) => u.prerequisiteId));
    }
    const dep = await prisma.taskDependency.upsert({
      where: { taskId_prerequisiteId: { taskId: id, prerequisiteId } },
      create: { taskId: id, prerequisiteId }, update: {},
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'task', entityId: id, after: { dependsOn: prerequisiteId }, reason: 'dependency', ipAddress: actor.ipAddress });
    return reply.code(201).send(dep);
  });

  app.delete('/tasks/:id/dependencies/:prerequisiteId', {
    preHandler: [app.authenticate, app.requirePermissions('task.write')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id, prerequisiteId } = req.params as { id: string; prerequisiteId: string };
    const task = await prisma.task.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!task) throw notFound('وظیفه');
    await prisma.taskDependency.deleteMany({ where: { taskId: id, prerequisiteId } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'task', entityId: id, before: { dependsOn: prerequisiteId }, reason: 'dependency removed', ipAddress: actor.ipAddress });
    return { ok: true };
  });

  /* ── Time on tasks (roadmap #14) ─────────────────────────────────────── */

  async function taskFor(req: Parameters<typeof actorFrom>[0], id: string) {
    const actor = actorFrom(req);
    const task = await prisma.task.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!task) throw notFound('وظیفه');
    return { actor, task };
  }

  app.get('/tasks/:id/time', { preHandler: [app.authenticate, app.requirePermissions('task.read')] }, async (req) => {
    const { id } = req.params as { id: string };
    const { task } = await taskFor(req, id);
    const entries = await prisma.timeEntry.findMany({
      where: { taskId: id }, orderBy: { workedOn: 'desc' }, include: { user: { select: { id: true, fullName: true } } },
    });
    return { taskId: id, estimateHours: task.estimateHours, actualHours: task.actualHours, entries };
  });

  /** The assignee logs their own time; task.write may log for anyone on the task. */
  app.post('/tasks/:id/time', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { actor, task } = await taskFor(req, id);
    const { hours, workedOn, note, userId } = (req.body ?? {}) as { hours?: number; workedOn?: string; note?: string; userId?: string };
    const forUser = userId ?? actor.id;
    if (task.assigneeId !== actor.id && !hasPermission(req, 'task.write')) throw forbidden('فقط مسئول وظیفه می‌تواند زمان ثبت کند');
    if (forUser !== actor.id && !hasPermission(req, 'task.write')) throw forbidden();
    const when = workedOn ? new Date(workedOn) : new Date();
    if (Number.isNaN(when.getTime())) throw badRequest('INVALID_DATE', 'تاریخ معتبر نیست');
    const result = await prisma.$transaction(async (tx) => {
      const r = await logTime(tx, { organizationId: actor.organizationId, taskId: id, userId: forUser, hours: Number(hours), workedOn: when, note: note ?? null });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'timeEntry', entityId: r.entry.id,
        after: { taskId: id, userId: forUser, hours: r.entry.hours, workedOn: r.entry.workedOn }, ipAddress: actor.ipAddress,
      }, tx);
      return r;
    });
    return reply.code(201).send(result);
  });

  app.delete('/tasks/:id/time/:entryId', { preHandler: [app.authenticate] }, async (req) => {
    const { id, entryId } = req.params as { id: string; entryId: string };
    const { actor } = await taskFor(req, id);
    const entry = await prisma.timeEntry.findFirst({ where: { id: entryId, taskId: id } });
    if (!entry) throw notFound('ثبت زمان');
    if (entry.userId !== actor.id && !hasPermission(req, 'task.write')) throw forbidden();
    const actualHours = await prisma.$transaction(async (tx) => {
      await tx.timeEntry.delete({ where: { id: entryId } });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: 'timeEntry', entityId: entryId,
        before: { taskId: id, hours: entry.hours }, ipAddress: actor.ipAddress,
      }, tx);
      return recomputeActual(tx, id);
    });
    return { ok: true, actualHours };
  });

  /* ── Tasks ───────────────────────────────────────────────────────────── */
  registerCrud(app, {
    path: 'tasks', model: 'task', workflowEntity: 'task', codeScope: 'task',
    permissions: { read: 'task.read', write: 'task.write' },
    createSchema: createTaskSchema, updateSchema: updateTaskSchema,
    sortable: ['createdAt', 'dueDate', 'priority'], searchable: ['title', 'description'],
    filter: (req) => {
      const { state, projectId, assigneeId, unit, mine } = req.query as Record<string, string | undefined>;
      return {
        ...(state ? { state } : {}), ...(projectId ? { projectId } : {}),
        ...(assigneeId ? { assigneeId } : {}), ...(unit ? { departmentCode: unit } : {}),
        ...(mine === 'true' ? { assigneeId: (req as any).user?.sub } : {}),
      };
    },
    listInclude: {
      project: { select: { id: true, code: true, name: true } },
      assignee: { select: { id: true, fullName: true } },
    },
    detailInclude: {
      project: { select: { id: true, code: true, name: true } },
      assignee: { select: { id: true, fullName: true } },
      workOrder: { select: { id: true, code: true, title: true } },
      qcReviews: true, revisions: true,
    },
    // Doc_H RACI #7/#8 — dispatching a task to a named owner starts the 4-hour acceptance clock,
    // so a task created with an assignee is already ASSIGNED rather than merely CREATED.
    toCreate: (input, actor) => ({
      ...input,
      createdById: actor.id,
      state: input.assigneeId ? 'ASSIGNED' : 'CREATED',
    }),
    afterCreate: async (task, actor) => {
      if (!task.assigneeId) return;
      await startSla(prisma, {
        organizationId: actor.organizationId,
        policyCode: 'SLA_TASK_ACCEPTANCE',
        entityType: 'task',
        entityId: task.id,
        ownerId: task.assigneeId,
      });
    },
  });

  /* ── Deliverables ────────────────────────────────────────────────────── */
  registerCrud(app, {
    path: 'deliverables', model: 'deliverable', workflowEntity: 'deliverable', codeScope: 'deliverable',
    permissions: { read: 'deliverable.read', write: 'deliverable.write' },
    createSchema: createDeliverableSchema, updateSchema: createDeliverableSchema.partial(),
    sortable: ['createdAt', 'dueDate'], searchable: ['name', 'description'],
    filter: (req) => {
      const { state, projectId, unit } = req.query as Record<string, string | undefined>;
      return {
        ...(state ? { state } : {}), ...(projectId ? { projectId } : {}),
        ...(unit ? { departmentCode: unit } : {}),
      };
    },
    listInclude: { project: { select: { id: true, code: true, name: true } } },
    detailInclude: {
      project: { select: { id: true, code: true, name: true } },
      qcReviews: { orderBy: { reviewedAt: 'desc' } },
      revisions: { orderBy: { createdAt: 'desc' } },
      documents: true,
    },
  });
};

export default deliveryRoutes;
