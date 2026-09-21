import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { PageBody, PageHeader } from '../components/Shell';
import { Code, WorkflowActions } from '../components/common';
import { Badge, Button, Card, EmptyState, ErrorBlock, LoadingBlock, StateBadge, StatTile, cx } from '../components/ui';
import { formatDate, formatRelative, toPersianDigits } from '../lib/format';

interface WorkItem {
  kind: string; entityType: string; entityId: string; code: string; title: string; state: string;
  projectCode: string | null; projectName: string | null; dueAt: string | null;
  sla: { policyCode: string; labelFa: string; state: string; dueAt: string; budgetHours: number; controlledHours: number } | null;
  href: string;
  availableTransitions: { action: string; labelFa: string; labelEn: string; requiresReason: boolean; to: string }[];
}
interface Queue {
  items: WorkItem[]; counts: Record<string, number>; kinds: Record<string, string>; breached: number; atRisk: number;
}

/** How a clock reads at a glance: what is left of it, or that it is gone. */
function SlaChip({ sla }: { sla: NonNullable<WorkItem['sla']> }) {
  const left = Math.max(0, sla.budgetHours - sla.controlledHours);
  const tone = sla.state === 'BREACHED' ? 'danger' : sla.state === 'AT_RISK' ? 'warning' : sla.state === 'PAUSED' ? 'neutral' : 'info';
  const text = sla.state === 'BREACHED' ? `نقض شده — ${formatRelative(sla.dueAt)}`
    : sla.state === 'PAUSED' ? 'متوقف'
    : `${toPersianDigits(Math.round(left * 10) / 10)} ساعت کاری مانده`;
  return <Badge tone={tone} className="whitespace-nowrap">{sla.labelFa}: {text}</Badge>;
}

/**
 * One queue for one person. Ordered by the server — a breached clock first, then whatever runs
 * out soonest — and each item carries its own actions, so the work gets done from the list.
 */
export default function MyWork() {
  const [kind, setKind] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useQuery<Queue>({
    queryKey: ['/me/work'], queryFn: () => apiGet('/me/work'), refetchInterval: 60_000,
  });

  const items = (data?.items ?? []).filter((i) => !kind || i.kind === kind);

  return (
    <>
      <PageHeader title="کارهای من" subtitle="هر چه با شماست، در یک صف — به ترتیب نزدیکی مهلت، نه تاریخ ایجاد" />
      <PageBody>
        {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={refetch} /> : !data ? null : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="در صف" value={toPersianDigits(data.items.length)} />
              <StatTile label="مهلت نقض‌شده" value={toPersianDigits(data.breached)} tone={data.breached > 0 ? 'danger' : 'success'} />
              <StatTile label="در خطر" value={toPersianDigits(data.atRisk)} tone={data.atRisk > 0 ? 'warning' : 'neutral'} />
              <StatTile label="نوع کار" value={toPersianDigits(Object.values(data.counts).filter(Boolean).length)} />
            </div>

            <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="فیلتر بر اساس نوع کار">
              <Button size="sm" variant={kind === null ? 'primary' : 'secondary'} onClick={() => setKind(null)}>همه</Button>
              {Object.entries(data.kinds).filter(([k]) => data.counts[k]).map(([k, label]) => (
                <Button key={k} size="sm" variant={kind === k ? 'primary' : 'secondary'} onClick={() => setKind(kind === k ? null : k)}>
                  {label} <span className="ms-1 text-[11px] opacity-70">{toPersianDigits(data.counts[k]!)}</span>
                </Button>
              ))}
            </div>

            <Card>
              {!items.length ? <EmptyState title="کاری در صف شما نیست" /> : (
                <ul className="divide-y divide-ink-100" data-testid="my-work">
                  {items.map((i) => (
                    <li key={`${i.kind}:${i.entityId}`} className={cx('px-4 py-3', i.sla?.state === 'BREACHED' && 'bg-rose-50/40')}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="neutral">{data.kinds[i.kind] ?? i.kind}</Badge>
                            <Link to={i.href} className="truncate text-sm font-medium text-ink-800 hover:underline">{i.title}</Link>
                            <Code>{i.code}</Code>
                            <StateBadge state={i.state} />
                          </div>
                          <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-500">
                            {i.projectCode && <span>{i.projectName} <Code>{i.projectCode}</Code></span>}
                            {i.dueAt && <span>مهلت: {formatDate(i.dueAt)} — {formatRelative(i.dueAt)}</span>}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          {i.sla && <SlaChip sla={i.sla} />}
                          {i.availableTransitions.length > 0
                            ? <WorkflowActions entity={i.entityType} id={i.entityId} transitions={i.availableTransitions} onDone={() => void refetch()} />
                            : <Link to={i.href}><Button size="sm">باز کردن</Button></Link>}
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
