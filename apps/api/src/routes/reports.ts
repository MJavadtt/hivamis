import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';

const num = (v: unknown) => Number(v ?? 0);

/**
 * Dashboards. Every figure below is aggregated from live tables — there are no hard-coded metrics.
 * The KPI set mirrors Doc_H data.pptx slide 34 («شاخص‌های کلیدی عملکرد به تفکیک واحد»).
 */
const reportRoutes: FastifyPluginAsync = async (app) => {
  /** Executive control tower — what is late, at risk, unhealthy, unprofitable, pending. */
  app.get('/reports/executive', {
    preHandler: [app.authenticate, app.requirePermissions('report.executive')],
  }, async (req) => {
    const actor = actorFrom(req);
    const org = actor.organizationId;
    const now = new Date();

    const [
      projects, opportunities, invoices, costs, tasks, changeRequests,
      risks, breachedSlas, atRiskSlas, revisions, feedbacks, pendingForms, companies,
    ] = await Promise.all([
      prisma.project.findMany({
        where: { organizationId: org, deletedAt: null },
        include: { company: { select: { id: true, legalName: true } } },
      }),
      prisma.opportunity.findMany({ where: { organizationId: org, deletedAt: null } }),
      prisma.invoice.findMany({ where: { organizationId: org, state: { not: 'CANCELLED' } } }),
      prisma.costDeclaration.findMany({
        where: { organizationId: org },
        include: { workOrder: { select: { projectId: true } } },
      }),
      prisma.task.findMany({ where: { organizationId: org } }),
      prisma.changeRequest.findMany({ where: { organizationId: org } }),
      prisma.risk.findMany({ where: { organizationId: org, state: 'OPEN' } }),
      prisma.slaClock.count({ where: { organizationId: org, state: 'BREACHED' } }),
      prisma.slaClock.count({ where: { organizationId: org, state: 'AT_RISK' } }),
      prisma.revision.findMany({ where: { organizationId: org } }),
      prisma.feedback.findMany({ where: { organizationId: org } }),
      prisma.formSubmission.count({ where: { organizationId: org, state: 'PENDING_APPROVAL' } }),
      prisma.company.count({ where: { organizationId: org, deletedAt: null } }),
    ]);

    const costByProject = new Map<string, number>();
    for (const c of costs) {
      const pid = c.workOrder?.projectId;
      if (!pid) continue;
      costByProject.set(pid, (costByProject.get(pid) ?? 0) + num(c.internalCost) + num(c.externalCost));
    }

    const active = projects.filter((p) => ['ACTIVE', 'PLANNING', 'AUTHORIZED'].includes(p.state));
    const overdueTasks = tasks.filter(
      (t) => t.dueDate && t.dueDate < now && !['APPROVED', 'CLOSED', 'CANCELLED'].includes(t.state),
    );

    const invoiced = invoices.reduce((s, i) => s + num(i.total), 0);
    const received = invoices.reduce((s, i) => s + num(i.paidAmount), 0);
    const totalCost = [...costByProject.values()].reduce((a, b) => a + b, 0);
    const contractedRevenue = projects.reduce((s, p) => s + num(p.contractValue), 0);

    const projectHealth = projects
      .filter((p) => !['CLOSED', 'CANCELLED'].includes(p.state))
      .map((p) => {
        const pTasks = tasks.filter((t) => t.projectId === p.id);
        const late = pTasks.filter(
          (t) => t.dueDate && t.dueDate < now && !['APPROVED', 'CLOSED', 'CANCELLED'].includes(t.state),
        ).length;
        const cost = costByProject.get(p.id) ?? 0;
        const revenue = num(p.contractValue);
        const overdueProject = p.plannedEnd != null && p.plannedEnd < now && p.state !== 'COMPLETED';
        const status = late > 2 || overdueProject ? 'RED' : late > 0 || cost > num(p.plannedBudget) ? 'AMBER' : 'GREEN';
        return {
          id: p.id, code: p.code, name: p.name, state: p.state,
          company: p.company.legalName, plannedEnd: p.plannedEnd,
          overdueTasks: late, isOverdue: overdueProject,
          cost, revenue,
          margin: revenue - cost,
          marginPercent: revenue > 0 ? Number((((revenue - cost) / revenue) * 100).toFixed(1)) : null,
          status,
        };
      });

    const wonOpps = opportunities.filter((o) => o.state === 'WON');
    const closedOpps = opportunities.filter((o) => ['WON', 'LOST'].includes(o.state));

    return {
      pipeline: {
        openOpportunities: opportunities.filter((o) => !['WON', 'LOST'].includes(o.state)).length,
        pipelineValue: opportunities
          .filter((o) => !['WON', 'LOST'].includes(o.state))
          .reduce((s, o) => s + num(o.estimatedValue), 0),
        wonValue: wonOpps.reduce((s, o) => s + num(o.estimatedValue), 0),
        winRate: closedOpps.length ? Math.round((wonOpps.length / closedOpps.length) * 100) : null,
      },
      projects: {
        total: projects.length,
        active: active.length,
        pendingAuthorization: projects.filter((p) => p.state === 'PENDING_AUTHORIZATION').length,
        onHold: projects.filter((p) => p.state === 'ON_HOLD').length,
        closed: projects.filter((p) => p.state === 'CLOSED').length,
        red: projectHealth.filter((p) => p.status === 'RED').length,
        amber: projectHealth.filter((p) => p.status === 'AMBER').length,
        green: projectHealth.filter((p) => p.status === 'GREEN').length,
      },
      finance: actor.permissions.includes('finance.read')
        ? {
            contractedRevenue, totalCost,
            grossMargin: contractedRevenue - totalCost,
            marginPercent: contractedRevenue > 0
              ? Number((((contractedRevenue - totalCost) / contractedRevenue) * 100).toFixed(1))
              : null,
            invoiced, received, outstanding: invoiced - received,
            overdueInvoices: invoices.filter(
              (i) => i.dueDate && i.dueDate < now && num(i.paidAmount) < num(i.total),
            ).length,
          }
        : null,
      delivery: {
        openTasks: tasks.filter((t) => !['APPROVED', 'CLOSED', 'CANCELLED'].includes(t.state)).length,
        overdueTasks: overdueTasks.length,
        onTimeRate: (() => {
          const done = tasks.filter((t) => ['APPROVED', 'CLOSED'].includes(t.state) && t.dueDate);
          if (!done.length) return null;
          const onTime = done.filter((t) => t.submittedAt && t.dueDate && t.submittedAt <= t.dueDate).length;
          return Math.round((onTime / done.length) * 100);
        })(),
        revisionRate: tasks.length ? Number(((revisions.length / tasks.length) * 100).toFixed(1)) : 0,
        openRevisions: revisions.filter((r) => !['APPROVED', 'REJECTED'].includes(r.state)).length,
      },
      governance: {
        openChangeRequests: changeRequests.filter((c) => !['CLOSED', 'REJECTED'].includes(c.state)).length,
        outOfScopeChanges: changeRequests.filter((c) => c.scopeVerdict === 'OUT_OF_SCOPE').length,
        openRisks: risks.length,
        criticalRisks: risks.filter((r) => r.impact === 'CRITICAL' || r.probability === 'CRITICAL').length,
        slaBreached: breachedSlas,
        slaAtRisk: atRiskSlas,
        pendingApprovals: pendingForms,
      },
      customers: {
        total: companies,
        avgCsat: feedbacks.length
          ? Number((feedbacks.reduce((s, f) => s + f.csat, 0) / feedbacks.length).toFixed(2))
          : null,
        avgNps: feedbacks.length
          ? Number((feedbacks.reduce((s, f) => s + f.nps, 0) / feedbacks.length).toFixed(1))
          : null,
      },
      projectHealth: projectHealth.sort((a, b) => (a.status === 'RED' ? -1 : b.status === 'RED' ? 1 : 0)),
    };
  });

  /** Role-aware landing dashboard: my work, my queues, my SLAs. */
  app.get('/reports/my-dashboard', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const org = actor.organizationId;
    const now = new Date();

    const [myTasks, myProjects, myForms, awaitingMe, myRevisions, mySlas, notifications] = await Promise.all([
      prisma.task.findMany({
        where: { organizationId: org, assigneeId: actor.id, state: { notIn: ['CLOSED', 'CANCELLED'] } },
        include: { project: { select: { id: true, code: true, name: true } } },
        orderBy: { dueDate: 'asc' }, take: 50,
      }),
      prisma.project.findMany({
        where: {
          organizationId: org, deletedAt: null,
          state: { notIn: ['CLOSED', 'CANCELLED'] },
          OR: [
            { accountOwnerId: actor.id },
            { tasks: { some: { assigneeId: actor.id } } },
            { raciAssignments: { some: { userId: actor.id } } },
          ],
        },
        include: { company: { select: { legalName: true } } },
        take: 30,
      }),
      prisma.formSubmission.count({ where: { organizationId: org, submittedById: actor.id, state: 'PENDING_APPROVAL' } }),
      prisma.formSubmission.count({
        where: {
          organizationId: org, state: 'PENDING_APPROVAL',
          submittedById: { not: actor.id },
          definition: { approverRoles: { hasSome: actor.roles } },
        },
      }),
      prisma.revision.findMany({
        where: {
          organizationId: org, state: { notIn: ['APPROVED', 'REJECTED'] },
          OR: [
            { assigneeId: actor.id },
            ...(actor.departmentCode ? [{ responsibleDepartmentCode: actor.departmentCode }] : []),
          ],
        },
        include: { deliverable: { select: { id: true, code: true, name: true } } },
        orderBy: { dueDate: 'asc' }, take: 30,
      }),
      prisma.slaClock.findMany({
        where: { organizationId: org, ownerId: actor.id, state: { in: ['RUNNING', 'AT_RISK', 'BREACHED'] } },
        include: { policy: true }, orderBy: { dueAt: 'asc' }, take: 30,
      }),
      prisma.notification.count({ where: { userId: actor.id, readAt: null } }),
    ]);

    return {
      tasks: {
        items: myTasks,
        total: myTasks.length,
        overdue: myTasks.filter((t) => t.dueDate && t.dueDate < now).length,
        dueThisWeek: myTasks.filter(
          (t) => t.dueDate && t.dueDate >= now && t.dueDate <= new Date(now.getTime() + 7 * 86_400_000),
        ).length,
        awaitingAcceptance: myTasks.filter((t) => t.state === 'ASSIGNED').length,
      },
      projects: myProjects,
      forms: { mySubmissionsPending: myForms, awaitingMyApproval: awaitingMe },
      revisions: { items: myRevisions, overdue: myRevisions.filter((r) => r.dueDate < now).length },
      sla: {
        items: mySlas,
        breached: mySlas.filter((s) => s.state === 'BREACHED').length,
        atRisk: mySlas.filter((s) => s.state === 'AT_RISK').length,
      },
      unreadNotifications: notifications,
    };
  });

  /** Sales funnel KPIs — Doc_H slide 34, «فروش» column. */
  app.get('/reports/sales', {
    preHandler: [app.authenticate, app.requirePermissions('report.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const org = actor.organizationId;
    const [leads, opportunities, briefs, proposals] = await Promise.all([
      prisma.lead.findMany({ where: { organizationId: org, deletedAt: null } }),
      prisma.opportunity.findMany({
        where: { organizationId: org, deletedAt: null },
        include: { owner: { select: { id: true, fullName: true } } },
      }),
      prisma.brief.findMany({ where: { organizationId: org, deletedAt: null } }),
      prisma.proposal.findMany({ where: { organizationId: org, deletedAt: null } }),
    ]);

    const won = opportunities.filter((o) => o.state === 'WON');
    const lost = opportunities.filter((o) => o.state === 'LOST');
    const cycleDays = won
      .filter((o) => o.wonAt)
      .map((o) => (o.wonAt!.getTime() - o.createdAt.getTime()) / 86_400_000);

    const byOwner = new Map<string, { name: string; open: number; won: number; value: number }>();
    for (const o of opportunities) {
      const key = o.owner?.id ?? 'unassigned';
      const row = byOwner.get(key) ?? { name: o.owner?.fullName ?? 'نامشخص', open: 0, won: 0, value: 0 };
      if (o.state === 'WON') { row.won++; row.value += num(o.estimatedValue); }
      else if (!['LOST'].includes(o.state)) row.open++;
      byOwner.set(key, row);
    }

    return {
      funnel: {
        leads: leads.length,
        qualifiedLeads: leads.filter((l) => ['QUALIFIED', 'CONVERTED'].includes(l.state)).length,
        opportunities: opportunities.length,
        briefs: briefs.length,
        proposals: proposals.length,
        won: won.length,
        lost: lost.length,
      },
      conversion: {
        leadToOpportunity: leads.length
          ? Math.round((leads.filter((l) => l.state === 'CONVERTED').length / leads.length) * 100) : null,
        opportunityToProposal: opportunities.length
          ? Math.round((proposals.length / opportunities.length) * 100) : null,
        proposalToWin: proposals.length ? Math.round((won.length / proposals.length) * 100) : null,
        winRate: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : null,
      },
      value: {
        pipeline: opportunities.filter((o) => !['WON', 'LOST'].includes(o.state))
          .reduce((s, o) => s + num(o.estimatedValue), 0),
        won: won.reduce((s, o) => s + num(o.estimatedValue), 0),
        averageDealSize: won.length ? won.reduce((s, o) => s + num(o.estimatedValue), 0) / won.length : 0,
      },
      salesCycleDays: cycleDays.length
        ? Number((cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length).toFixed(1)) : null,
      briefQuality: {
        averageCompleteness: briefs.length
          ? Math.round(briefs.reduce((s, b) => s + b.completenessScore, 0) / briefs.length) : null,
        returnedIncomplete: briefs.filter((b) => b.returnCount > 0).length,
        totalReturns: briefs.reduce((s, b) => s + b.returnCount, 0),
      },
      lostReasons: lost.filter((o) => o.lostReason)
        .reduce<Record<string, number>>((acc, o) => {
          acc[o.lostReason!] = (acc[o.lostReason!] ?? 0) + 1; return acc;
        }, {}),
      byOwner: [...byOwner.values()],
    };
  });

  /** Per-unit delivery quality — Doc_H slide 34, «واحدهای اجرایی» column. */
  app.get('/reports/units', {
    preHandler: [app.authenticate, app.requirePermissions('report.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const org = actor.organizationId;
    const now = new Date();
    const [tasks, revisions, qc, costs, workOrders] = await Promise.all([
      prisma.task.findMany({ where: { organizationId: org } }),
      prisma.revision.findMany({ where: { organizationId: org } }),
      prisma.qcReview.findMany({ where: { organizationId: org }, include: { deliverable: true } }),
      prisma.costDeclaration.findMany({ where: { organizationId: org } }),
      prisma.workOrder.findMany({ where: { organizationId: org } }),
    ]);

    const units = ['ST', 'CR', 'ME', 'DM'];
    return units.map((unit) => {
      const uTasks = tasks.filter((t) => t.departmentCode === unit);
      const done = uTasks.filter((t) => ['APPROVED', 'CLOSED'].includes(t.state));
      const onTime = done.filter((t) => t.submittedAt && t.dueDate && t.submittedAt <= t.dueDate);
      const uQc = qc.filter((q) => q.deliverable?.departmentCode === unit && q.level === 'UNIT');
      const uRev = revisions.filter((r) => r.responsibleDepartmentCode === unit);
      const uWo = workOrders.filter((w) => w.targetDepartmentCode === unit);
      const accepted = uWo.filter((w) => !['DRAFT', 'ISSUED', 'PENDING_ACCEPTANCE'].includes(w.state));

      return {
        unit,
        openTasks: uTasks.filter((t) => !['APPROVED', 'CLOSED', 'CANCELLED'].includes(t.state)).length,
        completedTasks: done.length,
        overdueTasks: uTasks.filter(
          (t) => t.dueDate && t.dueDate < now && !['APPROVED', 'CLOSED', 'CANCELLED'].includes(t.state),
        ).length,
        onTimeDeliveryRate: done.length ? Math.round((onTime.length / done.length) * 100) : null,
        firstPassYield: uQc.length
          ? Math.round((uQc.filter((q) => q.verdict === 'PASSED').length / uQc.length) * 100) : null,
        revisionCount: uRev.length,
        revisionRate: uTasks.length ? Number(((uRev.length / uTasks.length) * 100).toFixed(1)) : 0,
        openRevisions: uRev.filter((r) => !['APPROVED', 'REJECTED'].includes(r.state)).length,
        acceptanceRate: uWo.length ? Math.round((accepted.length / uWo.length) * 100) : null,
        declaredCost: costs.filter((c) => c.departmentCode === unit)
          .reduce((s, c) => s + num(c.internalCost) + num(c.externalCost), 0),
        workOrders: uWo.length,
      };
    });
  });

  /** SLA compliance across the process, grouped by Doc_H policy. */
  app.get('/reports/sla', {
    preHandler: [app.authenticate, app.requirePermissions('report.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const clocks = await prisma.slaClock.findMany({
      where: { organizationId: actor.organizationId }, include: { policy: true },
    });
    const byPolicy = new Map<string, { labelFa: string; total: number; met: number; breached: number; running: number; atRisk: number }>();
    for (const c of clocks) {
      const row = byPolicy.get(c.policy.code) ?? {
        labelFa: c.policy.labelFa, total: 0, met: 0, breached: 0, running: 0, atRisk: 0,
      };
      row.total++;
      if (c.state === 'MET') row.met++;
      else if (c.state === 'BREACHED') row.breached++;
      else if (c.state === 'AT_RISK') row.atRisk++;
      else if (c.state === 'RUNNING') row.running++;
      byPolicy.set(c.policy.code, row);
    }
    const rows = [...byPolicy.entries()].map(([code, r]) => ({
      code, ...r,
      complianceRate: r.met + r.breached > 0 ? Math.round((r.met / (r.met + r.breached)) * 100) : null,
    }));
    const closed = clocks.filter((c) => ['MET', 'BREACHED'].includes(c.state));
    return {
      overall: {
        total: clocks.length,
        met: clocks.filter((c) => c.state === 'MET').length,
        breached: clocks.filter((c) => c.state === 'BREACHED').length,
        running: clocks.filter((c) => c.state === 'RUNNING').length,
        atRisk: clocks.filter((c) => c.state === 'AT_RISK').length,
        complianceRate: closed.length
          ? Math.round((closed.filter((c) => c.state === 'MET').length / closed.length) * 100) : null,
      },
      byPolicy: rows.sort((a, b) => b.total - a.total),
    };
  });

  /** Data-quality register — records that would silently break the process if left alone. */
  app.get('/reports/data-quality', {
    preHandler: [app.authenticate, app.requirePermissions('report.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const org = actor.organizationId;
    const now = new Date();

    const [incompleteBriefs, unauthorizedActive, tasksNoSource, pricelessProposals,
           projectsNoRaci, overdueRevisions, unsettledClosed] = await Promise.all([
      prisma.brief.count({ where: { organizationId: org, completenessScore: { lt: 100 }, state: { not: 'APPROVED' } } }),
      prisma.project.findMany({
        where: { organizationId: org, state: 'ACTIVE', authorizations: { none: {} } },
        select: { id: true, code: true, name: true },
      }),
      prisma.task.count({ where: { organizationId: org, sourceRef: '' } }),
      prisma.proposal.count({
        where: { organizationId: org, state: { in: ['FINAL_QC', 'APPROVED'] }, salePrice: null },
      }),
      prisma.project.findMany({
        where: {
          organizationId: org, state: { in: ['ACTIVE', 'PLANNING'] },
          raciAssignments: { none: {} },
        },
        select: { id: true, code: true, name: true },
      }),
      prisma.revision.count({
        where: { organizationId: org, state: { notIn: ['APPROVED', 'REJECTED'] }, dueDate: { lt: now } },
      }),
      prisma.project.findMany({
        where: { organizationId: org, state: 'CLOSED', closureChecklist: { financialStatusClear: false } },
        select: { id: true, code: true, name: true },
      }),
    ]);

    const findings = [
      { key: 'incompleteBriefs', labelFa: 'بریف‌های ناقص در جریان', count: incompleteBriefs, severity: 'MEDIUM' },
      { key: 'unauthorizedActiveProjects', labelFa: 'پروژه فعال بدون مجوز شروع (نقض §۱۳)', count: unauthorizedActive.length, severity: 'CRITICAL', samples: unauthorizedActive },
      { key: 'tasksWithoutSource', labelFa: 'وظیفه بدون سند مرجع (نقض §۶)', count: tasksNoSource, severity: 'HIGH' },
      { key: 'proposalsWithoutPrice', labelFa: 'پروپوزال در QC نهایی بدون قیمت', count: pricelessProposals, severity: 'HIGH' },
      { key: 'projectsWithoutRaci', labelFa: 'پروژه در حال اجرا بدون RACI', count: projectsNoRaci.length, severity: 'MEDIUM', samples: projectsNoRaci },
      { key: 'overdueRevisions', labelFa: 'اصلاحیه‌های سررسید گذشته', count: overdueRevisions, severity: 'HIGH' },
      { key: 'closedUnsettled', labelFa: 'پروژه بسته با وضعیت مالی نامشخص', count: unsettledClosed.length, severity: 'HIGH', samples: unsettledClosed },
    ];

    return {
      findings: findings.filter((f) => f.count > 0),
      clean: findings.filter((f) => f.count === 0).map((f) => f.key),
      score: Math.max(0, 100 - findings.reduce((s, f) => s + f.count * (f.severity === 'CRITICAL' ? 10 : f.severity === 'HIGH' ? 5 : 2), 0)),
    };
  });
};

export default reportRoutes;
