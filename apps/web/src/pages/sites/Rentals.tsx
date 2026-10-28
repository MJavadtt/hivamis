import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { OBLIGATION_KINDS } from '@hiva/contracts';
import { apiGet, downloadFile, type Page } from '../../lib/api';
import {
  formatDate, isoToJalaliParts, jalaliDaysInMonth, jalaliFirstWeekday, jalaliPartsToValue, localDigits, todayJalaliParts, weekdayShort,
} from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { Code } from '../../components/common';
import { Button, Card, EmptyState, ErrorBlock, Input, LoadingBlock, Pagination, StatTile, Table, Tabs, Td, Th, Tr, cx } from '../../components/ui';
import { JalaliDateInput } from '../../components/JalaliDateInput';
import { isEnglish, tr } from '../../i18n';
import { Money, MoneyList, ObligationStatus, SitesNav, kindLabel } from './shared';
import { FilterSelect, SavedViews } from './Venues';
import { PeopleSelect } from './pickers';
import { period } from './Ledger';

/**
 * Rentals (ADR-103, module C) — «اجاره‌داری، جدول اجاره‌داری»: what is owed across every venue — the
 * week's dues, what is overdue, the deposits out — as a register to filter and export and as a
 * calendar of the Persian month.
 */

interface Item {
  id: string; kind: string; dueDate: string; amount: string; settledAmount: string; outstanding: string; overdue: boolean; status: string; currency: string;
  description: string | null; periodStart: string | null; periodEnd: string | null;
  siteProject: { id: string; code: string; name: string; responsible?: { fullName: string } | null; venue: { id?: string; name: string; city: string } };
}
type Sum = { currency: string; amount: string };
interface Dashboard {
  outstanding: Sum[]; overdue: Sum[]; next30: Sum[];
  counts: { overdue: number; dueThisWeek: number; pendingContracts: number; pendingDeductions: number; settling: number; active: number; failedReminders: number };
  deposits: { currency: string; held: string; eligible: string; refunded: string }[];
  upcoming: Item[]; overdueItems: Item[];
}

export default function RentalsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';
  return (
    <>
      <PageHeader title={tr('اجاره‌داری')} subtitle={tr('اجاره، شارژ، ودیعه و جریمه‌های همهٔ مکان‌ها — سررسیدها، معوق‌ها و پرداخت‌ها')} />
      <PageBody>
        <SitesNav />
        <Card>
          <Tabs active={tab} onChange={(t) => setParams(new URLSearchParams({ tab: t }), { replace: true })} tabs={[
            { key: 'overview', label: tr('نمای کلی') }, { key: 'register', label: tr('جدول اجاره‌داری') }, { key: 'calendar', label: tr('تقویم سررسیدها') },
          ]} />
          <div className="p-4">
            {tab === 'overview' && <Overview />}
            {tab === 'register' && <Register />}
            {tab === 'calendar' && <Calendar />}
          </div>
        </Card>
      </PageBody>
    </>
  );
}

function Overview() {
  const { data, isLoading, error, refetch } = useQuery<Dashboard>({ queryKey: ['/rentals/dashboard'], queryFn: () => apiGet('/rentals/dashboard') });
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('مانده')} value={<MoneyList rows={data.outstanding} empty={tr('هیچ')} />} />
        <StatTile label={tr('سررسیدگذشته')} value={<MoneyList rows={data.overdue} empty={tr('هیچ')} />} hint={tr('{0} قلم', localDigits(data.counts.overdue))} tone={data.counts.overdue ? 'danger' : 'success'} />
        <StatTile label={tr('۳۰ روز آینده')} value={<MoneyList rows={data.next30} empty={tr('هیچ')} />} hint={tr('{0} قلم در همین هفته', localDigits(data.counts.dueThisWeek))} tone={data.counts.dueThisWeek ? 'warning' : 'neutral'} />
        <StatTile label={tr('ودیعهٔ نزد مکان‌ها')} value={<MoneyList rows={data.deposits.map((d) => ({ currency: d.currency, amount: d.held }))} empty={tr('هیچ')} />} hint={data.deposits.some((d) => Number(d.eligible) > 0) ? tr('بخشی آمادهٔ عودت') : undefined} />
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Link to="/sites/projects?state=ACTIVE" className="rounded-full bg-surface px-3 py-1 ring-1 ring-edge">{tr('{0} پروژهٔ فعال', localDigits(data.counts.active))}</Link>
        <Link to="/sites/projects?state=CONTRACT_PENDING" className={cx('rounded-full px-3 py-1 ring-1', data.counts.pendingContracts ? 'bg-amber-50 ring-amber-200' : 'bg-surface ring-edge')}>{tr('{0} قرارداد منتظر تأیید', localDigits(data.counts.pendingContracts))}</Link>
        <span className={cx('rounded-full px-3 py-1 ring-1', data.counts.pendingDeductions ? 'bg-amber-50 ring-amber-200' : 'bg-surface ring-edge')}>{tr('{0} کسر از ودیعه منتظر تصمیم', localDigits(data.counts.pendingDeductions))}</span>
        <Link to="/sites/projects?state=SETTLING" className="rounded-full bg-surface px-3 py-1 ring-1 ring-edge">{tr('{0} پروژه در تسویه', localDigits(data.counts.settling))}</Link>
        {data.counts.failedReminders > 0 && <Link to="/sites/reminders" className="rounded-full bg-rose-50 px-3 py-1 ring-1 ring-rose-200">{tr('{0} یادآوری ناموفق', localDigits(data.counts.failedReminders))}</Link>}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <ItemList title={tr('معوق‌ها')} items={data.overdueItems} empty={tr('چیزی معوق نیست')} />
        <ItemList title={tr('سررسیدهای پیش رو')} items={data.upcoming} empty={tr('در ۳۰ روز آینده سررسیدی نیست')} />
      </div>
    </div>
  );
}

function ItemList({ title, items, empty }: { title: string; items: Item[]; empty: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-bold">{title}</h3>
      {!items.length ? <EmptyState title={empty} /> : (
        <ul className="divide-y divide-ink-100 rounded-lg ring-1 ring-ink-100">
          {items.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <Link to={`/sites/projects/${o.siteProject.id}?tab=finance`} className="min-w-0 flex-1 hover:underline">
                <span className="font-medium">{kindLabel(o.kind)}</span> · {o.siteProject.name} <span className="text-xs text-ink-500">({o.siteProject.venue.name})</span>
              </Link>
              <span className={cx('text-xs', o.overdue && 'font-semibold text-rose-700')}>{formatDate(o.dueDate)}</span>
              <Money value={o.outstanding} currency={o.currency} tone={o.overdue ? 'danger' : undefined} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const REGISTER_KEYS = ['q', 'status', 'kind', 'city', 'province', 'responsibleId', 'from', 'to', 'page'] as const;

function Register() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const f = Object.fromEntries(REGISTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof REGISTER_KEYS)[number], string>;
  const set = (patch: Partial<typeof f>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  const query = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), status: f.status || 'open', pageSize: '50' };
  const { data, isLoading, error, refetch } = useQuery<Page<Item> & { totals: { currency: string; amount: string; settled: string; outstanding: string }[] }>({ queryKey: ['/site-obligations', query], queryFn: () => apiGet('/site-obligations', query) });
  const exportQuery = new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([k]) => !['page', 'pageSize'].includes(k))));
  return (
    <div className="space-y-3">
      <SavedViews page="rentals" current={{ ...f, tab: 'register' }} onApply={(filters) => setParams(new URLSearchParams({ ...filters, tab: 'register' }), { replace: true })} />
      <div className="flex flex-wrap items-center gap-2">
        <Input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder={tr('پروژه یا مکان…')} aria-label={tr('جستجو')} className="w-48" />
        <FilterSelect label={tr('وضعیت')} value={f.status} onChange={(v) => set({ status: v })} all={tr('باز')} options={[{ value: 'overdue', label: tr('سررسیدگذشته') }, { value: 'settled', label: tr('تسویه‌شده') }, { value: 'all', label: tr('همه') }]} />
        <FilterSelect label={tr('نوع')} value={f.kind} onChange={(v) => set({ kind: v })} options={OBLIGATION_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} />
        <Input value={f.city} onChange={(e) => set({ city: e.target.value })} placeholder={tr('شهر')} aria-label={tr('شهر')} className="w-28" />
        <div className="w-44"><PeopleSelect label={tr('مسئول')} value={f.responsibleId || null} onChange={(v) => set({ responsibleId: v ?? '' })} empty={tr('هر مسئول')} /></div>
        <div className="w-36"><JalaliDateInput value={f.from} onChange={(v) => set({ from: v })} label={tr('سررسید از')} /></div>
        <div className="w-36"><JalaliDateInput value={f.to} onChange={(v) => set({ to: v })} label={tr('سررسید تا')} /></div>
        <Button size="sm" onClick={() => void downloadFile(`/site-data/export/obligations?${exportQuery}`, 'rentals.xlsx')}>{tr('خروجی اکسل')}</Button>
      </div>
      {data?.totals.length ? (
        <p className="flex flex-wrap gap-4 text-sm">{data.totals.map((t) => (
          <span key={t.currency}>{tr('جمع:')} <Money value={t.amount} currency={t.currency} /> · {tr('تسویه:')} <Money value={t.settled} currency={t.currency} /> · {tr('مانده:')} <Money value={t.outstanding} currency={t.currency} tone="danger" /></span>
        ))}</p>
      ) : null}
      {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : !data?.items.length ? <EmptyState title={tr('قلمی با این فیلترها نیست')} /> : (
        <>
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('سررسید')}</Th><Th>{tr('قلم')}</Th><Th>{tr('پروژه / مکان')}</Th><Th>{tr('مسئول')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('مانده')}</Th><Th>{tr('وضعیت')}</Th></tr></thead>
            <tbody>{data.items.map((o) => (
              <Tr key={o.id} onClick={() => navigate(`/sites/projects/${o.siteProject.id}?tab=finance`)} className={o.overdue ? 'bg-rose-50/40' : undefined}>
                <Td><span className={cx('text-xs', o.overdue && 'font-semibold text-rose-700')}>{formatDate(o.dueDate)}</span></Td>
                <Td>{kindLabel(o.kind)}<span className="block text-xs text-ink-500">{o.description ?? period(o)}</span></Td>
                <Td><span className="text-sm">{o.siteProject.name}</span> <Code>{o.siteProject.code}</Code><span className="block text-xs text-ink-500">{o.siteProject.venue.name} · {o.siteProject.venue.city}</span></Td>
                <Td><span className="text-xs">{o.siteProject.responsible?.fullName ?? '—'}</span></Td>
                <Td><Money value={o.amount} currency={o.currency} /></Td>
                <Td><Money value={o.outstanding} currency={o.currency} tone={o.overdue ? 'danger' : undefined} /></Td>
                <Td><ObligationStatus status={o.status} overdue={o.overdue} /></Td>
              </Tr>
            ))}</tbody>
          </Table>
          <Pagination page={data.page} pageCount={data.pageCount} total={data.total} onChange={(pg) => set({ page: String(pg) })} />
        </>
      )}
    </div>
  );
}

function Calendar() {
  const today = todayJalaliParts();
  const [ym, setYm] = useState({ jy: today.jy, jm: today.jm });
  const move = (d: number) => setYm(({ jy, jm }) => { let m = jm + d, y = jy; if (m > 12) { m = 1; y++; } if (m < 1) { m = 12; y--; } return { jy: y, jm: m }; });
  const days = jalaliDaysInMonth(ym.jy, ym.jm);
  const from = jalaliPartsToValue({ jy: ym.jy, jm: ym.jm, jd: 1, hh: 0, mm: 0 }, 'date');
  const next = ym.jm === 12 ? { jy: ym.jy + 1, jm: 1 } : { jy: ym.jy, jm: ym.jm + 1 };
  const to = jalaliPartsToValue({ ...next, jd: 1, hh: 0, mm: 0 }, 'date');
  const { data, isLoading, error, refetch } = useQuery<{ items: Item[]; contractEnds: { id: string; code: string; name: string; contractEnd: string; venue: { name: string } }[] }>({
    queryKey: ['/site-obligations/calendar', from], queryFn: () => apiGet('/site-obligations/calendar', { from, to }),
  });
  const onDay = (iso: string, d: number) => { const p = isoToJalaliParts(iso); return p?.jy === ym.jy && p.jm === ym.jm && p.jd === d; };
  const lead = jalaliFirstWeekday(ym.jy, ym.jm);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => move(-1)} aria-label={tr('ماه پیش')}>‹</Button>
        <h3 className="min-w-32 text-center text-sm font-bold">{new Intl.DateTimeFormat(isEnglish() ? 'en-u-ca-persian' : 'fa-IR-u-ca-persian', { month: 'long', year: 'numeric' }).format(new Date(`${from}T12:00:00`))}</h3>
        <Button size="sm" variant="ghost" onClick={() => move(1)} aria-label={tr('ماه بعد')}>›</Button>
        <Button size="sm" variant="ghost" onClick={() => setYm({ jy: today.jy, jm: today.jm })}>{tr('امروز')}</Button>
      </div>
      {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : (
        <div className="grid grid-cols-7 gap-1 text-xs" role="grid" aria-label={tr('تقویم سررسیدها')}>
          {Array.from({ length: 7 }, (_, i) => <div key={i} className="py-1 text-center font-bold text-ink-500">{weekdayShort(i)}</div>)}
          {Array.from({ length: lead }, (_, i) => <div key={`x${i}`} />)}
          {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
            const items = data?.items.filter((o) => onDay(o.dueDate, d)) ?? [];
            const ends = data?.contractEnds.filter((c) => onDay(c.contractEnd, d)) ?? [];
            const isToday = ym.jy === today.jy && ym.jm === today.jm && d === today.jd;
            return (
              <div key={d} className={cx('min-h-20 rounded-lg p-1 ring-1', isToday ? 'ring-2 ring-brand-500' : 'ring-ink-100')}>
                <div className="nums mb-0.5 font-semibold text-ink-600">{localDigits(d)}</div>
                {items.slice(0, 4).map((o) => (
                  <Link key={o.id} to={`/sites/projects/${o.siteProject.id}?tab=finance`} title={`${kindLabel(o.kind)} — ${o.siteProject.name}`}
                    className={cx('mb-0.5 block truncate rounded px-1', o.status === 'SETTLED' ? 'bg-emerald-50 text-emerald-800' : o.overdue ? 'bg-rose-100 text-rose-800' : 'bg-amber-50 text-amber-900')}>
                    {kindLabel(o.kind)} · {o.siteProject.venue.name}
                  </Link>
                ))}
                {items.length > 4 && <span className="text-ink-500">{tr('و {0} مورد دیگر', localDigits(items.length - 4))}</span>}
                {ends.map((c) => <Link key={c.id} to={`/sites/projects/${c.id}`} className="block truncate rounded bg-ink-100 px-1 text-ink-700">{tr('پایان قرارداد')} · {c.venue.name}</Link>)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
