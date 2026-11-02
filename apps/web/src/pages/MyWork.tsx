import { useState } from 'react';
import { Outbox } from '../components/Outbox';
import { Freshness } from '../components/Freshness';
import { offlineQuery } from '../lib/offline';
import { useSearchParams } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { useQuery } from '@tanstack/react-query';
import { PageBody, PageHeader } from '../components/Shell';
import { WorkCard } from '../components/WorkCard';
import { Button, Card, EmptyState, ErrorBlock, LoadingBlock } from '../components/ui';
import { localDigits } from '../lib/format';
import { fallbackInterval, useLiveStatus } from '../lib/live';
import { groupOf, type WorkGroup, type WorkItem } from '../lib/plain';
import { tr } from '../i18n';

interface Queue {
  items: WorkItem[]; counts: Record<string, number>; kinds: Record<string, string>; breached: number; atRisk: number;
  /** Audit PERF-4: a queue longer than one reading takes; what has waited longest is shown. */
  truncated?: boolean;
  /** Whose queue, when the system administrator reads someone else's (owner's report, 2026-10-23). */
  person?: { id: string; fullName: string } | null;
}

/** The groups a person sorts their work by, in the order they should look at them. */
const GROUPS: { key: WorkGroup; label: string; empty: string }[] = [
  { key: 'returned', label: tr('برگشت برای اصلاح'), empty: tr('چیزی برای اصلاح برنگشته است.') },
  { key: 'urgent', label: tr('فوری'), empty: tr('کار فوری ندارید.') },
  { key: 'decide', label: tr('منتظر تصمیم شما'), empty: tr('چیزی منتظر تصمیم شما نیست.') },
  { key: 'todo', label: tr('کارهای من'), empty: tr('کار دیگری با شما نیست.') },
  { key: 'waiting', label: tr('تحویل داده‌ام'), empty: tr('چیزی منتظر بررسی دیگران نیست.') },
];

/** One sentence that says how the day looks. */
export function summaryOf(items: WorkItem[]): string {
  const count = (g: WorkGroup) => items.filter((i) => groupOf(i) === g).length;
  const open = items.filter((i) => groupOf(i) !== 'waiting').length;
  if (!open) return tr('کاری منتظر شما نیست.');
  const parts = [tr('{0} کار با شماست', localDigits(open))];
  if (count('returned')) parts.push(tr('{0} کار برای اصلاح برگشته', localDigits(count('returned'))));
  if (count('urgent')) parts.push(tr('{0} کار فوری است', localDigits(count('urgent'))));
  if (count('decide')) parts.push(tr('{0} مورد منتظر تصمیم شماست', localDigits(count('decide'))));
  return `${parts.join(tr('، '))}${tr('.')}`;
}

/**
 * Everything a person has to do, in one place (roadmap #41; the owner's brief, 2026-11-02): each
 * piece of work as a card that says what to do and offers the one button that does it, sorted by
 * what came back, what is late, what waits on their decision, the rest — and what they have handed
 * in, which waits on someone else. The server's order inside each group: soonest deadline first.
 */
export default function MyWork() {
  const [group, setGroup] = useState<WorkGroup | null>(null);
  const live = useLiveStatus();
  // Kept on the device: the work list is what a person opens in the field (audit F-7).
  // `?for=` — someone else's queue, for the system administrator; read live, never kept on the device.
  const [params] = useSearchParams();
  const forId = params.get('for');
  const { data, isLoading, error, refetch } = useQuery<Queue>(forId
    ? { queryKey: ['/me/work', forId], queryFn: () => apiGet('/me/work', { for: forId }), refetchInterval: fallbackInterval(live) }
    : { ...offlineQuery<Queue>('/me/work'), refetchInterval: fallbackInterval(live) });

  const all = data?.items ?? [];
  const inGroup = (g: WorkGroup) => all.filter((i) => groupOf(i) === g);
  const shown = group ? GROUPS.filter((g) => g.key === group) : GROUPS;

  return (
    <>
      <PageHeader
        title={data?.person ? tr('کارهای {0}', data.person.fullName) : tr('کارهای من')}
        subtitle={data?.person ? tr('صف کار این نفر، همان‌طور که خودش می‌بیند — اقدام‌ها با دسترسی شما و به نام شما ثبت می‌شوند.') : tr('هر چه با شماست، با گام بعدی‌اش — فوری‌ترها بالاتر')} />
      <PageBody>
        {!forId && <Freshness path="/me/work" />}
        {!forId && <div className="mb-4 empty:hidden"><Outbox /></div>}
        {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={refetch} /> : !data ? null : (
          <>
            <p data-tour="work-summary" className="mb-4 text-[15px] font-medium text-ink-800" data-testid="work-summary">{summaryOf(all)}</p>
            {data.truncated && (
              <p role="status" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900" data-testid="work-truncated">
                {tr('صف شما بلندتر از آن است که یک‌جا نشان داده شود؛ آنچه بیشتر منتظر مانده آمده است. با بستن کارها بقیه نمایان می‌شوند.')}
              </p>
            )}

            <div data-tour="work-groups" className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label={tr('نمایش بر اساس گروه')}>
              <Button size="sm" variant={group === null ? 'primary' : 'secondary'} onClick={() => setGroup(null)}>{tr('همه')}</Button>
              {GROUPS.filter((g) => inGroup(g.key).length).map((g) => (
                <Button key={g.key} size="sm" variant={group === g.key ? 'primary' : 'secondary'} onClick={() => setGroup(group === g.key ? null : g.key)}>
                  {g.label} <span className="ms-1 text-[12.5px] opacity-70">{localDigits(inGroup(g.key).length)}</span>
                </Button>
              ))}
            </div>

            <div data-tour="work-list" className="space-y-6" data-testid="my-work">
              {!all.length ? (
                <Card><EmptyState title={tr('کاری در صف شما نیست')} description={tr('هر کاری که به شما سپرده شود، یا منتظر تصمیم شما باشد، همین‌جا می‌آید.')} /></Card>
              ) : shown.map((g) => {
                const items = inGroup(g.key);
                if (!items.length && !group) return null;
                return (
                  <section key={g.key} aria-label={g.label}>
                    <h2 className="mb-2 text-sm font-bold text-ink-700">{g.label} <span className="font-normal text-ink-400">{localDigits(items.length)}</span></h2>
                    {!items.length ? <p className="text-sm text-ink-500">{g.empty}</p> : (
                      <div className="grid gap-3 lg:grid-cols-2">
                        {items.map((i) => <WorkCard key={`${i.kind}:${i.entityId}`} item={i} onDone={() => void refetch()} />)}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}
