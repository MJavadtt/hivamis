import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { stateLabelFa } from '@hiva/contracts';
import { apiGet, downloadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, localDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { Code } from '../../components/common';
import { Button, Card, EmptyState, ErrorBlock, Input, LoadingBlock, ProgressBar, StatTile, Table, Tabs, Td, Th, Tr } from '../../components/ui';
import { JalaliDateInput } from '../../components/JalaliDateInput';
import { tr, trx } from '../../i18n';
import { Completeness, Money, MoneyList, SitesNav, fieldLabel, kindLabel, useSiteOptions } from './shared';

/**
 * Reports on venues, deployment projects and rentals (ADR-103) — «گزارشات متنوع». Every figure is the
 * server's, from the ledger's own rows, in its own currency; each table drills down to the records it
 * counts, and what each money figure means is written under it.
 */

type Row = { key: string; n: number };
interface VenueReport {
  total: number; active: number; byProvince: Row[]; byCity: { province: string; city: string; n: number }[]; byType: Row[]; byGrade: Row[]; byAudience: Row[];
  incomplete: { id: string; code: string; name: string; city: string; completeness: { score: number; missing: string[] } }[]; incompleteCount: number; withoutActiveProject: number;
  utilization: { id: string; code: string; name: string; city: string; projects: number; activeProjects: number; closedProjects: number }[];
}
interface ProjectReport {
  byState: Row[]; groups: { pending: number; active: number; completed: number; cancelled: number }; byCooperation: Row[]; byProvince: Row[]; byCity: Row[];
  awaitingApproval: { id: string; code: string; name: string; version: number; submittedAt: string | null; venue: { name: string } }[];
  upcomingInstallations: { id: string; code: string; name: string; installPlannedAt: string; venue: { name: string } }[];
  delayedInstallations: { id: string; code: string; name: string; installPlannedAt: string; daysLate: number; venue: { name: string } }[];
  expiringContracts: { id: string; code: string; name: string; contractEnd: string; venue: { name: string } }[];
  costs: { currency: string; projects: number; installation: string; transport: string; fabrication: string; counters: number }[];
}
interface Agg { currency: string; kind: string; amount: string; settled: string; open: string }
interface RentalReport {
  definitions: Record<string, string>; obligations: Agg[]; waived: Agg[]; outstanding: Agg[]; overdue: Agg[];
  cashflow: { month: string; currency: string; out: string; in: string; net: string }[];
  paidByVenue: { venueId: string; venue: string; currency: string; paid: string; payments: number }[];
  settlement: { id: string; code: string; name: string; state: string; currency: string; venue: string; outstanding: string; depositRemaining: string; costs: { installation: string; transport: string; fabrication: string; total: string }; settled: boolean }[];
  deposits: { byCurrency: { currency: string; held: string; eligible: string; refunded: string; deducted: string }[] };
}

export default function SiteReportsPage() {
  const { can } = useAuth();
  const tabs = [
    ...(can('venue.read') ? [{ key: 'venues', label: tr('مکان‌ها') }] : []),
    ...(can('site.read') ? [{ key: 'projects', label: tr('پروژه‌ها') }] : []),
    ...(can('rental.read') ? [{ key: 'rentals', label: tr('اجاره و مالی') }] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.key ?? 'venues');
  const [f, setF] = useState({ from: '', to: '', province: '', city: '' });
  const q = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  return (
    <>
      <PageHeader title={tr('گزارش‌های مکان‌ها و اجاره‌داری')} subtitle={tr('هر عدد از ردیف‌های خود دفتر؛ ارزها جدا، هرگز با هم جمع نمی‌شوند')} />
      <PageBody>
        <SitesNav />
        <Card>
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
          <div className="flex flex-wrap items-end gap-2 border-b border-ink-100 p-3">
            <Input value={f.province} onChange={(e) => setF({ ...f, province: e.target.value })} placeholder={tr('استان')} aria-label={tr('استان')} className="w-32" />
            <Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} placeholder={tr('شهر')} aria-label={tr('شهر')} className="w-32" />
            {tab === 'rentals' && <>
              <div className="w-36"><JalaliDateInput value={f.from} onChange={(v) => setF({ ...f, from: v })} label={tr('از')} /></div>
              <div className="w-36"><JalaliDateInput value={f.to} onChange={(v) => setF({ ...f, to: v })} label={tr('تا')} /></div>
              <Button size="sm" onClick={() => void downloadFile(`/site-data/export/deposits?${new URLSearchParams(q)}`, 'deposits.xlsx')}>{tr('خروجی ودیعه‌ها')}</Button>
              <Button size="sm" onClick={() => void downloadFile(`/site-data/export/payments?${new URLSearchParams(q)}`, 'payments.xlsx')}>{tr('خروجی پرداخت‌ها')}</Button>
            </>}
          </div>
          <div className="p-4">
            {tab === 'venues' && <Venues q={q} />}
            {tab === 'projects' && <Projects q={q} />}
            {tab === 'rentals' && <Rentals q={q} />}
          </div>
        </Card>
      </PageBody>
    </>
  );
}

function Bars({ title, rows, label, link }: { title: string; rows: Row[]; label: (k: string) => string; link?: (k: string) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <section>
      <h3 className="mb-2 text-sm font-bold">{title}</h3>
      {!rows.length ? <p className="text-xs text-ink-400">—</p> : (
        <ul className="space-y-1.5">
          {rows.slice(0, 15).map((r) => (
            <li key={r.key} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2 text-xs">
              {link ? <Link to={link(r.key)} className="truncate text-brand-700 hover:underline">{label(r.key)}</Link> : <span className="truncate">{label(r.key)}</span>}
              <ProgressBar value={(r.n / max) * 100} />
              <span className="nums text-end">{localDigits(r.n)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Venues({ q }: { q: Record<string, string> }) {
  const opts = useSiteOptions();
  const { data, isLoading, error, refetch } = useQuery<VenueReport>({ queryKey: ['/site-reports/venues', q], queryFn: () => apiGet('/site-reports/venues', q) });
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('مکان‌ها')} value={localDigits(data.total)} hint={tr('{0} فعال', localDigits(data.active))} />
        <StatTile label={tr('ناقص')} value={localDigits(data.incompleteCount)} tone={data.incompleteCount ? 'warning' : 'success'} />
        <StatTile label={tr('بی‌پروژهٔ فعال')} value={localDigits(data.withoutActiveProject)} />
        <StatTile label={tr('استان‌ها')} value={localDigits(data.byProvince.length)} />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Bars title={tr('به تفکیک استان')} rows={data.byProvince} label={(k) => k} link={(k) => `/sites/venues?province=${encodeURIComponent(k)}`} />
        <Bars title={tr('به تفکیک شهر')} rows={data.byCity.map((c) => ({ key: c.city, n: c.n }))} label={(k) => k} link={(k) => `/sites/venues?city=${encodeURIComponent(k)}`} />
        <Bars title={tr('به تفکیک نوع')} rows={data.byType} label={(k) => opts.label('VENUE_TYPE', k)} link={(k) => `/sites/venues?typeCode=${k}`} />
        <Bars title={tr('به تفکیک گرید')} rows={data.byGrade} label={(k) => (k === 'NONE' ? tr('بدون گرید') : opts.label('VENUE_GRADE', k))} />
        <Bars title={tr('به تفکیک مخاطب')} rows={data.byAudience} label={(k) => opts.label('AUDIENCE', k)} link={(k) => `/sites/venues?audience=${k}`} />
      </div>
      <section>
        <h3 className="mb-2 text-sm font-bold">{tr('مکان‌های ناقص')}</h3>
        {!data.incomplete.length ? <EmptyState title={tr('همهٔ مکان‌ها کامل‌اند')} /> : (
          <Table><thead className="bg-ink-50/60"><tr><Th>{tr('مکان')}</Th><Th>{tr('کامل بودن')}</Th><Th>{tr('کم دارد')}</Th></tr></thead>
            <tbody>{data.incomplete.slice(0, 50).map((v) => (
              <Tr key={v.id}><Td><Link to={`/sites/venues/${v.id}`} className="text-brand-700 hover:underline">{v.name}</Link> <span className="text-xs text-ink-500">{v.city}</span></Td>
                <Td><Completeness score={v.completeness.score} /></Td><Td><span className="text-xs">{v.completeness.missing.map(fieldLabel).join('، ')}</span></Td></Tr>
            ))}</tbody></Table>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-bold">{tr('بهره‌گیری از مکان‌ها')}</h3>
        {!data.utilization.length ? <EmptyState title={tr('هنوز پروژه‌ای ثبت نشده')} /> : (
          <Table><thead className="bg-ink-50/60"><tr><Th>{tr('مکان')}</Th><Th>{tr('پروژه‌ها')}</Th><Th>{tr('فعال')}</Th><Th>{tr('بسته‌شده')}</Th></tr></thead>
            <tbody>{data.utilization.map((v) => (
              <Tr key={v.id}><Td><Link to={`/sites/venues/${v.id}`} className="text-brand-700 hover:underline">{v.name}</Link> <span className="text-xs text-ink-500">{v.city}</span></Td>
                <Td>{localDigits(v.projects)}</Td><Td>{localDigits(v.activeProjects)}</Td><Td>{localDigits(v.closedProjects)}</Td></Tr>
            ))}</tbody></Table>
        )}
      </section>
    </div>
  );
}

function Projects({ q }: { q: Record<string, string> }) {
  const opts = useSiteOptions();
  const { data, isLoading, error, refetch } = useQuery<ProjectReport>({ queryKey: ['/site-reports/projects', q], queryFn: () => apiGet('/site-reports/projects', q) });
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  const list = (title: string, rows: { id: string; code: string; name: string; venue: { name: string } }[], extra: (r: any) => string) => (
    <section>
      <h3 className="mb-2 text-sm font-bold">{title} <span className="text-ink-400">({localDigits(rows.length)})</span></h3>
      {!rows.length ? <p className="text-xs text-ink-400">—</p> : (
        <ul className="divide-y divide-ink-100 rounded-lg ring-1 ring-ink-100">{rows.map((r) => (
          <li key={`${r.id}-${extra(r)}`} className="flex gap-2 px-3 py-1.5 text-sm"><Link to={`/sites/projects/${r.id}`} className="flex-1 text-brand-700 hover:underline">{r.name}</Link><span className="text-xs text-ink-500">{r.venue.name} · {extra(r)}</span></li>
        ))}</ul>
      )}
    </section>
  );
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('در جریان (پیش از بهره‌برداری)')} value={localDigits(data.groups.pending)} />
        <StatTile label={tr('فعال و در تسویه')} value={localDigits(data.groups.active)} tone="success" />
        <StatTile label={tr('بسته‌شده')} value={localDigits(data.groups.completed)} />
        <StatTile label={tr('لغوشده')} value={localDigits(data.groups.cancelled)} />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Bars title={tr('به تفکیک وضعیت')} rows={data.byState} label={(k) => trx(stateLabelFa(k))} link={(k) => `/sites/projects?state=${k}`} />
        <Bars title={tr('به تفکیک مدل همکاری')} rows={data.byCooperation} label={(k) => (k === 'NONE' ? '—' : opts.label('COOPERATION', k))} link={(k) => `/sites/projects?cooperationCode=${k}`} />
        <Bars title={tr('به تفکیک شهر')} rows={data.byCity} label={(k) => k} link={(k) => `/sites/projects?city=${encodeURIComponent(k)}`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {list(tr('قراردادهای منتظر تأیید'), data.awaitingApproval, (r) => tr('نسخهٔ {0}، از {1}', localDigits(r.version), formatDate(r.submittedAt)))}
        {list(tr('نصب‌های پیش رو (۳۰ روز)'), data.upcomingInstallations, (r) => formatDate(r.installPlannedAt))}
        {list(tr('نصب‌های با تأخیر'), data.delayedInstallations, (r) => tr('{0} روز تأخیر', localDigits(r.daysLate)))}
        {list(tr('قراردادهای رو به پایان (۶۰ روز)'), data.expiringContracts, (r) => formatDate(r.contractEnd))}
      </div>
      <section>
        <h3 className="mb-2 text-sm font-bold">{tr('هزینه‌های نصب، حمل و ساخت کانتر')}</h3>
        <Table><thead className="bg-ink-50/60"><tr><Th>{tr('ارز')}</Th><Th>{tr('پروژه‌ها')}</Th><Th>{tr('نصب')}</Th><Th>{tr('حمل و نقل')}</Th><Th>{tr('ساخت کانتر')}</Th><Th>{tr('کانترها')}</Th></tr></thead>
          <tbody>{data.costs.map((c) => (
            <Tr key={c.currency}><Td>{c.currency}</Td><Td>{localDigits(c.projects)}</Td><Td><Money value={c.installation} currency={c.currency} /></Td><Td><Money value={c.transport} currency={c.currency} /></Td><Td><Money value={c.fabrication} currency={c.currency} /></Td><Td>{localDigits(c.counters)}</Td></Tr>
          ))}</tbody></Table>
      </section>
    </div>
  );
}

function Rentals({ q }: { q: Record<string, string> }) {
  const { data, isLoading, error, refetch } = useQuery<RentalReport>({ queryKey: ['/site-reports/rentals', q], queryFn: () => apiGet('/site-reports/rentals', q) });
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  const kinds = [...new Set(data.obligations.map((o) => `${o.currency}|${o.kind}`))];
  const find = (rows: Agg[], k: string) => rows.find((r) => `${r.currency}|${r.kind}` === k);
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-bold">{tr('تعهدات، پرداخت‌ها و مانده به تفکیک نوع')}</h3>
        {!kinds.length ? <EmptyState title={tr('در این بازه تعهدی نیست')} /> : (
          <Table><thead className="bg-ink-50/60"><tr><Th>{tr('نوع')}</Th><Th>{tr('سررسیدشده در بازه')}</Th><Th>{tr('تسویه‌شده')}</Th><Th>{tr('بخشوده')}</Th><Th>{tr('مانده')}</Th><Th>{tr('سررسیدگذشته')}</Th></tr></thead>
            <tbody>{kinds.map((k) => {
              const [currency] = k.split('|') as [string];
              const a = find(data.obligations, k)!;
              return (
                <Tr key={k}><Td>{kindLabel(a.kind)} <span className="text-xs text-ink-500">{currency}</span></Td><Td><Money value={a.amount} currency={currency} /></Td><Td><Money value={a.settled} currency={currency} /></Td>
                  <Td><Money value={find(data.waived, k)?.open ?? '0'} currency={currency} tone="muted" /></Td><Td><Money value={find(data.outstanding, k)?.open ?? '0'} currency={currency} /></Td>
                  <Td><Money value={find(data.overdue, k)?.open ?? '0'} currency={currency} tone={Number(find(data.overdue, k)?.open ?? 0) > 0 ? 'danger' : undefined} /></Td></Tr>
              );
            })}</tbody></Table>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-bold">{tr('ودیعه‌ها')}</h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label={tr('نزد مکان‌ها')} value={<MoneyList rows={data.deposits.byCurrency.map((d) => ({ currency: d.currency, amount: d.held }))} />} />
          <StatTile label={tr('آمادهٔ عودت')} value={<MoneyList rows={data.deposits.byCurrency.map((d) => ({ currency: d.currency, amount: d.eligible }))} />} tone="warning" />
          <StatTile label={tr('عودت‌شده')} value={<MoneyList rows={data.deposits.byCurrency.map((d) => ({ currency: d.currency, amount: d.refunded }))} />} tone="success" />
          <StatTile label={tr('کسرشده')} value={<MoneyList rows={data.deposits.byCurrency.map((d) => ({ currency: d.currency, amount: d.deducted }))} />} />
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-bold">{tr('جریان نقدی به تفکیک ماه')}</h3>
        {!data.cashflow.length ? <EmptyState title={tr('پرداختی در این بازه نیست')} /> : (
          <Table><thead className="bg-ink-50/60"><tr><Th>{tr('ماه')}</Th><Th>{tr('پرداخت به مکان‌ها')}</Th><Th>{tr('دریافت از مکان‌ها')}</Th><Th>{tr('خالص خروجی')}</Th></tr></thead>
            <tbody>{data.cashflow.map((m) => <Tr key={`${m.month}${m.currency}`}><Td><span className="nums">{localDigits(m.month.replace('-', '/'))}</span></Td><Td><Money value={m.out} currency={m.currency} /></Td><Td><Money value={m.in} currency={m.currency} /></Td><Td><Money value={m.net} currency={m.currency} /></Td></Tr>)}</tbody></Table>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-bold">{tr('پرداخت به تفکیک مکان')}</h3>
        <Table><thead className="bg-ink-50/60"><tr><Th>{tr('مکان')}</Th><Th>{tr('پرداخت‌ها')}</Th><Th>{tr('جمع')}</Th></tr></thead>
          <tbody>{data.paidByVenue.slice(0, 50).map((v) => <Tr key={`${v.venueId}${v.currency}`}><Td><Link to={`/sites/venues/${v.venueId}`} className="text-brand-700 hover:underline">{v.venue}</Link></Td><Td>{localDigits(v.payments)}</Td><Td><Money value={v.paid} currency={v.currency} /></Td></Tr>)}</tbody></Table>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-bold">{tr('وضعیت تسویه و هزینهٔ هر پروژه')}</h3>
        <Table><thead className="bg-ink-50/60"><tr><Th>{tr('پروژه')}</Th><Th>{tr('مانده')}</Th><Th>{tr('ودیعهٔ نزد مکان')}</Th><Th>{tr('هزینه (نصب + حمل + ساخت)')}</Th><Th>{tr('تسویه')}</Th></tr></thead>
          <tbody>{data.settlement.map((p) => (
            <Tr key={p.id}><Td><Link to={`/sites/projects/${p.id}?tab=finance`} className="text-brand-700 hover:underline">{p.name}</Link> <Code>{p.code}</Code><span className="block text-xs text-ink-500">{p.venue} · {trx(stateLabelFa(p.state))}</span></Td>
              <Td><Money value={p.outstanding} currency={p.currency} /></Td><Td><Money value={p.depositRemaining} currency={p.currency} /></Td>
              <Td><Money value={p.costs.total} currency={p.currency} /></Td>
              <Td>{p.settled ? <span className="text-emerald-700">{tr('تسویه')}</span> : <span className="text-amber-700">{tr('باز')}</span>}</Td></Tr>
          ))}</tbody></Table>
      </section>
      <section className="rounded-lg bg-ink-50/60 p-3 text-xs text-ink-600">
        <h3 className="mb-1 font-bold">{tr('تعریف‌ها')}</h3>
        <dl className="space-y-1">{Object.entries(data.definitions).map(([k, v]) => <div key={k}><dt className="inline font-semibold">{k}: </dt><dd className="inline">{trx(v)}</dd></div>)}</dl>
      </section>
    </div>
  );
}
