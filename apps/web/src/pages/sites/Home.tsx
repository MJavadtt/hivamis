import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, localDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { Button, Card, EmptyState, StatTile } from '../../components/ui';
import { tr } from '../../i18n';
import { Money, MoneyList, SitesNav, kindLabel } from './shared';

/**
 * The venues module's home (ADR-103): what needs someone today — what is overdue, due this week, waiting
 * for an approval — and where the venues and projects stand, each figure a link to its records.
 */

interface Dashboard {
  outstanding: { currency: string; amount: string }[]; overdue: { currency: string; amount: string }[];
  counts: { overdue: number; dueThisWeek: number; pendingContracts: number; pendingDeductions: number; settling: number; active: number; failedReminders: number };
  upcoming: { id: string; kind: string; dueDate: string; outstanding: string; currency: string; siteProject: { id: string; name: string; venue: { name: string } } }[];
  overdueItems: { id: string; kind: string; dueDate: string; outstanding: string; currency: string; siteProject: { id: string; name: string; venue: { name: string } } }[];
}

export default function SitesHome() {
  const { can } = useAuth();
  const rentals = useQuery<Dashboard>({ queryKey: ['/rentals/dashboard'], queryFn: () => apiGet('/rentals/dashboard'), enabled: can('rental.read') });
  const venues = useQuery<{ total: number; active: number; incompleteCount: number; withoutActiveProject: number }>({ queryKey: ['/site-reports/venues', {}], queryFn: () => apiGet('/site-reports/venues'), enabled: can('venue.read') });
  const projects = useQuery<{ groups: { pending: number; active: number; completed: number; cancelled: number }; awaitingApproval: unknown[]; delayedInstallations: unknown[]; expiringContracts: unknown[] }>({
    queryKey: ['/site-reports/projects', {}], queryFn: () => apiGet('/site-reports/projects'), enabled: can('site.read'),
  });
  const d = rentals.data;
  return (
    <>
      <PageHeader title={tr('مکان‌ها و اجاره‌داری')} subtitle={tr('بانک مکان‌ها، پروژه‌های استقرار و اجاره‌داری — آنچه امروز کار دارد')}
        actions={<div className="flex gap-2">
          {can('venue.write') && <Link to="/sites/venues"><Button size="sm">{tr('مکان تازه')}</Button></Link>}
          {can('site.write') && <Link to="/sites/projects?new=1"><Button size="sm" variant="primary">{tr('پروژهٔ تازه')}</Button></Link>}
        </div>} />
      <PageBody>
        <SitesNav />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {venues.data && <Link to="/sites/venues"><StatTile label={tr('مکان‌ها')} value={localDigits(venues.data.total)} hint={tr('{0} ناقص · {1} بی‌پروژهٔ فعال', localDigits(venues.data.incompleteCount), localDigits(venues.data.withoutActiveProject))} /></Link>}
          {projects.data && <Link to="/sites/projects?open=true"><StatTile label={tr('پروژه‌های جاری')} value={localDigits(projects.data.groups.pending + projects.data.groups.active)} hint={tr('{0} در بهره‌برداری و تسویه', localDigits(projects.data.groups.active))} tone="success" /></Link>}
          {d && <Link to="/sites/rentals?tab=register&status=overdue"><StatTile label={tr('سررسیدگذشته')} value={<MoneyList rows={d.overdue} empty={tr('هیچ')} />} hint={tr('{0} قلم', localDigits(d.counts.overdue))} tone={d.counts.overdue ? 'danger' : 'success'} /></Link>}
          {d && <Link to="/sites/rentals"><StatTile label={tr('سررسید همین هفته')} value={localDigits(d.counts.dueThisWeek)} hint={<MoneyList rows={d.outstanding} empty={tr('بی‌مانده')} />} tone={d.counts.dueThisWeek ? 'warning' : 'neutral'} /></Link>}
        </div>

        {projects.data && (
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            {projects.data.awaitingApproval.length > 0 && <Link to="/sites/projects?state=CONTRACT_PENDING" className="rounded-full bg-amber-50 px-3 py-1 ring-1 ring-amber-200">{tr('{0} قرارداد منتظر تأیید', localDigits(projects.data.awaitingApproval.length))}</Link>}
            {projects.data.delayedInstallations.length > 0 && <Link to="/sites/reports" className="rounded-full bg-rose-50 px-3 py-1 ring-1 ring-rose-200">{tr('{0} نصب با تأخیر', localDigits(projects.data.delayedInstallations.length))}</Link>}
            {projects.data.expiringContracts.length > 0 && <Link to="/sites/reports" className="rounded-full bg-surface px-3 py-1 ring-1 ring-edge">{tr('{0} قرارداد رو به پایان', localDigits(projects.data.expiringContracts.length))}</Link>}
            {d && d.counts.pendingDeductions > 0 && <span className="rounded-full bg-amber-50 px-3 py-1 ring-1 ring-amber-200">{tr('{0} کسر از ودیعه منتظر تصمیم', localDigits(d.counts.pendingDeductions))}</span>}
            {d && d.counts.failedReminders > 0 && <Link to="/sites/reminders" className="rounded-full bg-rose-50 px-3 py-1 ring-1 ring-rose-200">{tr('{0} یادآوری ناموفق', localDigits(d.counts.failedReminders))}</Link>}
          </div>
        )}

        {d && (
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card title={tr('معوق‌ها')}>
              {!d.overdueItems.length ? <EmptyState title={tr('چیزی معوق نیست')} /> : (
                <ul className="divide-y divide-ink-100">{d.overdueItems.map((o) => (
                  <li key={o.id} className="flex items-center gap-2 px-5 py-2 text-sm"><Link to={`/sites/projects/${o.siteProject.id}?tab=finance`} className="flex-1 hover:underline">{kindLabel(o.kind)} · {o.siteProject.name} <span className="text-xs text-ink-500">({o.siteProject.venue.name})</span></Link><span className="text-xs text-rose-700">{formatDate(o.dueDate)}</span><Money value={o.outstanding} currency={o.currency} tone="danger" /></li>
                ))}</ul>
              )}
            </Card>
            <Card title={tr('سررسیدهای پیش رو')}>
              {!d.upcoming.length ? <EmptyState title={tr('در ۳۰ روز آینده سررسیدی نیست')} /> : (
                <ul className="divide-y divide-ink-100">{d.upcoming.map((o) => (
                  <li key={o.id} className="flex items-center gap-2 px-5 py-2 text-sm"><Link to={`/sites/projects/${o.siteProject.id}?tab=finance`} className="flex-1 hover:underline">{kindLabel(o.kind)} · {o.siteProject.name} <span className="text-xs text-ink-500">({o.siteProject.venue.name})</span></Link><span className="text-xs">{formatDate(o.dueDate)}</span><Money value={o.outstanding} currency={o.currency} /></li>
                ))}</ul>
              )}
            </Card>
          </div>
        )}
      </PageBody>
    </>
  );
}
