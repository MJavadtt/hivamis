/**
 * Revenue as it is earned, and the work in progress between earning and billing (roadmap #29).
 *
 * A contract value sits on the project and invoices go out when the contract says; neither is
 * when the revenue was earned. Without recognition, a monthly profit figure is the month the
 * contract was signed looking rich and the months the work was done looking like losses. Here a
 * project earns its contract value in proportion to how much of the work is done, measured one of
 * three ways the project chooses:
 *
 *   MILESTONE  the revenue shares of the milestones completed
 *   EFFORT     hours logged ÷ (hours logged + estimate still to go on open tasks)
 *   COST       cost incurred ÷ the larger of cost declared and cost incurred
 *
 * Effort and cost use "done ÷ (done + still to do)" rather than "done ÷ planned", so an overrun
 * lowers progress instead of pushing it past a hundred per cent. A closed project has earned all of
 * it. Recognised minus invoiced is the work in progress: positive, earned but not billed; negative,
 * billed ahead of the work (deferred revenue).
 *
 * Everything is computed from records already kept — milestones, tasks and their estimates, time
 * logged (#14) at each person's or unit's hourly cost, payments out, cost declarations, invoices,
 * amendments — as of any instant, so a month can be read as it stood at its end. A closed month is
 * frozen (`revenue_entries`); what changes after it lands in the next open month as a catch-up.
 */
import type { Tx } from '../db.js';
import { AppError, conflict } from '../lib/errors.js';
import { jalaliMonthLabel, jalaliOf, jalaliStart } from '../lib/jalali.js';

export const REVENUE_METHODS = ['MILESTONE', 'EFFORT', 'COST'] as const;
export type RevenueMethod = (typeof REVENUE_METHODS)[number];
export const METHOD_FA: Record<RevenueMethod, string> = {
  MILESTONE: 'بر پایهٔ نقاط عطف',
  EFFORT: 'درصد پیشرفت بر پایهٔ ساعت کار',
  COST: 'درصد پیشرفت بر پایهٔ هزینه',
};

const FA = '۰۱۲۳۴۵۶۷۸۹';
const fa = (v: string | number) => String(v).replace(/\d/g, (c) => FA[Number(c)]!);
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v == null ? 0 : Number(v));
const before = (d: Date | null | undefined, at: Date) => !!d && d < at;

/* ── Months ────────────────────────────────────────────────────────────── */

export interface Month { period: string; labelFa: string; start: Date; end: Date }

export function monthOf(jy: number, jm: number): Month {
  return { period: `${jy}-${String(jm).padStart(2, '0')}`, labelFa: jalaliMonthLabel(jy, jm), start: jalaliStart(jy, jm), end: jalaliStart(jy, jm + 1) };
}
export function parsePeriod(period: string): Month {
  const m = period.match(/^(1[34]\d\d)-(\d{2})$/);
  if (!m || +m[2]! < 1 || +m[2]! > 12) throw new AppError(400, 'INVALID_PERIOD', `دورهٔ «${period}» معتبر نیست؛ قالب درست: 1405-07`);
  return monthOf(+m[1]!, +m[2]!);
}
export const nextMonth = (m: Month) => { const j = jalaliOf(m.end); return monthOf(j.y, j.m); };
/** The last `count` Jalali months, oldest first, ending with the one `now` is in. */
export function lastMonths(count: number, now: Date): Month[] {
  const j = jalaliOf(now);
  const out: Month[] = [];
  for (let i = count - 1; i >= 0; i--) {
    let y = j.y, m = j.m - i;
    while (m < 1) { m += 12; y--; }
    out.push(monthOf(y, m));
  }
  return out;
}

/* ── The records ───────────────────────────────────────────────────────── */

export interface RevenueData {
  projects: { id: string; code: string; name: string; state: string; revenueMethod: string; contractValue: unknown; closedAt: Date | null; createdAt: Date; company: { legalName: string } }[];
  amendments: Map<string, { valueDelta: number; effectiveDate: Date }[]>;
  milestones: Map<string, { id: string; name: string; revenueShare: number | null; completedAt: Date | null; dueDate: Date }[]>;
  /** `doneAt`: when the task was finished — closed, or failing that submitted, for a task approved or closed. */
  tasks: Map<string, { id: string; estimateHours: number | null; state: string; doneAt: Date | null; createdAt: Date }[]>;
  entries: Map<string, { taskId: string; hours: number; workedOn: Date; userId: string }[]>;
  rates: Map<string, number | null>;
  paymentsOut: Map<string, { amount: number; occurredAt: Date }[]>;
  declared: Map<string, number>;
  /** Base totals, and the pass-through share of each (media billed for a vendor, #31). */
  invoices: Map<string, { total: number; passThrough: number; issueDate: Date }[]>;
  /** Media orders (#31): the agency's revenue on each, earned when the media ran. */
  media: Map<string, { agencyRevenue: number; airedAt: Date | null }[]>;
}

const group = <T, K>(rows: T[], key: (r: T) => K) => {
  const m = new Map<K, T[]>();
  for (const r of rows) (m.get(key(r)) ?? m.set(key(r), []).get(key(r))!).push(r);
  return m;
};

export async function loadRevenueData(tx: Tx, organizationId: string, projectIds?: string[]): Promise<RevenueData> {
  const scope = projectIds ? { in: projectIds } : undefined;
  const [projects, amendments, milestones, tasks, entries, users, payments, declarations, invoices, media] = await Promise.all([
    tx.project.findMany({
      where: { organizationId, deletedAt: null, ...(scope ? { id: scope } : {}) },
      select: { id: true, code: true, name: true, state: true, revenueMethod: true, contractValue: true, closedAt: true, createdAt: true, company: { select: { legalName: true } } },
    }),
    tx.amendment.findMany({
      where: { contract: { organizationId, projectId: scope ?? { not: null } } },
      select: { valueDelta: true, effectiveDate: true, contract: { select: { projectId: true } } },
    }),
    tx.milestone.findMany({ where: { project: { organizationId, ...(scope ? { id: scope } : {}) } }, orderBy: [{ sortOrder: 'asc' }, { dueDate: 'asc' }] }),
    tx.task.findMany({ where: { organizationId, ...(scope ? { projectId: scope } : {}) }, select: { id: true, projectId: true, estimateHours: true, state: true, closedAt: true, submittedAt: true, createdAt: true } }),
    tx.timeEntry.findMany({ where: { organizationId, ...(scope ? { task: { projectId: scope } } : {}) }, select: { taskId: true, hours: true, workedOn: true, userId: true, task: { select: { projectId: true } } } }),
    tx.user.findMany({ where: { organizationId }, select: { id: true, hourlyCost: true, department: { select: { hourlyCost: true } } } }),
    // A payment to a media vendor is a pass-through (#31): it is the client's media, not the project's cost.
    tx.payment.findMany({ where: { organizationId, direction: 'OUT', mediaOrderId: null, projectId: scope ?? { not: null } }, select: { projectId: true, amount: true, occurredAt: true } }),
    tx.costDeclaration.findMany({ where: { organizationId, workOrder: scope ? { projectId: scope } : { isNot: null } }, select: { internalCost: true, externalCost: true, workOrder: { select: { projectId: true } } } }),
    tx.invoice.findMany({ where: { organizationId, kind: 'INVOICE', state: { not: 'CANCELLED' }, projectId: scope ?? { not: null } }, select: { projectId: true, total: true, issueDate: true, lines: true, fxRate: true } }),
    tx.mediaOrder.findMany({ where: { organizationId, state: { not: 'CANCELLED' }, ...(scope ? { projectId: scope } : {}) }, select: { projectId: true, agencyRevenue: true, airedAt: true } }),
  ]);
  const declared = new Map<string, number>();
  for (const d of declarations) declared.set(d.workOrder!.projectId, (declared.get(d.workOrder!.projectId) ?? 0) + num(d.internalCost) + num(d.externalCost));
  return {
    projects,
    amendments: group(amendments.map((a) => ({ projectId: a.contract.projectId!, valueDelta: num(a.valueDelta), effectiveDate: a.effectiveDate })), (a) => a.projectId),
    milestones: group(milestones.map((m) => ({ id: m.id, projectId: m.projectId, name: m.name, revenueShare: m.revenueShare == null ? null : num(m.revenueShare), completedAt: m.completedAt, dueDate: m.dueDate })), (m) => m.projectId),
    tasks: group(tasks.map((t) => ({ id: t.id, projectId: t.projectId, estimateHours: t.estimateHours == null ? null : num(t.estimateHours), state: t.state, doneAt: t.closedAt ?? (['APPROVED', 'CLOSED'].includes(t.state) ? t.submittedAt : null), createdAt: t.createdAt })), (t) => t.projectId),
    entries: group(entries.map((e) => ({ taskId: e.taskId, projectId: e.task.projectId, hours: num(e.hours), workedOn: e.workedOn, userId: e.userId })), (e) => e.projectId),
    rates: new Map(users.map((u) => [u.id, u.hourlyCost != null ? num(u.hourlyCost) : u.department?.hourlyCost != null ? num(u.department.hourlyCost) : null])),
    paymentsOut: group(payments.map((p) => ({ projectId: p.projectId!, amount: num(p.amount), occurredAt: p.occurredAt })), (p) => p.projectId),
    declared,
    invoices: group(invoices.map((i) => ({ projectId: i.projectId!, total: num(i.total), passThrough: passThroughOf(i.lines, i.fxRate), issueDate: i.issueDate })), (i) => i.projectId),
    media: group(media.map((m) => ({ projectId: m.projectId, agencyRevenue: num(m.agencyRevenue), airedAt: m.airedAt })), (m) => m.projectId),
  };
}

/** The base value of an invoice's pass-through lines — media billed on a vendor's behalf (#31). */
function passThroughOf(lines: unknown, fxRate: unknown): number {
  if (!Array.isArray(lines)) return 0;
  const orig = lines.filter((l) => l && (l as { passThrough?: boolean }).passThrough)
    .reduce((s, l) => s + num((l as { quantity?: number }).quantity ?? 1) * num((l as { unitPrice?: number }).unitPrice), 0);
  return r2(orig * num(fxRate ?? 1));
}

/* ── A project's position at an instant ────────────────────────────────── */

export interface Position {
  projectId: string;
  method: RevenueMethod;
  at: Date;
  contractValue: number | null;
  progress: number | null;
  recognised: number | null;
  invoiced: number;
  /** Recognised − invoiced: earned and not billed (+), or billed ahead of the work (−). */
  wip: number | null;
  basis: Record<string, unknown>;
  /** Why progress could not be measured, when it could not. */
  reasonFa: string | null;
  notesFa: string[];
}

/** Labour cost of time entries, at each person's (or their unit's) hourly cost. */
export function labourCost(data: RevenueData, entries: { hours: number; userId: string }[]) {
  let cost = 0, unpricedHours = 0;
  for (const e of entries) {
    const rate = data.rates.get(e.userId);
    if (rate == null) unpricedHours += e.hours; else cost += e.hours * rate;
  }
  return { cost: r2(cost), unpricedHours: r2(unpricedHours) };
}

export function positionAt(data: RevenueData, projectId: string, at: Date): Position {
  const p = data.projects.find((x) => x.id === projectId)!;
  const method = (REVENUE_METHODS as readonly string[]).includes(p.revenueMethod) ? p.revenueMethod as RevenueMethod : 'EFFORT';
  const notesFa: string[] = [];
  // Billed, less what was billed on a vendor's behalf: pass-through is never the agency's (#31).
  const invoiced = r2((data.invoices.get(projectId) ?? []).filter((i) => before(i.issueDate, at)).reduce((s, i) => s + i.total - i.passThrough, 0));
  // Media commission is earned when the media runs (#31) — on top of the service contract.
  const closedBy = p.state === 'CLOSED' && before(p.closedAt, at);
  const mediaOrders = data.media.get(projectId) ?? [];
  const media = r2(mediaOrders.filter((m) => before(m.airedAt, at)).reduce((s, m) => s + m.agencyRevenue, 0));
  const out = (progress: number | null, basis: Record<string, unknown>, reasonFa: string | null = null, contractValue: number | null = null): Position => {
    const service = progress == null || contractValue == null ? null : r2(contractValue * progress);
    // Commission on media that ran is earned whatever the service side can be measured as; when
    // the service side cannot be, the media alone is recognised and the note says so.
    const recognised = service != null ? r2(service + media) : mediaOrders.length ? media : null;
    if (service == null && mediaOrders.length && reasonFa) notesFa.push('فقط کمیسیون رسانه شناسایی شد؛ بخش خدمات سنجیده نشد.');
    return {
      projectId, method, at, contractValue, progress: progress == null ? null : Math.round(progress * 1e6) / 1e6, recognised, invoiced,
      wip: recognised == null ? null : r2(recognised - invoiced), basis: mediaOrders.length ? { ...basis, mediaCommission: media } : basis, reasonFa, notesFa,
    };
  };

  // The contract value in force then: today's, less amendments that took effect afterwards.
  const later = (data.amendments.get(projectId) ?? []).filter((a) => a.effectiveDate >= at).reduce((s, a) => s + a.valueDelta, 0);
  const value = p.contractValue == null ? null : r2(num(p.contractValue) - later);
  if (!value || value <= 0) {
    // A media-only project earns its commission and nothing else.
    if (mediaOrders.length) { notesFa.push('قرارداد خدمات ثبت نشده؛ فقط کمیسیون رسانه شناسایی می‌شود.'); return out(0, {}, null, 0); }
    return out(null, {}, 'ارزش قرارداد ثبت نشده است؛ درآمدی برای شناسایی نیست.');
  }
  if (at <= p.createdAt) return out(0, { reason: 'NOT_STARTED' }, null, value);
  if (closedBy) return out(1, { closedAt: p.closedAt }, null, value);

  if (method === 'MILESTONE') {
    const ms = data.milestones.get(projectId) ?? [];
    const shared = ms.filter((m) => (m.revenueShare ?? 0) > 0);
    const totalShare = shared.reduce((s, m) => s + m.revenueShare!, 0);
    if (!totalShare) return out(null, {}, 'برای نقاط عطف سهم درآمد تعیین نشده است.', value);
    if (totalShare < 100) notesFa.push(`جمع سهم نقاط عطف ${fa(totalShare)}٪ است؛ بقیه هنگام بستن پروژه شناسایی می‌شود.`);
    const done = shared.filter((m) => before(m.completedAt, at));
    return out(Math.min(1, done.reduce((s, m) => s + m.revenueShare!, 0) / 100), {
      milestones: shared.map((m) => ({ id: m.id, name: m.name, share: m.revenueShare, done: before(m.completedAt, at) })), totalShare,
    }, null, value);
  }

  const entries = (data.entries.get(projectId) ?? []).filter((e) => before(e.workedOn, at));
  if (method === 'EFFORT') {
    // The work as it stood then: tasks that existed, less those already closed.
    const tasks = (data.tasks.get(projectId) ?? []).filter((t) => t.state !== 'CANCELLED' && before(t.createdAt, at));
    const loggedOn = new Map<string, number>();
    for (const e of entries) loggedOn.set(e.taskId, (loggedOn.get(e.taskId) ?? 0) + e.hours);
    const logged = entries.reduce((s, e) => s + e.hours, 0);
    let remaining = 0, unestimated = 0;
    for (const t of tasks) {
      if (before(t.doneAt, at)) continue;
      if (t.estimateHours == null) { unestimated++; continue; }
      remaining += Math.max(0, t.estimateHours - (loggedOn.get(t.id) ?? 0));
    }
    if (unestimated) notesFa.push(`${fa(unestimated)} وظیفهٔ باز برآورد ساعت ندارد و باقی‌ماندهٔ آن صفر فرض شد.`);
    if (logged + remaining <= 0) return out(null, {}, 'نه ساعتی ثبت شده و نه برآورد ساعتی برای وظایف هست.', value);
    return out(logged / (logged + remaining), { loggedHours: r2(logged), remainingHours: r2(remaining), unestimatedTasks: unestimated }, null, value);
  }

  // COST
  const labour = labourCost(data, entries);
  const external = r2((data.paymentsOut.get(projectId) ?? []).filter((x) => before(x.occurredAt, at)).reduce((s, x) => s + x.amount, 0));
  const incurred = labour.cost + external;
  const declared = data.declared.get(projectId) ?? 0;
  if (labour.unpricedHours) notesFa.push(`${fa(labour.unpricedHours)} ساعت کار بدون نرخ ساعتی ثبت شده و در هزینه حساب نشد.`);
  if (!declared && !incurred) return out(null, {}, 'نه هزینهٔ تمام‌شده‌ای اعلام شده و نه هزینه‌ای رخ داده است.', value);
  if (!declared) notesFa.push('هزینهٔ تمام‌شده اعلام نشده؛ پیشرفت با هزینهٔ رخ‌داده به‌تنهایی سنجیده شد.');
  return out(incurred / Math.max(declared, incurred), { labourCost: labour.cost, externalCost: external, incurred: r2(incurred), declared: r2(declared) }, null, value);
}

/** Declared cost above the contract value: a contract expected to lose money, said as soon as it is known. */
export function expectedLoss(data: RevenueData, projectId: string): number | null {
  const p = data.projects.find((x) => x.id === projectId)!;
  const declared = data.declared.get(projectId) ?? 0;
  const value = num(p.contractValue);
  return value > 0 && declared > value ? r2(declared - value) : null;
}

/* ── Months, frozen and open ───────────────────────────────────────────── */

export async function frozen(tx: Tx, organizationId: string) {
  const [periods, entries] = await Promise.all([
    tx.revenuePeriod.findMany({ where: { organizationId }, orderBy: { periodEnd: 'asc' } }),
    tx.revenueEntry.findMany({ where: { organizationId } }),
  ]);
  const byProject = new Map<string, Map<string, (typeof entries)[number]>>();
  for (const e of entries) (byProject.get(e.projectId) ?? byProject.set(e.projectId, new Map()).get(e.projectId)!).set(e.period, e);
  return { periods, byProject, last: periods.at(-1) ?? null };
}

/**
 * Recognised to date at an instant: the frozen figure when the instant is a closed month's end,
 * otherwise measured. So the first open month after a close starts where the books left it.
 */
export function cumulativeAt(data: RevenueData, fz: Awaited<ReturnType<typeof frozen>>, projectId: string, at: Date): number | null {
  const closedHere = fz.periods.find((p) => p.periodEnd.getTime() === at.getTime());
  if (closedHere) {
    const e = fz.byProject.get(projectId)?.get(closedHere.period);
    if (e) return Number(e.recognisedToDate);
  }
  return positionAt(data, projectId, at).recognised;
}

export function monthFlows(data: RevenueData, m: { start: Date; end: Date }) {
  const inMonth = (d: Date) => d >= m.start && d < m.end;
  const allEntries = [...data.entries.values()].flat().filter((e) => inMonth(e.workedOn));
  const labour = labourCost(data, allEntries);
  return {
    invoiced: r2([...data.invoices.values()].flat().filter((i) => inMonth(i.issueDate)).reduce((s, i) => s + i.total - i.passThrough, 0)),
    labourCost: labour.cost, unpricedHours: labour.unpricedHours,
    externalCost: r2([...data.paymentsOut.values()].flat().filter((x) => inMonth(x.occurredAt)).reduce((s, x) => s + x.amount, 0)),
  };
}

/** The accrual view of the last months beside the billing view, and the work in progress today. */
export async function revenueReport(tx: Tx, organizationId: string, count: number, now: Date) {
  const data = await loadRevenueData(tx, organizationId);
  const fz = await frozen(tx, organizationId);
  const months = lastMonths(count, now).map((m) => {
    const closed = fz.periods.find((p) => p.period === m.period);
    if (closed) {
      const t = closed.totals as Record<string, number>;
      return { ...m, closed: true, recognised: t.recognised ?? 0, invoiced: t.invoiced ?? 0, labourCost: t.labourCost ?? 0, externalCost: t.externalCost ?? 0, unpricedHours: t.unpricedHours ?? 0 };
    }
    const end = m.end < now ? m.end : now;
    let recognised = 0;
    for (const p of data.projects) {
      const a = cumulativeAt(data, fz, p.id, m.start) ?? 0;
      const b = cumulativeAt(data, fz, p.id, end);
      if (b != null) recognised += b - a;
    }
    return { ...m, closed: false, recognised: r2(recognised), ...monthFlows(data, { start: m.start, end }) };
  }).map((m) => ({
    ...m,
    /** Earned − cost: the month's real margin. */
    margin: r2(m.recognised - m.labourCost - m.externalCost),
    /** Billed − cost: what the month looked like before recognition. */
    billingMargin: r2(m.invoiced - m.labourCost - m.externalCost),
  }));

  const projects = data.projects.filter((p) => p.state !== 'CANCELLED').map((p) => {
    const pos = positionAt(data, p.id, now);
    return {
      id: p.id, code: p.code, name: p.name, client: p.company.legalName, state: p.state, method: pos.method, methodFa: METHOD_FA[pos.method],
      contractValue: pos.contractValue, progress: pos.progress, recognised: pos.recognised, invoiced: pos.invoiced, wip: pos.wip,
      reasonFa: pos.reasonFa, notesFa: pos.notesFa, expectedLoss: expectedLoss(data, p.id),
    };
  }).filter((p) => p.contractValue || p.invoiced);

  const measured = projects.filter((p) => p.wip != null);
  return {
    months,
    lastClosed: fz.last?.period ?? null,
    nextToClose: fz.last ? nextMonth(parsePeriod(fz.last.period)).period : null,
    wip: {
      unbilled: r2(measured.filter((p) => p.wip! > 0).reduce((s, p) => s + p.wip!, 0)),
      deferred: r2(measured.filter((p) => p.wip! < 0).reduce((s, p) => s - p.wip!, 0)),
    },
    projects,
  };
}

/* ── Closing a month ───────────────────────────────────────────────────── */

export async function closePeriod(tx: Tx, organizationId: string, period: string, actorId: string, now: Date) {
  const m = parsePeriod(period);
  if (m.end > now) throw new AppError(422, 'PERIOD_NOT_ENDED', `دورهٔ ${m.labelFa} هنوز تمام نشده است؛ ماه جاری بسته نمی‌شود.`);
  const fz = await frozen(tx, organizationId);
  if (fz.periods.some((p) => p.period === period)) throw conflict('PERIOD_ALREADY_CLOSED', `دورهٔ ${m.labelFa} پیش‌تر بسته شده است و بازگشایی نمی‌شود.`);
  if (fz.last) {
    const expected = nextMonth(parsePeriod(fz.last.period));
    if (expected.period !== period) {
      throw new AppError(422, 'PERIOD_OUT_OF_ORDER', `دوره‌ها به ترتیب بسته می‌شوند؛ دورهٔ بعدی برای بستن ${expected.labelFa} است.`, { expected: expected.period });
    }
  }

  const data = await loadRevenueData(tx, organizationId);
  const rows: { projectId: string; code: string; amount: number }[] = [];
  const unmeasured: { projectId: string; code: string; reasonFa: string }[] = [];
  for (const p of data.projects) {
    const pos = positionAt(data, p.id, m.end);
    if (pos.recognised == null) {
      if (pos.reasonFa && p.contractValue) unmeasured.push({ projectId: p.id, code: p.code, reasonFa: pos.reasonFa });
      continue;
    }
    // What earlier closes froze; the first close starts from the position at the month's start.
    const prevEntry = fz.last ? fz.byProject.get(p.id)?.get(fz.last.period) : undefined;
    const opening = fz.last ? Number(prevEntry?.recognisedToDate ?? 0) : (positionAt(data, p.id, m.start).recognised ?? 0);
    const amount = r2(pos.recognised - opening);
    await tx.revenueEntry.create({
      data: {
        organizationId, projectId: p.id, period, periodEnd: m.end, method: pos.method,
        progress: pos.progress!, contractValue: pos.contractValue!, recognisedToDate: pos.recognised,
        amount, invoicedToDate: pos.invoiced,
        basis: { ...pos.basis, opening, notesFa: pos.notesFa, catchUp: fz.last && !prevEntry && pos.recognised > 0 ? true : undefined } as object,
      },
    });
    rows.push({ projectId: p.id, code: p.code, amount });
  }
  const flows = monthFlows(data, m);
  const totals = { recognised: r2(rows.reduce((s, r) => s + r.amount, 0)), ...flows, projects: rows.length, unmeasured: unmeasured.length };
  const closed = await tx.revenuePeriod.create({
    data: { organizationId, period, periodStart: m.start, periodEnd: m.end, closedById: actorId, totals },
  });
  return { period: closed, month: m, totals, entries: rows, unmeasured };
}
