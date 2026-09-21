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
import { formatCurrency, formatPercent, toPersianDigits } from '../lib/format';

const CHART_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export default function Reports() {
  const { can } = useAuth();
  const [tab, setTab] = useState(can('report.executive') ? 'executive' : 'sales');

  const tabs = [
    ...(can('report.executive') ? [{ key: 'executive', label: 'برج کنترل مدیریتی' }] : []),
    { key: 'sales', label: 'قیف فروش' },
    { key: 'units', label: 'عملکرد واحدها' },
    { key: 'sla', label: 'پایبندی به SLA' },
    { key: 'quality', label: 'کیفیت داده' },
  ];

  return (
    <>
      <PageHeader
        title="گزارش‌ها"
        subtitle="تمام اعداد از داده‌های زنده سیستم محاسبه می‌شوند"
        actions={tab === 'executive' ? <PdfButton kind="executive-report" id="all" label="خروجی PDF گزارش" /> : undefined}
      />
      <div className="border-b border-ink-200 bg-surface px-2">
        <Tabs tabs={tabs} active={tab} onChange={setTab} />
      </div>
      <PageBody>
        {tab === 'executive' && <Executive />}
        {tab === 'sales' && <SalesReport />}
        {tab === 'units' && <UnitsReport />}
        {tab === 'sla' && <SlaReport />}
        {tab === 'quality' && <DataQuality />}
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
    { name: 'سالم', value: data.projects.green, color: '#10b981' },
    { name: 'نیازمند توجه', value: data.projects.amber, color: '#f59e0b' },
    { name: 'بحرانی', value: data.projects.red, color: '#ef4444' },
  ].filter((d) => d.value > 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="پروژه‌های فعال" value={toPersianDigits(data.projects.active)}
          hint={`${toPersianDigits(data.projects.total)} پروژه در کل`} tone="progress" />
        <StatTile label="ارزش پایپ‌لاین" value={formatCurrency(data.pipeline.pipelineValue)}
          hint={`${toPersianDigits(data.pipeline.openOpportunities)} فرصت باز`} />
        <StatTile label="وظایف سررسید گذشته" value={toPersianDigits(data.delivery.overdueTasks)}
          tone={data.delivery.overdueTasks > 0 ? 'danger' : 'success'} />
        <StatTile label="SLA نقض‌شده" value={toPersianDigits(data.governance.slaBreached)}
          tone={data.governance.slaBreached > 0 ? 'danger' : 'success'}
          hint={`${toPersianDigits(data.governance.slaAtRisk)} در خطر`} />
      </div>

      {data.finance && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="درآمد قراردادی" value={formatCurrency(data.finance.contractedRevenue)} />
          <StatTile label="هزینه واقعی" value={formatCurrency(data.finance.totalCost)} />
          <StatTile label="حاشیه سود ناخالص" value={formatCurrency(data.finance.grossMargin)}
            tone={data.finance.grossMargin > 0 ? 'success' : 'danger'} hint={formatPercent(data.finance.marginPercent)} />
          <StatTile label="مانده مطالبات" value={formatCurrency(data.finance.outstanding)}
            tone={data.finance.overdueInvoices > 0 ? 'danger' : 'warning'}
            hint={`${toPersianDigits(data.finance.overdueInvoices)} فاکتور سررسید گذشته`} />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="سلامت پرتفوی پروژه‌ها" className="lg:col-span-1">
          {!healthData.length ? <EmptyState title="پروژه فعالی نیست" /> : (
            <div className="p-4">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={healthData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                    {healthData.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => toPersianDigits(v)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="حاکمیت فرآیند" className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-x-4 p-4 sm:grid-cols-3">
            {[
              ['درخواست‌های تغییر باز', data.governance.openChangeRequests, 'warning'],
              ['تغییرات خارج از Scope', data.governance.outOfScopeChanges, 'warning'],
              ['ریسک‌های باز', data.governance.openRisks, 'warning'],
              ['ریسک‌های بحرانی', data.governance.criticalRisks, 'danger'],
              ['تأییدهای در انتظار', data.governance.pendingApprovals, 'info'],
              ['اصلاحیه‌های باز', data.delivery.openRevisions, 'warning'],
            ].map(([label, value, tone]) => (
              <div key={label as string} className="border-b border-ink-100 py-2.5">
                <p className="text-xs text-ink-500">{label as string}</p>
                <p className={`mt-0.5 text-xl font-semibold nums ${Number(value) > 0 ? (tone === 'danger' ? 'text-rose-700' : 'text-amber-700') : 'text-ink-800'}`}>
                  {toPersianDigits(Number(value))}
                </p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="سلامت پروژه‌ها" subtitle="مرتب‌شده بر اساس شدت — بحرانی‌ها ابتدا">
        {!data.projectHealth.length ? <EmptyState title="پروژه فعالی نیست" /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr><Th>پروژه</Th><Th>مشتری</Th><Th>وضعیت</Th><Th>وظایف عقب‌افتاده</Th><Th>درآمد</Th><Th>هزینه</Th><Th>حاشیه</Th><Th>سلامت</Th></tr>
            </thead>
            <tbody>
              {data.projectHealth.map((p: any) => (
                <Tr key={p.id}>
                  <Td><Link to={`/projects/${p.id}`} className="text-sm text-brand-600 hover:underline">{p.name}</Link><Code>{p.code}</Code></Td>
                  <Td className="text-xs">{p.company}</Td>
                  <Td><StateBadge state={p.state} /></Td>
                  <Td className="nums text-xs">
                    {toPersianDigits(p.overdueTasks)}
                    {p.isOverdue && <Badge tone="danger" className="ms-1">تأخیر پروژه</Badge>}
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
                    {p.status === 'RED' ? 'بحرانی' : p.status === 'AMBER' ? 'توجه' : 'سالم'}
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
    { name: 'سرنخ', value: data.funnel.leads },
    { name: 'فرصت', value: data.funnel.opportunities },
    { name: 'بریف', value: data.funnel.briefs },
    { name: 'پروپوزال', value: data.funnel.proposals },
    { name: 'برنده', value: data.funnel.won },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="نرخ برد" value={data.conversion.winRate != null ? `${toPersianDigits(data.conversion.winRate)}٪` : '—'}
          tone={data.conversion.winRate >= 50 ? 'success' : 'warning'} />
        <StatTile label="ارزش پایپ‌لاین" value={formatCurrency(data.value.pipeline)} />
        <StatTile label="میانگین اندازه معامله" value={formatCurrency(data.value.averageDealSize)} />
        <StatTile label="میانگین چرخه فروش"
          value={data.salesCycleDays != null ? `${toPersianDigits(data.salesCycleDays)} روز` : '—'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="قیف فروش">
          <div className="p-4">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={funnel}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12, fontFamily: 'Vazirmatn' }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number) => toPersianDigits(v)} />
                <Bar dataKey="value" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="کیفیت بریف" subtitle="شاخص Brief Completeness — Doc_H RACI #3">
          <div className="space-y-4 p-4">
            <div>
              <div className="mb-1 flex justify-between text-xs text-ink-500">
                <span>میانگین کامل بودن بریف‌ها</span>
                <span className="nums">{data.briefQuality.averageCompleteness != null ? `${toPersianDigits(data.briefQuality.averageCompleteness)}٪` : '—'}</span>
              </div>
              <ProgressBar value={data.briefQuality.averageCompleteness ?? 0}
                tone={(data.briefQuality.averageCompleteness ?? 0) >= 90 ? 'success' : 'warning'} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">بریف‌های بازگشتی</p>
                <p className="mt-0.5 text-xl font-semibold nums">{toPersianDigits(data.briefQuality.returnedIncomplete)}</p>
              </div>
              <div className="rounded-lg bg-ink-50 p-3">
                <p className="text-xs text-ink-500">مجموع دفعات بازگشت</p>
                <p className="mt-0.5 text-xl font-semibold nums">{toPersianDigits(data.briefQuality.totalReturns)}</p>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card title="عملکرد به تفکیک مالک فروش">
        {!data.byOwner.length ? <EmptyState title="داده‌ای وجود ندارد" /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>مالک</Th><Th>فرصت باز</Th><Th>برنده</Th><Th>ارزش برنده‌شده</Th></tr></thead>
            <tbody>
              {data.byOwner.map((o: any) => (
                <Tr key={o.name}>
                  <Td className="text-sm">{o.name}</Td>
                  <Td className="nums text-xs">{toPersianDigits(o.open)}</Td>
                  <Td className="nums text-xs">{toPersianDigits(o.won)}</Td>
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
  ST: 'استراتژی', CR: 'خلاقیت / گرافیک / تولید', ME: 'رسانه', DM: 'دیجیتال مارکتینگ',
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
      <Card title="شاخص‌های کیفیت واحدها" subtitle="Doc_H slide 34 — ستون «واحدهای اجرایی»">
        <div className="p-4">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fontFamily: 'Vazirmatn' }} />
              <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} />
              <Tooltip formatter={(v: number) => `${toPersianDigits(v)}٪`} />
              <Legend wrapperStyle={{ fontFamily: 'Vazirmatn', fontSize: 12 }} />
              <Bar dataKey="تحویل به‌موقع" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
              <Bar dataKey="First Pass Yield" fill={CHART_COLORS[2]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title="جزئیات عملکرد">
        <Table>
          <thead className="bg-ink-50/60">
            <tr><Th>واحد</Th><Th>وظایف باز</Th><Th>تکمیل‌شده</Th><Th>عقب‌افتاده</Th><Th>تحویل به‌موقع</Th>
              <Th>First Pass Yield</Th><Th>نرخ اصلاحیه</Th><Th>هزینه اعلامی</Th></tr>
          </thead>
          <tbody>
            {(data ?? []).map((u) => (
              <Tr key={u.unit}>
                <Td className="text-sm font-medium">{UNIT_NAMES[u.unit] ?? u.unit}</Td>
                <Td className="nums text-xs">{toPersianDigits(u.openTasks)}</Td>
                <Td className="nums text-xs">{toPersianDigits(u.completedTasks)}</Td>
                <Td className="nums text-xs">
                  {u.overdueTasks > 0 ? <Badge tone="danger">{toPersianDigits(u.overdueTasks)}</Badge> : toPersianDigits(0)}
                </Td>
                <Td className="text-xs">{u.onTimeDeliveryRate != null ? `${toPersianDigits(u.onTimeDeliveryRate)}٪` : '—'}</Td>
                <Td className="text-xs">{u.firstPassYield != null ? `${toPersianDigits(u.firstPassYield)}٪` : '—'}</Td>
                <Td className="text-xs">
                  <Badge tone={u.revisionRate > 30 ? 'danger' : u.revisionRate > 15 ? 'warning' : 'success'}>
                    {toPersianDigits(u.revisionRate)}٪
                  </Badge>
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="نرخ پایبندی کلی"
          value={data.overall.complianceRate != null ? `${toPersianDigits(data.overall.complianceRate)}٪` : '—'}
          tone={data.overall.complianceRate >= 90 ? 'success' : data.overall.complianceRate >= 70 ? 'warning' : 'danger'} />
        <StatTile label="رعایت‌شده" value={toPersianDigits(data.overall.met)} tone="success" />
        <StatTile label="نقض‌شده" value={toPersianDigits(data.overall.breached)}
          tone={data.overall.breached > 0 ? 'danger' : 'success'} />
        <StatTile label="در جریان / در خطر"
          value={`${toPersianDigits(data.overall.running)} / ${toPersianDigits(data.overall.atRisk)}`}
          tone={data.overall.atRisk > 0 ? 'warning' : 'neutral'} />
      </div>

      <Card title="پایبندی به تفکیک سیاست SLA" subtitle="مهلت‌ها از Doc_H — «SLA پیشنهادی»">
        {!data.byPolicy.length ? <EmptyState title="داده SLA وجود ندارد" /> : (
          <Table>
            <thead className="bg-ink-50/60">
              <tr>
                <Th>سیاست</Th><Th>کل</Th><Th>رعایت‌شده</Th><Th>نقض‌شده</Th><Th>در جریان</Th><Th>متوقف</Th>
                <Th>میانگین سپری‌شده</Th><Th>میانگین تحت کنترل ما</Th><Th>نرخ پایبندی</Th>
              </tr>
            </thead>
            <tbody>
              {data.byPolicy.map((p: any) => (
                <Tr key={p.code}>
                  <Td><p className="text-sm">{p.labelFa}</p><Code>{p.code}</Code></Td>
                  <Td className="nums text-xs">{toPersianDigits(p.total)}</Td>
                  <Td className="nums text-xs text-emerald-700">{toPersianDigits(p.met)}</Td>
                  <Td className="nums text-xs text-rose-700">{toPersianDigits(p.breached)}</Td>
                  <Td className="nums text-xs">{toPersianDigits(p.running + p.atRisk)}</Td>
                  <Td className="nums text-xs">{toPersianDigits(p.paused ?? 0)}</Td>
                  <Td className="nums text-xs text-ink-500">{p.avgElapsedHours == null ? '—' : `${toPersianDigits(p.avgElapsedHours)} س`}</Td>
                  <Td className="nums text-xs font-medium">{p.avgControlledHours == null ? '—' : `${toPersianDigits(p.avgControlledHours)} س`}</Td>
                  <Td>
                    {p.complianceRate == null ? <span className="text-xs text-ink-400">—</span> : (
                      <div className="w-24">
                        <ProgressBar value={p.complianceRate} tone={p.complianceRate >= 90 ? 'success' : p.complianceRate >= 70 ? 'warning' : 'danger'} />
                        <span className="nums text-[11px] text-ink-500">{toPersianDigits(p.complianceRate)}٪</span>
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
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ['/reports/data-quality'], queryFn: () => apiGet('/reports/data-quality'),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <Card title="امتیاز کیفیت داده" subtitle="رکوردهایی که فرآیند را بی‌سروصدا مختل می‌کنند">
        <div className="p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-3xl font-semibold nums">{toPersianDigits(data.score)}</span>
            <span className="text-sm text-ink-500">از ۱۰۰</span>
          </div>
          <ProgressBar value={data.score} tone={data.score >= 90 ? 'success' : data.score >= 70 ? 'warning' : 'danger'} />
        </div>
      </Card>

      <Card title="یافته‌ها">
        {!data.findings.length ? (
          <EmptyState title="هیچ مشکلی یافت نشد" description="تمام کنترل‌های کیفیت داده سبز هستند." />
        ) : (
          <ul className="divide-y divide-ink-100">
            {data.findings.map((f: any) => (
              <li key={f.key} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-800">{f.labelFa}</p>
                  {f.samples?.length > 0 && (
                    <p className="mt-1 text-xs text-ink-500">
                      نمونه: {f.samples.slice(0, 3).map((s: any) => s.name ?? s.code).join('، ')}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={f.severity === 'CRITICAL' ? 'danger' : f.severity === 'HIGH' ? 'warning' : 'neutral'}>
                    {f.severity === 'CRITICAL' ? 'بحرانی' : f.severity === 'HIGH' ? 'زیاد' : 'متوسط'}
                  </Badge>
                  <span className="text-lg font-semibold nums">{toPersianDigits(f.count)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
