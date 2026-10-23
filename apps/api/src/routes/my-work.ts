import type { FastifyPluginAsync } from 'fastify';
import { forbidden, notFound } from '../lib/errors.js';
import { isSystemAdmin } from '../auth/grants.js';
import { userPermissions } from '../auth/overrides.js';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';
import { allowedFor } from '../workflow/engine.js';
import { pendingForRoles } from '../forms/engine.js';
import { loadCalendar } from '../sla/engine.js';
import { predictClocks, type Risk } from '../sla/predict.js';
import { over, QUEUE_CAP } from '../lib/limits.js';
import { businessHoursBetween } from '../lib/business-calendar.js';

/**
 * One queue for one person (roadmap #41).
 *
 * A person's work was in five places: tasks, work orders, the QC queue, forms awaiting
 * approval, revisions. /reports/my-dashboard collected some of it, as a report. This is a work
 * queue: every item carries the transitions the person may perform on it and is ordered by how
 * soon its SLA runs out — not by when it was created, which is the order nothing urgent ever
 * arrives in.
 */

export type WorkKind =
  | 'task' | 'workOrder' | 'qcUnit' | 'qcAccount' | 'qcFinal' | 'formApproval' | 'revision' | 'clarification';

export interface WorkItem {
  kind: WorkKind;
  entityType: string;
  entityId: string;
  code: string;
  title: string;
  state: string;
  projectCode: string | null;
  projectName: string | null;
  /** The record's own deadline, if it has one. */
  dueAt: Date | null;
  /** The nearest open SLA clock on the record, if any. */
  sla: {
    policyCode: string; labelFa: string; state: string; dueAt: Date;
    budgetHours: number; controlledHours: number;
    /** Where this deadline is heading, judged against comparable past ones (roadmap #8). */
    risk?: { probability: number; risk: Risk; becauseFa: string | null } | null;
  } | null;
  href: string;
  availableTransitions: ReturnType<typeof allowedFor>;
}

const KIND_LABEL: Record<WorkKind, string> = {
  task: 'وظیفه', workOrder: 'سفارش کار', qcUnit: 'QC واحد', qcAccount: 'QC اکانت', qcFinal: 'QC نهایی',
  formApproval: 'تأیید فرم', revision: 'اصلاحیه', clarification: 'رفع ابهام',
};

interface QueueOwner { id: string; fullName?: string; departmentCode: string | null; roles: string[]; permissions: string[]; delegatedRoles?: Record<string, string> }

/** The reader, or — for the system administrator only — the person whose queue they asked for. */
async function whoseQueue(actor: ReturnType<typeof actorFrom>, forId: string | undefined): Promise<QueueOwner> {
  if (!forId || forId === actor.id) return actor;
  if (!isSystemAdmin(actor)) throw forbidden('صف کار دیگران را فقط مدیر سیستم می‌بیند.');
  const u = await prisma.user.findFirst({
    where: { id: forId, organizationId: actor.organizationId, deletedAt: null },
    select: { id: true, fullName: true, department: { select: { code: true } }, roles: { select: { role: { select: { code: true } } } } },
  });
  if (!u) throw notFound('کاربر');
  const roles = u.roles.map((r) => r.role.code);
  return { id: u.id, fullName: u.fullName, departmentCode: u.department?.code ?? null, roles, permissions: await userPermissions({ id: u.id, organizationId: actor.organizationId, roles }) };
}

const myWorkRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me/work', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const org = actor.organizationId;
    // Whose queue: one's own — or, for the system administrator, anyone's (owner's report,
    // 2026-10-23). What can be done from it stays the reader's own to decide (allowedFor below).
    const person = await whoseQueue(actor, (req.query as { for?: string }).for);
    const can = (p: string) => person.permissions.includes(p as never);
    const proj = { select: { code: true, name: true } } as const;

    // Each source capped, what has waited longest first (audit PERF-4); the answer says when one was cut.
    const sources = await Promise.all([
      prisma.task.findMany({
        where: { organizationId: org, assigneeId: person.id, state: { notIn: ['APPROVED', 'CLOSED', 'CANCELLED'] } },
        include: { project: proj }, orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }], take: over(QUEUE_CAP),
      }),
      // Orders sit with their owner until submitted for QC.
      prisma.workOrder.findMany({
        where: { organizationId: org, ownerId: person.id, state: { in: ['ISSUED', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'IN_PROGRESS'] } },
        include: { project: proj }, orderBy: { createdAt: 'asc' }, take: over(QUEUE_CAP),
      }),
      // A clarification request sits with whoever may issue orders — Account.
      can('workorder.issue')
        ? prisma.workOrder.findMany({
            where: { organizationId: org, state: 'CLARIFICATION_REQUESTED' }, include: { project: proj }, orderBy: { createdAt: 'asc' }, take: over(QUEUE_CAP),
          })
        : Promise.resolve([]),
      // Unit QC: deliverables of my own department, submitted and not yet reviewed since.
      // Every unit's, for the system administrator.
      can('qc.unit') && (person.departmentCode || isSystemAdmin(person))
        ? prisma.deliverable.findMany({
            where: { organizationId: org, state: 'SUBMITTED', ...(isSystemAdmin(person) ? {} : { departmentCode: person.departmentCode ?? '' }) },
            include: { project: proj, qcReviews: { where: { level: 'UNIT' }, select: { reviewedAt: true }, orderBy: { reviewedAt: 'desc' }, take: 1 } },
            orderBy: { submittedAt: 'asc' }, take: over(QUEUE_CAP),
          }).then((ds) => ds.filter((d) => !d.qcReviews[0] || (d.submittedAt && d.qcReviews[0].reviewedAt < d.submittedAt)))
        : Promise.resolve([]),
      can('qc.account')
        ? prisma.deliverable.findMany({ where: { organizationId: org, state: 'IN_QC' }, include: { project: proj }, orderBy: { submittedAt: 'asc' }, take: over(QUEUE_CAP) })
        : Promise.resolve([]),
      can('qc.final')
        ? prisma.proposal.findMany({ where: { organizationId: org, state: 'FINAL_QC' }, include: { brief: { select: { title: true } } }, orderBy: { createdAt: 'asc' }, take: over(QUEUE_CAP) })
        : Promise.resolve([]),
      can('form.approve')
        ? prisma.formSubmission.findMany({
            // Every pending form waits for the system administrator; anyone else, those for their roles.
            where: isSystemAdmin(person)
              ? { organizationId: org, state: 'PENDING_APPROVAL' }
              : { organizationId: org, state: 'PENDING_APPROVAL', submittedById: { not: person.id }, ...pendingForRoles(person.roles) },
            include: { definition: { select: { nameFa: true } }, project: proj }, orderBy: { submittedAt: 'asc' }, take: over(QUEUE_CAP),
          })
        : Promise.resolve([]),
      prisma.revision.findMany({
        where: { organizationId: org, assigneeId: person.id, state: { notIn: ['APPROVED', 'REJECTED'] } },
        include: { deliverable: { select: { name: true, project: proj } } }, orderBy: { createdAt: 'asc' }, take: over(QUEUE_CAP),
      }),
    ]);
    const truncated = sources.some((rows) => rows.length > QUEUE_CAP);
    const [tasks, orders, clarifications, unitQc, accountQc, finalQc, forms, revisions] = sources.map((rows) => rows.slice(0, QUEUE_CAP)) as typeof sources;

    const items: WorkItem[] = [
      ...tasks.map((t) => item('task', 'task', t.id, t.code, t.title, t.state, t.project, t.dueDate, `/tasks/${t.id}`)),
      ...orders.map((w) => item('workOrder', 'workOrder', w.id, w.code, w.title, w.state, w.project, w.deadline, `/work-orders/${w.id}`)),
      ...clarifications.map((w) => item('clarification', 'workOrder', w.id, w.code, w.clarificationNote ? `${w.title} — ${w.clarificationNote}` : w.title, w.state, w.project, w.deadline, `/work-orders/${w.id}`)),
      ...unitQc.map((d) => item('qcUnit', 'deliverable', d.id, d.code, d.name, d.state, d.project, d.dueDate, '/qc')),
      ...accountQc.map((d) => item('qcAccount', 'deliverable', d.id, d.code, d.name, d.state, d.project, d.dueDate, '/qc')),
      ...finalQc.map((p) => item('qcFinal', 'proposal', p.id, p.code, p.brief?.title ?? p.code, p.state, null, null, `/proposals/${p.id}`)),
      ...forms.map((f) => item('formApproval', 'formSubmission', f.id, f.code, f.definition.nameFa, f.state, f.project, null, '/forms')),
      ...revisions.map((r) => item('revision', 'revision', r.id, r.code, r.deliverable?.name ?? r.reason, r.state, r.deliverable?.project ?? null, r.dueDate, '/qc')),
    ];

    // One query for every open clock on everything collected, then the nearest per record.
    const ids = items.map((i) => i.entityId);
    const clocks = ids.length
      ? await prisma.slaClock.findMany({
          where: { organizationId: org, entityId: { in: ids }, state: { in: ['RUNNING', 'AT_RISK', 'BREACHED', 'PAUSED'] } },
          include: { policy: true }, orderBy: { dueAt: 'asc' },
        })
      : [];
    const cal = await loadCalendar(org);
    const now = new Date();
    const nearest = new Map<string, (typeof clocks)[number]>();
    for (const c of clocks) if (!nearest.has(`${c.entityType}:${c.entityId}`)) nearest.set(`${c.entityType}:${c.entityId}`, c);

    for (const i of items) {
      const c = nearest.get(`${i.entityType}:${i.entityId}`);
      if (!c) continue;
      const elapsed = businessHoursBetween(c.startedAt, now, cal);
      const paused = Number(c.pausedHours) + (c.state === 'PAUSED' && c.pausedAt ? businessHoursBetween(c.pausedAt, now, cal) : 0);
      i.sla = {
        policyCode: c.policy.code, labelFa: c.policy.labelFa, state: c.state, dueAt: c.dueAt,
        budgetHours: Number(c.policy.hours), controlledHours: Math.round((elapsed - paused) * 100) / 100,
      };
    }
    // "You are going to be late", where the work actually is — not only in a manager's report.
    const openClockIds = clocks.filter((c) => ['RUNNING', 'AT_RISK'].includes(c.state)).map((c) => c.id);
    if (openClockIds.length) {
      const byClock = new Map((await predictClocks(prisma, org, openClockIds, { now })).map((p) => [p.clockId, p]));
      for (const i of items) {
        const c = nearest.get(`${i.entityType}:${i.entityId}`);
        const p = c && byClock.get(c.id);
        if (!p || !i.sla || p.risk === 'LOW') continue;
        i.sla.risk = { probability: p.probability, risk: p.risk, becauseFa: p.becauseFa[0] ?? null };
      }
    }

    for (const i of items) {
      i.availableTransitions = i.entityType === 'formSubmission' ? [] : allowedFor(i.entityType, i.state, actor.permissions);
    }

    items.sort((a, b) => urgency(a, now) - urgency(b, now));

    const counts = Object.fromEntries(
      (Object.keys(KIND_LABEL) as WorkKind[]).map((k) => [k, items.filter((i) => i.kind === k).length]),
    ) as Record<WorkKind, number>;
    return {
      items, counts, kinds: KIND_LABEL, truncated,
      // Whose queue this is, when it is not the reader's own.
      person: person.id !== actor.id ? { id: person.id, fullName: person.fullName ?? '' } : null,
      breached: items.filter((i) => i.sla?.state === 'BREACHED').length,
      atRisk: items.filter((i) => i.sla?.state === 'AT_RISK').length,
    };
  });
};

function item(
  kind: WorkKind, entityType: string, entityId: string, code: string, title: string, state: string,
  project: { code: string; name: string } | null, dueAt: Date | null, href: string,
): WorkItem {
  return {
    kind, entityType, entityId, code, title, state,
    projectCode: project?.code ?? null, projectName: project?.name ?? null,
    dueAt, sla: null, href, availableTransitions: [],
  };
}

/**
 * Lower sorts first. A breached clock beats everything; then whatever runs out soonest; a
 * record with no clock is ordered by its own deadline, and one with neither goes last.
 */
function urgency(i: WorkItem, now: Date): number {
  const hour = 3_600_000;
  if (i.sla) {
    if (i.sla.state === 'BREACHED') return -1e12 + (i.sla.dueAt.getTime() - now.getTime()) / hour;
    if (i.sla.state === 'PAUSED') return 1e9 + (i.sla.dueAt.getTime() - now.getTime()) / hour;
    return (i.sla.dueAt.getTime() - now.getTime()) / hour;
  }
  if (i.dueAt) return 1e6 + (i.dueAt.getTime() - now.getTime()) / hour;
  return 1e10;
}

export default myWorkRoutes;
