import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { stateLabelFa } from '@hiva/contracts';
import { apiGet } from '../lib/api';
import { PageBody, PageHeader } from '../components/Shell';
import { Code, EntityList } from '../components/common';
import { Badge, Button, Card, EmptyState, ErrorBlock, LoadingBlock, Select, StatTile, StateBadge, cx } from '../components/ui';
import { formatCurrency, formatDate, formatRelative, toPersianDigits } from '../lib/format';

const UNITS = [
  { value: 'ST', label: 'استراتژی' }, { value: 'CR', label: 'خلاقیت / گرافیک / تولید' },
  { value: 'ME', label: 'رسانه' }, { value: 'DM', label: 'دیجیتال مارکتینگ' },
];
const KINDS = [
  { value: 'FREELANCER', label: 'فریلنسر' }, { value: 'OUTSOURCE', label: 'آوت‌سورس' },
  { value: 'SUPPLIER', label: 'تأمین‌کننده' }, { value: 'PARTNER', label: 'شریک تجاری' },
];

interface Profile {
  supplier: { id: string; name: string; kind: string; departmentCode: string | null; specialty: string | null; dayRate: string | null; isActive: boolean; contactName: string | null; phone: string | null; email: string | null };
  evaluations: { count: number; quality: number | null; timeliness: number | null; communication: number | null; costValue: number | null; overall: number | null; reuseRate: number | null; latest: { comments: string | null; overall: number; createdAt: string; evaluatedBy: string }[] };
  requests: { total: number; byState: Record<string, number>; fulfilled: number; onTimeRate: number | null; open: number; averageCost: number | null; projects: number };
  timeline: { at: string; kind: 'REQUEST' | 'EVALUATION'; code: string | null; label: string }[];
  score?: number;
}

const pct = (v: number | null) => (v == null ? '—' : `${toPersianDigits(v)}٪`);
const rating = (v: number | null) => (v == null ? '—' : `${toPersianDigits(v)} از ۵`);

/** Every supplier and freelancer, with the numbers that used to live in three tables. */
export default function Suppliers() {
  const { id } = useParams();
  if (id) return <SupplierDetail id={id} />;
  return (
    <>
      <PageHeader title="تأمین‌کنندگان و فریلنسرها" subtitle="بند ۵ — دیتابیس و مدیریت عملکرد؛ امتیاز، تحویل به‌موقع و بار فعلی در یک نگاه" />
      <PageBody>
        <div className="space-y-5">
          <Suggest />
          <EntityList<any>
            path="/suppliers"
            searchPlaceholder="جستجو در نام یا تخصص…"
            rowHref={(r) => `/suppliers/${r.id}`}
            filters={[{ key: 'kind', label: 'نوع', options: KINDS }, { key: 'unit', label: 'واحد', options: UNITS }]}
            emptyTitle="تأمین‌کننده‌ای ثبت نشده"
            columns={[
              { key: 'name', header: 'نام', render: (r) => (<><p className="font-medium text-ink-800">{r.name}</p><span className="text-xs text-ink-500">{r.specialty}</span></>) },
              { key: 'kind', header: 'نوع', render: (r) => <Badge tone="neutral">{stateLabelFa(r.kind)}</Badge> },
              { key: 'unit', header: 'واحد', render: (r) => <span className="text-xs">{r.departmentCode ?? '—'}</span> },
              { key: 'rating', header: 'امتیاز', render: (r) => <span className="nums text-xs">{r.averageRating == null ? '—' : toPersianDigits(Math.round(Number(r.averageRating) * 10) / 10)}</span> },
              { key: 'rate', header: 'نرخ روزانه', render: (r) => <span className="nums text-xs">{r.dayRate ? formatCurrency(Number(r.dayRate)) : '—'}</span> },
              { key: 'active', header: 'وضعیت', render: (r) => <Badge tone={r.isActive ? 'success' : 'neutral'}>{r.isActive ? 'فعال' : 'غیرفعال'}</Badge> },
            ]}
          />
        </div>
      </PageBody>
    </>
  );
}

/** Who to send the next request to, ranked by evidence rather than by who comes to mind. */
function Suggest() {
  const [unit, setUnit] = useState('CR');
  const [kind, setKind] = useState('');
  const { data, isLoading } = useQuery<Profile[]>({
    queryKey: ['/suppliers/suggest', unit, kind],
    queryFn: () => apiGet('/suppliers/suggest', { departmentCode: unit, ...(kind ? { kind } : {}), limit: '5' }),
  });
  return (
    <Card title="پیشنهاد برای درخواست بعدی" subtitle="بر پایهٔ ارزیابی‌ها، تحویل به‌موقع، همکاری مجدد و بار فعلی — تأمین‌کنندهٔ بدون سابقه فقط با ظرفیت آزاد رتبه می‌گیرد"
      action={
        <div className="flex gap-2">
          <Select value={unit} onChange={(e) => setUnit(e.target.value)} className="w-auto text-xs" aria-label="واحد">
            {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </Select>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-auto text-xs" aria-label="نوع">
            <option value="">هر نوع</option>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
        </div>
      }>
      {isLoading ? <LoadingBlock /> : !data?.length ? <EmptyState title="تأمین‌کنندهٔ فعالی برای این واحد ثبت نشده" /> : (
        <ol className="divide-y divide-ink-100" data-testid="suggestions">
          {data.map((p, i) => (
            <li key={p.supplier.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="nums w-6 text-center text-xs text-ink-400">{toPersianDigits(i + 1)}</span>
              <Link to={`/suppliers/${p.supplier.id}`} className="min-w-0 flex-1 text-sm font-medium text-ink-800 hover:underline">
                {p.supplier.name} <span className="text-xs font-normal text-ink-500">{p.supplier.specialty}</span>
              </Link>
              <span className="text-xs text-ink-500">امتیاز {rating(p.evaluations.overall)} · به‌موقع {pct(p.requests.onTimeRate)} · باز {toPersianDigits(p.requests.open)}</span>
              <Badge tone={p.score! >= 70 ? 'success' : p.score! >= 40 ? 'warning' : 'neutral'}>{toPersianDigits(p.score!)}</Badge>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function SupplierDetail({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useQuery<Profile>({
    queryKey: ['/suppliers', id, '360'], queryFn: () => apiGet(`/suppliers/${id}/360`),
  });
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock error={error} onRetry={refetch} />;
  const { supplier: s, evaluations: e, requests: r } = data;
  return (
    <>
      <PageHeader title={s.name} subtitle={[stateLabelFa(s.kind), s.departmentCode, s.specialty].filter(Boolean).join(' · ')}
        actions={<Link to="/suppliers"><Button size="sm">همهٔ تأمین‌کنندگان</Button></Link>} />
      <PageBody>
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="supplier-stats">
          <StatTile label="امتیاز کلی" value={rating(e.overall)} hint={`${toPersianDigits(e.count)} ارزیابی`} tone={e.overall == null ? 'neutral' : e.overall >= 4 ? 'success' : e.overall >= 3 ? 'warning' : 'danger'} />
          <StatTile label="تحویل به‌موقع" value={pct(r.onTimeRate)} hint={`${toPersianDigits(r.fulfilled)} تأمین انجام‌شده`} tone={r.onTimeRate == null ? 'neutral' : r.onTimeRate >= 80 ? 'success' : 'warning'} />
          <StatTile label="همکاری مجدد" value={pct(e.reuseRate)} hint="نظر ارزیاب‌ها" />
          <StatTile label="در حال انجام" value={toPersianDigits(r.open)} hint={`${toPersianDigits(r.projects)} پروژه · میانگین ${r.averageCost == null ? '—' : formatCurrency(r.averageCost)}`} tone={r.open > 2 ? 'warning' : 'neutral'} />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="ارزیابی به تفکیک" subtitle="فرم D33 — چهار بُعد">
            <dl className="divide-y divide-ink-100 px-4">
              {([['کیفیت خروجی', e.quality], ['رعایت زمان‌بندی', e.timeliness], ['کیفیت ارتباط', e.communication], ['ارزش در برابر هزینه', e.costValue]] as const).map(([label, v]) => (
                <div key={label} className="flex items-center justify-between py-2 text-sm">
                  <dt className="text-ink-600">{label}</dt>
                  <dd className={cx('nums font-medium', v == null ? 'text-ink-400' : v >= 4 ? 'text-emerald-700' : v >= 3 ? 'text-amber-700' : 'text-rose-700')}>{rating(v)}</dd>
                </div>
              ))}
            </dl>
            {e.latest.length > 0 && (
              <ul className="border-t border-ink-100 px-4 py-2 text-xs text-ink-600">
                {e.latest.map((l, i) => <li key={i} className="py-1">«{l.comments ?? '—'}» — {l.evaluatedBy}، {formatDate(l.createdAt)}</li>)}
              </ul>
            )}
          </Card>

          <Card title="درخواست‌های تأمین" subtitle={Object.entries(r.byState).map(([k, v]) => `${stateLabelFa(k)} ${toPersianDigits(v)}`).join(' · ') || 'هنوز درخواستی ثبت نشده'}>
            {!data.timeline.length ? <EmptyState title="سابقه‌ای ثبت نشده" /> : (
              <ul className="divide-y divide-ink-100" data-testid="supplier-timeline">
                {data.timeline.map((t, i) => (
                  <li key={i} className="flex items-start gap-2 px-4 py-2 text-xs">
                    <Badge tone={t.kind === 'EVALUATION' ? 'info' : 'neutral'}>{t.kind === 'EVALUATION' ? 'ارزیابی' : 'درخواست'}</Badge>
                    <span className="min-w-0 flex-1 text-ink-700">{t.label} {t.code && <Code>{t.code}</Code>}</span>
                    <span className="text-ink-400">{formatRelative(t.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="mt-5 text-xs text-ink-500">
          {s.contactName && <span className="me-3">تماس: {s.contactName}</span>}
          {s.phone && <span className="me-3">{toPersianDigits(s.phone)}</span>}
          {s.email && <span>{s.email}</span>}
          {!s.isActive && <StateBadge state="INACTIVE" className="ms-3" />}
        </div>
      </PageBody>
    </>
  );
}
