/**
 * SLA breach prediction (roadmap #8).
 *
 * `warnAt` fires at a fixed fraction of the budget — three-quarters of the way through, when
 * the work is mostly done and the deadline mostly spent. It tells a person they *were* late.
 * The clocks themselves hold what is needed to say it earlier: every finished clock is one
 * observation of how long this policy actually takes in this unit.
 *
 * The model is deliberately the simple one the roadmap asks for, and it is stated rather than
 * hidden: among past clocks of the same policy and unit that were still open at the point this
 * one has reached, what share went on to exceed the budget. That is a conditional probability
 * over real observations, not a curve fitted to nothing. The owner's current load (#12) adjusts
 * the odds upward when they are over capacity, and nothing else touches the number.
 */
import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { addBusinessHours, businessHoursBetween, DEFAULT_CALENDAR, type Calendar } from '../lib/business-calendar.js';
import { loadCalendar } from './engine.js';
import { personLoads } from '../reports/capacity.js';
import { appUrl, notify, slaWarningMail } from '../mail/notify.js';

/** Below this, the history of a (policy, unit) pair says nothing and the pair is skipped. */
export const MIN_SAMPLES = 8;
/** Most recent finished clocks read per policy — enough for a distribution, bounded for cost. */
export const SAMPLE_LIMIT = 400;
/** Over-capacity raises the odds by at most this much (at 200 % utilisation or beyond). */
export const MAX_LOAD_FACTOR = 0.5;
/** A prediction at or above this is worth telling the owner about, once. */
export const NOTIFY_AT = 0.7;

export type Risk = 'LOW' | 'WATCH' | 'LIKELY' | 'CRITICAL';
export const riskOf = (p: number): Risk => (p >= 0.75 ? 'CRITICAL' : p >= 0.5 ? 'LIKELY' : p >= 0.25 ? 'WATCH' : 'LOW');

export interface Prediction {
  clockId: string;
  policyCode: string;
  policyFa: string;
  entityType: string;
  entityId: string;
  ownerId: string | null;
  departmentCode: string | null;
  budgetHours: number;
  consumedHours: number;
  /** Fraction of the budget spent — what `warnAt` compares against. */
  ratio: number;
  probability: number;
  risk: Risk;
  basis: {
    source: 'POLICY_AND_UNIT' | 'POLICY' | 'NONE';
    samples: number;
    /** Of the samples, those still open at this point — the ones the probability is over. */
    survivors: number;
    breachRate: number | null;
    medianHours: number | null;
    p85Hours: number | null;
  };
  /** Where the median of the surviving samples puts the finish, on the owner's calendar. */
  expectedFinish: Date | null;
  expectedOverrunHours: number | null;
  loadFactor: number;
  /** The prediction says "likely" while the fixed threshold is still silent. */
  beatsWarnAt: boolean;
  becauseFa: string[];
}

interface Sample { hours: number; breached: boolean }

/**
 * Controlled hours of every finished clock, keyed `policyCode|unit` and `policyCode`.
 * Controlled, not elapsed: paused hours were never the owner's to spend (ADR-005 addendum).
 */
export async function historySamples(tx: Tx, organizationId: string): Promise<Map<string, Sample[]>> {
  const stopped = await tx.slaClock.findMany({
    where: { organizationId, stoppedAt: { not: null } },
    orderBy: { stoppedAt: 'desc' },
    take: SAMPLE_LIMIT * 4,
    select: {
      startedAt: true, stoppedAt: true, pausedHours: true, ownerId: true, breachedAt: true,
      policy: { select: { code: true, hours: true } },
    },
  });
  // ownerId is a plain column, not a relation, so the units come from one lookup of their own.
  const units = await unitsOf(tx, stopped.map((c) => c.ownerId));
  const calendars = new Map<string, Calendar>();
  const calFor = async (ownerId: string | null) => {
    const key = ownerId ?? '';
    if (!calendars.has(key)) calendars.set(key, await loadCalendar(organizationId, { userId: ownerId ?? undefined }));
    return calendars.get(key)!;
  };

  const out = new Map<string, Sample[]>();
  const push = (key: string, s: Sample) => {
    const list = out.get(key) ?? out.set(key, []).get(key)!;
    if (list.length < SAMPLE_LIMIT) list.push(s);
  };
  for (const c of stopped) {
    const cal = await calFor(c.ownerId);
    const hours = Math.max(0, businessHoursBetween(c.startedAt, c.stoppedAt!, cal) - Number(c.pausedHours));
    const sample: Sample = { hours, breached: hours > Number(c.policy.hours) };
    push(c.policy.code, sample);
    const unit = c.ownerId ? units.get(c.ownerId) : null;
    if (unit) push(`${c.policy.code}|${unit}`, sample);
  }
  return out;
}

export interface PredictOptions {
  /** Reuse across a batch: history is one query for the whole organisation. */
  history?: Map<string, Sample[]>;
  /** Utilisation per owner, 0–999, from the capacity model. */
  loads?: Map<string, number>;
  now?: Date;
}

export async function predictClocks(
  tx: Tx, organizationId: string, clockIds?: string[], opts: PredictOptions = {},
): Promise<Prediction[]> {
  const now = opts.now ?? new Date();
  const clocks = await tx.slaClock.findMany({
    where: {
      organizationId, state: { in: ['RUNNING', 'AT_RISK'] },
      ...(clockIds ? { id: { in: clockIds } } : {}),
    },
    include: { policy: true },
    orderBy: { dueAt: 'asc' },
    take: 500,
  });
  if (!clocks.length) return [];
  const units = await unitsOf(tx, clocks.map((c) => c.ownerId));

  const history = opts.history ?? await historySamples(tx, organizationId);
  const loads = opts.loads ?? await ownerUtilisation(tx, organizationId, clocks.map((c) => c.ownerId).filter((x): x is string => !!x), now);

  const calendars = new Map<string, Calendar>();
  const out: Prediction[] = [];
  for (const c of clocks) {
    const key = c.ownerId ?? '';
    if (!calendars.has(key)) calendars.set(key, await loadCalendar(organizationId, { userId: c.ownerId ?? undefined }).catch(() => DEFAULT_CALENDAR));
    const cal = calendars.get(key)!;
    const unit = (c.ownerId ? units.get(c.ownerId) : null) ?? null;
    const budget = Number(c.policy.hours);
    const consumed = Math.max(0, businessHoursBetween(c.startedAt, now, cal) - Number(c.pausedHours));
    const ratio = budget > 0 ? consumed / budget : 1;

    const unitSamples = unit ? history.get(`${c.policy.code}|${unit}`) ?? [] : [];
    const policySamples = history.get(c.policy.code) ?? [];
    const [samples, source] = unitSamples.length >= MIN_SAMPLES
      ? [unitSamples, 'POLICY_AND_UNIT' as const]
      : policySamples.length >= MIN_SAMPLES
        ? [policySamples, 'POLICY' as const]
        : [[] as Sample[], 'NONE' as const];

    // Only clocks that were still open at this point are comparable: the ones that finished
    // earlier already answered a different question.
    const survivors = samples.filter((s) => s.hours >= consumed);
    const becauseFa: string[] = [];
    let base: number;
    if (source === 'NONE') {
      base = clamp(ratio * 0.8, 0.02, 0.95);
      becauseFa.push('سابقهٔ کافی برای این سیاست ثبت نشده — این عدد فقط از نسبت مصرف‌شدهٔ مهلت می‌آید');
    } else if (survivors.length === 0) {
      base = 0.95;
      becauseFa.push(`هیچ‌یک از ${fa(samples.length)} مهلت مشابه تا این مرحله باز نمانده بود — این یکی از همهٔ آن‌ها گذشته است`);
    } else {
      base = survivors.filter((s) => s.breached).length / survivors.length;
      becauseFa.push(source === 'POLICY_AND_UNIT'
        ? `از ${fa(survivors.length)} مهلت مشابه در واحد ${unit} که تا این مرحله باز بودند، ${fa(Math.round(base * 100))}٪ نقض شد`
        : `از ${fa(survivors.length)} مهلت مشابه در کل سازمان که تا این مرحله باز بودند، ${fa(Math.round(base * 100))}٪ نقض شد`);
    }

    // Over-capacity raises the odds; nothing lowers them. A person with room still has to do
    // the work, and claiming a discount for it would be inventing evidence.
    const utilisation = c.ownerId ? loads.get(c.ownerId) ?? 0 : 0;
    const loadFactor = 1 + Math.min(1, Math.max(0, utilisation - 100) / 100) * MAX_LOAD_FACTOR;
    if (loadFactor > 1) becauseFa.push(`مسئول این مهلت ${fa(utilisation)}٪ ظرفیتش پر است — احتمال به همین نسبت بالاتر گرفته شده`);
    const odds = (base / Math.max(1e-6, 1 - base)) * loadFactor;
    const probability = clamp(base >= 1 ? 0.99 : odds / (1 + odds), 0.01, 0.99);

    const median = survivors.length ? percentile(survivors.map((s) => s.hours), 0.5) : null;
    const p85 = samples.length ? percentile(samples.map((s) => s.hours), 0.85) : null;
    const expectedFinish = median != null ? addBusinessHours(now, Math.max(0, median - consumed), cal) : null;
    if (median != null && median > budget) {
      becauseFa.push(`نیمی از آن‌ها دست‌کم ${fa(r1(median))} ساعت کاری طول کشیدند، در برابر مهلت ${fa(budget)} ساعته`);
    }
    const beatsWarnAt = probability >= 0.5 && ratio < Number(c.policy.warnAt);
    if (beatsWarnAt) becauseFa.push(`هنوز ${fa(Math.round(ratio * 100))}٪ مهلت مصرف شده و آستانهٔ هشدار ثابت خاموش است`);

    out.push({
      clockId: c.id, policyCode: c.policy.code, policyFa: c.policy.labelFa,
      entityType: c.entityType, entityId: c.entityId, ownerId: c.ownerId, departmentCode: unit,
      budgetHours: budget, consumedHours: r1(consumed), ratio: Math.round(ratio * 100) / 100,
      probability: Math.round(probability * 100) / 100, risk: riskOf(probability),
      basis: {
        source, samples: samples.length, survivors: survivors.length,
        breachRate: samples.length ? Math.round((samples.filter((s) => s.breached).length / samples.length) * 100) / 100 : null,
        medianHours: median == null ? null : r1(median), p85Hours: p85 == null ? null : r1(p85),
      },
      expectedFinish, expectedOverrunHours: median == null ? null : r1(median - budget),
      loadFactor: Math.round(loadFactor * 100) / 100, beatsWarnAt, becauseFa,
    });
  }
  out.sort((a, b) => b.probability - a.probability || a.budgetHours - b.budgetHours);
  return out;
}

/** The unit each owner belongs to; `ownerId` carries no relation of its own. */
async function unitsOf(tx: Tx, ownerIds: (string | null)[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(ownerIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, department: { select: { code: true } } } });
  return new Map(users.map((u) => [u.id, u.department?.code ?? null]));
}

/** Current utilisation of each owner, over the coming week — the load half of the model. */
async function ownerUtilisation(tx: Tx, organizationId: string, userIds: string[], now: Date): Promise<Map<string, number>> {
  if (!userIds.length) return new Map();
  const loads = await personLoads(tx, organizationId, { from: now, to: new Date(now.getTime() + 7 * 86_400_000) }, { userIds: [...new Set(userIds)] });
  return new Map(loads.map((l) => [l.userId, l.utilisation]));
}

/**
 * Tell each owner once, when the prediction turns serious while the fixed threshold is still
 * silent. `riskNotifiedAt` is the once: a probability that wobbles around the line must not
 * produce a stream of messages, which is how people learn to ignore the app.
 */
export async function notifyPredictedBreaches(
  now = new Date(),
  send: (p: Prediction) => Promise<void> = tellTheOwner,
): Promise<{ notified: number }> {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  let notified = 0;
  for (const org of orgs) {
    const predictions = await predictClocks(prisma, org.id, undefined, { now });
    for (const p of predictions) {
      if (p.probability < NOTIFY_AT || !p.ownerId) continue;
      const clock = await prisma.slaClock.findUnique({ where: { id: p.clockId }, select: { riskNotifiedAt: true } });
      if (clock?.riskNotifiedAt) continue;
      await send(p);
      await prisma.slaClock.update({ where: { id: p.clockId }, data: { riskNotifiedAt: now, riskProbability: p.probability } });
      notified++;
    }
  }
  return { notified };
}

/**
 * The message itself. It says the probability and what it is based on, because "this is likely
 * to be late" without a reason is indistinguishable from a machine guessing.
 */
async function tellTheOwner(p: Prediction): Promise<void> {
  const percent = fa(Math.round(p.probability * 100));
  const url = appUrl(`/${p.entityType}s/${p.entityId}`);
  await notify({
    userId: p.ownerId,
    kind: 'SLA_PREDICTED_BREACH',
    title: `پیش‌بینی نقض SLA — ${p.policyFa}`,
    body: `احتمال نقض «${p.policyFa}» ${percent}٪ برآورد می‌شود. ${p.becauseFa[0] ?? ''}`,
    entityType: p.entityType, entityId: p.entityId, severity: 'WARNING',
    mail: slaWarningMail({
      policyFa: p.policyFa, entityFa: p.entityType, code: p.entityId.slice(0, 8),
      remainingFa: `احتمال نقض ${percent}٪ — ${p.becauseFa[0] ?? ''}`, url,
    }),
  });
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r1 = (n: number) => Math.round(n * 10) / 10;
const fa = (n: number) => new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(n);
function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}
