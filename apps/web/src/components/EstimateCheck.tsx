import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { Badge } from './ui';
import { Code } from './common';
import { formatCurrency, localDigits } from '../lib/format';
import { loc, tr } from '../i18n';

interface Range { p25: number; median: number; p75: number; mean: number }
interface Estimate {
  basis: 'SIMILAR' | 'UNIT_WIDE' | 'NONE';
  comparables: {
    workOrderId: string; code: string; title: string; similarity: number;
    declaredCost: number | null; actualCost: number | null; workingDays: number | null; whyFa: string[];
  }[];
  summary: { count: number; declared: Range | null; actual: Range | null; workingDays: Range | null; overrunRatio: number | null };
  verdict: null | { band: 'LOW' | 'WITHIN' | 'HIGH'; ratioToMedian: number | null; messageFa: string };
  schedule: null | { tight: boolean; messageFa: string };
  noteFa: string;
}
const TONE = { LOW: 'danger', WITHIN: 'success', HIGH: 'warning' } as const;
const BAND_FA = { LOW: tr('پایین‌تر از سابقه'), WITHIN: tr('در بازهٔ معمول'), HIGH: tr('بالاتر از سابقه') } as const;

/**
 * The figure being typed, beside what similar work in this unit really cost (roadmap #24).
 * Debounced so it answers the number the person settled on, not every keystroke. Advisory: it
 * never stops a declaration — it makes an unrealistic one visible before the price is locked.
 */
export function EstimateCheck({ workOrderId, proposed }: { workOrderId: string; proposed: number }) {
  const [settled, setSettled] = useState(proposed);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(proposed), 400);
    return () => window.clearTimeout(t);
  }, [proposed]);

  const { data, error } = useQuery<Estimate>({
    queryKey: ['/work-orders', workOrderId, 'estimate', settled],
    queryFn: () => apiGet(`/work-orders/${workOrderId}/estimate`, settled > 0 ? { proposedCost: String(settled) } : {}),
    retry: false,
  });
  if (error || !data) return null;
  const ref = data.summary.actual ?? data.summary.declared;

  return (
    <div className="rounded-lg bg-ink-50/70 p-3 text-xs" data-testid="estimate-check">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink-700">{tr('مقایسه با سفارش‌های مشابه')}</span>
        {data.verdict && data.verdict.ratioToMedian != null && (
          <Badge tone={TONE[data.verdict.band]}>{BAND_FA[data.verdict.band]}</Badge>
        )}
      </div>
      <p className="mt-1 text-ink-500">{loc(data, 'note')}</p>

      {ref && (
        <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
          <div className="rounded bg-surface px-2 py-1.5">
            <dt className="text-[10px] text-ink-400">{data.summary.actual ? tr('هزینهٔ واقعی (میانه)') : tr('اعلام‌شده (میانه)')}</dt>
            <dd className="nums font-medium">{formatCurrency(ref.median)}</dd>
          </div>
          <div className="rounded bg-surface px-2 py-1.5">
            <dt className="text-[10px] text-ink-400">{tr('بازهٔ معمول')}</dt>
            <dd className="nums">{tr('{0} تا {1}', formatCurrency(ref.p25), formatCurrency(ref.p75))}</dd>
          </div>
          <div className="rounded bg-surface px-2 py-1.5">
            <dt className="text-[10px] text-ink-400">{tr('زمان (میانه)')}</dt>
            <dd className="nums">{data.summary.workingDays ? tr('{0} روز کاری', localDigits(data.summary.workingDays.median)) : '—'}</dd>
          </div>
        </dl>
      )}

      {data.verdict && data.verdict.ratioToMedian != null && (
        <p className={data.verdict.band === 'LOW' ? 'mt-2 font-medium text-rose-700' : 'mt-2 text-ink-700'}>{loc(data.verdict, 'message')}</p>
      )}
      {data.summary.overrunRatio != null && data.summary.overrunRatio > 1.05 && (
        <p className="mt-1 text-amber-800">{tr('برآوردهای این واحد به‌طور میانه {0}٪ کمتر از هزینهٔ واقعی بوده‌اند.', localDigits(Math.round((data.summary.overrunRatio - 1) * 100)))}</p>
      )}
      {data.schedule?.tight && <p className="mt-1 text-amber-800">{loc(data.schedule, 'message')}</p>}

      {data.comparables.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-ink-500">{tr('سفارش‌های مقایسه‌شده ({0})', localDigits(data.comparables.length))}</summary>
          <ul className="mt-1 space-y-1">
            {data.comparables.map((c) => (
              <li key={c.workOrderId} className="text-[11px] text-ink-600">
                <Code>{c.code}</Code>{' '}{tr('{0} —{1}اعلام‌شده {2}{3}· واقعی {4}', c.title, ' ', c.declaredCost != null ? formatCurrency(c.declaredCost) : '—', ' ', c.actualCost != null ? formatCurrency(c.actualCost) : '—')}{c.workingDays != null && tr(' · {0} روز', localDigits(c.workingDays))}
                <span className="block text-ink-400">{c.whyFa.join(' · ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
