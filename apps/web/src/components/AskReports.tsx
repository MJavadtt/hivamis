import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { Badge, Button, Card, Checkbox, Field, Input, Select } from './ui';
import { localDigits } from '../lib/format';
import { loc, tr, trx } from '../i18n';

interface CatalogMetric {
  key: string; labelFa: string; definitionFa: string; unit: string; example: string;
  dims: { key: string; labelFa: string }[]; filters: string[]; allowed: boolean; lockedFa: string | null; asOfNow: boolean;
}
interface Catalog { metrics: CatalogMetric[]; periods: { key: string; labelFa: string }[]; modelFallback: boolean }
interface Plan {
  metric: string;
  filters: { units?: string[]; companyId?: string; projectId?: string; personId?: string; entity?: string };
  period: { preset?: string | null; from?: string | null; to?: string | null };
  groupBy: string | null; compare: boolean; sort: 'desc' | 'asc' | null;
}
interface Answer {
  status: 'ANSWERED' | 'NEEDS_CLARIFICATION' | 'NOT_UNDERSTOOD' | 'REFUSED';
  question: string | null; planner: 'RULES' | 'MODEL' | 'EXPLICIT'; plan: Plan | null;
  understoodFa: string[]; metric?: { key: string; labelFa: string; definitionFa: string; unit: string };
  value?: number | null; valueFa?: string; countFa?: string; secondaryFa?: string | null; answerFa?: string;
  periodFa?: string; groupByFa?: string | null;
  rows?: { key: string; labelFa: string; value: number | null; valueFa: string; countFa: string }[];
  previous?: { valueFa: string; periodFa: string; changeFa: string };
  basis?: { count: number; items: { entity: string; id: string; label: string; href: string }[] };
  caveatsFa: string[]; ignoredFa: string[];
  clarify?: { kind: string; questionFa: string; options: { value: string; labelFa: string }[] };
  refusal?: { permissions: string[]; messageFa: string };
  suggestions?: { key: string; labelFa: string; example: string }[];
}

const UNITS: [string, string][] = [['ST', tr('استراتژی')], ['CR', tr('خلاقیت')], ['ME', tr('رسانه')], ['DM', tr('دیجیتال')], ['A', tr('اکانت')], ['S', tr('فروش')], ['FI', tr('مالی')], ['OP', tr('عملیات')]];
const PLANNER_FA = { RULES: tr('فهم قاعده‌محور'), MODEL: tr('فهم با مدل زبانی'), EXPLICIT: tr('برداشت اصلاح‌شده') } as const;

/**
 * Questions about the organisation's numbers, answered from the catalogue of defined metrics
 * (roadmap #27). The page shows how a question was understood and lets it be corrected by
 * choosing, not rephrasing — and never hides the part of a question that was not applied.
 */
export function AskReports() {
  const { data: catalog } = useQuery<Catalog>({ queryKey: ['/reports/ask/catalog'], queryFn: () => apiGet('/reports/ask/catalog') });
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  // Words of the original question that were not applied stay visible through corrections of it.
  const [carried, setCarried] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (body: { question?: string; plan?: Plan }, keepCarried: boolean) => {
    setBusy(true); setError(null);
    try {
      const r = await apiPost<Answer>('/reports/ask', body);
      setAnswer(r);
      if (!keepCarried) setCarried(r.ignoredFa ?? []);
    } catch (e: any) { setError(e?.message ?? tr('پرسش ناموفق بود')); } finally { setBusy(false); }
  };
  const askText = (q: string) => { setQuestion(q); if (q.trim().length >= 3) void run({ question: q.trim() }, false); };
  const rerun = (plan: Plan) => void run({ plan }, true);

  const allowed = (catalog?.metrics ?? []).filter((m) => m.allowed);

  return (
    <div className="space-y-5">
      <Card title={tr('پرسش از داده‌ها')} subtitle={tr('پرسش به یکی از شاخص‌های تعریف‌شده برگردانده می‌شود؛ همان تعریف و همان عدد گزارش‌ها، با همان دسترسی‌های شما.')}>
        <form className="flex flex-col gap-2 p-4 sm:flex-row" onSubmit={(e) => { e.preventDefault(); askText(question); }}>
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} aria-label={tr('پرسش')}
            placeholder={tr('مثلاً: حاشیه سود پروژه‌های واحد رسانه در سه ماه گذشته چقدر بوده؟')} className="flex-1" />
          <Button type="submit" variant="primary" loading={busy} disabled={question.trim().length < 3}>{tr('بپرس')}</Button>
        </form>
        <div className="flex flex-wrap gap-1.5 px-4 pb-4">
          {allowed.slice(0, 6).map((m) => (
            <button key={m.key} type="button" onClick={() => askText(m.example)}
              className="rounded-full bg-ink-50 px-2.5 py-1 text-[11px] text-ink-600 hover:bg-brand-50 hover:text-brand-700">
              {m.example}
            </button>
          ))}
        </div>
        {error && <p className="px-4 pb-4 text-xs text-rose-700">{error}</p>}
      </Card>

      {answer && <AnswerView answer={answer} carried={carried} catalog={catalog} onPlan={rerun} onAsk={askText} />}

      <details className="rounded-xl bg-surface ring-1 ring-ink-200/70">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-700">{tr('چه می‌توانم بپرسم؟ — {0} شاخص', localDigits(allowed.length))}</summary>
        <ul className="divide-y divide-ink-100" data-testid="ask-catalog">
          {(catalog?.metrics ?? []).map((m) => (
            <li key={m.key} className="px-4 py-2.5 text-xs">
              <div className="flex items-center gap-2">
                <span className={m.allowed ? 'font-medium text-ink-800' : 'text-ink-400'}>{loc(m, 'label')}</span>
                {m.asOfNow && <Badge tone="neutral">{tr('وضعیت امروز')}</Badge>}
                {!m.allowed && <Badge tone="warning">{loc(m, 'locked')}</Badge>}
              </div>
              <p className="mt-0.5 text-ink-500">{loc(m, 'definition')}</p>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function AnswerView({ answer: a, carried, catalog, onPlan, onAsk }: {
  answer: Answer; carried: string[]; catalog?: Catalog; onPlan: (p: Plan) => void; onAsk: (q: string) => void;
}) {
  const unapplied = a.planner === 'EXPLICIT' ? carried : a.ignoredFa;

  if (a.status === 'NOT_UNDERSTOOD') {
    return (
      <Card title={tr('پرسش فهمیده نشد')} subtitle={loc(a, 'answer')}>
        <div className="flex flex-wrap gap-1.5 p-4" data-testid="ask-suggestions">
          {(a.suggestions ?? []).map((s) => (
            <button key={s.key} type="button" onClick={() => onAsk(s.example)} className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] text-brand-700">
              {loc(s, 'label')}: {s.example}
            </button>
          ))}
        </div>
      </Card>
    );
  }
  if (a.status === 'REFUSED') {
    return (
      <div className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200" data-testid="ask-refused">
        <p className="font-medium">{loc(a.metric, 'label')}</p>
        <p className="mt-1 text-xs">{loc(a.refusal, 'message')}</p>
      </div>
    );
  }
  if (a.status === 'NEEDS_CLARIFICATION' && a.clarify) {
    const choose = (value: string) => {
      if (!a.plan) return;
      const p: Plan = { ...a.plan, filters: { ...a.plan.filters } };
      if (a.clarify!.kind === 'metric') p.metric = value;
      if (a.clarify!.kind === 'client') p.filters.companyId = value;
      if (a.clarify!.kind === 'project') p.filters.projectId = value;
      if (a.clarify!.kind === 'person') p.filters.personId = value;
      if (a.clarify!.kind === 'entity') p.filters.entity = value;
      onPlan(p);
    };
    return (
      <Card title={loc(a.clarify, 'question')}>
        <div className="flex flex-wrap gap-2 p-4" data-testid="ask-clarify">
          {a.clarify.options.length === 0 && <p className="text-xs text-ink-500">{tr('پرسش را با نام یا کد درست دوباره بنویسید.')}</p>}
          {a.clarify.options.map((o) => <Button key={o.value} size="sm" variant="secondary" onClick={() => choose(o.value)}>{loc(o, 'label')}</Button>)}
        </div>
      </Card>
    );
  }

  const maxRow = Math.max(1, ...(a.rows ?? []).map((r) => Math.abs(r.value ?? 0)));
  return (
    <Card title={trx(a.metric?.labelFa ?? tr('پاسخ'))} subtitle={loc(a, 'period')}
      action={<Badge tone={a.planner === 'MODEL' ? 'warning' : 'neutral'}>{PLANNER_FA[a.planner]}</Badge>}>
      <div className="space-y-4 p-4" data-testid="ask-answer">
        {unapplied.length > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200" data-testid="ask-unapplied">{tr('این بخش از پرسش در عدد زیر اعمال نشده است: «{0}»', unapplied.join(' '))}</p>
        )}
        <div>
          <p className="text-3xl font-semibold text-ink-900 nums">{loc(a, 'value')}</p>
          {a.countFa && <p className="mt-0.5 text-xs text-ink-500">{loc(a, 'count')}</p>}
          {a.secondaryFa && <p className="mt-0.5 text-xs text-ink-500">{loc(a, 'secondary')}</p>}
          {a.previous && <p className="mt-1 text-xs text-ink-600">{tr('دورهٔ قبل — {0}: {1} ({2})', a.previous.periodFa, a.previous.valueFa, a.previous.changeFa)}</p>}
        </div>
        <p className="text-sm text-ink-700">{loc(a, 'answer')}</p>

        <div className="flex flex-wrap gap-1.5" data-testid="ask-understood">
          {a.understoodFa.map((u) => <span key={u} className="rounded-md bg-ink-50 px-2 py-0.5 text-[11px] text-ink-600">{u}</span>)}
        </div>

        {a.plan && catalog && <Correct plan={a.plan} catalog={catalog} onPlan={onPlan} />}

        <details className="text-xs text-ink-600">
          <summary className="cursor-pointer text-ink-500">{tr('تعریف این شاخص')}</summary>
          <p className="mt-1">{loc(a.metric, 'definition')}</p>
        </details>

        {!!a.rows?.length && (
          <table className="w-full text-xs" data-testid="ask-rows">
            <thead><tr className="text-ink-400"><th className="py-1 text-start font-normal">{loc(a, 'groupBy')}</th><th className="text-start font-normal">{tr('مقدار')}</th><th className="text-start font-normal">{tr('پایه')}</th></tr></thead>
            <tbody>
              {a.rows.map((r) => (
                <tr key={r.key} className="border-t border-ink-100">
                  <td className="py-1.5 text-ink-700">{loc(r, 'label')}</td>
                  <td className="w-2/5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 rounded bg-brand-400" style={{ width: `${Math.max(2, (Math.abs(r.value ?? 0) / maxRow) * 100)}%` }} />
                      <span className="nums whitespace-nowrap">{loc(r, 'value')}</span>
                    </div>
                  </td>
                  <td className="text-ink-400">{loc(r, 'count')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {a.caveatsFa.length > 0 && (
          <ul className="space-y-0.5 text-xs text-ink-600" data-testid="ask-caveats">{a.caveatsFa.map((c, i) => <li key={i}>· {c}</li>)}</ul>
        )}

        {a.basis && a.basis.count > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-ink-500">{tr('بر پایهٔ {0} رکورد', localDigits(a.basis.count))}</summary>
            <ul className="mt-1 space-y-0.5" data-testid="ask-basis">
              {a.basis.items.map((b) => <li key={`${b.entity}:${b.id}`}><Link to={b.href} className="text-brand-700 hover:underline">{b.label}</Link></li>)}
              {a.basis.count > a.basis.items.length && <li className="text-ink-400">{tr('و {0} رکورد دیگر', localDigits(a.basis.count - a.basis.items.length))}</li>}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

/** Correcting the understanding by choosing — the metric, the window, the split, the unit. */
function Correct({ plan, catalog, onPlan }: { plan: Plan; catalog: Catalog; onPlan: (p: Plan) => void }) {
  const metric = catalog.metrics.find((m) => m.key === plan.metric);
  const set = (patch: Partial<Plan>) => onPlan({ ...plan, ...patch, filters: { ...plan.filters, ...(patch.filters ?? {}) } });
  return (
    <div className="grid gap-2 rounded-lg bg-ink-50/60 p-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="ask-correct">
      <Field label={tr('شاخص')}>
        <Select value={plan.metric} onChange={(e) => set({ metric: e.target.value, groupBy: null })} aria-label={tr('شاخص')}>
          {catalog.metrics.filter((m) => m.allowed).map((m) => <option key={m.key} value={m.key}>{loc(m, 'label')}</option>)}
        </Select>
      </Field>
      <Field label={tr('بازه')}>
        <Select value="" onChange={(e) => e.target.value && set({ period: { preset: e.target.value, from: null, to: null } })} aria-label={tr('بازه')} disabled={metric?.asOfNow}>
          <option value="">{tr('— همین بازه —')}</option>
          {catalog.periods.map((p) => <option key={p.key} value={p.key}>{loc(p, 'label')}</option>)}
        </Select>
      </Field>
      <Field label={tr('تفکیک')}>
        <Select value={plan.groupBy ?? ''} onChange={(e) => set({ groupBy: e.target.value || null })} aria-label={tr('تفکیک')}>
          <option value="">{tr('بدون تفکیک')}</option>
          {(metric?.dims ?? []).map((d) => <option key={d.key} value={d.key}>{loc(d, 'label')}</option>)}
        </Select>
      </Field>
      <Field label={tr('واحد')}>
        <Select value={plan.filters.units?.[0] ?? ''} onChange={(e) => set({ filters: { units: e.target.value ? [e.target.value] : undefined } })} aria-label={tr('واحد')} disabled={!metric?.filters.includes('units')}>
          <option value="">{tr('همهٔ واحدها')}</option>
          {UNITS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
        </Select>
      </Field>
      <div className="flex items-end pb-2">
        <Checkbox checked={plan.compare} disabled={metric?.asOfNow} onChange={(e) => set({ compare: e.target.checked })} label={tr('مقایسه با دورهٔ قبل')} />
      </div>
    </div>
  );
}
