/**
 * The estimation assistant (roadmap #24).
 *
 * A unit declares what a work order will cost before anyone knows, and the declaration becomes
 * the price. Nothing put it beside what similar work actually took — so an optimistic number
 * sailed through, and the loss surfaced at closure, when nothing could be done about it.
 *
 * This says, at the moment of declaring: "N comparable orders in your unit — same kind of output,
 * similar size — were declared at X, actually cost Y and took Z working days; you are proposing
 * W." Comparables come from the unit's finished orders only; "actual" is the time logged on
 * their tasks at each person's hourly cost (#14) plus declared external spend. Every figure
 * carries its sample size, and too small a sample is said out loud rather than averaged.
 */
import type { Tx } from '../db.js';
import { businessHoursBetween, hoursPerDay } from '../lib/business-calendar.js';
import { loadCalendar } from '../sla/engine.js';
import { cosine, localEmbed, normalisePersian } from '../memory/embed.js';
import { hourlyCostOf } from './time.js';

/** Below this many comparables, a range is noise and the answer says so. */
export const MIN_COMPARABLES = 3;
export const MAX_COMPARABLES = 12;
/** Text similarity a comparable needs before size and format are even considered. */
const SIMILARITY_FLOOR = 0.12;

export interface Comparable {
  workOrderId: string;
  code: string;
  title: string;
  similarity: number;
  declaredCost: number | null;
  actualCost: number | null;
  hoursLogged: number;
  workingDays: number | null;
  whyFa: string[];
}

export interface Estimate {
  workOrder: { id: string; code: string; title: string; departmentCode: string; budget: number | null; deadline: Date };
  basis: 'SIMILAR' | 'UNIT_WIDE' | 'NONE';
  comparables: Comparable[];
  summary: {
    count: number;
    declared: Range | null;
    actual: Range | null;
    workingDays: Range | null;
    /** Median actual ÷ declared across comparables: how this unit's declarations usually land. */
    overrunRatio: number | null;
  };
  verdict: null | {
    proposedCost: number;
    band: 'LOW' | 'WITHIN' | 'HIGH';
    /** proposed ÷ the median of what comparables actually cost (declared, if none had actuals). */
    ratioToMedian: number | null;
    messageFa: string;
  };
  schedule: null | { workingDaysLeft: number; medianNeeded: number; tight: boolean; messageFa: string };
  noteFa: string;
}

export interface Range { p25: number; median: number; p75: number; mean: number }

function range(values: number[]): Range | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  // Linear interpolation between ranks: with four comparables, nearest-rank would call the
  // third value both the median and the p75.
  const at = (q: number) => {
    const pos = q * (v.length - 1);
    const lo = Math.floor(pos); const hi = Math.ceil(pos);
    return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
  };
  return { p25: round(at(0.25)), median: round(at(0.5)), p75: round(at(0.75)), mean: round(v.reduce((s, x) => s + x, 0) / v.length) };
}
const round = (n: number) => Math.round(n);
const fa = (n: number) => new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(n);
const money = (n: number) => `${fa(Math.round(n / 1_000_000))} میلیون ریال`;

const textOf = (w: { title: string; scopeOfWork: string; expectedOutput: string; outputFormat: string }) =>
  `${w.title}\n${w.scopeOfWork}\n${w.expectedOutput}\n${w.outputFormat}`;

/** Same kind of output: the formats share a meaningful word ("ویدئو", "پوستر", "گزارش"...). */
function sameFormat(a: string, b: string): boolean {
  const words = (s: string) => new Set(normalisePersian(s).split(' ').filter((w) => w.length > 2));
  const x = words(a); const y = words(b);
  for (const w of x) if (y.has(w)) return true;
  return false;
}

export async function estimateFor(
  tx: Tx, organizationId: string, workOrderId: string, opts: { proposedCost?: number; now?: Date } = {},
): Promise<Estimate> {
  const now = opts.now ?? new Date();
  const target = await tx.workOrder.findFirstOrThrow({
    where: { id: workOrderId, organizationId },
    include: { tasks: { select: { id: true } } },
  });
  const cal = await loadCalendar(organizationId, { departmentCode: target.targetDepartmentCode });

  const history = await tx.workOrder.findMany({
    where: {
      organizationId, targetDepartmentCode: target.targetDepartmentCode,
      state: { in: ['SUBMITTED', 'COMPLETED'] }, id: { not: workOrderId },
    },
    include: {
      costDeclarations: { select: { internalCost: true, externalCost: true } },
      tasks: { select: { id: true, timeEntries: { select: { hours: true, userId: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  const targetVector = localEmbed(textOf(target));
  const targetBudget = target.budget == null ? null : Number(target.budget);
  const rateCache = new Map<string, number | null>();
  const rate = async (userId: string) => {
    if (!rateCache.has(userId)) rateCache.set(userId, await hourlyCostOf(tx, userId));
    return rateCache.get(userId)!;
  };

  const all: Comparable[] = [];
  for (const w of history) {
    const similarity = Math.max(0, cosine(targetVector, localEmbed(textOf(w))));
    const whyFa: string[] = [`همان واحد (${w.targetDepartmentCode})`];
    let score = similarity;
    if (sameFormat(target.outputFormat, w.outputFormat)) { score += 0.15; whyFa.push(`همان نوع خروجی: ${w.outputFormat}`); }
    const budget = w.budget == null ? null : Number(w.budget);
    if (targetBudget && budget && budget >= targetBudget / 2 && budget <= targetBudget * 2) {
      score += 0.1; whyFa.push('بودجه در همان بازهٔ حجم');
    } else if (!targetBudget && Math.abs(w.tasks.length - target.tasks.length) <= Math.max(1, target.tasks.length / 2)) {
      score += 0.05; whyFa.push('تعداد وظایف نزدیک');
    }
    if (similarity >= 0.25) whyFa.push('شرح کار مشابه');

    const declared = w.costDeclarations.length
      ? w.costDeclarations.reduce((s, c) => s + Number(c.internalCost) + Number(c.externalCost), 0)
      : null;
    const external = w.costDeclarations.reduce((s, c) => s + Number(c.externalCost), 0);
    let hours = 0; let priced = 0; let anyRate = false; let unpriced = false;
    for (const t of w.tasks) for (const e of t.timeEntries) {
      const h = Number(e.hours); hours += h;
      const r = await rate(e.userId);
      if (r == null) unpriced = true; else { priced += h * r; anyRate = true; }
    }
    // An actual cost missing some of its hours is not an actual cost; say nothing rather than too little.
    const actual = anyRate && !unpriced ? priced + external : null;
    const started = w.acceptedAt ?? w.createdAt;
    const finished = w.submittedAt;
    const workingDays = finished && finished > started
      ? businessHoursBetween(started, finished, cal) / (hoursPerDay(cal) || 8)
      : null;

    all.push({
      workOrderId: w.id, code: w.code, title: w.title, similarity: Math.round(Math.min(1, score) * 1000) / 1000,
      declaredCost: declared, actualCost: actual == null ? null : Math.round(actual),
      hoursLogged: Math.round(hours * 10) / 10,
      workingDays: workingDays == null ? null : Math.round(workingDays * 10) / 10,
      whyFa,
    });
  }
  all.sort((a, b) => b.similarity - a.similarity);

  let comparables = all.filter((c) => c.similarity >= SIMILARITY_FLOOR).slice(0, MAX_COMPARABLES);
  let basis: Estimate['basis'] = 'SIMILAR';
  if (comparables.length < MIN_COMPARABLES) {
    comparables = all.slice(0, MAX_COMPARABLES);
    basis = comparables.length ? 'UNIT_WIDE' : 'NONE';
  }

  const declared = range(comparables.map((c) => c.declaredCost).filter((x): x is number => x != null));
  const actual = range(comparables.map((c) => c.actualCost).filter((x): x is number => x != null));
  const workingDays = range(comparables.map((c) => c.workingDays).filter((x): x is number => x != null));
  const ratios = comparables
    .filter((c) => c.actualCost != null && c.declaredCost)
    .map((c) => c.actualCost! / c.declaredCost!);
  const overrun = range(ratios.map((r) => r * 1000));
  const enough = comparables.length >= MIN_COMPARABLES;

  let verdict: Estimate['verdict'] = null;
  if (opts.proposedCost != null && opts.proposedCost > 0) {
    const reference = actual ?? declared;
    const refFa = actual ? 'واقعاً هزینه برده‌اند' : 'اعلام شده‌اند';
    if (!reference || !enough) {
      verdict = {
        proposedCost: opts.proposedCost, band: 'WITHIN', ratioToMedian: null,
        messageFa: 'سابقهٔ کافی برای مقایسه نیست — برآورد شما بدون معیار تاریخی ثبت می‌شود.',
      };
    } else {
      const ratio = Math.round((opts.proposedCost / reference.median) * 100) / 100;
      const band = opts.proposedCost < reference.p25 ? 'LOW' : opts.proposedCost > reference.p75 ? 'HIGH' : 'WITHIN';
      const head = `${fa(comparables.length)} سفارش مشابه به‌طور میانه ${money(reference.median)} ${refFa}${workingDays ? ` و ${fa(workingDays.median)} روز کاری برده‌اند` : ''}؛ برآورد شما ${money(opts.proposedCost)} است`;
      verdict = {
        proposedCost: opts.proposedCost, band, ratioToMedian: ratio,
        messageFa: band === 'LOW'
          ? `${head} — کمتر از ۷۵٪ سفارش‌های مشابه. پیش از قفل‌شدن قیمت بازبینی شود.`
          : band === 'HIGH'
            ? `${head} — بیشتر از ۷۵٪ سفارش‌های مشابه. اگر دلیلی دارد، در فرض‌ها بنویسید.`
            : `${head} — در بازهٔ معمول.`,
      };
    }
  }

  let schedule: Estimate['schedule'] = null;
  if (workingDays && enough) {
    const passed = target.deadline <= now;
    const left = passed ? 0 : businessHoursBetween(now, target.deadline, cal) / (hoursPerDay(cal) || 8);
    const tight = left < workingDays.median;
    schedule = {
      workingDaysLeft: Math.round(left * 10) / 10, medianNeeded: workingDays.median, tight,
      messageFa: passed
        ? `مهلت این سفارش گذشته است؛ سفارش‌های مشابه به‌طور میانه ${fa(workingDays.median)} روز کاری برده‌اند.`
        : tight
          ? `تا مهلت ${fa(Math.round(left * 10) / 10)} روز کاری مانده، در حالی که سفارش‌های مشابه به‌طور میانه ${fa(workingDays.median)} روز کاری برده‌اند.`
          : `تا مهلت ${fa(Math.round(left * 10) / 10)} روز کاری مانده؛ سفارش‌های مشابه به‌طور میانه ${fa(workingDays.median)} روز کاری برده‌اند.`,
    };
  }

  return {
    workOrder: {
      id: target.id, code: target.code, title: target.title, departmentCode: target.targetDepartmentCode,
      budget: targetBudget, deadline: target.deadline,
    },
    basis, comparables,
    summary: {
      count: comparables.length, declared, actual, workingDays,
      overrunRatio: overrun ? Math.round(overrun.median) / 1000 : null,
    },
    verdict, schedule,
    noteFa: basis === 'NONE'
      ? 'این واحد هنوز سفارش تمام‌شده‌ای ندارد که مبنای مقایسه باشد.'
      : basis === 'UNIT_WIDE'
        ? `سفارش مشابه کافی پیدا نشد؛ مقایسه با ${fa(comparables.length)} سفارش تمام‌شدهٔ همین واحد است${enough ? '' : ' و هنوز معنادار نیست'}.`
        : `بر پایهٔ ${fa(comparables.length)} سفارش تمام‌شدهٔ مشابه در همین واحد`
          + (actual ? '' : ' — برای آن‌ها زمان قیمت‌دار ثبت نشده، پس مقایسه با مبلغ اعلام‌شده است'),
  };
}
