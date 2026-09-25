import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { Badge } from './ui';
import { Code } from './common';
import { formatCurrency, toPersianDigits } from '../lib/format';

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
const BAND_FA = { LOW: 'پایین‌تر از سابقه', WITHIN: 'در بازهٔ معمول', HIGH: 'بالاتر از سابقه' } as const;

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
        <span className="font-medium text-ink-700">مقایسه با سفارش‌های مشابه</span>
        {data.verdict && data.verdict.ratioToMedian != null && (
          <Badge tone={TONE[data.verdict.band]}>{BAND_FA[data.verdict.band]}</Badge>
        )}
      </div>
      <p className="mt-1 text-ink-500">{data.noteFa}</p>

      {ref && (
        <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
          <div className="rounded bg-surface px-2 py-1.5">
            <dt className="text-[10px] text-ink-400">{data.summary.actual ? 'هزینهٔ واقعی (میانه)' : 'اعلام‌شده (میانه)'}</dt>
            <dd className="nums font-medium">{formatCurrency(ref.median)}</dd>
          </div>
          <div className="rounded bg-surface px-2 py-1.5">
            <dt className="text-[10px] text-ink-400">بازهٔ معمول</dt>
            <dd className="nums">{formatCurrency(ref.p25)} تا {formatCurrency(ref.p75)}</dd>
          </div>
          <div className="rounded bg-surface px-2 py-1.5">
            <dt className="text-[10px] text-ink-400">زمان (میانه)</dt>
            <dd className="nums">{data.summary.workingDays ? `${toPersianDigits(data.summary.workingDays.median)} روز کاری` : '—'}</dd>
          </div>
        </dl>
      )}

      {data.verdict && data.verdict.ratioToMedian != null && (
        <p className={data.verdict.band === 'LOW' ? 'mt-2 font-medium text-rose-700' : 'mt-2 text-ink-700'}>{data.verdict.messageFa}</p>
      )}
      {data.summary.overrunRatio != null && data.summary.overrunRatio > 1.05 && (
        <p className="mt-1 text-amber-800">
          برآوردهای این واحد به‌طور میانه {toPersianDigits(Math.round((data.summary.overrunRatio - 1) * 100))}٪ کمتر از هزینهٔ واقعی بوده‌اند.
        </p>
      )}
      {data.schedule?.tight && <p className="mt-1 text-amber-800">{data.schedule.messageFa}</p>}

      {data.comparables.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-ink-500">سفارش‌های مقایسه‌شده ({toPersianDigits(data.comparables.length)})</summary>
          <ul className="mt-1 space-y-1">
            {data.comparables.map((c) => (
              <li key={c.workOrderId} className="text-[11px] text-ink-600">
                <Code>{c.code}</Code> {c.title} —
                {' '}اعلام‌شده {c.declaredCost != null ? formatCurrency(c.declaredCost) : '—'}
                {' '}· واقعی {c.actualCost != null ? formatCurrency(c.actualCost) : '—'}
                {c.workingDays != null && ` · ${toPersianDigits(c.workingDays)} روز`}
                <span className="block text-ink-400">{c.whyFa.join(' · ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
