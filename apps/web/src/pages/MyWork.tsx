import { useState } from 'react';
import { Outbox } from '../components/Outbox';
import { Freshness } from '../components/Freshness';
import { offlineQuery } from '../lib/offline';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PageBody, PageHeader } from '../components/Shell';
import { Code, WorkflowActions } from '../components/common';
import { Badge, Button, Card, EmptyState, ErrorBlock, LoadingBlock, StateBadge, StatTile, cx } from '../components/ui';
import { formatDate, formatRelative, localDigits } from '../lib/format';
import { fallbackInterval, useLiveStatus } from '../lib/live';
import { loc, tr, trx } from '../i18n';

interface WorkItem {
  kind: string; entityType: string; entityId: string; code: string; title: string; state: string;
  projectCode: string | null; projectName: string | null; dueAt: string | null;
  sla: {
    policyCode: string; labelFa: string; state: string; dueAt: string; budgetHours: number; controlledHours: number;
    risk?: { probability: number; risk: 'WATCH' | 'LIKELY' | 'CRITICAL'; becauseFa: string | null } | null;
  } | null;
  href: string;
  availableTransitions: { action: string; labelFa: string; labelEn: string; requiresReason: boolean; to: string }[];
}
interface Queue {
  items: WorkItem[]; counts: Record<string, number>; kinds: Record<string, string>; breached: number; atRisk: number;
  /** Audit PERF-4: a queue longer than one reading takes; what has waited longest is shown. */
  truncated?: boolean;
}

/** How a clock reads at a glance: what is left of it, or that it is gone. */
function SlaChip({ sla }: { sla: NonNullable<WorkItem['sla']> }) {
  const left = Math.max(0, sla.budgetHours - sla.controlledHours);
  const tone = sla.state === 'BREACHED' ? 'danger' : sla.state === 'AT_RISK' ? 'warning' : sla.state === 'PAUSED' ? 'neutral' : 'info';
  const text = sla.state === 'BREACHED' ? tr('نقض شده — {0}', formatRelative(sla.dueAt))
    : sla.state === 'PAUSED' ? tr('متوقف')
    : tr('{0} ساعت کاری مانده', localDigits(Math.round(left * 10) / 10));
  return <Badge tone={tone} className="whitespace-nowrap">{loc(sla, 'label')}: {text}</Badge>;
}

/**
 * "You are going to run out of time" — said while there is still time to act (roadmap #8),
 * with the reason attached, because a bare percentage is not something anyone can act on.
 */
function RiskChip({ risk }: { risk: NonNullable<NonNullable<WorkItem['sla']>['risk']> }) {
  return (
    <Badge tone={risk.risk === 'CRITICAL' ? 'danger' : risk.risk === 'LIKELY' ? 'warning' : 'info'}
      className="whitespace-nowrap" >
      <span title={trx(risk.becauseFa ?? undefined)}>{tr('احتمال نقض {0}٪', localDigits(Math.round(risk.probability * 100)))}</span>
    </Badge>
  );
}

/**
 * One queue for one person. Ordered by the server — a breached clock first, then whatever runs
 * out soonest — and each item carries its own actions, so the work gets done from the list.
 */
export default function MyWork() {
  const [kind, setKind] = useState<string | null>(null);
  const live = useLiveStatus();
  // Kept on the device: the work list is what a person opens in the field (audit F-7).
  const { data, isLoading, error, refetch } = useQuery<Queue>({ ...offlineQuery<Queue>('/me/work'), refetchInterval: fallbackInterval(live) });

  const items = (data?.items ?? []).filter((i) => !kind || i.kind === kind);

  return (
    <>
      <PageHeader title={tr('کارهای من')} subtitle={tr('هر چه با شماست، در یک صف — به ترتیب نزدیکی مهلت، نه تاریخ ایجاد')} />
      <PageBody>
        <Freshness path="/me/work" />
        <div className="mb-4 empty:hidden"><Outbox /></div>
        {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={refetch} /> : !data ? null : (
          <>
            <div data-tour="tiles" className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label={tr('در صف')} value={localDigits(data.items.length)} />
              <StatTile label={tr('مهلت نقض‌شده')} value={localDigits(data.breached)} tone={data.breached > 0 ? 'danger' : 'success'} />
              <StatTile label={tr('در خطر')} value={localDigits(data.atRisk)} tone={data.atRisk > 0 ? 'warning' : 'neutral'} />
              <StatTile label={tr('نوع کار')} value={localDigits(Object.values(data.counts).filter(Boolean).length)} />
            </div>
            {data.truncated && (
              <p role="status" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900" data-testid="work-truncated">
                {tr('صف شما بلندتر از آن است که یک‌جا نشان داده شود؛ آنچه بیشتر منتظر مانده آمده است. با بستن کارها بقیه نمایان می‌شوند.')}
              </p>
            )}

            <div data-tour="work-kinds" className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label={tr('فیلتر بر اساس نوع کار')}>
              <Button size="sm" variant={kind === null ? 'primary' : 'secondary'} onClick={() => setKind(null)}>{tr('همه')}</Button>
              {Object.entries(data.kinds).filter(([k]) => data.counts[k]).map(([k, label]) => (
                <Button key={k} size="sm" variant={kind === k ? 'primary' : 'secondary'} onClick={() => setKind(kind === k ? null : k)}>
                  {trx(label)} <span className="ms-1 text-[12.5px] opacity-70">{localDigits(data.counts[k]!)}</span>
                </Button>
              ))}
            </div>

            <Card tour="work-list">
              {!items.length ? <EmptyState title={tr('کاری در صف شما نیست')} /> : (
                <ul className="divide-y divide-ink-100" data-testid="my-work">
                  {items.map((i) => (
                    <li key={`${i.kind}:${i.entityId}`} className={cx('px-4 py-3', i.sla?.state === 'BREACHED' && 'bg-rose-50/40')}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="neutral">{trx(data.kinds[i.kind] ?? i.kind)}</Badge>
                            <Link to={i.href} className="truncate text-sm font-medium text-ink-800 hover:underline">{i.title}</Link>
                            <Code>{i.code}</Code>
                            <StateBadge state={i.state} />
                          </div>
                          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-500">
                            {i.projectCode && <span>{i.projectName} <Code>{i.projectCode}</Code></span>}
                            {i.dueAt && <span>{tr('مهلت: {0} — {1}', formatDate(i.dueAt), formatRelative(i.dueAt))}</span>}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          {i.sla && <SlaChip sla={i.sla} />}
                          {i.sla?.risk && <RiskChip risk={i.sla.risk} />}
                          {i.availableTransitions.length > 0
                            ? <WorkflowActions entity={i.entityType} id={i.entityId} transitions={i.availableTransitions} onDone={() => void refetch()} />
                            : <Link to={i.href}><Button size="sm">{tr('باز کردن')}</Button></Link>}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  );
}
