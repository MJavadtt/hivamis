import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { offlineQuery } from '../lib/offline';
import { fallbackInterval, useLiveStatus } from '../lib/live';
import { PageBody, PageHeader } from '../components/Shell';
import { NoticeRow, type NotificationRow } from '../components/Notice';
import { StagePill, WorkCard } from '../components/WorkCard';
import { Button, Card, EmptyState, ErrorBlock, LoadingBlock } from '../components/ui';
import { formatDate, formatDateTime, formatRelative, localDigits } from '../lib/format';
import { groupOf, type WorkItem } from '../lib/plain';
import { summaryOf } from './MyWork';
import { flow, loc, tr, trx } from '../i18n';

/**
 * The first page a person sees (the owner's brief, 2026-11-02): what is theirs to do today and what
 * is coming — not a wall of figures. What came back to correct, what is late, what is next; their
 * meetings, what they have been told, their projects and what they have finished. Every part is
 * read from the routes the rest of the app uses; the figures moved to «نمای آماری من» (/overview).
 */

interface Queue { items: WorkItem[]; truncated?: boolean }
interface MyDashboard {
  projects: { id: string; code: string; name: string; state: string; healthStatus: string; plannedEnd: string | null; company: { legalName: string } }[];
}
interface BookingRow { id: string; code: string; title: string; state: string; startsAt: string; placeNote: string | null; room?: { name: string } | null }
interface TaskRow { id: string; title: string; closedAt: string | null; updatedAt: string; project?: { name: string } | null }

const HEALTH: Record<string, { label: string; cls: string }> = {
  GREEN: { label: tr('روی روال'), cls: 'text-emerald-700' },
  AMBER: { label: tr('نیازمند توجه'), cls: 'text-amber-700' },
  RED: { label: tr('در خطر'), cls: 'text-rose-700' },
};

export default function Home() {
  const { user, can } = useAuth();
  const live = useLiveStatus();
  const work = useQuery<Queue>({ ...offlineQuery<Queue>('/me/work'), refetchInterval: fallbackInterval(live) });
  const notices = useQuery<{ items: NotificationRow[]; unread: number }>({ queryKey: ['/notifications'], queryFn: () => apiGet('/notifications') });
  const mine = useQuery<MyDashboard>({ queryKey: ['/reports/my-dashboard'], queryFn: () => apiGet('/reports/my-dashboard') });
  // The window is fixed once per visit, so the query is read once — not again on every render.
  const span = useMemo(() => ({ from: new Date().toISOString(), to: new Date(Date.now() + 14 * 86_400_000).toISOString() }), []);
  const meetings = useQuery<Page<BookingRow>>({
    queryKey: ['/bookings', 'upcoming', span.from],
    queryFn: () => apiGet('/bookings', { scope: 'mine', from: span.from, to: span.to, pageSize: '20' }),
    enabled: can('meeting.book'),
  });
  const finished = useQuery<Page<TaskRow>>({
    queryKey: ['/tasks', 'mine', 'CLOSED'],
    queryFn: () => apiGet('/tasks', { mine: 'true', state: 'CLOSED', pageSize: '20' }),
    enabled: can('task.read'),
  });

  const items = work.data?.items ?? [];
  const returned = items.filter((i) => groupOf(i) === 'returned');
  const urgent = items.filter((i) => groupOf(i) === 'urgent');
  const next = items.filter((i) => ['decide', 'todo'].includes(groupOf(i)));
  const open = items.filter((i) => groupOf(i) !== 'waiting').length;
  const upcoming = (meetings.data?.items ?? [])
    .filter((b) => !['CANCELLED', 'REJECTED', 'COMPLETED'].includes(b.state))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 4);
  const done = (finished.data?.items ?? [])
    .sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt)).slice(0, 5);
  const unread = (notices.data?.items ?? []).filter((n) => !n.readAt).slice(0, 4);

  return (
    <>
      <PageHeader
        title={tr('سلام، {0}', user?.fullName ?? '')}
        subtitle={<span>{loc(user?.department, 'name')}{user?.jobTitle && ` — ${trx(user.jobTitle)}`}</span>}
      />
      <PageBody className="space-y-5">
        <Card tour="today">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div>
              <p className="text-base font-semibold text-ink-900" data-testid="today">{work.isLoading ? tr('در حال خواندن کارهای شما…') : summaryOf(items)}</p>
              {!work.isLoading && open > 0 && <p className="mt-1 text-sm text-ink-500">{tr('از بالا شروع کنید: هر کارت می‌گوید چه باید کرد و دکمه‌اش همان کار را انجام می‌دهد.')}</p>}
            </div>
            {open > 0 && <Link to="/my-work"><Button variant="primary">{tr('همهٔ کارهای من')} {flow()}</Button></Link>}
          </div>
        </Card>

        <div className="grid gap-5 xl:grid-cols-3">
          <div className="space-y-5 xl:col-span-2" data-tour="my-tasks">
            {work.isLoading ? <LoadingBlock /> : work.error ? <ErrorBlock error={work.error} onRetry={() => void work.refetch()} /> : !open ? (
              <Card><EmptyState title={tr('کاری منتظر شما نیست')} description={tr('هر کاری که به شما سپرده شود یا منتظر تصمیم شما باشد، همین‌جا نشان داده می‌شود.')} /></Card>
            ) : (
              <>
                <WorkSection title={tr('برگشت برای اصلاح')} hint={tr('کسی این‌ها را بررسی کرده و با توضیح برگردانده است.')} items={returned.slice(0, 3)} more={returned.length - 3} onDone={() => void work.refetch()} />
                <WorkSection title={tr('فوری')} hint={tr('مهلت این‌ها گذشته یا نزدیک است.')} items={urgent.slice(0, 3)} more={urgent.length - 3} onDone={() => void work.refetch()} />
                <WorkSection title={tr('کارهای بعدی')} items={next.slice(0, 4)} more={next.length - 4} onDone={() => void work.refetch()} />
              </>
            )}
          </div>

          <div className="space-y-5">
            {can('meeting.book') && (
              <Card tour="meetings" title={tr('جلسه‌های پیش رو')} footer={<><span /><Link to="/bookings" className="text-brand-700 hover:underline">{tr('همهٔ رزروها')} {flow()}</Link></>}>
                {!upcoming.length ? <EmptyState title={tr('در دو هفتهٔ آینده جلسه‌ای ندارید')} /> : (
                  <ul className="divide-y divide-ink-100">
                    {upcoming.map((b) => (
                      <li key={b.id}>
                        <Link to={`/bookings/${b.id}`} className="block px-4 py-2.5 hover:bg-ink-50">
                          <p className="text-sm font-medium text-ink-800">{b.title}</p>
                          <p className="mt-0.5 text-xs text-ink-500">{formatDateTime(b.startsAt)}{b.room?.name || b.placeNote ? ` — ${b.room?.name ?? b.placeNote}` : ''}</p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
            <Card tour="news" title={tr('اعلان‌های تازه')} subtitle={notices.data?.unread ? tr('{0} خوانده‌نشده', localDigits(notices.data.unread)) : undefined}>
              {!unread.length ? <EmptyState title={tr('اعلان تازه‌ای ندارید')} /> : <div>{unread.map((n) => <NoticeRow key={n.id} n={n} />)}</div>}
            </Card>
          </div>
        </div>

        <Card tour="my-projects" title={tr('پروژه‌های من')} footer={<><span /><Link to="/projects" className="text-brand-700 hover:underline">{tr('همهٔ پروژه‌ها')} {flow()}</Link></>}>
          {!mine.data?.projects.length ? <EmptyState title={tr('پروژهٔ در جریانی ندارید')} /> : (
            <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {mine.data.projects.slice(0, 6).map((p) => (
                <Link key={p.id} to={`/projects/${p.id}`} className="rounded-xl p-3 ring-1 ring-edge hover:bg-ink-50" data-testid="home-project">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-ink-900">{p.name}</p>
                    <StagePill state={p.state} entity="project" />
                  </div>
                  <p className="mt-0.5 text-xs text-ink-500">{p.company?.legalName}</p>
                  <p className="mt-2 flex justify-between text-xs">
                    <span className={HEALTH[p.healthStatus]?.cls ?? 'text-ink-500'}>{HEALTH[p.healthStatus]?.label ?? ''}</span>
                    {p.plannedEnd && <span className="text-ink-500">{tr('پایان: {0}', formatDate(p.plannedEnd))}</span>}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </Card>

        {can('task.read') && done.length > 0 && (
          <Card title={tr('تازه انجام داده‌اید')}>
            <ul className="divide-y divide-ink-100">
              {done.map((t) => (
                <li key={t.id}>
                  <Link to={`/tasks/${t.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-ink-50">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink-800">{t.title}</span>
                      {t.project?.name && <span className="text-xs text-ink-500">{t.project.name}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-emerald-700">{tr('انجام شد، {0}', formatRelative(t.closedAt ?? t.updatedAt))}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <p className="text-center text-xs text-ink-500">
          <Link to="/overview" className="text-brand-700 hover:underline">{tr('نمای آماری من')}</Link>
          {' — '}{tr('شمار وظایف، مهلت‌ها و فرصت‌های فروش، برای کسی که عدد می‌خواهد.')}
        </p>
      </PageBody>
    </>
  );
}

function WorkSection({ title, hint, items, more, onDone }: { title: string; hint?: string; items: WorkItem[]; more: number; onDone: () => void }) {
  if (!items.length) return null;
  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-ink-800">{title}</h2>
        {more > 0 && <Link to="/my-work" className="text-xs text-brand-700 hover:underline">{tr('و {0} مورد دیگر', localDigits(more))}</Link>}
      </div>
      {hint && <p className="mb-2 text-xs text-ink-500">{hint}</p>}
      <div className="grid gap-3 lg:grid-cols-2">{items.map((i) => <WorkCard key={`${i.kind}:${i.entityId}`} item={i} onDone={onDone} />)}</div>
    </section>
  );
}
