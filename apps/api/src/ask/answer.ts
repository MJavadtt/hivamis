/**
 * Answering a question about the organisation's numbers (roadmap #27).
 *
 * question ─▶ plan (rules; a language model only when rules find no metric, and only to fill the
 *             same plan) ─▶ permission check on the metric's fields ─▶ facts ─▶ total, rows,
 *             comparison ─▶ an answer that says what it understood, how the number is defined,
 *             which records it is made of, and what in the question it did not use.
 *
 * The permission check runs before a single fact is read: a number the asker may not see is not
 * computed and then hidden, it is never computed. A refusal is audited like any other refused
 * request, so the audit-trail detectors (#26) see someone asking for finance through a sentence
 * exactly as they would see them trying the finance page.
 */
import { DEPARTMENT_LABELS, PERMISSIONS, WORKFLOWS } from '@hiva/contracts';
import { z } from 'zod';
import type { Tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { jalaliMonthLabel, jalaliOf } from '../lib/jalali.js';
import { normalisePersian } from '../memory/embed.js';
import {
  DIM_LABEL_FA, DIMS, METRIC_BY_KEY, METRICS, UNIT_VALUE_FA, entityLabelFa, fa,
  type Dim, type Fact, type FactCtx, type Filters, type MetricSpec, type Ref,
} from './catalog.js';
import { parseQuestion, type Clarify, type Vocab } from './parse.js';
import { money, toMoney, ZERO, type Money } from '../lib/money.js';
import { ALL_TIME, previousPeriod, resolvePeriod, type Period } from './periods.js';

export interface AskActor {
  id: string;
  organizationId: string;
  departmentCode: string | null;
  permissions: string[];
  ipAddress?: string | null;
  requestId?: string | null;
}

export interface PlanInput {
  metric: string;
  filters?: Filters;
  period?: { preset?: string | null; from?: string | null; to?: string | null };
  groupBy?: Dim | null;
  compare?: boolean;
  sort?: 'desc' | 'asc' | null;
}

/** What a language model may return: names, never ids — they are resolved here, under the asker's reach. */
export const modelPlanSchema = z.object({
  metric: z.string(),
  units: z.array(z.string()).optional(),
  companyName: z.string().max(200).optional(),
  projectCode: z.string().max(40).optional(),
  personName: z.string().max(200).optional(),
  entity: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.enum(DIMS as [Dim, ...Dim[]]).nullable().optional(),
  compare: z.boolean().optional(),
});
export type ModelPlan = z.infer<typeof modelPlanSchema>;
export type Planner = (question: string, metrics: { key: string; labelFa: string; definitionFa: string; dims: Dim[] }[], now: Date) => Promise<unknown>;

export type AskStatus = 'ANSWERED' | 'NEEDS_CLARIFICATION' | 'NOT_UNDERSTOOD' | 'REFUSED';

export interface AskRow { key: string; labelFa: string; value: number | null; valueFa: string; countFa: string }
export interface AskResult {
  status: AskStatus;
  question: string | null;
  planner: 'RULES' | 'MODEL' | 'EXPLICIT';
  plan: (Required<Omit<PlanInput, 'period'>> & { period: { preset: null; from: string | null; to: string | null } }) | null;
  understoodFa: string[];
  metric?: { key: string; labelFa: string; definitionFa: string; unit: string };
  value?: number | null;
  valueFa?: string;
  countFa?: string;
  secondaryFa?: string | null;
  answerFa?: string;
  periodFa?: string;
  groupByFa?: string | null;
  rows?: AskRow[];
  previous?: { value: number | null; valueFa: string; periodFa: string; changeFa: string };
  basis?: { count: number; items: Ref[] };
  caveatsFa: string[];
  ignoredFa: string[];
  clarify?: Clarify;
  refusal?: { permissions: string[]; messageFa: string };
  suggestions?: { key: string; labelFa: string; example: string }[];
}

const permissionFa = (p: string) => (PERMISSIONS as Record<string, string>)[p] ?? p;
const unitFa = (code: string) => DEPARTMENT_LABELS[code as keyof typeof DEPARTMENT_LABELS]?.fa ?? code;

export async function loadVocab(tx: Tx, actor: AskActor): Promise<Vocab> {
  const [people, companies, projects] = await Promise.all([
    tx.user.findMany({
      where: { organizationId: actor.organizationId, deletedAt: null },
      select: { id: true, fullName: true, isActive: true, department: { select: { code: true } } },
    }),
    // A client the asker may not read is not a name the parser offers back to them.
    actor.permissions.includes('crm.company.read')
      ? tx.company.findMany({ where: { organizationId: actor.organizationId, deletedAt: null }, select: { id: true, legalName: true, brandName: true } })
      : Promise.resolve([]),
    actor.permissions.includes('project.read')
      ? tx.project.findMany({ where: { organizationId: actor.organizationId, deletedAt: null }, select: { id: true, code: true, name: true } })
      : Promise.resolve([]),
  ]);
  return {
    people: people.filter((p) => p.isActive).map((p) => ({ id: p.id, fullName: p.fullName, departmentCode: p.department?.code ?? null })),
    companies, projects,
    // Kept for labels: people who have left still own history.
    ...{ allPeople: people },
  } as Vocab & { allPeople: typeof people };
}

function allowedMetrics(actor: AskActor) {
  return METRICS.filter((m) => m.requires.every((p) => actor.permissions.includes(p)));
}

function suggestionsFor(actor: AskActor) {
  return allowedMetrics(actor).map((m) => ({ key: m.key, labelFa: m.labelFa, example: m.example }));
}

/** The whole path. `planner` is the language-model fallback; null when no model is configured. */
export async function ask(
  tx: Tx, actor: AskActor,
  input: { question?: string | null; plan?: PlanInput | null },
  opts: { now?: Date; planner?: Planner | null } = {},
): Promise<AskResult> {
  const now = opts.now ?? new Date();
  const vocab = await loadVocab(tx, actor) as Vocab & { allPeople: { id: string; fullName: string; department: { code: string } | null }[] };
  const people = new Map(vocab.allPeople.map((p) => [p.id, { fullName: p.fullName, departmentCode: p.department?.code ?? null }]));
  const question = input.question?.trim() || null;
  const caveatsFa: string[] = [];

  let planner: AskResult['planner'] = 'EXPLICIT';
  let metricKey: string | null = null;
  let filters: Filters = {};
  let period: Period = ALL_TIME;
  let groupBy: Dim | null = null;
  let compare = false;
  let sort: 'desc' | 'asc' | null = null;
  let ignored: string[] = [];

  const base = (status: AskStatus, extra: Partial<AskResult> = {}): AskResult => ({
    status, question, planner, plan: null, understoodFa: [], caveatsFa, ignoredFa: ignored, ...extra,
  });

  if (input.plan) {
    metricKey = input.plan.metric;
    filters = { ...(input.plan.filters ?? {}) };
    period = resolvePeriod({
      preset: input.plan.period?.preset ?? null,
      from: input.plan.period?.from ? new Date(input.plan.period.from) : null,
      to: input.plan.period?.to ? new Date(input.plan.period.to) : null,
    }, now);
    groupBy = input.plan.groupBy ?? null;
    compare = !!input.plan.compare;
    sort = input.plan.sort ?? null;
    // A plan comes back from the page; its ids must be ones this asker could have been offered.
    const known = {
      units: (u: string) => u in DEPARTMENT_LABELS,
      companyId: (id: string) => vocab.companies.some((c) => c.id === id),
      projectId: (id: string) => vocab.projects.some((p) => p.id === id),
      personId: (id: string) => people.has(id),
      entity: (e: string) => !!WORKFLOWS[e],
    };
    if (filters.units) filters.units = filters.units.filter(known.units);
    if (!filters.units?.length) delete filters.units;
    for (const k of ['companyId', 'projectId', 'personId', 'entity'] as const) {
      if (filters[k] && !known[k](filters[k]!)) { caveatsFa.push(`${filterLabelFa(k)} شناخته نشد و اعمال نشد.`); delete filters[k]; }
    }
  } else if (question) {
    planner = 'RULES';
    const parsed = parseQuestion(question, now, vocab, actor.id);
    ({ filters, period, groupBy, compare, sort, ignored } = parsed);
    if (parsed.metrics.length === 1) metricKey = parsed.metrics[0]!;

    if (!metricKey && opts.planner) {
      const fromModel = await planWithModel(opts.planner, question, actor, vocab, now);
      if (fromModel) {
        planner = 'MODEL';
        ({ metricKey, filters, period, groupBy, compare } = fromModel);
        ignored = [];
        caveatsFa.push('این پرسش را قاعده‌ها نفهمیدند و مدل زبانی آن را به یک شاخص از فهرست برگرداند — برداشت زیر را بررسی کنید.');
      }
    }
    if (parsed.clarify && !(planner === 'MODEL' && parsed.clarify.kind === 'metric')) {
      // The partial plan goes back with the question, so a choice re-runs it without rephrasing.
      return base('NEEDS_CLARIFICATION', { clarify: parsed.clarify, plan: planOf(metricKey ?? '', filters, period, groupBy, compare, sort) });
    }
    if (!metricKey) {
      const r = base('NOT_UNDERSTOOD', {
        suggestions: suggestionsFor(actor),
        answerFa: 'نتوانستم پرسش را به یکی از شاخص‌های تعریف‌شده برگردانم؛ عددی حدسی نمی‌سازم. یکی از شاخص‌های زیر را بپرسید یا پرسش را با نام شاخص بنویسید.',
      });
      // What people ask and the catalogue cannot answer is the list of what to add next.
      await record(tx, actor, r);
      return r;
    }
  } else {
    return base('NOT_UNDERSTOOD', { suggestions: suggestionsFor(actor) });
  }

  const spec = METRIC_BY_KEY.get(metricKey);
  if (!spec) return base('NOT_UNDERSTOOD', { suggestions: suggestionsFor(actor) });

  // ── Permissions: the metric's fields, the asker's reach over people, the asker's unit.
  const missing = spec.requires.filter((p) => !actor.permissions.includes(p));
  const personOther = (groupBy === 'person' || (filters.personId && filters.personId !== actor.id));
  if (!missing.length && spec.personSensitive && personOther && !actor.permissions.includes('report.executive')) missing.push('report.executive');
  if (!missing.length && spec.ownUnitUnless && !spec.ownUnitUnless.some((p) => actor.permissions.includes(p))) {
    const own = actor.departmentCode;
    if (!own || (filters.units ?? []).some((u) => u !== own)) {
      return await refuse(tx, actor, question, spec, [], `${spec.labelFa} واحدهای دیگر در دسترس شما نیست؛ فقط هزینه‌های واحد خودتان را می‌توانید بپرسید.`, caveatsFa, planner);
    }
    filters.units = [own];
    caveatsFa.push(`فقط ${spec.labelFa} واحد خودتان (${unitFa(own)}) حساب شد.`);
  }
  if (missing.length) {
    const why = missing.includes('report.executive') && spec.requires.every((p) => actor.permissions.includes(p))
      ? 'عملکرد فردی همکاران فقط برای مدیریت قابل مشاهده است؛ می‌توانید همین شاخص را برای خودتان یا به تفکیک واحد بپرسید.'
      : `پاسخ این پرسش به دسترسی «${missing.map(permissionFa).join('»، «')}» نیاز دارد؛ این عدد برای شما محاسبه نشد.`;
    return await refuse(tx, actor, question, spec, missing, why, caveatsFa, planner);
  }

  // ── What the metric can and cannot be cut by — said, not silently dropped.
  for (const key of Object.keys(filters) as (keyof Filters)[]) {
    if (filters[key] === undefined) continue;
    if (!spec.filters.includes(key)) {
      caveatsFa.push(`${filterLabelFa(key)} برای «${spec.labelFa}» قابل اعمال نیست و اعمال نشد.`);
      delete filters[key];
    }
  }
  if (groupBy && !(spec.dims.includes(groupBy) || (groupBy === 'month' && !spec.asOfNow && spec.facts))) {
    caveatsFa.push(`تفکیک بر اساس ${DIM_LABEL_FA[groupBy]} برای «${spec.labelFa}» ممکن نیست؛ عدد کل آمده است.`);
    groupBy = null;
  }
  if (spec.asOfNow && period.kind !== 'ALL') {
    caveatsFa.push(`«${spec.labelFa}» وضعیت امروز است؛ بازهٔ «${period.labelFa}» اعمال نشد.`);
    period = ALL_TIME;
  }
  if (spec.asOfNow && compare) { caveatsFa.push('مقایسه با دورهٔ قبل برای وضعیت امروز معنا ندارد.'); compare = false; }
  if (compare && period.kind === 'ALL') { caveatsFa.push('برای مقایسه، یک بازهٔ زمانی بپرسید (مثلاً «این فصل نسبت به فصل قبل»).'); compare = false; }
  if (spec.key === 'cycle_time' && !filters.entity) {
    return base('NEEDS_CLARIFICATION', {
      plan: planOf(spec.key, filters, period, groupBy, compare, sort),
      clarify: { kind: 'entity', questionFa: 'زمان چرخهٔ کدام فرایند؟', options: Object.keys(WORKFLOWS).map((k) => ({ value: k, labelFa: entityLabelFa(k) })) },
    });
  }

  // ── Compute.
  const ctx: FactCtx = { tx, org: actor.organizationId, from: period.from, to: period.to, filters, now, people };
  const understoodFa = describe(spec, filters, period, groupBy, compare, vocab, people);
  let value: number | null;
  let countFa: string;
  let secondaryFa: string | null = null;
  let rows: AskRow[] | undefined;
  let basis: AskResult['basis'];
  let previous: AskResult['previous'];

  if (spec.direct) {
    const r = await spec.direct(ctx);
    value = r.value; countFa = r.countFa; caveatsFa.push(...r.noteFa);
  } else {
    const facts = await spec.facts!(ctx);
    const total = sum(facts);
    value = spec.value(total);
    countFa = spec.countFa(total);
    secondaryFa = spec.secondaryFa?.(total) ?? null;
    if (spec.caveats) caveatsFa.push(...await spec.caveats(ctx, total));
    if (groupBy) rows = group(spec, facts, groupBy, sort);
    basis = basisOf(facts);
    if (compare) {
      const prev = previousPeriod(period, now);
      if (prev) {
        const prevFacts = await spec.facts!({ ...ctx, from: prev.from, to: prev.to });
        const pv = spec.value(sum(prevFacts));
        previous = { value: pv, valueFa: UNIT_VALUE_FA(spec.unit, pv), periodFa: prev.labelFa, changeFa: change(spec, value, pv) };
      }
    }
  }

  const valueFa = UNIT_VALUE_FA(spec.unit, value);
  const scope = understoodFa.filter((u) => !u.startsWith('شاخص') && !u.startsWith('بازه') && !u.startsWith('تفکیک') && !u.startsWith('مقایسه'));
  let answerFa = value == null
    ? `${spec.labelFa}${scope.length ? ` (${scope.join('، ')})` : ''}، ${period.labelFa}: داده‌ای برای محاسبه نیست (${countFa || 'هیچ رکوردی'}).`
    : `${spec.labelFa}${scope.length ? ` (${scope.join('، ')})` : ''}، ${period.labelFa}: ${valueFa}${countFa ? ` — ${countFa}` : ''}.`;
  if (rows?.length && sort) {
    const top = rows.find((r) => r.value != null);
    if (top) answerFa += ` ${sort === 'desc' ? 'بیشترین' : 'کمترین'}: ${top.labelFa} با ${top.valueFa}.`;
  }
  // In the sentence itself, because the sentence is what gets copied into a chat or a slide.
  if (ignored.length) answerFa += ` بخشی از پرسش در این عدد اعمال نشده است: «${ignored.join(' ')}».`;

  const result: AskResult = {
    status: 'ANSWERED', question, planner, plan: planOf(spec.key, filters, period, groupBy, compare, sort),
    understoodFa, metric: { key: spec.key, labelFa: spec.labelFa, definitionFa: spec.definitionFa, unit: spec.unit },
    value, valueFa, countFa, secondaryFa, answerFa, periodFa: period.labelFa,
    groupByFa: groupBy ? (groupBy === 'person' ? spec.personLabelFa ?? DIM_LABEL_FA.person : DIM_LABEL_FA[groupBy]) : null,
    rows, previous, basis, caveatsFa, ignoredFa: ignored,
  };
  await record(tx, actor, result);
  return result;
}

async function refuse(
  tx: Tx, actor: AskActor, question: string | null, spec: MetricSpec, missing: string[], messageFa: string,
  caveatsFa: string[], planner: AskResult['planner'],
): Promise<AskResult> {
  await audit({
    organizationId: actor.organizationId, actorId: actor.id, action: 'PERMISSION_DENIED', entityType: 'report.ask',
    reason: missing.length ? `missing: ${missing.join(', ')}` : `scope: ${spec.key}`,
    after: { metric: spec.key, question },
    ipAddress: actor.ipAddress ?? null, requestId: actor.requestId ?? null,
  }).catch(() => undefined);
  return {
    status: 'REFUSED', question, planner, plan: null, understoodFa: [`شاخص: ${spec.labelFa}`], caveatsFa, ignoredFa: [],
    metric: { key: spec.key, labelFa: spec.labelFa, definitionFa: spec.definitionFa, unit: spec.unit },
    refusal: { permissions: missing, messageFa }, answerFa: messageFa,
  };
}

function planOf(metric: string, filters: Filters, period: Period, groupBy: Dim | null, compare: boolean, sort: 'desc' | 'asc' | null): AskResult['plan'] {
  return {
    metric, filters, groupBy, compare, sort,
    period: { preset: null, from: period.from?.toISOString() ?? null, to: period.to?.toISOString() ?? null },
  };
}

const filterLabelFa = (k: keyof Filters) => ({ units: 'فیلتر واحد', companyId: 'فیلتر مشتری', projectId: 'فیلتر پروژه', personId: 'فیلتر فرد', entity: 'نوع فرایند' }[k]);

function describe(spec: MetricSpec, f: Filters, period: Period, groupBy: Dim | null, compare: boolean, vocab: Vocab, people: FactCtx['people']): string[] {
  const out = [`شاخص: ${spec.labelFa}`];
  if (f.units?.length) {
    const names = f.units.map(unitFa).join(' و ');
    out.push(spec.unitMeaning === 'PROJECT' ? `پروژه‌هایی که واحد ${names} در آن‌ها سفارش کار داشته` : `واحد ${names}`);
  }
  if (f.companyId) out.push(`مشتری: ${vocab.companies.find((c) => c.id === f.companyId)?.legalName ?? '—'}`);
  if (f.projectId) { const p = vocab.projects.find((x) => x.id === f.projectId); out.push(`پروژه: ${p ? `${p.name} (${p.code})` : '—'}`); }
  if (f.personId) out.push(`${spec.personLabelFa ?? 'فرد'}: ${people.get(f.personId)?.fullName ?? '—'}`);
  if (f.entity) out.push(`فرایند: ${entityLabelFa(f.entity)}`);
  out.push(`بازه: ${period.labelFa}`);
  if (groupBy) out.push(`تفکیک: ${groupBy === 'person' ? spec.personLabelFa ?? DIM_LABEL_FA.person : DIM_LABEL_FA[groupBy]}`);
  if (compare) out.push('مقایسه با دورهٔ قبل');
  return out;
}

/**
 * Each measure summed as a decimal and rounded once (audit CALC-2): an answer that adds a few thousand
 * amounts must not drift. Counts are whole, so they come out as they went in.
 */
function sum(facts: Fact[]): Record<string, number> {
  const m: Record<string, Money> = {};
  for (const f of facts) for (const [k, v] of Object.entries(f.m)) m[k] = (m[k] ?? ZERO).add(money(v));
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, toMoney(v)]));
}

function group(spec: MetricSpec, facts: Fact[], dim: Dim, sort: 'desc' | 'asc' | null): AskRow[] {
  const groups = new Map<string, { labelFa: string; facts: Fact[] }>();
  for (const f of facts) {
    let d = f.dims[dim];
    if (dim === 'month') {
      if (f.at) { const j = jalaliOf(f.at); d = { key: `${j.y}-${String(j.m).padStart(2, '0')}`, labelFa: jalaliMonthLabel(j.y, j.m) }; }
      else d = { key: '~', labelFa: 'بدون تاریخ' };
    }
    if (!d) d = { key: '-', labelFa: 'نامشخص' };
    const g = groups.get(d.key) ?? groups.set(d.key, { labelFa: d.labelFa, facts: [] }).get(d.key)!;
    g.facts.push(f);
  }
  const rows = [...groups.entries()].map(([key, g]) => {
    const m = sum(g.facts);
    const value = spec.value(m);
    return { key, labelFa: g.labelFa, value, valueFa: UNIT_VALUE_FA(spec.unit, value), countFa: spec.countFa(m) };
  });
  if (dim === 'month' && !sort) return rows.sort((a, b) => a.key.localeCompare(b.key));
  const dir = sort === 'asc' ? 1 : -1;
  return rows.sort((a, b) => (a.value == null ? 1 : b.value == null ? -1 : dir * (a.value - b.value)));
}

function basisOf(facts: Fact[]): AskResult['basis'] {
  const seen = new Map<string, Ref>();
  for (const f of facts) if (f.ref && !seen.has(`${f.ref.entity}:${f.ref.id}`)) seen.set(`${f.ref.entity}:${f.ref.id}`, f.ref);
  return { count: seen.size, items: [...seen.values()].slice(0, 25) };
}

function change(spec: MetricSpec, now: number | null, before: number | null): string {
  if (now == null || before == null) return 'دورهٔ قبل داده‌ای برای مقایسه ندارد';
  if (spec.unit === 'PERCENT') {
    const d = Math.round((now - before) * 10) / 10;
    return d === 0 ? 'بدون تغییر' : `${fa(Math.abs(d).toString().replace('.', '٫'))} واحد درصد ${d > 0 ? 'بیشتر' : 'کمتر'}`;
  }
  if (before === 0) return now === 0 ? 'بدون تغییر' : 'دورهٔ قبل صفر بود';
  const r = Math.round(((now - before) / Math.abs(before)) * 100);
  return r === 0 ? 'بدون تغییر' : `${fa(Math.abs(r))}٪ ${r > 0 ? 'بیشتر' : 'کمتر'}`;
}

async function record(tx: Tx, actor: AskActor, r: AskResult): Promise<void> {
  await tx.aiInteraction.create({
    data: {
      organizationId: actor.organizationId, userId: actor.id, capability: 'NL_REPORT',
      model: r.planner === 'MODEL' ? 'model-planner' : 'rule-planner',
      promptSummary: (r.question ?? `plan:${r.metric?.key}`).slice(0, 500),
      responseText: r.answerFa?.slice(0, 8000) ?? null,
      groundingRefs: (r.basis?.items ?? []) as object,
      latencyMs: 0, succeeded: r.status === 'ANSWERED', errorMessage: r.status === 'ANSWERED' ? null : r.status,
    },
  }).catch(() => undefined);
}

/**
 * The model's plan, checked and resolved here: its metric must be one the catalogue has and the
 * asker may read, its names are looked up under the asker's reach, its dates must parse. The model
 * never sees data — only the question and the list of metrics.
 */
async function planWithModel(planner: Planner, question: string, actor: AskActor, vocab: Vocab, now: Date) {
  const allowed = allowedMetrics(actor);
  let raw: unknown;
  try { raw = await planner(question, allowed.map((m) => ({ key: m.key, labelFa: m.labelFa, definitionFa: m.definitionFa, dims: m.dims })), now); }
  catch { return null; }
  const parsed = modelPlanSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  if (!METRIC_BY_KEY.has(p.metric)) return null;

  const filters: Filters = {};
  const units = (p.units ?? []).filter((u) => u in DEPARTMENT_LABELS);
  if (units.length) filters.units = units;
  if (p.companyName) {
    const n = normalisePersian(p.companyName);
    const hit = vocab.companies.filter((c) => normalisePersian(c.legalName).includes(n) || (c.brandName && normalisePersian(c.brandName).includes(n)));
    if (hit.length === 1) filters.companyId = hit[0]!.id;
  }
  if (p.projectCode) { const hit = vocab.projects.find((x) => x.code.toUpperCase() === p.projectCode!.toUpperCase()); if (hit) filters.projectId = hit.id; }
  if (p.personName) {
    const n = normalisePersian(p.personName);
    const hit = vocab.people.filter((x) => normalisePersian(x.fullName).includes(n));
    if (hit.length === 1) filters.personId = hit[0]!.id;
  }
  if (p.entity && WORKFLOWS[p.entity]) filters.entity = p.entity;
  const from = p.from ? new Date(p.from) : null;
  const to = p.to ? new Date(p.to) : null;
  const period = from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())
    ? resolvePeriod({ from, to }, now) : ALL_TIME;
  return { metricKey: p.metric, filters, period, groupBy: p.groupBy ?? null, compare: !!p.compare };
}

/** The catalogue as the asker sees it: what they can ask, and what they cannot and why. */
export function catalogFor(actor: AskActor) {
  return METRICS.map((m) => {
    const missing = m.requires.filter((p) => !actor.permissions.includes(p));
    return {
      key: m.key, labelFa: m.labelFa, definitionFa: m.definitionFa, unit: m.unit, example: m.example,
      dims: m.dims.map((d) => ({ key: d, labelFa: d === 'person' ? m.personLabelFa ?? DIM_LABEL_FA.person : DIM_LABEL_FA[d] }))
        .concat(!m.asOfNow && m.facts && !m.dims.includes('month') ? [{ key: 'month' as Dim, labelFa: DIM_LABEL_FA.month }] : []),
      filters: m.filters, asOfNow: !!m.asOfNow, personSensitive: !!m.personSensitive,
      allowed: missing.length === 0,
      lockedFa: missing.length ? `نیازمند دسترسی «${missing.map(permissionFa).join('»، «')}»` : null,
    };
  });
}
