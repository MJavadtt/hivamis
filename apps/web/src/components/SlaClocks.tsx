import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SLA_PAUSE_KINDS, stateLabelFa } from '@hiva/contracts';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../hooks/queries';
import { Badge, Button, Card, EmptyState, Input, Select, StateBadge, cx } from './ui';
import { formatDate, formatRelative, localDigits } from '../lib/format';
import { loc, tr, trx } from '../i18n';

interface Pause {
  id: string; kind: string; reason: string; pausedAt: string; resumedAt: string | null;
  businessHours: string | null;
}
interface Clock {
  id: string; state: string; dueAt: string; startedAt: string; stoppedAt: string | null;
  ownerId: string | null; policy: { code: string; labelFa: string };
  elapsedHours: number; pausedHours: number; controlledHours: number; budgetHours: number;
  pauses: Pause[];
}

/** People-facing kinds only; TRANSITION is reserved for the state machines. */
const KINDS = SLA_PAUSE_KINDS.filter((k) => k !== 'TRANSITION');

const h = (n: number) => tr('{0} ساعت', localDigits(Math.round(n * 10) / 10));

/**
 * Every SLA clock on one record, with the number that matters beside the one people expect:
 * how long the clock has been open, and how much of that was actually ours. A clock can be
 * paused by its owner or by traffic management, always with a reason — the reason is what
 * turns "late" into "late because the client took nine days to answer".
 */
export function SlaClocksCard({ entityType, entityId, title = tr('مهلت‌های SLA') }: {
  entityType: string; entityId: string; title?: string;
}) {
  const { user, can } = useAuth();
  const { data, isLoading } = useQuery<Clock[]>({
    queryKey: ['/sla-clocks', entityType, entityId],
    queryFn: () => apiGet('/sla-clocks', { entityType, entityId, state: 'ALL' }),
  });
  const [pausing, setPausing] = useState<string | null>(null);
  const [kind, setKind] = useState<string>(KINDS[0]!);
  const [reason, setReason] = useState('');

  const pause = useAction(
    (id: string) => apiPost(`/sla-clocks/${id}/pause`, { kind, reason }),
    tr('مهلت متوقف شد.'),
  );
  const resume = useAction((id: string) => apiPost(`/sla-clocks/${id}/resume`), tr('مهلت از سر گرفته شد.'));

  const mayManage = (c: Clock) => c.ownerId === user?.id || can('traffic.manage');

  return (
    <Card title={title} subtitle={tr('زمان سپری‌شده در برابر زمان تحت کنترل ما — فقط دومی مبنای ارزیابی است')}>
      {isLoading ? null : !data?.length ? <EmptyState title={tr('مهلتی روی این رکورد ثبت نشده')} /> : (
        <ul className="divide-y divide-ink-100">
          {data.map((c) => {
            const open = ['RUNNING', 'AT_RISK', 'PAUSED'].includes(c.state);
            const current = c.pauses.find((p) => !p.resumedAt);
            return (
              <li key={c.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink-800">{loc(c.policy, 'label')}</p>
                    <p className="text-xs text-ink-500">{tr('مهلت: {0} — {1}', formatDate(c.dueAt), formatRelative(c.dueAt))}</p>
                    <p className="mt-1 text-xs text-ink-600" data-testid="sla-hours">{tr('سپری‌شده {0} · در انتظار دیگران {1} ·{2}', h(c.elapsedHours), h(c.pausedHours), ' ')}<span className={cx('font-medium', c.controlledHours > c.budgetHours ? 'text-danger-700' : 'text-ink-800')}>{tr('تحت کنترل ما {0}', h(c.controlledHours))}</span>{tr('{0}از {1}', ' ', h(c.budgetHours))}</p>
                    {current && (
                      <p className="mt-1 text-xs text-ink-500">
                        <Badge tone="neutral">{trx(stateLabelFa(current.kind))}</Badge>{' '}
                        {current.reason}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StateBadge state={c.state} />
                    {open && mayManage(c) && c.state !== 'PAUSED' && (
                      <Button size="sm" onClick={() => setPausing(pausing === c.id ? null : c.id)}>{tr('توقف')}</Button>
                    )}
                    {open && mayManage(c) && c.state === 'PAUSED' && (
                      <Button size="sm" variant="primary" loading={resume.isPending} onClick={() => resume.mutate(c.id)}>{tr('از سرگیری')}</Button>
                    )}
                  </div>
                </div>

                {pausing === c.id && (
                  <form
                    className="mt-3 flex flex-wrap items-end gap-2"
                    onSubmit={(e) => { e.preventDefault(); pause.mutate(c.id, { onSuccess: () => { setPausing(null); setReason(''); } }); }}
                  >
                    <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-auto text-xs" aria-label={tr('نوع توقف')}>
                      {KINDS.map((k) => <option key={k} value={k}>{trx(stateLabelFa(k))}</option>)}
                    </Select>
                    <Input
                      value={reason} onChange={(e) => setReason(e.target.value)} required
                      placeholder={tr('دلیل توقف — منتظر چه کسی هستیم؟')} className="min-w-[16rem] flex-1 text-xs" aria-label={tr('دلیل توقف')}
                    />
                    <Button type="submit" size="sm" variant="primary" loading={pause.isPending} disabled={!reason.trim()}>{tr('ثبت توقف')}</Button>
                    <Button type="button" size="sm" onClick={() => setPausing(null)}>{tr('انصراف')}</Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
