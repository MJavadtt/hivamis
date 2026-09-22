/**
 * Probabilistic delivery forecast (roadmap #11).
 *
 * A single plannedEnd is a promise nobody can keep; "50% by the 15th, 85% by the 22nd" is
 * something Account can commit to without gambling. The estimate-to-actual ratios of finished
 * tasks (#14) are the distribution; the dependency chain (#10) is the structure; a few thousand
 * runs of the one through the other are the forecast.
 *
 * Time inside the simulation is working hours from now, so the calendar arithmetic runs once
 * per percentile rather than once per task per run.
 */
import type { Tx } from '../db.js';
import { addBusinessHours, businessHoursBetween } from '../lib/business-calendar.js';
import { loadCalendar } from '../sla/engine.js';
import { DEFAULT_TASK_HOURS } from './schedule.js';

/** Used when an organisation has too little history to say anything: a mild optimism bias. */
export const DEFAULT_RATIOS = [0.7, 0.85, 1.0, 1.0, 1.1, 1.25, 1.5, 1.8, 2.2, 3.0];
export const MIN_SAMPLES = 8;

/** Deterministic PRNG (mulberry32) so a forecast can be reproduced from its seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RatioSource { departmentCode: string | null; count: number; source: 'department' | 'organisation' | 'default'; ratios: number[] }

/** Estimate-to-actual ratios of finished tasks, per department, falling back outward. */
export async function ratioSamples(tx: Tx, organizationId: string): Promise<Map<string, RatioSource>> {
  const done = await tx.task.findMany({
    where: { organizationId, state: { in: ['APPROVED', 'CLOSED'] }, estimateHours: { gt: 0 }, actualHours: { gt: 0 } },
    select: { departmentCode: true, estimateHours: true, actualHours: true },
  });
  const byDept = new Map<string, number[]>();
  const all: number[] = [];
  for (const t of done) {
    const r = Math.min(10, Number(t.actualHours) / Number(t.estimateHours));
    all.push(r);
    (byDept.get(t.departmentCode) ?? byDept.set(t.departmentCode, []).get(t.departmentCode)!).push(r);
  }
  const out = new Map<string, RatioSource>();
  for (const [dept, ratios] of byDept) {
    if (ratios.length >= MIN_SAMPLES) out.set(dept, { departmentCode: dept, count: ratios.length, source: 'department', ratios });
  }
  const fallback: RatioSource = all.length >= MIN_SAMPLES
    ? { departmentCode: null, count: all.length, source: 'organisation', ratios: all }
    : { departmentCode: null, count: 0, source: 'default', ratios: DEFAULT_RATIOS };
  out.set('*', fallback);
  return out;
}

export interface Forecast {
  projectId: string;
  runs: number;
  seed: number;
  openTasks: number;
  /** Working hours from now, and the date, at which the given share of runs had finished. */
  percentiles: { p50: Date; p85: Date; p95: Date; p50Hours: number; p85Hours: number; p95Hours: number };
  plannedEnd: Date | null;
  /** Share of runs that finished on or before the plan. */
  probabilityOnTime: number | null;
  histogram: { fromHours: number; toHours: number; from: Date; to: Date; runs: number }[];
  /** Where each department's ratios came from, and how many. */
  samples: RatioSource[];
  /** The plain CPM finish, for comparison: what "one number" would have said. */
  deterministicHours: number;
}

export async function forecastProject(
  tx: Tx, organizationId: string, projectId: string, opts: { runs?: number; seed?: number } = {},
): Promise<Forecast> {
  const runs = Math.min(Math.max(opts.runs ?? 2000, 100), 10_000);
  const seed = opts.seed ?? (Date.now() & 0xffffffff);
  const random = rng(seed);
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { plannedEnd: true } });
  const tasks = await tx.task.findMany({
    where: { projectId, organizationId, state: { notIn: ['APPROVED', 'CLOSED', 'CANCELLED'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, departmentCode: true, estimateHours: true, submittedAt: true, dependsOn: { select: { prerequisiteId: true } } },
  });
  const cal = await loadCalendar(organizationId);
  const now = new Date();
  const samples = await ratioSamples(tx, organizationId);

  // Topological order over open tasks; a prerequisite that is already finished contributes nothing.
  const ids = new Set(tasks.map((t) => t.id));
  const pre = new Map(tasks.map((t) => [t.id, t.dependsOn.map((d) => d.prerequisiteId).filter((p) => ids.has(p))]));
  const order: string[] = [];
  const indeg = new Map(tasks.map((t) => [t.id, pre.get(t.id)!.length]));
  const ready = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  while (ready.length) {
    const id = ready.shift()!; order.push(id);
    for (const t of tasks) if (pre.get(t.id)!.includes(id) && indeg.set(t.id, indeg.get(t.id)! - 1).get(t.id) === 0) ready.push(t.id);
  }
  const est = new Map(tasks.map((t) => [t.id, t.submittedAt ? 0 : t.estimateHours == null ? DEFAULT_TASK_HOURS : Number(t.estimateHours)]));
  const dist = new Map(tasks.map((t) => [t.id, (samples.get(t.departmentCode) ?? samples.get('*')!).ratios]));

  const finishes: number[] = new Array(runs);
  const ef = new Map<string, number>();
  for (let r = 0; r < runs; r++) {
    ef.clear();
    let projectFinish = 0;
    for (const id of order) {
      const start = Math.max(0, ...pre.get(id)!.map((p) => ef.get(p) ?? 0));
      const ratios = dist.get(id)!;
      const ratio = ratios[Math.floor(random() * ratios.length)]!;
      const finish = start + est.get(id)! * ratio;
      ef.set(id, finish);
      if (finish > projectFinish) projectFinish = finish;
    }
    finishes[r] = projectFinish;
  }
  finishes.sort((a, b) => a - b);
  const at = (q: number) => finishes[Math.min(runs - 1, Math.floor(q * runs))]!;
  const [p50h, p85h, p95h] = [at(0.5), at(0.85), at(0.95)];

  let deterministic = 0;
  const detEf = new Map<string, number>();
  for (const id of order) {
    const f = Math.max(0, ...pre.get(id)!.map((p) => detEf.get(p) ?? 0)) + est.get(id)!;
    detEf.set(id, f); deterministic = Math.max(deterministic, f);
  }

  const plannedHours = project.plannedEnd && project.plannedEnd > now ? businessHoursBetween(now, project.plannedEnd, cal) : project.plannedEnd ? 0 : null;
  const onTime = plannedHours == null ? null : finishes.filter((f) => f <= plannedHours).length / runs;

  const max = finishes[runs - 1]!;
  const buckets = 10;
  const width = Math.max(1, max / buckets);
  const histogram = Array.from({ length: buckets }, (_, i) => {
    const from = i * width, to = (i + 1) * width;
    return { fromHours: r1(from), toHours: r1(to), from: addBusinessHours(now, from, cal), to: addBusinessHours(now, to, cal), runs: finishes.filter((f) => f >= from && (i === buckets - 1 ? f <= to : f < to)).length };
  });

  return {
    projectId, runs, seed, openTasks: tasks.length,
    percentiles: { p50: addBusinessHours(now, p50h, cal), p85: addBusinessHours(now, p85h, cal), p95: addBusinessHours(now, p95h, cal), p50Hours: r1(p50h), p85Hours: r1(p85h), p95Hours: r1(p95h) },
    plannedEnd: project.plannedEnd, probabilityOnTime: onTime == null ? null : Math.round(onTime * 100) / 100,
    histogram,
    samples: [...new Set(tasks.map((t) => t.departmentCode))].map((d) => samples.get(d) ?? samples.get('*')!).filter((s, i, a) => a.findIndex((x) => x.departmentCode === s.departmentCode && x.source === s.source) === i).map(({ ratios, ...s }) => ({ ...s, ratios: [] })),
    deterministicHours: r1(deterministic),
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
