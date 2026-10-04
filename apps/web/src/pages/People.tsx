import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ROLE_LABELS, type RoleCode } from '@hiva/contracts';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, localDigits } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBlock, Input, LoadingBlock, StateBadge } from '../components/ui';
import { Code } from '../components/common';
import { PageBody, PageHeader } from '../components/Shell';
import { Avatar } from '../components/Avatar';
import { UnitTag } from '../components/UnitTag';
import { pair, tr, trx } from '../i18n';

/**
 * Colleagues, and a page for each (Hivamis task 4): who someone is, how to reach them, and — where
 * the reader may see it — what they are working on.
 */

interface Unit { code: string; nameFa: string; nameEn: string; color: string }
interface PersonRow { id: string; fullName: string; jobTitle: string | null; email: string; department: Unit | null }
interface Person extends PersonRow {
  isActive: boolean; joinedAt: string; roles: string[]; self: boolean;
  private: { phone: string | null; phoneVerified: boolean; lastLoginAt: string | null } | null;
  work: {
    openTasks: number | null; overdueTasks: number | null;
    tasks: { id: string; code: string; title: string; state: string; dueDate: string | null }[] | null;
    projects: { id: string; code: string; name: string; state: string }[] | null;
  };
}

/** Off to Google to link an account; it sends the browser back to /me. */
export async function goToGoogleLink(): Promise<void> {
  const { url } = await apiPost<{ url: string }>('/me/google/link');
  window.location.assign(url);
}

/** A name that opens the person's page. */
export function PersonLink({ id, name, className }: { id: string | null | undefined; name: string; className?: string }) {
  if (!id) return <span className={className}>{name}</span>;
  return <Link to={`/people/${id}`} className={className ?? 'hover:text-brand-700 hover:underline'}>{name}</Link>;
}

export function PeopleDirectory() {
  const [q, setQ] = useState('');
  const { data, isLoading, error, refetch } = useQuery<PersonRow[]>({ queryKey: ['/people', q], queryFn: () => apiGet('/people', { q: q || undefined }) });
  return (
    <>
      <PageHeader title={tr('همکاران')} subtitle={tr('همهٔ همکاران سازمان؛ برای دیدن صفحهٔ هرکس روی نامش بزنید')} />
      <PageBody>
        <div className="mb-4 max-w-sm"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('جستجوی نام، سمت یا ایمیل…')} aria-label={tr('جستجوی همکار')} /></div>
        {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : !data?.length ? <EmptyState title={tr('کسی پیدا نشد')} /> : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="people">
            {data.map((p) => (
              <li key={p.id}>
                <Link to={`/people/${p.id}`} className="flex items-center gap-3 rounded-xl bg-surface p-3 ring-1 ring-ink-200 transition hover:ring-brand-300">
                  <Avatar name={p.fullName} unit={p.department?.code} color={p.department?.color} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{p.fullName}</p>
                    <p className="truncate text-xs text-ink-500">{trx(p.jobTitle) || '—'}</p>
                  </div>
                  {p.department && <UnitTag code={p.department.code} />}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  );
}

export function PersonPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { data: p, isLoading, error, refetch } = useQuery<Person>({ queryKey: ['/people', id], queryFn: () => apiGet(`/people/${id}`) });
  if (isLoading) return <LoadingBlock />;
  if (error || !p) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  return (
    <>
      <PageHeader title={p.fullName} subtitle={trx(p.jobTitle) || undefined}
        actions={p.self ? <Link to="/me" className="text-sm text-brand-700 underline">{tr('روش‌های ورود و دستگاه‌ها')}</Link> : undefined} />
      <PageBody>
        <div className="grid gap-5 lg:grid-cols-[20rem_1fr]" data-testid="person">
          <Card>
            <div className="flex flex-col items-center gap-2 p-5 text-center">
              <Avatar name={p.fullName} unit={p.department?.code} color={p.department?.color} size="lg" />
              <p className="text-base font-semibold text-ink-900">{p.fullName}</p>
              {p.department && <UnitTag code={p.department.code} />}
              <div className="flex flex-wrap justify-center gap-1">
                {p.roles.map((r) => <Badge key={r} tone="neutral">{pair(ROLE_LABELS[r as RoleCode]) || r}</Badge>)}
              </div>
              {!p.isActive && <Badge tone="danger">{tr('غیرفعال')}</Badge>}
            </div>
            <dl className="divide-y divide-ink-100 border-t border-ink-100 text-sm">
              <div className="flex justify-between gap-3 px-4 py-2.5"><dt className="text-ink-500">{tr('ایمیل')}</dt><dd><a href={`mailto:${p.email}`} className="ltr text-brand-700 hover:underline">{p.email}</a></dd></div>
              {p.private && (
                <>
                  <div className="flex justify-between gap-3 px-4 py-2.5"><dt className="text-ink-500">{tr('شمارهٔ همراه')}</dt><dd className="ltr">{p.private.phone ?? '—'}{p.private.phoneVerified && <Badge tone="success" className="ms-1">{tr('تأییدشده')}</Badge>}</dd></div>
                  <div className="flex justify-between gap-3 px-4 py-2.5"><dt className="text-ink-500">{tr('آخرین ورود')}</dt><dd>{p.private.lastLoginAt ? formatDateTime(p.private.lastLoginAt) : '—'}</dd></div>
                </>
              )}
              <div className="flex justify-between gap-3 px-4 py-2.5"><dt className="text-ink-500">{tr('عضو از')}</dt><dd>{formatDate(p.joinedAt)}</dd></div>
            </dl>
          </Card>

          <div className="space-y-5">
            {p.work.openTasks !== null && (
              <Card title={tr('کارهای باز')} subtitle={tr('{0} وظیفهٔ باز · {1} گذشته از مهلت', localDigits(p.work.openTasks), localDigits(p.work.overdueTasks ?? 0))}>
                {!p.work.tasks?.length ? <EmptyState title={tr('وظیفهٔ بازی ندارد')} /> : (
                  <ul className="divide-y divide-ink-100">
                    {p.work.tasks.map((t) => (
                      <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                        <Code>{t.code}</Code>
                        {can('task.read') ? <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1 truncate hover:text-brand-700 hover:underline">{t.title}</Link> : <span className="min-w-0 flex-1 truncate">{t.title}</span>}
                        {t.dueDate && <span className="text-xs text-ink-500">{formatDate(t.dueDate)}</span>}
                        <StateBadge state={t.state} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
            {p.work.projects !== null && (
              <Card title={tr('پروژه‌ها')}>
                {!p.work.projects.length ? <EmptyState title={tr('در پروژه‌ای تخصیص ندارد')} /> : (
                  <ul className="divide-y divide-ink-100">
                    {p.work.projects.map((pr) => (
                      <li key={pr.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                        <Code>{pr.code}</Code>
                        <Link to={`/projects/${pr.id}`} className="min-w-0 flex-1 truncate hover:text-brand-700 hover:underline">{pr.name}</Link>
                        <StateBadge state={pr.state} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}
