import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import type { ChatAction, PlanOutcome } from '../lib/chat';
import { Button, cx } from './ui';
import { tr, trx } from '../i18n';

/**
 * What the assistant proposes to change (audit F-4), for the person to approve step by step. Each step
 * says in words what it does and, opened, the exact request it will make. Nothing is written until
 * "do the selected" is pressed; then each runs as the person, through the same API as the page, and
 * the card says what became of it. Reopened from the history, it reads its plan's state again.
 */

interface PlanState { status: 'PROPOSED' | 'EXECUTED' | 'PARTIAL' | 'FAILED' | 'DECLINED'; outcome: PlanOutcome[] | null; expired: boolean }

const OUTCOME = {
  DONE: { label: () => tr('انجام شد'), tone: 'text-emerald-700' },
  FAILED: { label: () => tr('انجام نشد'), tone: 'text-rose-700' },
  DECLINED: { label: () => tr('کنار گذاشته شد'), tone: 'text-ink-500' },
} as const;

export function PlanCard({ action }: { action: ChatAction }) {
  const qc = useQueryClient();
  const steps = action.steps ?? [];
  const key = ['/ai/plans', action.planId];
  const { data } = useQuery<PlanState>({ queryKey: key, queryFn: () => apiGet(`/ai/plans/${action.planId}`), enabled: !!action.planId });
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(steps.flatMap((s, i) => (s.issue ? [] : [i]))));
  const [error, setError] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: (selected: number[]) => (selected.length
      ? apiPost<{ status: PlanState['status']; outcome: PlanOutcome[] }>(`/ai/plans/${action.planId}/execute`, { steps: selected })
      : apiPost<{ status: PlanState['status']; outcome: PlanOutcome[] }>(`/ai/plans/${action.planId}/decline`, {})),
    onSuccess: (r) => {
      qc.setQueryData<PlanState>(key, { status: r.status, outcome: r.outcome, expired: false });
      // What the steps wrote shows on the page behind at once.
      if (r.outcome.some((o) => o.status === 'DONE')) void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== '/ai/plans' });
    },
    onError: (e) => setError((e as Error).message),
  });

  const decided = data && data.status !== 'PROPOSED';
  const open = data?.status === 'PROPOSED' && !data.expired;
  // Nothing in it can run as it stands: say so, rather than offer a button that does nothing.
  const doable = steps.some((s) => !s.issue);
  const outcome = (i: number) => data?.outcome?.find((o) => o.index === i);
  const toggle = (i: number) => setChosen((c) => { const n = new Set(c); if (n.has(i)) n.delete(i); else n.add(i); return n; });

  return (
    <section className="mt-2 rounded-xl bg-panel p-3 ring-1 ring-inset ring-brand-200" data-testid="plan" aria-label={action.label}>
      <h3 className="text-xs font-semibold text-ink-800">{action.label}</h3>
      <p className="mt-0.5 text-[12.5px] leading-5 text-ink-500">
        {decided ? tr('دربارهٔ این پیشنهاد تصمیم گرفته شد.') : data?.expired ? tr('این پیشنهاد کهنه شده است؛ اگر هنوز لازم است دوباره بخواهید.')
          : !doable ? tr('هیچ موردی از این پیشنهاد به همین شکل انجام‌شدنی نیست؛ دلیلش زیر هر مورد آمده است. آنچه کم است را به دستیار بگویید.')
          : tr('هیچ‌کدام انجام نشده است. آنچه را می‌خواهید علامت بزنید و «انجام موارد انتخاب‌شده» را بزنید — یا بنویسید «بله»؛ هر مورد با نام شما و مثل صفحهٔ خودش انجام می‌شود.')}
      </p>
      <ol className="mt-2 space-y-2">
        {steps.map((s, i) => {
          const o = outcome(i);
          return (
            <li key={i} className="rounded-lg bg-surface px-2.5 py-2 ring-1 ring-inset ring-ink-200">
              <label className={cx('flex items-start gap-2 text-sm leading-6 text-ink-800', (s.issue || !open) && 'cursor-default')}>
                <input type="checkbox" className="mt-1.5 size-4 shrink-0 accent-brand-600" checked={!s.issue && (o ? o.status !== 'DECLINED' : chosen.has(i))}
                  disabled={!!s.issue || !open || decide.isPending} onChange={() => toggle(i)} />
                <span className="min-w-0 flex-1" dir="auto">{s.summary}</span>
              </label>
              {s.issue && <p className="ms-6 mt-1 text-[12.5px] leading-5 text-amber-800" data-testid="plan-issue">{tr('انجام‌شدنی نیست: {0}', s.issue)}</p>}
              {o && (
                <p className={cx('ms-6 mt-1 text-[12.5px] leading-5', OUTCOME[o.status].tone)} data-testid="plan-outcome">
                  {OUTCOME[o.status].label()}{o.status === 'FAILED' && o.message ? `: ${trx(o.message)}` : ''}
                </p>
              )}
              {s.request.path && (
                <details className="ms-6 mt-1 text-[12.5px] text-ink-500">
                  <summary className="cursor-pointer select-none">{tr('دقیقاً چه نوشته می‌شود')}</summary>
                  <pre dir="ltr" className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-ink-50 p-2 text-start font-mono text-[12px] leading-5 text-ink-700">
                    {`${s.request.method} /api/v1${s.request.path}\n${JSON.stringify(s.request.body, null, 2)}`}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
      </ol>
      {error && <p role="alert" className="mt-2 text-[12.5px] text-rose-700">{error}</p>}
      {open && doable && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" disabled={!chosen.size} loading={decide.isPending && chosen.size > 0}
            onClick={() => { setError(null); decide.mutate([...chosen].sort((a, b) => a - b)); }}>
            {tr('انجام موارد انتخاب‌شده')}
          </Button>
          <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => { setError(null); decide.mutate([]); }}>{tr('هیچ‌کدام')}</Button>
        </div>
      )}
    </section>
  );
}
