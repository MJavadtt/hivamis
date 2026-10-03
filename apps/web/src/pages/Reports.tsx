import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { Code } from '../components/common';
import { PdfButton } from '../components/PdfButton';
import {
  Badge, Card, EmptyState, ErrorBlock, LoadingBlock, ProgressBar, StateBadge,
  StatTile, Table, Tabs, Td, Th, Tr,
} from '../components/ui';
import { formatCurrency, formatPercent, localDigits, formatDate } from '../lib/format';
import { ProcessMap } from '../components/ProcessMap';
import { BreachRisk } from '../components/BreachRisk';
import { AskReports } from '../components/AskReports';
import { RevenueReport } from '../components/Revenue';
import { MediaReport } from '../components/Media';
import { loc, tr, trx } from '../i18n';

const CHART_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export default function Reports() {
  const { can } = useAuth();
  const [tab, setTab] = useState(can('report.executive') ? 'executive' : 'sales');

  const tabs = [
    ...(can('report.executive') ? [{ key: 'executive', label: tr('برج کنترل مدیریتی') }] : []),
    { key: 'ask', label: tr('پرسش از داده‌ها') },
    { key: 'sales', label: tr('قیف فروش') },
    { key: 'units', label: tr('عملکرد واحدها') },
    { key: 'sla', label: tr('پایبندی به SLA') },
    { key: 'quality', label: tr('کیفیت داده') },
    // Each tab only for who may read what it shows (Hivamis task 6).
    ...(can('report.executive') ? [{ key: 'mining', label: tr('کشف فرآیند') }] : []),
    ...(can('pricing.read') ? [{ key: 'cost', label: tr('دقت برآورد') }] : []),
    ...(can('finance.read') ? [{ key: 'revenue', label: tr('درآمد و کار در جریان') }] : []),
    ...(can('pricing.read') ? [{ key: 'media', label: tr('رسانه') }] : []),
  ];

  return (
    <>
      <PageHeader
        title={tr('گزارش‌ها')}
        subtitle={tr('تمام اعداد از داده‌های زنده سیستم محاسبه می‌شوند')}
        actions={tab === 'executive' ? <PdfButton kind="executive-report" id="all" label={tr('خروجی PDF گزارش')} /> : undefined}
      />
      <div className="border-b border-ink-200 bg-surface px-2">
        <Tabs tabs={tabs} active={tab} onChange={setTab} />
      </div>
      <PageBody>
        {tab === 'executive' && <Executive />}
        {tab === 'ask' && <AskReports />}
        {tab === 'sales' && <SalesReport />}
        {tab === 'units' && <UnitsReport />}
        {tab === 'sla' && <SlaReport />}
        {tab === 'quality' && <DataQuality />}
        {tab === 'mining' && <ProcessMap />}
        {tab === 'cost' && <CostAccuracy />}
        {tab === 'revenue' && <RevenueReport />}
        {tab === 'media' && <MediaReport />}
      </PageBody>
    </>
  );
}

function Executive() {
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ['/reports/executive'], queryFn: () => apiGet('/reports/executive'),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const healthData = [
    { name: tr('سالم'), value: data.projects.green, color: '#10b981' },
    { name: tr('نیازمند توجه'), value: data.projects.amber, color: '#f59e0b' },
    { name: tr('بحرانی'), value: data.projects.red, color: '#ef4444' },
  ].filter((d) => d.value > 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('پروژه‌های فعال')} value={localDigits(data.projects.active)}
          hint={tr('{0} پروژه در کل', localDigits(data.projects.total))} tone="progress" />
        <StatTile label={tr('ارزش پایپ‌لاین')} value={formatCurrency(data.pipeline.pipelineValue)}
          hint={tr('{0} فرصت باز', localDigits(data.pipeline.openOpportunities))} />
        <StatTile label={tr('وظایف سررسید گذشته')} value={localDigits(data.delivery.overdueTasks)}
          tone={data.delivery.overdueTasks > 0 ? 'danger' : 'success'} />
        <StatTile label={tr('SLA نقض‌شده')} value={localDigits(data.governance.slaBreached)}
          tone={data.governance.slaBreached > 0 ? 'danger' : 'success'}
          hint={tr('{0} در خطر', localDigits(data.governance.slaAtRisk))} />
      </div>

      {data.finance && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label={tr('درآمد قراردادی')} value={formatCurrency(data.finance.contractedRevenue)} />
          <StatTile label={tr('هزینه واقعی')} value={formatCurrency(data.finance.totalCost)} />
          <StatTile label={tr('حاشیه سود ناخالص')} value={formatCurrency(data.finance.grossMargin)}
            tone={data.finance.grossMargin > 0 ? 'success' : 'danger'} hint={formatPercent(data.finance.marginPercent)} />
          <StatTile label={tr('مانده مطالبات')} value={formatCurrency(data.finance.outstanding)}
            tone={data.finance.overdueInvoices > 0 ? 'danger' : 'warning'}
            hint={tr('{0} فاکتور سررسید گذشته', localDigits(data.finance.overdueInvoices))} />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title={tr('سلامت پرتفوی پروژه‌ها')} className="lg:col-span-1">
          {!healthData.length ? <EmptyState title={tr('پروژه فعالی نیست')} /> : (
            <div className="p-4">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={healthData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                    {healthData.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => localDigits(v)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title={tr('حاکمیت فرآیند')} className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-x-4 p-4 sm:grid-cols-3">
            {[
              [tr('درخواست‌های تغییر باز'), data.governance.openChangeRequests, 'warning'],
              [tr('تغییرات خارج از Scope'), data.governance.outOfScopeChanges, 'warning'],
              [tr('ریسک‌های باز'), data.governance.openRisks, 'warning'],
              [tr('ریسک‌های بحرانی'), data.governance.criticalRisks, 'danger'],
              [tr('تأییدهای در انتظار'), data.governance.pendingApprovals, 'info'],
              [tr('اصلاحیه‌های باز'), data.delivery.openRevisions, 'warning'],
            ].map(([label, value, tone]) => (
              <div key={label as string} className="border-b border-ink-100 py-2.5">
                <p className="text-xs text-ink-500">{label as string}</p>
                <p className={`mt-0.5 text-xl font-semibold nums ${Number(value) > 0 ? (tone === 'danger' ? 'text-rose-700' : 'text-amber-700') : 'text-ink-800'}`}>
                  {localDigits(Number(value))}
                </p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title={tr('سلامت پروژه‌ها')} subtitle={tr('مرتب‌شده بر اساس شدت — بحرانی‌ها ابتدا')}>
        {!data.projectHealth.length ? <EmptyState title={tr('پروژه فعالی نیست')} /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>{tr('پروژه')}</Th><Th>{tr('مشتری')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('وظایف عقب‌افتاده')}</Th><Th>{tr('درآمد')}</Th><Th>{tr('هزینه')}</Th><Th>{tr('حاشیه')}</Th><Th>{tr('سلامت')}</Th></tr>
            </thead>
            <tbody>
              {data.projectHealth.map((p: any) => (
                <Tr key={p.id}>
                  <Td><Link to={`/projects/${p.id}`} className="text-sm text-brand-600 hover:underline">{p.name}</Link><Code>{p.code}</Code></Td>
                  <Td className="text-xs">{p.company}</Td>
                  <Td><StateBadge state={p.state} /></Td>
                  <Td className="nums text-xs">
                    {localDigits(p.overdueTasks)}
                    {p.isOverdue && <Badge tone="danger" className="ms-1">{tr('تأخیر پروژه')}</Badge>}
                  </Td>
                  <Td className="text-xs">{formatCurrency(p.revenue)}</Td>
                  <Td className="text-xs">{formatCurrency(p.cost)}</Td>
                  <Td className="text-xs">
                    {p.marginPercent == null ? '—' : (
                      <Badge tone={p.marginPercent >= 30 ? 'success' : p.marginPercent >= 15 ? 'warning' : 'danger'}>
                        {formatPercent(p.marginPercent)}
                      </Badge>
                    )}
                  </Td>
                  <Td><Badge tone={p.status === 'RED' ? 'danger' : p.status === 'AMBER' ? 'warning' : 'success'}>
                    {p.status === 'RED' ? tr('بحرانی') : p.status === 'AMBER' ? tr('توجه') : tr('سالم')}
                  </Badge></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function SalesReport() {
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ['/reports/sales'], queryFn: () => apiGet('/reports/sales'),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const funnel = [
    { name: tr('سرنخ'), value: data.funnel.leads },
    { name: tr('فرصت'), value: data.funnel.opportunities },
    { name: tr('بریف'), value: data.funnel.briefs },
    { name: tr('پروپوزال'), value: data.funnel.proposals },
    { name: tr('برنده'), value: data.funnel.won },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('نرخ برد')} value={data.conversion.winRate != null ? tr('{0}٪', localDigits(data.conversion.winRate)) : '—'}
          tone={data.conversion.winRate >= 50 ? 'success' : 'warning'} />
        <StatTile label={tr('ارزش پایپ‌لاین')} value={formatCurrency(data.value.pipeline)} />
        <StatTile label={tr('میانگین اندازه معامله')} value={formatCurrency(data.value.averageDealSize)} />
        <StatTile label={tr('میانگین چرخه فروش')}
          value={data.salesCycleDays != null ? tr('{0} روز', localDigits(data.salesCycleDays)) : '—'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={tr('قیف فروش')}>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={funnel}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12, fontFamily: 'Vazirmatn' }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number) => localDigits(v)} />
                <Bar dataKey="value" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title={tr('کیفیت بریف')} subtitle={tr('شاخص Brief Completeness — Doc_H RACI #3')}>
          <div className="space-y-4 p-4">
            <div>
              <div className="mb-1 flex justify-between text-xs text-ink-500">
                <span>{tr('میانگین کامل بودن بریف‌ها')}</span>
                <span className="nums">{data.briefQuality.averageCompleteness != null ? tr('{0}٪', localDigits(data.briefQuality.averageCompleteness)) : '—'}</span>
              </div>
              <ProgressBar value={data.briefQuality.averageCompleteness ?? 0}
                tone={(data.briefQuality.averageCompleteness ?? 0) >= 90 ? 'success' : 'warning'} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">{tr('بریف‌های بازگشتی')}</p>
                <p className="mt-0.5 text-xl font-semibold nums">{localDigits(data.briefQuality.returnedIncomplete)}</p>
              </div>
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">{tr('مجموع دفعات بازگشت')}</p>
                <p className="mt-0.5 text-xl font-semibold nums">{localDigits(data.briefQuality.totalReturns)}</p>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card title={tr('عملکرد به تفکیک مالک فروش')}>
        {!data.byOwner.length ? <EmptyState title={tr('داده‌ای وجود ندارد')} /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('مالک')}</Th><Th>{tr('فرصت باز')}</Th><Th>{tr('برنده')}</Th><Th>{tr('ارزش برنده‌شده')}</Th></tr></thead>
            <tbody>
              {data.byOwner.map((o: any) => (
                <Tr key={o.name}>
                  <Td className="text-sm">{o.name}</Td>
                  <Td className="nums text-xs">{localDigits(o.open)}</Td>
                  <Td className="nums text-xs">{localDigits(o.won)}</Td>
                  <Td className="text-xs">{formatCurrency(o.value)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

const UNIT_NAMES: Record<string, string> = {
  ST: tr('استراتژی'), CR: tr('خلاقیت / گرافیک / تولید'), ME: tr('رسانه'), DM: tr('دیجیتال مارکتینگ'),
};

function UnitsReport() {
  const { data, isLoading, error, refetch } = useQuery<any[]>({
    queryKey: ['/reports/units'], queryFn: () => apiGet('/reports/units'),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  const chart = (data ?? []).map((u) => ({
    name: UNIT_NAMES[u.unit] ?? u.unit,
    'تحویل به‌موقع': u.onTimeDeliveryRate ?? 0,
    'First Pass Yield': u.firstPassYield ?? 0,
  }));

  return (
    <div className="space-y-5">
      <Card title={tr('شاخص‌های کیفیت واحدها')} subtitle={tr('Doc_H slide 34 — ستون «واحدهای اجرایی»')}>
        <div className="p-4">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fontFamily: 'Vazirmatn' }} />
              <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} />
              <Tooltip formatter={(v: number) => tr('{0}٪', localDigits(v))} />
              <Legend wrapperStyle={{ fontFamily: 'Vazirmatn', fontSize: 12 }} />
              <Bar dataKey={tr('تحویل به‌موقع')} fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
              <Bar dataKey="First Pass Yield" fill={CHART_COLORS[2]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title={tr('جزئیات عملکرد')}>
        <Table>
          <thead className="bg-ink-50/60">
            <tr><Th>{tr('واحد')}</Th><Th>{tr('وظایف باز')}</Th><Th>{tr('تکمیل‌شده')}</Th><Th>{tr('عقب‌افتاده')}</Th><Th>{tr('تحویل به‌موقع')}</Th>
              <Th>First Pass Yield</Th><Th>{tr('نرخ اصلاحیه')}</Th><Th>{tr('هزینه اعلامی')}</Th></tr>
          </thead>
          <tbody>
            {(data ?? []).map((u) => (
              <Tr key={u.unit}>
                <Td className="text-sm font-medium">{UNIT_NAMES[u.unit] ?? u.unit}</Td>
                <Td className="nums text-xs">{localDigits(u.openTasks)}</Td>
                <Td className="nums text-xs">{localDigits(u.completedTasks)}</Td>
                <Td className="nums text-xs">
                  {u.overdueTasks > 0 ? <Badge tone="danger">{localDigits(u.overdueTasks)}</Badge> : localDigits(0)}
                </Td>
                <Td className="text-xs">{u.onTimeDeliveryRate != null ? tr('{0}٪', localDigits(u.onTimeDeliveryRate)) : '—'}</Td>
                <Td className="text-xs">{u.firstPassYield != null ? tr('{0}٪', localDigits(u.firstPassYield)) : '—'}</Td>
                <Td className="text-xs">
                  <Badge tone={u.revisionRate > 30 ? 'danger' : u.revisionRate > 15 ? 'warning' : 'success'}>{tr('{0}٪', localDigits(u.revisionRate))}</Badge>
                </Td>
                <Td className="text-xs">{formatCurrency(u.declaredCost)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function SlaReport() {
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ['/reports/sla'], queryFn: () => apiGet('/reports/sla'),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <BreachRisk />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('نرخ پایبندی کلی')}
          value={data.overall.complianceRate != null ? tr('{0}٪', localDigits(data.overall.complianceRate)) : '—'}
          tone={data.overall.complianceRate >= 90 ? 'success' : data.overall.complianceRate >= 70 ? 'warning' : 'danger'} />
        <StatTile label={tr('رعایت‌شده')} value={localDigits(data.overall.met)} tone="success" />
        <StatTile label={tr('نقض‌شده')} value={localDigits(data.overall.breached)}
          tone={data.overall.breached > 0 ? 'danger' : 'success'} />
        <StatTile label={tr('در جریان / در خطر')}
          value={`${localDigits(data.overall.running)} / ${localDigits(data.overall.atRisk)}`}
          tone={data.overall.atRisk > 0 ? 'warning' : 'neutral'} />
      </div>

      <Card title={tr('پایبندی به تفکیک سیاست SLA')} subtitle={tr('مهلت‌ها از Doc_H — «SLA پیشنهادی»')}>
        {!data.byPolicy.length ? <EmptyState title={tr('داده SLA وجود ندارد')} /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr>
                <Th>{tr('سیاست')}</Th><Th>{tr('کل')}</Th><Th>{tr('رعایت‌شده')}</Th><Th>{tr('نقض‌شده')}</Th><Th>{tr('در جریان')}</Th><Th>{tr('متوقف')}</Th>
                <Th>{tr('میانگین سپری‌شده')}</Th><Th>{tr('میانگین تحت کنترل ما')}</Th><Th>{tr('نرخ پایبندی')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.byPolicy.map((p: any) => (
                <Tr key={p.code}>
                  <Td><p className="text-sm">{loc(p, 'label')}</p><Code>{p.code}</Code></Td>
                  <Td className="nums text-xs">{localDigits(p.total)}</Td>
                  <Td className="nums text-xs text-emerald-700">{localDigits(p.met)}</Td>
                  <Td className="nums text-xs text-rose-700">{localDigits(p.breached)}</Td>
                  <Td className="nums text-xs">{localDigits(p.running + p.atRisk)}</Td>
                  <Td className="nums text-xs">{localDigits(p.paused ?? 0)}</Td>
                  <Td className="nums text-xs text-ink-500">{p.avgElapsedHours == null ? '—' : tr('{0} س', localDigits(p.avgElapsedHours))}</Td>
                  <Td className="nums text-xs font-medium">{p.avgControlledHours == null ? '—' : tr('{0} س', localDigits(p.avgControlledHours))}</Td>
                  <Td>
                    {p.complianceRate == null ? <span className="text-xs text-ink-400">—</span> : (
                      <div className="w-24">
                        <ProgressBar value={p.complianceRate} tone={p.complianceRate >= 90 ? 'success' : p.complianceRate >= 70 ? 'warning' : 'danger'} />
                        <span className="nums text-[11px] text-ink-500">{tr('{0}٪', localDigits(p.complianceRate))}</span>
                      </div>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function DataQuality() {
  const { can } = useAuth();
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ['/reports/data-quality'], queryFn: () => apiGet('/reports/data-quality'),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      {can('governance.read') && <WaiverRegister />}
      <Card title={tr('امتیاز کیفیت داده')} subtitle={tr('رکوردهایی که فرآیند را بی‌سروصدا مختل می‌کنند')}>
        <div className="p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-3xl font-semibold nums">{localDigits(data.score)}</span>
            <span className="text-sm text-ink-500">{tr('از ۱۰۰')}</span>
          </div>
          <ProgressBar value={data.score} tone={data.score >= 90 ? 'success' : data.score >= 70 ? 'warning' : 'danger'} />
        </div>
      </Card>

      <Card title={tr('یافته‌ها')}>
        {!data.findings.length ? (
          <EmptyState title={tr('هیچ مشکلی یافت نشد')} description={tr('تمام کنترل‌های کیفیت داده سبز هستند.')} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {data.findings.map((f: any) => (
              <li key={f.key} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-800">{loc(f, 'label')}</p>
                  {f.samples?.length > 0 && (
                    <p className="mt-1 text-xs text-ink-500">{tr('نمونه:')}{' '}{f.samples.slice(0, 3).map((s: any) => s.name ?? s.code).join(tr('، '))}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={f.severity === 'CRITICAL' ? 'danger' : f.severity === 'HIGH' ? 'warning' : 'neutral'}>
                    {f.severity === 'CRITICAL' ? tr('بحرانی') : f.severity === 'HIGH' ? tr('زیاد') : tr('متوسط')}
                  </Badge>
                  <span className="text-lg font-semibold nums">{localDigits(f.count)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const WAIVER_STATUS: Record<string, { fa: string; tone: 'warning' | 'neutral' | 'success' | 'danger' }> = {
  OPEN: { fa: tr('باز'), tone: 'warning' }, USED: { fa: tr('مصرف‌شده'), tone: 'neutral' },
  EXPIRED: { fa: tr('منقضی'), tone: 'success' }, REVOKED: { fa: tr('لغوشده'), tone: 'danger' },
};

/**
 * The register of exceptions. A waiver is a rule set aside on purpose; the report that hunts
 * rules set aside by accident shows the deliberate ones beside them, with names on each.
 */
function WaiverRegister() {
  const { data } = useQuery<any[]>({ queryKey: ['/waivers'], queryFn: () => apiGet('/waivers') });
  if (!data) return null;
  const open = data.filter((w) => w.status === 'OPEN').length;
  return (
    <Card title={tr('دفتر استثناها')} subtitle={tr('قوانینی که با اجازهٔ مدیریت، یک بار و برای یک رکورد، کنار گذاشته شده‌اند — {0} استثنای باز', localDigits(open))}>
      {!data.length ? <EmptyState title={tr('استثنایی ثبت نشده — همان‌طور که باید')} /> : (
        <Table>
          <thead className="bg-ink-50/60">
            <tr><Th>{tr('قانون')}</Th><Th>{tr('رکورد')}</Th><Th>{tr('دلیل')}</Th><Th>{tr('صادرکننده')}</Th><Th>{tr('انقضا')}</Th><Th>{tr('وضعیت')}</Th></tr>
          </thead>
          <tbody data-testid="waiver-register">
            {data.map((w) => (
              <Tr key={w.id}>
                <Td className="text-xs">{loc(w, 'guardLabel')}</Td>
                <Td className="text-xs">{w.entityType} <Code>{String(w.entityId).slice(0, 8)}</Code></Td>
                <Td className="max-w-xs text-xs text-ink-600">{w.reason}</Td>
                <Td className="text-xs">{w.grantedByName}{w.usedByName && <span className="text-ink-400">{' '}{tr('· مصرف:')}{' '}{w.usedByName}</span>}</Td>
                <Td className="text-xs">{formatDate(w.expiresAt)}</Td>
                <Td><Badge tone={WAIVER_STATUS[w.status]?.tone ?? 'neutral'}>{trx(WAIVER_STATUS[w.status]?.fa ?? w.status)}</Badge></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** Declared cost against the hours, per unit — the Doc_H "cost accuracy" KPI with both sides. */
function CostAccuracy() {
  const { data, isLoading, error, refetch } = useQuery<any>({ queryKey: ['/reports/cost-accuracy'], queryFn: () => apiGet('/reports/cost-accuracy') });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;
  const ratioTone = (r: number | null) => (r == null ? 'neutral' : r > 1.15 ? 'danger' : r < 0.85 ? 'warning' : 'success');
  return (
    <div className="space-y-5">
      <Card title={tr('دقت برآورد هزینه به تفکیک واحد')} subtitle={tr('قیمت تمام‌شدهٔ اعلامی در برابر نفر-ساعت واقعی × نرخ ساعتی. نسبت ۱ یعنی اعلام دقیق؛ بالاتر یعنی واحد هزینه‌ای را جذب می‌کند که قیمت نکرده')}>
        {!data.units.length ? <EmptyState title={tr('هنوز زمانی ثبت نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>{tr('واحد')}</Th><Th>{tr('سفارش‌ها')}</Th><Th>{tr('اعلام‌شده')}</Th><Th>{tr('ساعت واقعی')}</Th><Th>{tr('هزینهٔ واقعی')}</Th><Th>{tr('نسبت')}</Th><Th>{tr('خطای برآورد زمان')}</Th></tr>
            </thead>
            <tbody data-testid="cost-accuracy">
              {data.units.map((u: any) => (
                <Tr key={u.departmentCode}>
                  <Td className="text-xs">{u.departmentCode}</Td>
                  <Td className="nums text-xs">{localDigits(u.workOrders)}</Td>
                  <Td className="nums text-xs">{formatCurrency(u.declared)}</Td>
                  <Td className="nums text-xs">{localDigits(u.hours)}{u.unpricedHours > 0 && <span className="text-ink-400">{' '}{tr('({0} بدون نرخ)', localDigits(u.unpricedHours))}</span>}</Td>
                  <Td className="nums text-xs">{u.actualCost == null ? '—' : formatCurrency(u.actualCost)}</Td>
                  <Td><Badge tone={ratioTone(u.ratio)}>{u.ratio == null ? '—' : localDigits(u.ratio)}</Badge></Td>
                  <Td className="nums text-xs">{u.estimateErrorPercent == null ? '—' : tr('{0}٪', localDigits(u.estimateErrorPercent))}<span className="text-ink-400">{' '}{tr('({0} وظیفه)', localDigits(u.tasksWithBoth))}</span></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

