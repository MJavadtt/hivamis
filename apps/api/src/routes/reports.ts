import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { loadCalendar } from '../sla/engine.js';
import { pendingForRoles } from '../forms/engine.js';
import { mine } from '../reports/mining.js';
import { costAccuracy } from '../reports/time.js';
import { isWorkflowEntity } from '@hiva/contracts';
import { businessHoursBetween } from '../lib/business-calendar.js';
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
    const canSeeFinance = actor.permissions.includes('finance.read');

    const OPEN_TASK = ['APPROVED', 'CLOSED', 'CANCELLED'];
    const DONE_TASK = ['APPROVED', 'CLOSED'];
    const LIVE_PROJECT = ['ACTIVE', 'PLANNING', 'AUTHORIZED'];
    const DEAD_PROJECT = ['CLOSED', 'CANCELLED'];

    /**
     * Aggregated in PostgreSQL rather than in Node.
     *
     * This handler used to pull every project, opportunity, invoice, cost declaration, task,
     * change request, risk, revision and feedback row into memory and reduce them in JavaScript —
     * and projectHealth ran a tasks.filter() per project, so it was O(projects × tasks). At 400
     * projects and 20k tasks that is 8M comparisons per request, on the CEO's landing page.
     * Measured before this change: p95 1.06s for a single caller, 7.2s at ten concurrent.
     *
     * Raw SQL is used only for the two per-project roll-ups, which Prisma's groupBy cannot express
     * (both need a join). Both are tagged templates, so every value is a bound parameter.
     */
    const [
      oppByState, projByState, taskByState, overdueTasks, doneWithDue, onTimeDone,
      revisionTotal, revisionOpen, crByState, crOutOfScope, riskAgg,
      breachedSlas, atRiskSlas, pendingForms, companies, feedbackAgg,
      costRows, lateByProject,
    ] = await Promise.all([
      prisma.opportunity.groupBy({
        by: ['state'], where: { organizationId: org, deletedAt: null },
        _count: { _all: true }, _sum: { estimatedValue: true },
      }),
      prisma.project.groupBy({
        by: ['state'], where: { organizationId: org, deletedAt: null },
        _count: { _all: true }, _sum: { contractValue: true },
      }),
      prisma.task.groupBy({
        by: ['state'], where: { organizationId: org }, _count: { _all: true },
      }),
      prisma.task.count({
        where: { organizationId: org, dueDate: { lt: now, not: null }, state: { notIn: OPEN_TASK } },
      }),
      prisma.task.count({
        where: { organizationId: org, state: { in: DONE_TASK }, dueDate: { not: null } },
      }),
      // "On time" needs a column-to-column comparison, which Prisma's filter API cannot express.
      prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n FROM tasks
        WHERE "organizationId" = ${org} AND state = ANY(${DONE_TASK})
          AND "dueDate" IS NOT NULL AND "submittedAt" IS NOT NULL AND "submittedAt" <= "dueDate"`,
      prisma.revision.count({ where: { organizationId: org } }),
      prisma.revision.count({
        where: { organizationId: org, state: { notIn: ['APPROVED', 'REJECTED'] } },
      }),
      prisma.changeRequest.count({
        where: { organizationId: org, state: { notIn: ['CLOSED', 'REJECTED'] } },
      }),
      prisma.changeRequest.count({ where: { organizationId: org, scopeVerdict: 'OUT_OF_SCOPE' } }),
      prisma.risk.groupBy({
        by: ['impact', 'probability'], where: { organizationId: org, state: 'OPEN' },
        _count: { _all: true },
      }),
      prisma.slaClock.count({ where: { organizationId: org, state: 'BREACHED' } }),
      prisma.slaClock.count({ where: { organizationId: org, state: 'AT_RISK' } }),
      prisma.formSubmission.count({ where: { organizationId: org, state: 'PENDING_APPROVAL' } }),
      prisma.company.count({ where: { organizationId: org, deletedAt: null } }),
      prisma.feedback.aggregate({
        where: { organizationId: org }, _count: { _all: true }, _avg: { csat: true, nps: true },
      }),
      // Cost per project — cost_declarations reach a project only through their work order.
      prisma.$queryRaw<{ projectId: string; cost: string }[]>`
        SELECT w."projectId" AS "projectId",
               SUM(c."internalCost" + c."externalCost")::text AS cost
        FROM cost_declarations c
        JOIN work_orders w ON w.id = c."workOrderId"
        WHERE c."organizationId" = ${org}
        GROUP BY w."projectId"`,
      // Late tasks per project — this is what the per-project filter() was recomputing.
      prisma.$queryRaw<{ projectId: string; late: bigint }[]>`
        SELECT "projectId", COUNT(*)::bigint AS late
        FROM tasks
        WHERE "organizationId" = ${org} AND "dueDate" < ${now}
          AND state <> ALL(${OPEN_TASK})
        GROUP BY "projectId"`,
    ]);

    // Finance is not merely hidden from an unauthorised caller — it is not computed.
    const invoiceAgg = canSeeFinance
      ? await prisma.invoice.aggregate({
          where: { organizationId: org, state: { not: 'CANCELLED' } },
          _sum: { total: true, paidAmount: true },
        })
      : null;
    const overdueInvoices = canSeeFinance
      ? await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*)::bigint AS n FROM invoices
          WHERE "organizationId" = ${org} AND state <> 'CANCELLED'
            AND "dueDate" IS NOT NULL AND "dueDate" < ${now} AND "paidAmount" < total`
      : null;

    const costByProject = new Map(costRows.map((r) => [r.projectId, Number(r.cost)]));
    const lateByProjectMap = new Map(lateByProject.map((r) => [r.projectId, Number(r.late)]));

    const sumBy = <T extends { state: string }>(
      rows: T[], pick: (r: T) => number, match: (s: string) => boolean,
    ) => rows.filter((r) => match(r.state)).reduce((acc, r) => acc + pick(r), 0);

    const countBy = (rows: { state: string; _count: { _all: number } }[], match: (s: string) => boolean) =>
      rows.filter((r) => match(r.state)).reduce((acc, r) => acc + r._count._all, 0);

    const contractedRevenue = projByState.reduce((acc, r) => acc + num(r._sum.contractValue), 0);
    const totalCost = [...costByProject.values()].reduce((a, b) => a + b, 0);

    // Only the projects that appear in the health list are loaded, and only the columns it shows.
    const healthProjects = await prisma.project.findMany({
      where: { organizationId: org, deletedAt: null, state: { notIn: DEAD_PROJECT } },
      select: {
        id: true, code: true, name: true, state: true, plannedEnd: true,
        plannedBudget: true, contractValue: true,
        company: { select: { legalName: true } },
      },
    });

    const projectHealth = healthProjects.map((p) => {
      const late = lateByProjectMap.get(p.id) ?? 0;
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

    const openOpps = countBy(oppByState, (s) => !['WON', 'LOST'].includes(s));
    const wonCount = countBy(oppByState, (s) => s === 'WON');
    const closedCount = countBy(oppByState, (s) => ['WON', 'LOST'].includes(s));
    const totalTasks = taskByState.reduce((acc, r) => acc + r._count._all, 0);
    const onTime = Number(onTimeDone[0]?.n ?? 0);
    const invoiced = num(invoiceAgg?._sum.total);
    const received = num(invoiceAgg?._sum.paidAmount);

    return {
      pipeline: {
        openOpportunities: openOpps,
        pipelineValue: sumBy(oppByState, (r) => num(r._sum.estimatedValue), (s) => !['WON', 'LOST'].includes(s)),
        wonValue: sumBy(oppByState, (r) => num(r._sum.estimatedValue), (s) => s === 'WON'),
        winRate: closedCount ? Math.round((wonCount / closedCount) * 100) : null,
      },
      projects: {
        total: countBy(projByState, () => true),
        active: countBy(projByState, (s) => LIVE_PROJECT.includes(s)),
        pendingAuthorization: countBy(projByState, (s) => s === 'PENDING_AUTHORIZATION'),
        onHold: countBy(projByState, (s) => s === 'ON_HOLD'),
        closed: countBy(projByState, (s) => s === 'CLOSED'),
        red: projectHealth.filter((p) => p.status === 'RED').length,
        amber: projectHealth.filter((p) => p.status === 'AMBER').length,
        green: projectHealth.filter((p) => p.status === 'GREEN').length,
      },
      finance: canSeeFinance
        ? {
            contractedRevenue, totalCost,
            grossMargin: contractedRevenue - totalCost,
            marginPercent: contractedRevenue > 0
              ? Number((((contractedRevenue - totalCost) / contractedRevenue) * 100).toFixed(1))
              : null,
            invoiced, received, outstanding: invoiced - received,
            overdueInvoices: Number(overdueInvoices?.[0]?.n ?? 0),
          }
        : null,
      delivery: {
        openTasks: countBy(taskByState, (s) => !OPEN_TASK.includes(s)),
        overdueTasks,
        onTimeRate: doneWithDue ? Math.round((onTime / doneWithDue) * 100) : null,
        revisionRate: totalTasks ? Number(((revisionTotal / totalTasks) * 100).toFixed(1)) : 0,
        openRevisions: revisionOpen,
      },
      governance: {
        openChangeRequests: crByState,
        outOfScopeChanges: crOutOfScope,
        openRisks: riskAgg.reduce((acc, r) => acc + r._count._all, 0),
        criticalRisks: riskAgg
          .filter((r) => r.impact === 'CRITICAL' || r.probability === 'CRITICAL')
          .reduce((acc, r) => acc + r._count._all, 0),
        slaBreached: breachedSlas,
        slaAtRisk: atRiskSlas,
        pendingApprovals: pendingForms,
        // Exceptions granted against the rules: open ones and those spent in the last 30 days.
        // An exception should be rare enough to count by hand; this is where management sees
        // whether it still is.
        waiversOpen: await prisma.waiver.count({ where: { organizationId: org, usedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
        waiversUsed30d: await prisma.waiver.count({ where: { organizationId: org, usedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } } }),
      },
      customers: {
        total: companies,
        avgCsat: feedbackAgg._count._all ? Number((feedbackAgg._avg.csat ?? 0).toFixed(2)) : null,
        avgNps: feedbackAgg._count._all ? Number((feedbackAgg._avg.nps ?? 0).toFixed(1)) : null,
      },
      projectHealth: projectHealth.sort((a, b) => (a.status === 'RED' ? -1 : b.status === 'RED' ? 1 : 0)),
    };
  });

  /** Role-aware landing dashboard: my work, my queues, my SLAs. */
  app.get('/reports/my-dashboard', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const org = actor.organizationId;
    const now = new Date();

    const [myTasks, myProjects, myOpportunities, myForms, awaitingMe, myRevisions, mySlas, notifications] = await Promise.all([
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
      // "My projects" in two halves: what is being executed, and what is still being sold — the
      // opportunities I own, for whoever may read the pipeline.
      actor.permissions.includes('crm.opportunity.read')
        ? prisma.opportunity.findMany({
            where: { organizationId: org, deletedAt: null, ownerId: actor.id, state: { notIn: ['WON', 'LOST'] } },
            select: {
              id: true, code: true, title: true, state: true, estimatedValue: true, expectedCloseDate: true,
              company: { select: { legalName: true } },
            },
            orderBy: [{ expectedCloseDate: { sort: 'asc', nulls: 'last' } }], take: 30,
          })
        : Promise.resolve(null),
      prisma.formSubmission.count({ where: { organizationId: org, submittedById: actor.id, state: 'PENDING_APPROVAL' } }),
      prisma.formSubmission.count({
        where: {
          organizationId: org, state: 'PENDING_APPROVAL',
          submittedById: { not: actor.id },
          ...pendingForRoles(actor.roles),
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
      // null when the pipeline is not the reader's to see; the dashboard then shows no sales half.
      opportunities: myOpportunities,
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
    const units = ['ST', 'CR', 'ME', 'DM'];

    /**
     * Grouped in the database. This used to load every task, revision, QC review, cost
     * declaration and work order, then run five filter() passes per unit over the full arrays —
     * 432ms on a 20k-task dataset for eleven numbers per unit.
     */
    const DONE = ['APPROVED', 'CLOSED'];
    const CLOSED_TASK = ['APPROVED', 'CLOSED', 'CANCELLED'];
    const UNACCEPTED_WO = ['DRAFT', 'ISSUED', 'PENDING_ACCEPTANCE'];

    const [
      taskTotals, taskDone, taskDoneWithDue, taskOpen, taskOverdue, taskOnTime,
      revTotals, revOpen, qcRows, costTotals, woTotals, woAccepted,
    ] = await Promise.all([
      prisma.task.groupBy({ by: ['departmentCode'], where: { organizationId: org }, _count: { _all: true } }),
      prisma.task.groupBy({
        by: ['departmentCode'], where: { organizationId: org, state: { in: DONE } }, _count: { _all: true },
      }),
      // The on-time denominator: a task with no due date can be neither on time nor late. Same
      // definition as the control tower and the question box (#27), so the three cannot disagree.
      prisma.task.groupBy({
        by: ['departmentCode'], where: { organizationId: org, state: { in: DONE }, dueDate: { not: null } }, _count: { _all: true },
      }),
      prisma.task.groupBy({
        by: ['departmentCode'], where: { organizationId: org, state: { notIn: CLOSED_TASK } }, _count: { _all: true },
      }),
      prisma.task.groupBy({
        by: ['departmentCode'],
        where: { organizationId: org, state: { notIn: CLOSED_TASK }, dueDate: { lt: now, not: null } },
        _count: { _all: true },
      }),
      // Column-to-column comparison, so raw — with bound parameters.
      prisma.$queryRaw<{ departmentCode: string; n: bigint }[]>`
        SELECT "departmentCode", COUNT(*)::bigint AS n FROM tasks
        WHERE "organizationId" = ${org} AND state = ANY(${DONE})
          AND "dueDate" IS NOT NULL AND "submittedAt" IS NOT NULL AND "submittedAt" <= "dueDate"
        GROUP BY "departmentCode"`,
      prisma.revision.groupBy({
        by: ['responsibleDepartmentCode'], where: { organizationId: org }, _count: { _all: true },
      }),
      prisma.revision.groupBy({
        by: ['responsibleDepartmentCode'],
        where: { organizationId: org, state: { notIn: ['APPROVED', 'REJECTED'] } }, _count: { _all: true },
      }),
      // First-pass yield is per DELIVERABLE department, which lives on the joined row.
      prisma.$queryRaw<{ departmentCode: string; passed: bigint; total: bigint }[]>`
        SELECT d."departmentCode" AS "departmentCode",
               COUNT(*) FILTER (WHERE q.verdict = 'PASSED')::bigint AS passed,
               COUNT(*)::bigint AS total
        FROM qc_reviews q
        JOIN deliverables d ON d.id = q."deliverableId"
        WHERE q."organizationId" = ${org} AND q.level = 'UNIT'
        GROUP BY d."departmentCode"`,
      prisma.costDeclaration.groupBy({
        by: ['departmentCode'], where: { organizationId: org },
        _sum: { internalCost: true, externalCost: true },
      }),
      prisma.workOrder.groupBy({
        by: ['targetDepartmentCode'], where: { organizationId: org }, _count: { _all: true },
      }),
      prisma.workOrder.groupBy({
        by: ['targetDepartmentCode'],
        where: { organizationId: org, state: { notIn: UNACCEPTED_WO } }, _count: { _all: true },
      }),
    ]);

    const byDept = (rows: { departmentCode: string; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.departmentCode, r._count._all]));
    const byResp = (rows: { responsibleDepartmentCode: string; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.responsibleDepartmentCode, r._count._all]));
    const byTarget = (rows: { targetDepartmentCode: string; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.targetDepartmentCode, r._count._all]));

    const total = byDept(taskTotals), done = byDept(taskDone), doneWithDue = byDept(taskDoneWithDue);
    const open = byDept(taskOpen), overdue = byDept(taskOverdue);
    const onTime = new Map(taskOnTime.map((r) => [r.departmentCode, Number(r.n)]));
    const rev = byResp(revTotals), revOpenMap = byResp(revOpen);
    const qcMap = new Map(qcRows.map((r) => [r.departmentCode, { passed: Number(r.passed), total: Number(r.total) }]));
    const cost = new Map(costTotals.map((r) => [r.departmentCode, num(r._sum.internalCost) + num(r._sum.externalCost)]));
    const wo = byTarget(woTotals), woOk = byTarget(woAccepted);

    return units.map((unit) => {
      const nTasks = total.get(unit) ?? 0;
      const nDone = done.get(unit) ?? 0;
      const nRev = rev.get(unit) ?? 0;
      const nWo = wo.get(unit) ?? 0;
      const qcUnit = qcMap.get(unit);
      return {
        unit,
        openTasks: open.get(unit) ?? 0,
        completedTasks: nDone,
        overdueTasks: overdue.get(unit) ?? 0,
        onTimeDeliveryRate: doneWithDue.get(unit) ? Math.round(((onTime.get(unit) ?? 0) / doneWithDue.get(unit)!) * 100) : null,
        firstPassYield: qcUnit?.total ? Math.round((qcUnit.passed / qcUnit.total) * 100) : null,
        revisionCount: nRev,
        revisionRate: nTasks ? Number(((nRev / nTasks) * 100).toFixed(1)) : 0,
        openRevisions: revOpenMap.get(unit) ?? 0,
        acceptanceRate: nWo ? Math.round(((woOk.get(unit) ?? 0) / nWo) * 100) : null,
        declaredCost: cost.get(unit) ?? 0,
        workOrders: nWo,
      };
    });
  });

  /** SLA compliance across the process, grouped by Doc_H policy. */
  app.get('/reports/sla', {
    preHandler: [app.authenticate, app.requirePermissions('report.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const clocks = await prisma.slaClock.findMany({
      where: { organizationId: actor.organizationId }, include: { policy: true, pauses: true },
    });
    const cal = await loadCalendar(actor.organizationId);
    const now = new Date();
    type Row = {
      labelFa: string; total: number; met: number; breached: number; running: number; atRisk: number;
      paused: number; elapsedHours: number; pausedHours: number; closedCount: number;
    };
    const byPolicy = new Map<string, Row>();
    // Across the whole organisation, how long has been spent waiting on whom.
    const waitingByKind: Record<string, number> = {};
    for (const c of clocks) {
      const row = byPolicy.get(c.policy.code) ?? {
        labelFa: c.policy.labelFa, total: 0, met: 0, breached: 0, running: 0, atRisk: 0,
        paused: 0, elapsedHours: 0, pausedHours: 0, closedCount: 0,
      };
      row.total++;
      if (c.state === 'MET') row.met++;
      else if (c.state === 'BREACHED') row.breached++;
      else if (c.state === 'AT_RISK') row.atRisk++;
      else if (c.state === 'RUNNING') row.running++;
      else if (c.state === 'PAUSED') row.paused++;
      // Averages are over closed clocks only; an open one has not finished consuming anything.
      if (c.stoppedAt) {
        row.closedCount++;
        row.elapsedHours += businessHoursBetween(c.startedAt, c.stoppedAt, cal);
        row.pausedHours += Number(c.pausedHours);
      }
      for (const p of c.pauses) {
        const hours = p.businessHours != null
          ? Number(p.businessHours)
          : businessHoursBetween(p.pausedAt, now, cal);
        waitingByKind[p.kind] = (waitingByKind[p.kind] ?? 0) + hours;
      }
      byPolicy.set(c.policy.code, row);
    }
    const avg = (sum: number, n: number) => (n > 0 ? Math.round((sum / n) * 10) / 10 : null);
    const rows = [...byPolicy.entries()].map(([code, { closedCount, elapsedHours, pausedHours, ...r }]) => ({
      code, ...r,
      complianceRate: r.met + r.breached > 0 ? Math.round((r.met / (r.met + r.breached)) * 100) : null,
      avgElapsedHours: avg(elapsedHours, closedCount),
      avgPausedHours: avg(pausedHours, closedCount),
      avgControlledHours: avg(elapsedHours - pausedHours, closedCount),
    }));
    const closed = clocks.filter((c) => ['MET', 'BREACHED'].includes(c.state));
    return {
      overall: {
        total: clocks.length,
        met: clocks.filter((c) => c.state === 'MET').length,
        breached: clocks.filter((c) => c.state === 'BREACHED').length,
        running: clocks.filter((c) => c.state === 'RUNNING').length,
        atRisk: clocks.filter((c) => c.state === 'AT_RISK').length,
        paused: clocks.filter((c) => c.state === 'PAUSED').length,
        complianceRate: closed.length
          ? Math.round((closed.filter((c) => c.state === 'MET').length / closed.length) * 100) : null,
        waitingHoursByKind: Object.fromEntries(
          Object.entries(waitingByKind).map(([k, v]) => [k, Math.round(v * 10) / 10]),
        ),
      },
      byPolicy: rows.sort((a, b) => b.total - a.total),
    };
  });

  /**
   * Process mining and conformance (roadmap #1): the process the organisation actually runs,
   * discovered from state_transitions, laid against the one it declared.
   */
  app.get('/reports/mining/:entity', {
    preHandler: [app.authenticate, app.requirePermissions('report.executive')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { entity } = req.params as { entity: string };
    if (!isWorkflowEntity(entity)) throw badRequest('UNKNOWN_ENTITY', `موجودیت «${entity}» فاقد ماشین حالت است.`);
    const { from, to } = req.query as { from?: string; to?: string };
    const window = {
      ...(from ? { from: new Date(from) } : {}), ...(to ? { to: new Date(to) } : {}),
    };
    if ((window.from && Number.isNaN(window.from.getTime())) || (window.to && Number.isNaN(window.to.getTime()))) {
      throw badRequest('INVALID_RANGE', 'بازهٔ زمانی معتبر نیست');
    }
    const cal = await loadCalendar(actor.organizationId);
    return mine(prisma, actor.organizationId, entity, cal, window);
  });

  /** Declared cost against the hours (roadmap #14). The Doc_H KPI "cost accuracy", with both sides. */
  app.get('/reports/cost-accuracy', {
    preHandler: [app.authenticate, app.requirePermissions('report.read', 'pricing.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { from, to } = req.query as { from?: string; to?: string };
    const window = { ...(from ? { from: new Date(from) } : {}), ...(to ? { to: new Date(to) } : {}) };
    if ((window.from && Number.isNaN(window.from.getTime())) || (window.to && Number.isNaN(window.to.getTime()))) {
      throw badRequest('INVALID_RANGE', 'بازهٔ زمانی معتبر نیست');
    }
    return costAccuracy(prisma, actor.organizationId, window);
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

    // The register of exceptions belongs here too: a waiver is a rule set aside on purpose, and
    // the report that hunts rules set aside by accident should show the deliberate ones beside them.
    const openWaivers = await prisma.waiver.findMany({
      where: { organizationId: org, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true, entityType: true, entityId: true, guard: true, reason: true, expiresAt: true },
    });
    /*
     * Doc_H §6 — no verbal task is valid. A meeting that never got minutes is where decisions stay
     * verbal (roadmap #23): two days is long enough to write them, short enough to still remember.
     */
    const meetingsWithoutMinutes = await prisma.meeting.findMany({
      where: { organizationId: org, minutesRecordedAt: null, heldAt: { lt: new Date(Date.now() - 2 * 86_400_000) } },
      select: { id: true, code: true, subject: true, heldAt: true }, orderBy: { heldAt: 'desc' }, take: 20,
    });
    const meetingsWithoutMinutesCount = await prisma.meeting.count({
      where: { organizationId: org, minutesRecordedAt: null, heldAt: { lt: new Date(Date.now() - 2 * 86_400_000) } },
    });

    const findings = [
      { key: 'incompleteBriefs', labelFa: 'بریف‌های ناقص در جریان', count: incompleteBriefs, severity: 'MEDIUM' },
      { key: 'meetingsWithoutMinutes', labelFa: 'جلسهٔ برگزارشده بدون صورتجلسه — تصمیم‌ها شفاهی مانده‌اند (§۶)', count: meetingsWithoutMinutesCount, severity: 'MEDIUM', samples: meetingsWithoutMinutes },
      { key: 'openWaivers', labelFa: 'استثناهای باز بر قوانین حاکم', count: openWaivers.length, severity: 'MEDIUM', samples: openWaivers },
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
