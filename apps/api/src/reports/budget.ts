/**
 * Budget against actual, at the level where control is possible (roadmap #30).
 *
 * The project 360 already compared plannedBudget with the sum of cost declarations. But a
 * project overrun is the sum of unit overruns, and by the time the project figure moves it is
 * too late to do anything about the unit that caused it. Each work order carries a budget and
 * each cost declaration names its work order, so the comparison can be made per unit — and made
 * at the moment a declaration lands, which is the moment someone can still act.
 */
import type { Tx } from '../db.js';
import { notify } from '../mail/notify.js';

/** Declared cost at or above this share of budget is "near"; above 100% is "over". */
export const NEAR_THRESHOLD = 0.9;

export type BudgetStatus = 'NO_BUDGET' | 'UNDER' | 'NEAR' | 'OVER';

export interface WorkOrderBudget {
  workOrderId: string;
  code: string;
  title: string;
  departmentCode: string;
  state: string;
  budget: number | null;
  declared: number;
  internal: number;
  external: number;
  variance: number | null;
  variancePercent: number | null;
  status: BudgetStatus;
  declarations: number;
}

export function statusOf(budget: number | null, declared: number): BudgetStatus {
  if (budget == null || budget <= 0) return 'NO_BUDGET';
  if (declared > budget) return 'OVER';
  if (declared >= budget * NEAR_THRESHOLD) return 'NEAR';
  return 'UNDER';
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Every work order of a project against what its unit has declared so far. */
export async function projectBudget(tx: Tx, projectId: string) {
  const [project, orders, sums] = await Promise.all([
    tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { plannedBudget: true, contractValue: true } }),
    tx.workOrder.findMany({
      where: { projectId }, orderBy: { createdAt: 'asc' },
      select: { id: true, code: true, title: true, targetDepartmentCode: true, state: true, budget: true },
    }),
    tx.costDeclaration.groupBy({
      by: ['workOrderId'], where: { workOrder: { projectId } },
      _sum: { internalCost: true, externalCost: true }, _count: { _all: true },
    }),
  ]);
  const byOrder = new Map(sums.map((s) => [s.workOrderId, s]));

  const workOrders: WorkOrderBudget[] = orders.map((o) => {
    const s = byOrder.get(o.id);
    const internal = Number(s?._sum.internalCost ?? 0);
    const external = Number(s?._sum.externalCost ?? 0);
    const declared = internal + external;
    const budget = o.budget == null ? null : Number(o.budget);
    return {
      workOrderId: o.id, code: o.code, title: o.title, departmentCode: o.targetDepartmentCode, state: o.state,
      budget, declared: round(declared), internal: round(internal), external: round(external),
      variance: budget == null ? null : round(budget - declared),
      variancePercent: budget ? round(((declared - budget) / budget) * 100) : null,
      status: statusOf(budget, declared),
      declarations: s?._count._all ?? 0,
    };
  });

  // Per unit: a department may hold several orders on one project.
  const units = new Map<string, { departmentCode: string; budget: number; declared: number; orders: number }>();
  for (const w of workOrders) {
    const u = units.get(w.departmentCode) ?? { departmentCode: w.departmentCode, budget: 0, declared: 0, orders: 0 };
    u.budget += w.budget ?? 0; u.declared += w.declared; u.orders += 1;
    units.set(w.departmentCode, u);
  }

  const allocated = workOrders.reduce((s, w) => s + (w.budget ?? 0), 0);
  const declared = workOrders.reduce((s, w) => s + w.declared, 0);
  const planned = project.plannedBudget == null ? null : Number(project.plannedBudget);
  return {
    project: {
      plannedBudget: planned,
      /** What the work orders add up to — may legitimately differ from the plan. */
      allocated: round(allocated),
      declared: round(declared),
      unallocated: planned == null ? null : round(planned - allocated),
      status: statusOf(planned, declared),
    },
    units: [...units.values()].map((u) => ({ ...u, budget: round(u.budget), declared: round(u.declared), status: statusOf(u.budget, u.declared) })),
    workOrders,
    thresholds: { near: NEAR_THRESHOLD },
  };
}

/**
 * Called right after a declaration is written. If the order has now crossed its budget — or
 * come within reach of it — the people who can still do something hear about it now, not in
 * next month's report: the account owner, who can rescope, and whoever declared, who may be
 * about to declare more.
 */
export async function checkWorkOrderBudget(
  tx: Tx, workOrderId: string, declaredById: string,
): Promise<{ status: BudgetStatus; budget: number | null; declared: number; notified: string[] }> {
  const wo = await tx.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    select: { code: true, title: true, budget: true, targetDepartmentCode: true, project: { select: { id: true, code: true, accountOwnerId: true } } },
  });
  const sum = await tx.costDeclaration.aggregate({ where: { workOrderId }, _sum: { internalCost: true, externalCost: true } });
  const declared = Number(sum._sum.internalCost ?? 0) + Number(sum._sum.externalCost ?? 0);
  const budget = wo.budget == null ? null : Number(wo.budget);
  const status = statusOf(budget, declared);

  const notified: string[] = [];
  if (status === 'OVER' || status === 'NEAR') {
    const over = status === 'OVER';
    const recipients = [...new Set([wo.project.accountOwnerId, declaredById].filter((x): x is string => !!x))];
    for (const userId of recipients) {
      await notify({
        userId, kind: 'BUDGET_OVERRUN', severity: over ? 'CRITICAL' : 'WARNING',
        title: over
          ? `عبور از بودجه — ${wo.code}`
          : `نزدیک به سقف بودجه — ${wo.code}`,
        body: `${wo.title} (${wo.targetDepartmentCode}): اعلام‌شده ${Math.round(declared).toLocaleString('fa-IR')} از بودجهٔ ${Math.round(budget!).toLocaleString('fa-IR')} ریال — پروژهٔ ${wo.project.code}`,
        entityType: 'workOrder', entityId: workOrderId,
      });
      notified.push(userId);
    }
  }
  return { status, budget, declared: round(declared), notified };
}
