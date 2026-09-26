import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, Input, Modal, ProgressBar, Select, StatTile, Table, Td, Th, Tr, useToast } from './ui';
import { formatCurrency, formatPercent, toPersianDigits } from '../lib/format';

/* Roadmap #29 — revenue as the work earns it, and the work in progress between earning and billing. */

interface Position {
  method: string; progress: number | null; recognised: number | null; invoiced: number; wip: number | null;
  contractValue: number | null; reasonFa: string | null; notesFa: string[]; basis: Record<string, any>;
}
interface ProjectRevenueData {
  method: string; methodFa: string; methods: { key: string; labelFa: string }[];
  position: Position; expectedLoss: number | null; lastClosed: string | null;
  milestones: { id: string; name: string; revenueShare: number | null; completedAt: string | null }[];
  months: { period: string; labelFa: string; closed: boolean; recognised: number | null; recognisedToDate: number | null; invoiced: number }[];
}

/** Work in progress in words: earned and not billed, or billed ahead of the work. */
export function WipLabel({ wip }: { wip: number | null }) {
  if (wip == null) return <span className="text-ink-400">—</span>;
  if (Math.abs(wip) < 1) return <span className="text-ink-500">هم‌تراز</span>;
  return wip > 0
    ? <span className="text-amber-700">{formatCurrency(wip)} کار انجام‌شدهٔ صورت‌حساب‌نشده</span>
    : <span className="text-sky-700">{formatCurrency(-wip)} پیش‌صورت‌حساب (درآمد انتقالی)</span>;
}

export function ProjectRevenue({ projectId }: { projectId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery<ProjectRevenueData>({ queryKey: ['/projects', projectId, 'revenue'], queryFn: () => apiGet(`/projects/${projectId}/revenue`) });
  const [shares, setShares] = useState<Record<string, string> | null>(null);
  if (!data) return null;
  const p = data.position;
  const editable = can('finance.budget');

  const save = async (body: unknown) => {
    try {
      const r = await apiPatch<{ noteFa: string | null }>(`/projects/${projectId}/revenue`, body);
      toast(r.noteFa ?? 'شیوهٔ شناسایی درآمد به‌روز شد.');
      setShares(null);
      await qc.invalidateQueries({ queryKey: ['/projects', projectId, 'revenue'] });
    } catch (e: any) { toast(e?.message ?? 'ذخیره ناموفق بود.', 'danger'); }
  };

  return (
    <Card title="شناسایی درآمد"
      subtitle="درآمد به نسبت کار انجام‌شده شناسایی می‌شود، نه هنگام امضای قرارداد و نه هنگام صدور فاکتور."
      action={editable ? (
        <Select value={data.method} onChange={(e) => void save({ method: e.target.value })} aria-label="شیوهٔ شناسایی">
          {data.methods.map((m) => <option key={m.key} value={m.key}>{m.labelFa}</option>)}
        </Select>
      ) : <Badge tone="neutral">{data.methodFa}</Badge>}>
      <div className="space-y-4 p-4" data-testid="project-revenue">
        {p.reasonFa ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{p.reasonFa}</p>
        ) : (
          <>
            <div>
              <div className="mb-1 flex justify-between text-xs text-ink-500">
                <span>پیشرفت: {formatPercent((p.progress ?? 0) * 100)}</span>
                <span>ارزش قرارداد: {formatCurrency(p.contractValue)}</span>
              </div>
              <ProgressBar value={(p.progress ?? 0) * 100} tone="success" />
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <StatTile label="درآمد شناسایی‌شده تا امروز" value={formatCurrency(p.recognised)} />
              <StatTile label="صورت‌حساب‌شده" value={formatCurrency(p.invoiced)} />
              <StatTile label="کار در جریان" value={<span className="text-sm"><WipLabel wip={p.wip} /></span>} />
            </div>
          </>
        )}
        {data.expectedLoss != null && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">قرارداد زیان‌ده: هزینهٔ تمام‌شدهٔ اعلام‌شده {formatCurrency(data.expectedLoss)} بیش از ارزش قرارداد است.</p>
        )}
        {p.notesFa.length > 0 && <ul className="space-y-0.5 text-xs text-ink-500">{p.notesFa.map((n) => <li key={n}>· {n}</li>)}</ul>}

        {data.method === 'MILESTONE' && (
          <div className="rounded-lg ring-1 ring-ink-200/70">
            <div className="flex items-center justify-between px-3 py-2 text-xs">
              <span className="font-medium text-ink-700">سهم درآمد نقاط عطف</span>
              {editable && !shares && <button className="text-brand-700 underline" onClick={() => setShares(Object.fromEntries(data.milestones.map((m) => [m.id, m.revenueShare == null ? '' : String(m.revenueShare)])))}>ویرایش</button>}
            </div>
            <ul className="divide-y divide-ink-100 text-xs" data-testid="milestone-shares">
              {data.milestones.map((m) => (
                <li key={m.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="flex-1 text-ink-700">{m.name}</span>
                  {m.completedAt ? <Badge tone="success">انجام‌شده</Badge> : <Badge tone="neutral">پیش رو</Badge>}
                  {shares
                    ? <Input type="number" className="ltr w-20" value={shares[m.id] ?? ''} aria-label={`سهم ${m.name}`} onChange={(e) => setShares({ ...shares, [m.id]: e.target.value })} />
                    : <span className="w-16 text-left nums">{m.revenueShare == null ? '—' : `${toPersianDigits(m.revenueShare)}٪`}</span>}
                </li>
              ))}
            </ul>
            {shares && (
              <div className="flex justify-end gap-2 px-3 py-2">
                <Button size="sm" variant="ghost" onClick={() => setShares(null)}>انصراف</Button>
                <Button size="sm" variant="primary" onClick={() => void save({ shares: Object.entries(shares).map(([milestoneId, v]) => ({ milestoneId, revenueShare: v === '' ? null : Number(v) })) })}>ذخیره</Button>
              </div>
            )}
          </div>
        )}

        {data.months.length > 0 && (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>ماه</Th><Th>شناسایی‌شده</Th><Th>صورت‌حساب‌شده</Th><Th /></tr></thead>
            <tbody>
              {data.months.map((m) => (
                <Tr key={m.period}>
                  <Td className="text-xs">{m.labelFa}</Td>
                  <Td className="text-xs">{formatCurrency(m.recognised)}</Td>
                  <Td className="text-xs">{formatCurrency(m.invoiced)}</Td>
                  <Td>{m.closed && <Badge tone="neutral">بسته‌شده</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}

/* ── The organisation, month by month ──────────────────────────────────── */

interface ReportMonth {
  period: string; labelFa: string; closed: boolean; recognised: number; invoiced: number;
  labourCost: number; externalCost: number; unpricedHours: number; margin: number; billingMargin: number;
}
interface RevenueReportData {
  months: ReportMonth[]; lastClosed: string | null; nextToClose: string | null;
  wip: { unbilled: number; deferred: number };
  projects: { id: string; code: string; name: string; client: string; methodFa: string; contractValue: number | null; progress: number | null; recognised: number | null; invoiced: number; wip: number | null; reasonFa: string | null; expectedLoss: number | null }[];
}

export function RevenueReport() {
  const { can } = useAuth();
  const { data } = useQuery<RevenueReportData>({ queryKey: ['/reports/revenue'], queryFn: () => apiGet('/reports/revenue', { months: 12 }) });
  const [closing, setClosing] = useState<ReportMonth | null>(null);
  if (!data) return null;
  // The first close may be any finished month; after that, only the next one in order.
  // The last row is the month in progress, which cannot be closed. After the first close only the
  // next month in order can be; the first close is offered on the latest finished month, where
  // adopting the books naturally starts (everything before it is the opening balance).
  const finished = data.months.slice(0, -1);
  const closable = data.nextToClose
    ? finished.filter((m) => m.period === data.nextToClose)
    : finished.slice(-1).filter((m) => !m.closed);
  const unpriced = data.months.reduce((s, m) => s + m.unpricedHours, 0);

  return (
    <div className="space-y-5" data-testid="revenue-report">
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="کار انجام‌شدهٔ صورت‌حساب‌نشده" value={formatCurrency(data.wip.unbilled)} hint="درآمدی که به‌دست آمده و هنوز فاکتور نشده" tone="warning" />
        <StatTile label="پیش‌صورت‌حساب (درآمد انتقالی)" value={formatCurrency(data.wip.deferred)} hint="فاکتورشده پیش از انجام کار" />
      </div>
      <Card title="سودآوری ماهانه — درآمد شناسایی‌شده در برابر صورت‌حساب"
        subtitle="ستون «حاشیه» با درآمد به‌دست‌آمده حساب می‌شود؛ «حاشیه به روش فاکتور» همان ماه را آن‌طور نشان می‌دهد که پیش از شناسایی درآمد دیده می‌شد."
        action={can('finance.settle') && closable[0] ? <Button size="sm" variant="secondary" onClick={() => setClosing(closable[0]!)}>بستن {closable[0].labelFa}</Button> : undefined}>
        <Table>
          <thead className="bg-ink-50/60"><tr><Th>ماه</Th><Th>درآمد شناسایی‌شده</Th><Th>صورت‌حساب‌شده</Th><Th>هزینهٔ کار</Th><Th>هزینهٔ بیرونی</Th><Th>حاشیه</Th><Th>حاشیه به روش فاکتور</Th></tr></thead>
          <tbody data-testid="revenue-months">
            {data.months.map((m) => (
              <Tr key={m.period}>
                <Td className="text-xs">{m.labelFa} {m.closed && <Badge tone="neutral">بسته</Badge>}</Td>
                <Td className="text-xs">{formatCurrency(m.recognised)}</Td>
                <Td className="text-xs">{formatCurrency(m.invoiced)}</Td>
                <Td className="text-xs">{formatCurrency(m.labourCost)}</Td>
                <Td className="text-xs">{formatCurrency(m.externalCost)}</Td>
                <Td className={`text-xs ${m.margin < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{formatCurrency(m.margin)}</Td>
                <Td className="text-xs text-ink-500">{formatCurrency(m.billingMargin)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {unpriced > 0 && <p className="px-4 py-2 text-[11px] text-ink-500">{toPersianDigits(Math.round(unpriced))} ساعت کار بدون نرخ ساعتی ثبت شده و در هزینهٔ کار نیامده است — نرخ واحدها را در «مدیریت» تعیین کنید.</p>}
      </Card>
      <Card title="کار در جریان به تفکیک پروژه">
        {!data.projects.length ? <EmptyState title="پروژه‌ای با ارزش قرارداد نیست" /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>پروژه</Th><Th>شیوه</Th><Th>پیشرفت</Th><Th>شناسایی‌شده</Th><Th>صورت‌حساب‌شده</Th><Th>کار در جریان</Th></tr></thead>
            <tbody>
              {data.projects.map((p) => (
                <Tr key={p.id}>
                  <Td className="text-xs"><Link to={`/projects/${p.id}`} className="text-brand-700 hover:underline">{p.name}</Link> <span className="text-ink-400">{p.client}</span>
                    {p.expectedLoss != null && <Badge tone="danger">زیان‌ده</Badge>}</Td>
                  <Td className="text-[11px] text-ink-500">{p.methodFa}</Td>
                  <Td className="text-xs">{p.progress == null ? <span className="text-amber-700" title={p.reasonFa ?? ''}>سنجیده نشد</span> : formatPercent(p.progress * 100)}</Td>
                  <Td className="text-xs">{formatCurrency(p.recognised)}</Td>
                  <Td className="text-xs">{formatCurrency(p.invoiced)}</Td>
                  <Td className="text-xs"><WipLabel wip={p.wip} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {closing && <ClosePeriod month={closing} onClose={() => setClosing(null)} />}
    </div>
  );
}

function ClosePeriod({ month, onClose }: { month: ReportMonth; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const run = async () => {
    setBusy(true);
    try {
      const r = await apiPost<{ totals: { recognised: number; projects: number }; unmeasured: { code: string; reasonFa: string }[] }>('/revenue/periods/close', { period: month.period });
      toast(`${month.labelFa} بسته شد: ${formatCurrency(r.totals.recognised)} درآمد در ${toPersianDigits(r.totals.projects)} پروژه${r.unmeasured.length ? `؛ ${toPersianDigits(r.unmeasured.length)} پروژه سنجیده نشد` : ''}.`);
      await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? 'بستن دوره ناموفق بود.', 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`بستن ${month.labelFa}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>انصراف</Button><Button variant="primary" loading={busy} onClick={() => void run()}>بستن دوره</Button></>}>
      <p className="text-sm text-ink-700">درآمد شناسایی‌شدهٔ {month.labelFa} ({formatCurrency(month.recognised)}) برای هر پروژه ثابت می‌شود.</p>
      <p className="mt-2 text-xs text-ink-500">دورهٔ بسته بازگشایی نمی‌شود. اگر بعداً ساعت، هزینه یا نقطهٔ عطفی با تاریخی در این ماه ثبت شود، اثرش در نخستین ماه باز به‌صورت اصلاحی می‌نشیند — این ماه همان می‌ماند که بسته شد.</p>
    </Modal>
  );
}

/** Marking a milestone done — the event milestone-based revenue is earned on. */
export function MilestoneDone({ projectId, milestoneId }: { projectId: string; milestoneId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <button className="text-[11px] text-brand-700 underline" onClick={async () => {
      try {
        await apiPatch(`/projects/${projectId}/milestones/${milestoneId}`, { completedAt: new Date().toISOString() });
        toast('نقطهٔ عطف انجام‌شده ثبت شد.');
        await qc.invalidateQueries();
      } catch (e: any) { toast(e?.message ?? 'ثبت ناموفق بود.', 'danger'); }
    }}>انجام شد</button>
  );
}
