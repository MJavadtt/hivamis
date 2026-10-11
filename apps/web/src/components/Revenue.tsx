import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, Input, Modal, ProgressBar, Select, StatTile, Table, Td, Th, Tr, useToast } from './ui';
import { formatCurrency, formatPercent, localDigits } from '../lib/format';
import { loc, tr, trx } from '../i18n';

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
  if (Math.abs(wip) < 1) return <span className="text-ink-500">{tr('هم‌تراز')}</span>;
  return wip > 0
    ? <span className="text-amber-700">{tr('{0} کار انجام‌شدهٔ صورت‌حساب‌نشده', formatCurrency(wip))}</span>
    : <span className="text-sky-700">{tr('{0} پیش‌صورت‌حساب (درآمد انتقالی)', formatCurrency(-wip))}</span>;
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
      toast(trx(r.noteFa ?? tr('شیوهٔ شناسایی درآمد به‌روز شد.')));
      setShares(null);
      await qc.invalidateQueries({ queryKey: ['/projects', projectId, 'revenue'] });
    } catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); }
  };

  return (
    <Card title={tr('شناسایی درآمد')}
      subtitle={tr('درآمد به نسبت کار انجام‌شده شناسایی می‌شود، نه هنگام امضای قرارداد و نه هنگام صدور فاکتور.')}
      action={editable ? (
        <Select value={data.method} onChange={(e) => void save({ method: e.target.value })} aria-label={tr('شیوهٔ شناسایی')}>
          {data.methods.map((m) => <option key={m.key} value={m.key}>{loc(m, 'label')}</option>)}
        </Select>
      ) : <Badge tone="neutral">{loc(data, 'method')}</Badge>}>
      <div className="space-y-4 p-4" data-testid="project-revenue">
        {p.reasonFa ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{loc(p, 'reason')}</p>
        ) : (
          <>
            <div>
              <div className="mb-1 flex justify-between text-xs text-ink-500">
                <span>{tr('پیشرفت: {0}', formatPercent((p.progress ?? 0) * 100))}</span>
                <span>{tr('ارزش قرارداد: {0}', formatCurrency(p.contractValue))}</span>
              </div>
              <ProgressBar value={(p.progress ?? 0) * 100} tone="success" />
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <StatTile label={tr('درآمد شناسایی‌شده تا امروز')} value={formatCurrency(p.recognised)} />
              <StatTile label={tr('صورت‌حساب‌شده')} value={formatCurrency(p.invoiced)} />
              <StatTile label={tr('کار در جریان')} value={<span className="text-sm"><WipLabel wip={p.wip} /></span>} />
            </div>
          </>
        )}
        {data.expectedLoss != null && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{tr('قرارداد زیان‌ده: هزینهٔ تمام‌شدهٔ اعلام‌شده {0} بیش از ارزش قرارداد است.', formatCurrency(data.expectedLoss))}</p>
        )}
        {p.notesFa.length > 0 && <ul className="space-y-0.5 text-xs text-ink-500">{p.notesFa.map((n) => <li key={n}>· {trx(n)}</li>)}</ul>}

        {data.method === 'MILESTONE' && (
          <div className="rounded-lg ring-1 ring-ink-200">
            <div className="flex items-center justify-between px-3 py-2 text-xs">
              <span className="font-medium text-ink-700">{tr('سهم درآمد نقاط عطف')}</span>
              {editable && !shares && <button className="text-brand-700 underline" onClick={() => setShares(Object.fromEntries(data.milestones.map((m) => [m.id, m.revenueShare == null ? '' : String(m.revenueShare)])))}>{tr('ویرایش')}</button>}
            </div>
            <ul className="divide-y divide-ink-100 text-xs" data-testid="milestone-shares">
              {data.milestones.map((m) => (
                <li key={m.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="flex-1 text-ink-700">{m.name}</span>
                  {m.completedAt ? <Badge tone="success">{tr('انجام‌شده')}</Badge> : <Badge tone="neutral">{tr('پیش رو')}</Badge>}
                  {shares
                    ? <Input type="number" className="ltr w-20" value={shares[m.id] ?? ''} aria-label={tr('سهم {0}', m.name)} onChange={(e) => setShares({ ...shares, [m.id]: e.target.value })} />
                    : <span className="w-16 text-end nums">{m.revenueShare == null ? '—' : tr('{0}٪', localDigits(m.revenueShare))}</span>}
                </li>
              ))}
            </ul>
            {shares && (
              <div className="flex justify-end gap-2 px-3 py-2">
                <Button size="sm" variant="ghost" onClick={() => setShares(null)}>{tr('انصراف')}</Button>
                <Button size="sm" variant="primary" onClick={() => void save({ shares: Object.entries(shares).map(([milestoneId, v]) => ({ milestoneId, revenueShare: v === '' ? null : Number(v) })) })}>{tr('ذخیره')}</Button>
              </div>
            )}
          </div>
        )}

        {data.months.length > 0 && (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('ماه')}</Th><Th>{tr('شناسایی‌شده')}</Th><Th>{tr('صورت‌حساب‌شده')}</Th><Th /></tr></thead>
            <tbody>
              {data.months.map((m) => (
                <Tr key={m.period}>
                  <Td className="text-xs">{loc(m, 'label')}</Td>
                  <Td className="text-xs">{formatCurrency(m.recognised)}</Td>
                  <Td className="text-xs">{formatCurrency(m.invoiced)}</Td>
                  <Td>{m.closed && <Badge tone="neutral">{tr('بسته‌شده')}</Badge>}</Td>
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
  contractValueIncludesTax: boolean;
  months: ReportMonth[]; lastClosed: string | null; nextToClose: string | null;
  wip: { unbilled: number; deferred: number };
  projects: { id: string; code: string; name: string; client: string; methodFa: string; contractValue: number | null; progress: number | null; recognised: number | null; invoiced: number; wip: number | null; reasonFa: string | null; expectedLoss: number | null }[];
}

export function RevenueReport() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery<RevenueReportData>({ queryKey: ['/reports/revenue'], queryFn: () => apiGet('/reports/revenue', { months: 12 }) });
  const [closing, setClosing] = useState<ReportMonth | null>(null);
  if (!data) return null;
  // Audit CALC-1: invoices are compared with what was earned on the contract values' own footing.
  const setTaxBasis = async (includes: boolean) => {
    try {
      await apiPatch('/organization', { contractValueIncludesTax: includes });
      await qc.invalidateQueries({ queryKey: ['/reports/revenue'] });
      toast(tr('مبنای مقایسهٔ فاکتورها به‌روز شد.'));
    } catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); }
  };
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
        <StatTile label={tr('کار انجام‌شدهٔ صورت‌حساب‌نشده')} value={formatCurrency(data.wip.unbilled)} hint={tr('درآمدی که به‌دست آمده و هنوز فاکتور نشده')} tone="warning" />
        <StatTile label={tr('پیش‌صورت‌حساب (درآمد انتقالی)')} value={formatCurrency(data.wip.deferred)} hint={tr('فاکتورشده پیش از انجام کار')} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-600" data-testid="tax-basis">
        <span>{data.contractValueIncludesTax
          ? tr('ارزش قراردادها با مالیات بر ارزش افزوده ثبت شده‌اند؛ فاکتورها با جمع کل‌شان سنجیده می‌شوند.')
          : tr('ارزش قراردادها بدون مالیات بر ارزش افزوده ثبت شده‌اند؛ فاکتورها بدون مالیات سنجیده می‌شوند.')}</span>
        {can('admin.settings') && (
          <Button size="sm" variant="ghost" onClick={() => void setTaxBasis(!data.contractValueIncludesTax)}>
            {data.contractValueIncludesTax ? tr('قراردادها بدون مالیات‌اند') : tr('قراردادها با مالیات‌اند')}
          </Button>
        )}
      </div>
      <Card title={tr('سودآوری ماهانه — درآمد شناسایی‌شده در برابر صورت‌حساب')}
        subtitle={tr('ستون «حاشیه» با درآمد به‌دست‌آمده حساب می‌شود؛ «حاشیه به روش فاکتور» همان ماه را آن‌طور نشان می‌دهد که پیش از شناسایی درآمد دیده می‌شد.')}
        action={can('finance.settle') && closable[0] ? <Button size="sm" variant="secondary" onClick={() => setClosing(closable[0]!)}>{tr('بستن {0}', closable[0].labelFa)}</Button> : undefined}>
        <Table>
          <thead className="bg-ink-50/60"><tr><Th>{tr('ماه')}</Th><Th>{tr('درآمد شناسایی‌شده')}</Th><Th>{tr('صورت‌حساب‌شده')}</Th><Th>{tr('هزینهٔ کار')}</Th><Th>{tr('هزینهٔ بیرونی')}</Th><Th>{tr('حاشیه')}</Th><Th>{tr('حاشیه به روش فاکتور')}</Th></tr></thead>
          <tbody data-testid="revenue-months">
            {data.months.map((m) => (
              <Tr key={m.period}>
                <Td className="text-xs">{loc(m, 'label')} {m.closed && <Badge tone="neutral">{tr('بسته')}</Badge>}</Td>
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
        {unpriced > 0 && <p className="px-4 py-2 text-[12.5px] text-ink-500">{tr('{0} ساعت کار بدون نرخ ساعتی ثبت شده و در هزینهٔ کار نیامده است — نرخ واحدها را در «مدیریت» تعیین کنید.', localDigits(Math.round(unpriced)))}</p>}
      </Card>
      <Card title={tr('کار در جریان به تفکیک پروژه')}>
        {!data.projects.length ? <EmptyState title={tr('پروژه‌ای با ارزش قرارداد نیست')} /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('پروژه')}</Th><Th>{tr('شیوه')}</Th><Th>{tr('پیشرفت')}</Th><Th>{tr('شناسایی‌شده')}</Th><Th>{tr('صورت‌حساب‌شده')}</Th><Th>{tr('کار در جریان')}</Th></tr></thead>
            <tbody>
              {data.projects.map((p) => (
                <Tr key={p.id}>
                  <Td className="text-xs"><Link to={`/projects/${p.id}`} className="text-brand-700 hover:underline">{p.name}</Link> <span className="text-ink-400">{p.client}</span>
                    {p.expectedLoss != null && <Badge tone="danger">{tr('زیان‌ده')}</Badge>}</Td>
                  <Td className="text-[12.5px] text-ink-500">{loc(p, 'method')}</Td>
                  <Td className="text-xs">{p.progress == null ? <span className="text-amber-700" title={trx(p.reasonFa ?? '')}>{tr('سنجیده نشد')}</span> : formatPercent(p.progress * 100)}</Td>
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
      toast(tr('{0} بسته شد: {1} درآمد در {2} پروژه{3}.', month.labelFa, formatCurrency(r.totals.recognised), localDigits(r.totals.projects), r.unmeasured.length ? tr('؛ {0} پروژه سنجیده نشد', localDigits(r.unmeasured.length)) : ''));
      await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? tr('بستن دوره ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('بستن {0}', month.labelFa)} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} onClick={() => void run()}>{tr('بستن دوره')}</Button></>}>
      <p className="text-sm text-ink-700">{tr('درآمد شناسایی‌شدهٔ {0} ({1}) برای هر پروژه ثابت می‌شود.', month.labelFa, formatCurrency(month.recognised))}</p>
      <p className="mt-2 text-xs text-ink-500">{tr('دورهٔ بسته بازگشایی نمی‌شود. اگر بعداً ساعت، هزینه یا نقطهٔ عطفی با تاریخی در این ماه ثبت شود، اثرش در نخستین ماه باز به‌صورت اصلاحی می‌نشیند — این ماه همان می‌ماند که بسته شد.')}</p>
    </Modal>
  );
}

/** Marking a milestone done — the event milestone-based revenue is earned on. */
export function MilestoneDone({ projectId, milestoneId }: { projectId: string; milestoneId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <button className="text-[12.5px] text-brand-700 underline" onClick={async () => {
      try {
        await apiPatch(`/projects/${projectId}/milestones/${milestoneId}`, { completedAt: new Date().toISOString() });
        toast(tr('نقطهٔ عطف انجام‌شده ثبت شد.'));
        await qc.invalidateQueries();
      } catch (e: any) { toast(e?.message ?? tr('ثبت ناموفق بود.'), 'danger'); }
    }}>{tr('انجام شد')}</button>
  );
}
