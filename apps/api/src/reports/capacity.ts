/**
 * Capacity-aware assignment (roadmap #12).
 *
 * `User.weeklyCapacityHours` and the `allocations` table both existed and nothing read them at
 * the moment that matters — the moment a task is handed to a person. The traffic board showed
 * load *afterwards*; this puts the same arithmetic in front of the decision, and adds what the
 * board could not know: whether the person can still finish by the due date, on their own
 * calendar (#13), after the work they already hold.
 *
 * Deliberately advisory. Doc_H nowhere forbids overloading someone — a deadline sometimes costs
 * a weekend, and a system that refuses the assignment only pushes the work off the system. So
 * the over-capacity verdict is a warning carried beside the name, never a guard.
 */
import type { Tx } from '../db.js';
import { addBusinessHours, businessHoursBetween } from '../lib/business-calendar.js';
import { loadCalendar } from '../sla/engine.js';
import { DEFAULT_TASK_HOURS } from './schedule.js';

const OPEN_STATES = ['CREATED', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED', 'IN_QC', 'REVISION_REQUIRED'];
const DONE_STATES = ['APPROVED', 'CLOSED'];
/** Below this many finished tasks, a person's on-time and accuracy history says nothing. */
export const MIN_HISTORY = 5;

export type LoadStatus = 'UNDER_UTILISED' | 'HEALTHY' | 'AT_CAPACITY' | 'OVER_ALLOCATED';

export interface PersonLoad {
  userId: string;
  fullName: string;
  jobTitle: string | null;
  departmentCode: string | null;
  /** Working hours in the window on this person's own calendar, capped by their contract. */
  capacityHours: number;
  /** Working hours the window holds on their calendar, before the contractual cap. */
  calendarHours: number;
  /** Hours the window would have held without their leave — the difference is the leave. */
  leaveHours: number;
  allocatedHours: number;
  taskHours: number;
  committedHours: number;
  remainingHours: number;
  utilisation: number;
  status: LoadStatus;
  openTasks: number;
  overdueTasks: number;
}

export const statusOf = (utilisation: number): LoadStatus =>
  utilisation > 100 ? 'OVER_ALLOCATED' : utilisation >= 85 ? 'AT_CAPACITY' : utilisation >= 40 ? 'HEALTHY' : 'UNDER_UTILISED';

export interface LoadWindow { from: Date; to: Date }

/**
 * Per-person load over a window. Capacity is the smaller of what their calendar holds and what
 * their contract says, so a four-day week and a week of leave both show up honestly.
 *
 * Allocations and open tasks are two views of the same commitment, so the larger is taken
 * rather than their sum — the convention the traffic board has always used.
 */
export async function personLoads(
  tx: Tx, organizationId: string, window: LoadWindow, opts: { departmentCode?: string; userIds?: string[] } = {},
): Promise<PersonLoad[]> {
  const users = await tx.user.findMany({
    where: {
      organizationId, isActive: true, deletedAt: null,
      ...(opts.departmentCode ? { department: { code: opts.departmentCode } } : {}),
      ...(opts.userIds ? { id: { in: opts.userIds } } : {}),
    },
    select: {
      id: true, fullName: true, jobTitle: true, weeklyCapacityHours: true,
      department: { select: { code: true } },
    },
    orderBy: { fullName: 'asc' },
  });
  if (!users.length) return [];

  const orgCal = await loadCalendar(organizationId);
  const [allocations, tasks] = await Promise.all([
    tx.allocation.findMany({
      where: { userId: { in: users.map((u) => u.id) }, fromDate: { lte: window.to }, toDate: { gte: window.from } },
      select: { userId: true, fromDate: true, toDate: true, hoursPerDay: true },
    }),
    tx.task.findMany({
      where: {
        organizationId, assigneeId: { in: users.map((u) => u.id) }, state: { in: OPEN_STATES },
        OR: [{ dueDate: null }, { dueDate: { lte: window.to } }],
      },
      select: { assigneeId: true, estimateHours: true, actualHours: true, dueDate: true },
    }),
  ]);

  const now = new Date();
  const days = Math.max(0, (window.to.getTime() - window.from.getTime()) / 86_400_000);
  const out: PersonLoad[] = [];
  for (const u of users) {
    const cal = await loadCalendar(organizationId, { userId: u.id, departmentCode: u.department?.code });
    const calendarHours = businessHoursBetween(window.from, window.to, cal);
    // What the same window would hold on the organisation's calendar: the gap is their leave.
    const leaveHours = Math.max(0, r1(businessHoursBetween(window.from, window.to, orgCal) - calendarHours));
    const contractHours = (Number(u.weeklyCapacityHours) * days) / 7;
    const capacityHours = Math.min(calendarHours, contractHours);

    const mine = allocations.filter((a) => a.userId === u.id);
    const allocatedHours = mine.reduce((sum, a) => {
      const start = a.fromDate > window.from ? a.fromDate : window.from;
      const end = a.toDate < window.to ? a.toDate : window.to;
      const overlapDays = Math.max(0, (end.getTime() - start.getTime()) / 86_400_000);
      return sum + overlapDays * (cal.workingDays.length / 7) * Number(a.hoursPerDay);
    }, 0);
    // What is left of each open task, not its whole estimate: logged hours are already spent.
    const myTasks = tasks.filter((t) => t.assigneeId === u.id);
    const taskHours = myTasks.reduce((s, t) => {
      const est = t.estimateHours == null ? DEFAULT_TASK_HOURS : Number(t.estimateHours);
      return s + Math.max(0, est - Number(t.actualHours ?? 0));
    }, 0);

    const committedHours = Math.max(allocatedHours, taskHours);
    const utilisation = capacityHours > 0 ? Math.round((committedHours / capacityHours) * 100) : committedHours > 0 ? 999 : 0;
    out.push({
      userId: u.id, fullName: u.fullName, jobTitle: u.jobTitle, departmentCode: u.department?.code ?? null,
      capacityHours: r1(capacityHours), calendarHours: r1(calendarHours), leaveHours,
      allocatedHours: r1(allocatedHours), taskHours: r1(taskHours), committedHours: r1(committedHours),
      remainingHours: r1(capacityHours - committedHours), utilisation, status: statusOf(utilisation),
      openTasks: myTasks.length, overdueTasks: myTasks.filter((t) => t.dueDate && t.dueDate < now).length,
    });
  }
  return out;
}

export interface Candidate {
  load: PersonLoad;
  /** Remaining capacity covers the work. */
  fits: boolean;
  /** Utilisation once this task is added — the number the warning is about. */
  utilisationAfter: number;
  statusAfter: LoadStatus;
  /** When they would finish, on their own calendar, after what they already hold. */
  earliestFinish: Date;
  missesDueDate: boolean;
  history: { doneTasks: number; onTimePercent: number | null; estimateErrorPercent: number | null };
  score: number;
  reasonsFa: string[];
  warningsFa: string[];
}

export interface SuggestInput {
  departmentCode?: string;
  /** Hours of work to place; defaults to one working day. */
  hours?: number;
  /** The due date the assignment has to meet, if any. */
  by?: Date;
  limit?: number;
  /** Candidates to consider, instead of a whole department. */
  userIds?: string[];
}

/**
 * Who should take this work. Remaining capacity carries most of the weight; delivery history
 * breaks ties. Every component of the score is also returned in words, because a ranking
 * nobody can argue with is a ranking nobody trusts.
 */
export async function suggestAssignees(
  tx: Tx, organizationId: string, input: SuggestInput,
): Promise<{ window: LoadWindow; hours: number; by: Date | null; candidates: Candidate[] }> {
  const hours = input.hours && input.hours > 0 ? input.hours : DEFAULT_TASK_HOURS;
  const now = new Date();
  const by = input.by ?? null;
  // Look ahead to the due date, but never judge capacity on less than a week or more than a quarter.
  const horizon = by && by > now ? by.getTime() : now.getTime() + 14 * 86_400_000;
  const window = {
    from: now,
    to: new Date(Math.min(Math.max(horizon, now.getTime() + 7 * 86_400_000), now.getTime() + 90 * 86_400_000)),
  };

  const loads = await personLoads(tx, organizationId, window, { departmentCode: input.departmentCode, userIds: input.userIds });
  if (!loads.length) return { window, hours, by, candidates: [] };
  const history = await deliveryHistory(tx, organizationId, loads.map((l) => l.userId));

  const candidates: Candidate[] = [];
  for (const load of loads) {
    const cal = await loadCalendar(organizationId, { userId: load.userId, departmentCode: load.departmentCode ?? undefined });
    const h = history.get(load.userId) ?? { doneTasks: 0, onTimePercent: null, estimateErrorPercent: null };
    const utilisationAfter = load.capacityHours > 0
      ? Math.round(((load.committedHours + hours) / load.capacityHours) * 100) : 999;
    // They start this after clearing what they already hold — the honest finish, not the optimistic one.
    const earliestFinish = addBusinessHours(now, load.committedHours + hours, cal);
    const fits = load.remainingHours >= hours;
    const missesDueDate = !!by && earliestFinish > by;

    const availability = load.capacityHours > 0 ? clamp01(load.remainingHours / hours) : 0;
    const onTime = h.onTimePercent == null ? 0.6 : h.onTimePercent / 100;
    const accuracy = h.estimateErrorPercent == null ? 0.6 : clamp01(1 - h.estimateErrorPercent / 100);
    const clean = load.openTasks === 0 ? 1 : clamp01(1 - load.overdueTasks / load.openTasks);
    const score = Math.round((availability * 0.45 + onTime * 0.25 + accuracy * 0.15 + clean * 0.15) * 100)
      - (missesDueDate ? 25 : 0);

    const reasonsFa: string[] = [];
    reasonsFa.push(fits
      ? `${fa(load.remainingHours)} ساعت ظرفیت آزاد در این بازه — کار ${fa(hours)} ساعت است`
      : `ظرفیت آزادش ${fa(load.remainingHours)} ساعت است و کار ${fa(hours)} ساعت`);
    if (load.leaveHours > 0) reasonsFa.push(`${fa(load.leaveHours)} ساعت از این بازه مرخصی دارد`);
    if (h.doneTasks >= MIN_HISTORY) {
      if (h.onTimePercent != null) reasonsFa.push(`از ${fa(h.doneTasks)} وظیفهٔ تمام‌شده، ${fa(h.onTimePercent)}٪ سر موعد`);
      if (h.estimateErrorPercent != null) reasonsFa.push(`انحراف برآوردش به‌طور میانگین ${fa(h.estimateErrorPercent)}٪`);
    } else {
      reasonsFa.push('سابقهٔ کافی برای داوری کیفیت تحویل ندارد — رتبه فقط بر پایهٔ ظرفیت است');
    }

    const warningsFa: string[] = [];
    if (utilisationAfter > 100) warningsFa.push(`این تخصیص او را به ${fa(utilisationAfter)}٪ ظرفیت می‌رساند`);
    else if (utilisationAfter >= 85) warningsFa.push(`با این تخصیص به ${fa(utilisationAfter)}٪ ظرفیت می‌رسد`);
    if (missesDueDate) warningsFa.push('با کاری که روی دستش است، پیش از موعد این وظیفه تمام نمی‌کند');
    if (load.overdueTasks > 0) warningsFa.push(`${fa(load.overdueTasks)} وظیفهٔ گذشته از موعد دارد`);

    candidates.push({
      load, fits, utilisationAfter, statusAfter: statusOf(utilisationAfter), earliestFinish, missesDueDate,
      history: h, score, reasonsFa, warningsFa,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.load.utilisation - b.load.utilisation);
  return { window, hours, by, candidates: candidates.slice(0, Math.min(Math.max(input.limit ?? 5, 1), 50)) };
}

/** On-time delivery and estimate accuracy from each person's finished tasks. */
async function deliveryHistory(tx: Tx, organizationId: string, userIds: string[]) {
  const done = await tx.task.findMany({
    where: { organizationId, assigneeId: { in: userIds }, state: { in: DONE_STATES } },
    select: { assigneeId: true, dueDate: true, closedAt: true, submittedAt: true, estimateHours: true, actualHours: true },
  });
  const out = new Map<string, { doneTasks: number; onTimePercent: number | null; estimateErrorPercent: number | null }>();
  for (const id of userIds) {
    const mine = done.filter((t) => t.assigneeId === id);
    const dated = mine.filter((t) => t.dueDate && (t.submittedAt ?? t.closedAt));
    const errors = mine
      .filter((t) => t.estimateHours != null && t.actualHours != null && Number(t.estimateHours) > 0)
      .map((t) => Math.abs(Number(t.actualHours) - Number(t.estimateHours)) / Number(t.estimateHours));
    out.set(id, {
      doneTasks: mine.length,
      onTimePercent: dated.length >= MIN_HISTORY
        ? Math.round((dated.filter((t) => (t.submittedAt ?? t.closedAt)! <= t.dueDate!).length / dated.length) * 100)
        : null,
      estimateErrorPercent: errors.length >= MIN_HISTORY
        ? Math.round((errors.reduce((a, b) => a + b, 0) / errors.length) * 100)
        : null,
    });
  }
  return out;
}

/** What one more assignment would do to one person — the warning shown beside their name. */
export async function assignmentImpact(
  tx: Tx, organizationId: string, userId: string, opts: { hours?: number; by?: Date } = {},
): Promise<Candidate | null> {
  const { candidates } = await suggestAssignees(tx, organizationId, { userIds: [userId], hours: opts.hours, by: opts.by, limit: 1 });
  return candidates[0] ?? null;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
const fa = (n: number) => new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(n);
