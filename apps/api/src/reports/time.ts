/**
 * Time logging and cost accuracy (roadmap #14).
 *
 * Doc_H names "cost accuracy" a KPI of the execution units, and cost_declarations holds what
 * the units *declared*. Nothing measured what it actually took, so the KPI had one side. Time
 * entries are that other side: hours, a day, a note — logged as work goes, or as one number
 * when the task is submitted, which is the least a person can be asked and still closes the
 * loop. Hours become money through an hourly cost, the person's own or their unit's default.
 */
import type { Tx } from '../db.js';
import { money, sumOf, toMoney, ZERO } from '../lib/money.js';
import { capped, FACT_CAP, over } from '../lib/limits.js';
import { badRequest } from '../lib/errors.js';

export const MAX_HOURS_PER_ENTRY = 24;

/** Add hours to a task and keep actualHours as their sum. Returns the entry and the new total. */
export async function logTime(
  tx: Tx,
  input: { organizationId: string; taskId: string; userId: string; hours: number; workedOn?: Date; note?: string | null },
) {
  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS_PER_ENTRY) {
    throw badRequest('INVALID_HOURS', `ساعت باید عددی بین ۰ و ${MAX_HOURS_PER_ENTRY} باشد`, { hours: input.hours });
  }
  const entry = await tx.timeEntry.create({
    data: {
      organizationId: input.organizationId, taskId: input.taskId, userId: input.userId,
      hours: Math.round(hours * 100) / 100, workedOn: input.workedOn ?? new Date(), note: input.note ?? null,
    },
  });
  const total = await recomputeActual(tx, input.taskId);
  return { entry, actualHours: total };
}

export async function recomputeActual(tx: Tx, taskId: string): Promise<number> {
  const sum = await tx.timeEntry.aggregate({ where: { taskId }, _sum: { hours: true } });
  const total = Number(sum._sum.hours ?? 0);
  await tx.task.update({ where: { id: taskId }, data: { actualHours: total } });
  return total;
}

/** A person's hourly cost: their own, else their unit's, else null (hours stay hours). */
export async function hourlyCostOf(tx: Tx, userId: string): Promise<number | null> {
  const u = await tx.user.findUnique({ where: { id: userId }, select: { hourlyCost: true, department: { select: { hourlyCost: true } } } });
  const rate = u?.hourlyCost ?? u?.department?.hourlyCost ?? null;
  return rate == null ? null : Number(rate);
}

export interface CostAccuracyRow {
  departmentCode: string;
  workOrders: number;
  /** Σ internalCost declared by the unit on its orders. */
  declared: number;
  /** Σ hours logged on the orders' tasks. */
  hours: number;
  /** Σ hours × hourly cost, where a rate is known. */
  actualCost: number | null;
  /** Hours logged by people with no rate — the part of actualCost that is missing. */
  unpricedHours: number;
  /** actualCost / declared — 1.0 is a perfect declaration; > 1 the unit under-declared. */
  ratio: number | null;
  /** Estimate accuracy of the unit's tasks: mean |actual − estimate| / estimate, as a percent. */
  estimateErrorPercent: number | null;
  tasksWithBoth: number;
}

/**
 * Declared cost against what the hours say, per unit and per order. A unit whose ratio sits
 * near 1 declares honestly; one drifting above is absorbing cost it did not price; one below is
 * padding. Six months of this is a pricing model.
 */
export async function costAccuracy(tx: Tx, organizationId: string, window: { from?: Date; to?: Date } = {}) {
  const dateFilter = window.from || window.to
    ? { createdAt: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) } }
    : {};
  // The newest FACT_CAP orders in the window (audit PERF-4); `truncated` says when there were more.
  const read = await tx.workOrder.findMany({
    where: { organizationId, ...dateFilter }, orderBy: { createdAt: 'desc' }, take: over(FACT_CAP),
    select: {
      id: true, code: true, title: true, targetDepartmentCode: true, budget: true,
      costDeclarations: { select: { internalCost: true, externalCost: true } },
      tasks: { select: { id: true, departmentCode: true, estimateHours: true, actualHours: true, timeEntries: { select: { hours: true, userId: true } } } },
    },
  });
  const { rows: orders, truncated } = capped(read, FACT_CAP);

  const rateCache = new Map<string, number | null>();
  const rateFor = async (userId: string) => {
    if (!rateCache.has(userId)) rateCache.set(userId, await hourlyCostOf(tx, userId));
    return rateCache.get(userId)!;
  };

  const perOrder = [];
  const perUnit = new Map<string, CostAccuracyRow & { errors: number[] }>();
  for (const o of orders) {
    // Money and hours as decimals (audit CALC-2); rounded once in the row.
    const declared = toMoney(sumOf(o.costDeclarations.map((c) => c.internalCost)), 0);
    let hoursD = ZERO, priced = ZERO, unpricedD = ZERO, anyRate = false;
    const errors: number[] = [];
    for (const t of o.tasks) {
      for (const e of t.timeEntries) {
        const h = money(e.hours); hoursD = hoursD.add(h);
        const rate = await rateFor(e.userId);
        if (rate == null) unpricedD = unpricedD.add(h); else { priced = priced.add(h.mul(rate)); anyRate = true; }
      }
      if (t.estimateHours != null && t.actualHours != null && Number(t.estimateHours) > 0) {
        errors.push(Math.abs(Number(t.actualHours) - Number(t.estimateHours)) / Number(t.estimateHours));
      }
    }
    const actualCost = anyRate ? toMoney(priced, 0) : null;
    const row = {
      workOrderId: o.id, code: o.code, title: o.title, departmentCode: o.targetDepartmentCode,
      declared, hours: toMoney(hoursD), actualCost, unpricedHours: toMoney(unpricedD),
      ratio: actualCost != null && declared > 0 ? r2(actualCost / declared) : null,
      estimateErrorPercent: errors.length ? Math.round((errors.reduce((a, b) => a + b, 0) / errors.length) * 100) : null,
      tasksWithBoth: errors.length,
    };
    perOrder.push(row);
    const u = perUnit.get(o.targetDepartmentCode) ?? perUnit.set(o.targetDepartmentCode, {
      departmentCode: o.targetDepartmentCode, workOrders: 0, declared: 0, hours: 0, actualCost: null, unpricedHours: 0, ratio: null, estimateErrorPercent: null, tasksWithBoth: 0, errors: [],
    }).get(o.targetDepartmentCode)!;
    u.workOrders++; u.declared += row.declared; u.hours += row.hours; u.unpricedHours += row.unpricedHours;
    if (actualCost != null) u.actualCost = (u.actualCost ?? 0) + actualCost;
    u.errors.push(...errors);
  }
  const units: CostAccuracyRow[] = [...perUnit.values()].map(({ errors, ...u }) => ({
    ...u, hours: r2(u.hours), unpricedHours: r2(u.unpricedHours),
    ratio: u.actualCost != null && u.declared > 0 ? r2(u.actualCost / u.declared) : null,
    estimateErrorPercent: errors.length ? Math.round((errors.reduce((a, b) => a + b, 0) / errors.length) * 100) : null,
    tasksWithBoth: errors.length,
  })).sort((a, b) => b.declared - a.declared);

  return { window: { from: window.from ?? null, to: window.to ?? null }, units, workOrders: perOrder.filter((r) => r.declared > 0 || r.hours > 0), truncated };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
