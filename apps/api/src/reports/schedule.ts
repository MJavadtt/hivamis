/**
 * Critical path and schedule (roadmap #10).
 *
 * task_dependencies, the working calendar, and estimateHours on every task were all the inputs
 * CPM needs; nothing computed it. The value is not the chart — it is the float: "this task is
 * three days late and it does not matter" against "this one is a day late and the whole project
 * moves". Without float, every delay looks the same.
 *
 * Durations are working hours on the assignee's calendar (#13), so a task held by someone on
 * leave is scheduled around the leave. Finish-to-start is the only dependency kind modelled;
 * the schema has a `kind` column for the others when they are needed.
 */
import type { Tx } from '../db.js';
import { addBusinessHours, businessHoursBetween, hoursPerDay, type Calendar } from '../lib/business-calendar.js';
import { loadCalendar } from '../sla/engine.js';

/** A task without an estimate is scheduled as one working day — visible, and marked as assumed. */
export const DEFAULT_TASK_HOURS = 8;

export interface ScheduledTask {
  taskId: string;
  code: string;
  title: string;
  state: string;
  assigneeId: string | null;
  assigneeName: string | null;
  departmentCode: string;
  estimateHours: number;
  estimateAssumed: boolean;
  earliestStart: Date;
  earliestFinish: Date;
  latestStart: Date;
  latestFinish: Date;
  /** Working hours this task can slip without moving the project's finish. ≤ 0 is critical. */
  floatHours: number;
  critical: boolean;
  dueDate: Date | null;
  /** The earliest finish lands after the task's own due date. */
  missesDueDate: boolean;
  prerequisites: string[];
  done: boolean;
}

export interface Schedule {
  projectId: string;
  start: Date;
  plannedEnd: Date | null;
  /** When the last task can earliest finish. */
  projectedEnd: Date;
  /** Working hours the projection lands past the planned end; negative is slack. */
  slipHours: number | null;
  criticalPath: string[];
  tasks: ScheduledTask[];
  cycles: string[][];
}

const DONE = new Set(['APPROVED', 'CLOSED', 'CANCELLED']);

export async function scheduleProject(tx: Tx, organizationId: string, projectId: string): Promise<Schedule> {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: projectId }, select: { plannedStart: true, plannedEnd: true, actualStart: true, createdAt: true },
  });
  const tasks = await tx.task.findMany({
    where: { projectId, organizationId, state: { not: 'CANCELLED' } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, code: true, title: true, state: true, assigneeId: true, departmentCode: true, estimateHours: true, dueDate: true,
      acceptedAt: true, submittedAt: true, closedAt: true, createdAt: true,
      assignee: { select: { fullName: true } },
      dependsOn: { select: { prerequisiteId: true } },
    },
  });
  const orgCal = await loadCalendar(organizationId);
  const cals = new Map<string, Calendar>();
  const calFor = async (userId: string | null) => {
    const key = userId ?? '';
    if (!cals.has(key)) cals.set(key, userId ? await loadCalendar(organizationId, { userId }) : orgCal);
    return cals.get(key)!;
  };

  const start = project.actualStart ?? project.plannedStart ?? project.createdAt;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const prereqs = new Map(tasks.map((t) => [t.id, t.dependsOn.map((d) => d.prerequisiteId).filter((p) => byId.has(p))]));

  // Kahn's algorithm; whatever will not sort is in a cycle and is reported, not scheduled.
  const indeg = new Map(tasks.map((t) => [t.id, prereqs.get(t.id)!.length]));
  const order: string[] = [];
  const ready = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const t of tasks) if (prereqs.get(t.id)!.includes(id)) {
      indeg.set(t.id, indeg.get(t.id)! - 1);
      if (indeg.get(t.id) === 0) ready.push(t.id);
    }
  }
  const stuck = tasks.filter((t) => !order.includes(t.id)).map((t) => t.id);
  const cycles = stuck.length ? [stuck] : [];

  // Forward pass. A finished task occupies exactly the span it took; an open one starts when its
  // prerequisites finish (or now, if that has already passed) and runs for its estimate.
  const now = new Date();
  const es = new Map<string, Date>(); const ef = new Map<string, Date>();
  const hours = new Map<string, number>(); const assumed = new Set<string>();
  for (const id of order) {
    const t = byId.get(id)!;
    const cal = await calFor(t.assigneeId);
    let h = t.estimateHours == null ? DEFAULT_TASK_HOURS : Number(t.estimateHours);
    if (t.estimateHours == null) assumed.add(id);
    const preFinish = prereqs.get(id)!.map((p) => ef.get(p)!).filter(Boolean);
    let s = new Date(Math.max(start.getTime(), ...preFinish.map((d) => d.getTime())));
    if (DONE.has(t.state) && t.closedAt) {
      // History, not a plan: the span it actually took.
      s = t.acceptedAt ?? t.createdAt;
      const e = t.closedAt;
      h = businessHoursBetween(s, e, cal);
      es.set(id, s); ef.set(id, e); hours.set(id, h);
      continue;
    }
    // An open task cannot start in the past: the earliest it can begin is now, or when it was
    // accepted if the work is already under way.
    if (!DONE.has(t.state)) s = new Date(Math.max(s.getTime(), t.acceptedAt?.getTime() ?? now.getTime()));
    if (t.submittedAt && !DONE.has(t.state)) { // submitted, awaiting QC: the work is done, the wait is not
      es.set(id, t.acceptedAt ?? t.createdAt); ef.set(id, t.submittedAt); hours.set(id, h); continue;
    }
    es.set(id, s); ef.set(id, addBusinessHours(s, h, cal)); hours.set(id, h);
  }
  const projectedEnd = new Date(Math.max(start.getTime(), ...[...ef.values()].map((d) => d.getTime())));

  // Backward pass from the projected end (the plan's own end, if later, would hide the slip).
  const lf = new Map<string, Date>(); const ls = new Map<string, Date>();
  const successors = new Map<string, string[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const p of prereqs.get(t.id)!) successors.get(p)!.push(t.id);
  for (const id of [...order].reverse()) {
    const t = byId.get(id)!;
    const cal = await calFor(t.assigneeId);
    const succStarts = successors.get(id)!.map((s) => ls.get(s)!).filter(Boolean);
    const finish = succStarts.length ? new Date(Math.min(...succStarts.map((d) => d.getTime()))) : projectedEnd;
    lf.set(id, finish);
    // Walk back the task's hours from its latest finish on its own calendar.
    ls.set(id, subtractBusinessHours(finish, hours.get(id)!, cal));
  }

  const scheduled: ScheduledTask[] = order.map((id) => {
    const t = byId.get(id)!;
    const cal = cals.get(t.assigneeId ?? '') ?? orgCal;
    const floatHours = Math.round(businessHoursBetween(es.get(id)!, ls.get(id)!, cal) * 100) / 100;
    return {
      taskId: id, code: t.code, title: t.title, state: t.state, assigneeId: t.assigneeId, assigneeName: t.assignee?.fullName ?? null,
      departmentCode: t.departmentCode, estimateHours: hours.get(id)!, estimateAssumed: assumed.has(id),
      earliestStart: es.get(id)!, earliestFinish: ef.get(id)!, latestStart: ls.get(id)!, latestFinish: lf.get(id)!,
      floatHours, critical: floatHours <= 0.01 && !DONE.has(t.state),
      dueDate: t.dueDate, missesDueDate: !!t.dueDate && ef.get(id)! > t.dueDate && !DONE.has(t.state),
      prerequisites: prereqs.get(id)!, done: DONE.has(t.state),
    };
  });

  const slipHours = project.plannedEnd ? Math.round((projectedEnd > project.plannedEnd ? businessHoursBetween(project.plannedEnd, projectedEnd, orgCal) : -businessHoursBetween(projectedEnd, project.plannedEnd, orgCal)) * 100) / 100 : null;
  return {
    projectId, start, plannedEnd: project.plannedEnd, projectedEnd, slipHours,
    criticalPath: scheduled.filter((t) => t.critical).map((t) => t.taskId),
    tasks: scheduled, cycles,
  };
}

/** Walk `hours` of working time back from `end` on a calendar — the mirror of addBusinessHours. */
export function subtractBusinessHours(end: Date, hours: number, cal: Calendar): Date {
  // Bisect on the forward function: cheap enough for schedule sizes, and exact by construction.
  if (hours <= 0) return end;
  const perDay = hoursPerDay(cal) || 8;
  let lo = new Date(end.getTime() - (hours / perDay + 14) * 86_400_000 * 3);
  let hi = end;
  for (let i = 0; i < 40; i++) {
    const mid = new Date((lo.getTime() + hi.getTime()) / 2);
    if (addBusinessHours(mid, hours, cal) <= end) lo = mid; else hi = mid;
  }
  return lo;
}
