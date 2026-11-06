import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OBLIGATION_KINDS, PAYMENT_PURPOSE_LABELS } from '@hiva/contracts';
import { apiGet, apiPost, downloadFile } from '../../lib/api';
import { useAuth, useSystemAdmin } from '../../lib/auth';
import { formatDate } from '../../lib/format';
import {
  Badge, Button, Card, Checkbox, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Modal, Select, StatTile, StateBadge, Table, Td, Textarea, Th, Tr, cx, useToast,
} from '../../components/ui';
import { JalaliDateInput } from '../../components/JalaliDateInput';
import { tr, trx } from '../../i18n';
import { AmountInput, Money, ObligationStatus, clientKey, kindLabel, pairLabel, useSiteOptions } from './shared';
import { SiteUpload } from './pickers';
import type { Project } from './Projects';

/**
 * A deployment project's money (ADR-103, module C): what is owed and when, what was paid against it,
 * the deposit — held, deducted, returned — and the closure's checklist. Every sum is the server's, in
 * the project's currency; the screen adds nothing up.
 */

interface Obligation { id: string; kind: string; categoryCode: string | null; description: string | null; periodStart: string | null; periodEnd: string | null; dueDate: string; amount: string; settledAmount: string; outstanding: string; overdue: boolean; status: string; source: string; closeReason: string | null }
interface Payment { id: string; purpose: keyof typeof PAYMENT_PURPOSE_LABELS; amount: string; paidAt: string; methodCode: string; reference: string | null; chequeNumber: string | null; chequeBank: string | null; chequeDate: string | null; note: string | null; reversedAt: string | null; reversalReason: string | null; recordedBy: { fullName: string }; reversedBy: { fullName: string } | null; allocations: { obligationId: string; amount: string; reversedAt: string | null }[] }
interface DepositEntry { id: string; kind: string; amount: string; reason: string | null; status: string; obligation: { id: string; kind: string; dueDate: string } | null; recordedBy: { id: string; fullName: string }; decidedBy: { fullName: string } | null; decisionComment: string | null; createdAt: string }
export interface Balances {
  currency: string; due: string; settled: string; outstanding: string; overdue: string; upcoming30: string; paidOut: string; paidIn: string; credit: string;
  byKind: Record<string, { due: string; settled: string; waived: string; outstanding: string; overdue: string }>;
  deposit: { original: string | null; held: string; deductionsApproved: string; deductionsPending: string; refunded: string; remaining: string; status: string };
  costs: { installation: string; transport: string; fabrication: string; total: string };
}
interface Ledger { obligations: Obligation[]; payments: Payment[]; deposits: DepositEntry[]; balances: Balances }

const ask = (e: any) => e?.message ?? tr('عملیات ناموفق بود.');
export const period = (o: { periodStart: string | null; periodEnd: string | null }) => (o.periodStart ? `${formatDate(o.periodStart)} — ${formatDate(o.periodEnd)}` : '');

export function ProjectLedger({ project: p }: { project: Project }) {
  const { can, user } = useAuth();
  const systemAdmin = useSystemAdmin();
  const opts = useSiteOptions();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery<Ledger>({ queryKey: ['/site-projects', p.id, 'ledger'], queryFn: () => apiGet(`/site-projects/${p.id}/ledger`) });
  const [paying, setPaying] = useState<{ purpose: Payment['purpose']; obligation?: Obligation } | null>(null);
  const [adding, setAdding] = useState(false);
  const [schedule, setSchedule] = useState<any>(null);
  const [closing, setClosing] = useState<{ o: Obligation; action: 'WAIVE' | 'VOID' } | null>(null);
  const [reversing, setReversing] = useState<Payment | null>(null);
  const [deducting, setDeducting] = useState(false);
  const [reason, setReason] = useState('');
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  const b = data.balances, cur = p.currency;
  const manage = can('rental.manage') && p.state !== 'CLOSED';
  const run = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); toast(done); await qc.invalidateQueries(); return true; } catch (e) { toast(ask(e), 'danger'); return false; } };
  const preview = async () => { try { setSchedule(await apiPost(`/site-projects/${p.id}/schedule`, { dryRun: true })); } catch (e) { toast(ask(e), 'danger'); } };
  const rows = data.obligations.filter((o) => filter === 'all' || ['OPEN', 'PARTIAL'].includes(o.status));
  const files = (rid: string, kind: string) => p.documents.filter((d) => d.siteRecordType === kind && d.siteRecordId === rid);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label={tr('مانده')} value={<Money value={b.outstanding} currency={cur} />} tone={Number(b.outstanding) > 0 ? 'warning' : 'success'} />
        <StatTile label={tr('سررسیدگذشته')} value={<Money value={b.overdue} currency={cur} />} tone={Number(b.overdue) > 0 ? 'danger' : 'neutral'} />
        <StatTile label={tr('۳۰ روز آینده')} value={<Money value={b.upcoming30} currency={cur} />} />
        <StatTile label={tr('پرداخت‌شده به مکان')} value={<Money value={b.paidOut} currency={cur} />} />
        <StatTile label={tr('ودیعهٔ نزد مکان')} value={<Money value={b.deposit.remaining} currency={cur} />} hint={depositStatus(b.deposit.status)} />
      </div>
      {Number(b.credit) > 0 && <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-amber-200">{tr('اضافه‌پرداخت به مکان:')} <Money value={b.credit} currency={cur} /> — {tr('به قلمی نسبت دهید یا برگشتش را ثبت کنید.')}</p>}
      {!p.scheduleGeneratedAt && (Number(p.rentAmount ?? 0) > 0 || Number(p.chargeAmount ?? 0) > 0) && (
        <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-amber-200">{tr('جدول اجاره و شارژ هنوز ساخته نشده است؛ یادآوری‌ها و سررسیدها از آن می‌آیند.')}</p>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="me-auto text-sm font-bold">{tr('تعهدات: اجاره، شارژ، ودیعه، جریمه و سایر')}</h3>
          <Select value={filter} onChange={(e) => setFilter(e.target.value as 'open' | 'all')} className="w-36 text-xs" aria-label={tr('نمایش')}><option value="open">{tr('فقط باز')}</option><option value="all">{tr('همه')}</option></Select>
          {manage && <Button size="sm" onClick={() => void preview()}>{p.scheduleGeneratedAt ? tr('بازسازی جدول اجاره') : tr('ساخت جدول اجاره')}</Button>}
          {manage && <Button size="sm" onClick={() => setAdding(true)}>{tr('قلم تازه')}</Button>}
          {manage && <Button size="sm" variant="primary" onClick={() => setPaying({ purpose: 'OBLIGATIONS' })}>{tr('ثبت پرداخت')}</Button>}
          <Button size="sm" variant="ghost" onClick={() => void downloadFile(`/site-data/export/obligations?siteProjectId=${p.id}&status=all`, 'obligations.xlsx')}>{tr('اکسل')}</Button>
        </div>
        {!rows.length ? <EmptyState title={filter === 'open' ? tr('قلم بازی نیست') : tr('قلمی ثبت نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('قلم')}</Th><Th>{tr('سررسید')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('تسویه‌شده')}</Th><Th>{tr('مانده')}</Th><Th>{tr('وضعیت')}</Th><Th /></tr></thead>
            <tbody>{rows.map((o) => (
              <Tr key={o.id} className={o.overdue ? 'bg-rose-50/40' : undefined}>
                <Td><span className="font-medium">{kindLabel(o.kind)}</span>{o.categoryCode && <span className="ms-1 text-xs text-ink-500">{opts.label('CHARGE_CATEGORY', o.categoryCode)}</span>}<span className="block text-xs text-ink-500">{o.description ?? period(o)}</span></Td>
                <Td><span className={cx('text-xs', o.overdue && 'font-semibold text-rose-700')}>{formatDate(o.dueDate)}</span></Td>
                <Td><Money value={o.amount} currency={cur} exact /></Td>
                <Td><Money value={o.settledAmount} currency={cur} tone="muted" /></Td>
                <Td><Money value={o.outstanding} currency={cur} tone={o.overdue ? 'danger' : undefined} /></Td>
                <Td><ObligationStatus status={o.status} overdue={o.overdue} />{o.closeReason && <span className="block text-xs text-ink-500">{o.closeReason}</span>}</Td>
                <Td>{manage && ['OPEN', 'PARTIAL'].includes(o.status) && (
                  <span className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setPaying({ purpose: 'OBLIGATIONS', obligation: o })}>{tr('پرداخت')}</Button>
                    {can('rental.approve') && <Button size="sm" variant="ghost" onClick={() => { setReason(''); setClosing({ o, action: 'WAIVE' }); }}>{tr('بخشودن')}</Button>}
                    {Number(o.settledAmount) === 0 && <Button size="sm" variant="ghost" onClick={() => { setReason(''); setClosing({ o, action: 'VOID' }); }}>{tr('باطل')}</Button>}
                  </span>
                )}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-bold">{tr('پرداخت‌ها')}</h3>
        {!data.payments.length ? <EmptyState title={tr('پرداختی ثبت نشده')} /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('تاریخ')}</Th><Th>{tr('نوع')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('نحوه')}</Th><Th>{tr('مرجع')}</Th><Th>{tr('ثبت')}</Th><Th /></tr></thead>
            <tbody>{data.payments.map((x) => (
              <Tr key={x.id} className={x.reversedAt ? 'opacity-60' : undefined}>
                <Td>{formatDate(x.paidAt)}</Td>
                <Td><Badge tone={x.purpose === 'OBLIGATIONS' ? 'neutral' : 'success'}>{pairLabel(PAYMENT_PURPOSE_LABELS, x.purpose)}</Badge></Td>
                <Td><Money value={x.amount} currency={cur} exact /></Td>
                <Td><span className="text-xs">{opts.label('PAYMENT_METHOD', x.methodCode)}{x.chequeNumber && ` · ${tr('چک {0}', x.chequeNumber)}${x.chequeDate ? ` (${formatDate(x.chequeDate)})` : ''}`}</span></Td>
                <Td><span className="text-xs">{x.reference ?? '—'}</span>{files(x.id, 'payment').map((d) => <button key={d.id} type="button" className="block text-xs text-brand-700 underline" onClick={() => void downloadFile(`/documents/${d.id}/download`, d.fileName)}>{d.fileName}</button>)}</Td>
                <Td><span className="text-xs">{x.recordedBy.fullName}</span>{x.reversedAt && <span className="block text-xs text-rose-700">{tr('برگشت: {0}', x.reversalReason ?? '')}</span>}</Td>
                <Td>{manage && !x.reversedAt && <span className="flex gap-1">
                  <SiteUpload label={tr('رسید')} fields={{ siteProjectId: p.id, siteRecordType: 'payment', siteRecordId: x.id }} accept="image/*,application/pdf" />
                  <Button size="sm" variant="ghost" onClick={() => { setReason(''); setReversing(x); }}>{tr('برگشت')}</Button>
                </span>}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="me-auto text-sm font-bold">{tr('ودیعه')}</h3>
          {manage && Number(b.deposit.remaining) > 0 && <Button size="sm" onClick={() => setDeducting(true)}>{tr('کسر از ودیعه')}</Button>}
          {manage && Number(b.deposit.remaining) > 0 && <Button size="sm" variant="primary" onClick={() => setPaying({ purpose: 'DEPOSIT_REFUND' })}>{tr('ثبت عودت ودیعه')}</Button>}
          {manage && Number(b.credit) > 0 && <Button size="sm" onClick={() => setPaying({ purpose: 'CREDIT_REFUND' })}>{tr('ثبت برگشت اضافه‌پرداخت')}</Button>}
        </div>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-6">
          {([[tr('ودیعهٔ قرارداد'), b.deposit.original], [tr('پرداخت‌شده'), b.deposit.held], [tr('کسر تأییدشده'), b.deposit.deductionsApproved], [tr('کسر در انتظار'), b.deposit.deductionsPending], [tr('عودت‌شده'), b.deposit.refunded], [tr('ماندهٔ قابل عودت'), b.deposit.remaining]] as const).map(([l, v]) => (
            <div key={l} className="rounded-lg p-2 ring-1 ring-ink-100"><dt className="text-xs text-ink-500">{l}</dt><dd><Money value={v} currency={cur} exact /></dd></div>
          ))}
        </dl>
        {data.deposits.length > 0 && (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('نوع')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('دلیل')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('ثبت / تصمیم')}</Th><Th /></tr></thead>
            <tbody>{data.deposits.map((d) => (
              <Tr key={d.id}>
                <Td>{d.kind === 'DEDUCTION' ? tr('کسر') : tr('عودت')}{d.obligation && <span className="block text-xs text-ink-500">{tr('بابت {0}، {1}', kindLabel(d.obligation.kind), formatDate(d.obligation.dueDate))}</span>}</Td>
                <Td><Money value={d.amount} currency={cur} exact /></Td>
                <Td><span className="text-xs">{d.reason ?? '—'}</span>{files(d.id, 'deduction').map((f) => <button key={f.id} type="button" className="block text-xs text-brand-700 underline" onClick={() => void downloadFile(`/documents/${f.id}/download`, f.fileName)}>{f.fileName}</button>)}</Td>
                <Td><StateBadge state={d.status} /></Td>
                <Td><span className="text-xs">{d.recordedBy.fullName}{d.decidedBy && ` / ${d.decidedBy.fullName}`}{d.decisionComment && `: ${d.decisionComment}`}</span></Td>
                <Td>{d.kind === 'DEDUCTION' && d.status === 'PROPOSED' && (
                  <span className="flex flex-wrap gap-1">
                    {manage && <SiteUpload label={tr('مستند')} fields={{ siteProjectId: p.id, siteRecordType: 'deduction', siteRecordId: d.id }} />}
                    {can('rental.approve') && (d.recordedBy.id !== user?.id || systemAdmin) && <>
                      <Button size="sm" variant="primary" onClick={() => void run(() => apiPost(`/site-deposit-entries/${d.id}/decision`, { decision: 'APPROVE' }), tr('کسر تأیید شد.'))}>{tr('تأیید')}</Button>
                      <Button size="sm" variant="danger" onClick={() => void run(() => apiPost(`/site-deposit-entries/${d.id}/decision`, { decision: 'REJECT' }), tr('کسر رد شد.'))}>{tr('رد')}</Button>
                    </>}
                  </span>
                )}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-bold">{tr('هزینه‌های پروژه')}</h3>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {([[tr('نصب'), b.costs.installation], [tr('حمل و نقل'), b.costs.transport], [tr('ساخت کانترها'), b.costs.fabrication], [tr('جمع'), b.costs.total]] as const).map(([l, v]) => (
            <div key={l} className="rounded-lg p-2 ring-1 ring-ink-100"><dt className="text-xs text-ink-500">{l}</dt><dd><Money value={v} currency={cur} /></dd></div>
          ))}
        </dl>
      </section>

      {paying && <PaymentForm project={p} obligations={data.obligations} balances={b} purpose={paying.purpose} preset={paying.obligation} onClose={() => setPaying(null)} />}
      {adding && <ObligationForm project={p} onClose={() => setAdding(false)} />}
      {deducting && <DeductionForm project={p} obligations={data.obligations} remaining={b.deposit.remaining} onClose={() => setDeducting(false)} />}
      {schedule && (
        <Modal open wide onClose={() => setSchedule(null)} title={tr('جدول اجاره — پیش‌نمایش')}
          footer={<><Button onClick={() => setSchedule(null)}>{tr('انصراف')}</Button><Button variant="primary" disabled={!schedule.create.length && !schedule.update.length && !schedule.void.length}
            onClick={() => void run(() => apiPost(`/site-projects/${p.id}/schedule`, { dryRun: false }), tr('جدول اجاره ثبت شد.')).then((ok) => ok && setSchedule(null))}>{tr('ثبت جدول')}</Button></>}>
          <p className="mb-2 text-sm text-ink-600">{tr('{0} قلم تازه، {1} قلم اصلاح، {2} قلم باطل؛ {3} قلم پرداخت‌شده دست نمی‌خورد.', schedule.create.length, schedule.update.length, schedule.void.length, schedule.kept.length)}</p>
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('قلم')}</Th><Th>{tr('دوره')}</Th><Th>{tr('سررسید')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('تغییر')}</Th></tr></thead>
            <tbody>
              {[...schedule.create.map((x: any) => ({ ...x, change: tr('تازه') })), ...schedule.update.map((x: any) => ({ ...x, change: tr('اصلاح') })), ...schedule.void.map((x: any) => ({ ...x, kind: x.scheduleKey.split(':')[0], change: tr('باطل') }))].map((x: any) => (
                <Tr key={`${x.scheduleKey}-${x.change}`}><Td>{kindLabel(x.kind)}</Td><Td><span className="text-xs">{period(x)}</span></Td><Td>{formatDate(x.dueDate)}</Td><Td><Money value={x.amount} currency={cur} exact /></Td><Td><Badge>{x.change}</Badge></Td></Tr>
              ))}
            </tbody>
          </Table>
        </Modal>
      )}
      {closing && (
        <Modal open onClose={() => setClosing(null)} draftKey={`close:${closing.action}:${closing.o.id}`} title={closing.action === 'WAIVE' ? tr('بخشودن {0}', kindLabel(closing.o.kind)) : tr('باطل کردن {0}', kindLabel(closing.o.kind))}
          footer={<><Button onClick={() => setClosing(null)}>{tr('انصراف')}</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={() => void run(() => apiPost(`/site-obligations/${closing.o.id}/close`, { action: closing.action, reason }), tr('ثبت شد.')).then((ok) => ok && setClosing(null))}>{tr('ثبت')}</Button></>}>
          <p className="mb-2 text-sm text-ink-600">{closing.action === 'WAIVE' ? tr('مکان مانده را بخشیده است؛ قلم با همین دلیل بسته می‌شود.') : tr('این قلم هرگز بدهی نبوده (اشتباه ثبت شده، یا پروژه زودتر تمام شده). فقط قلم بی‌پرداخت باطل می‌شود.')}</p>
          <Field label={tr('دلیل')} required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </Modal>
      )}
      {reversing && (
        <Modal open onClose={() => setReversing(null)} title={tr('برگشت پرداخت')} draftKey={`reverse:${reversing.id}`}
          footer={<><Button onClick={() => setReversing(null)}>{tr('انصراف')}</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={() => void run(() => apiPost(`/site-payments/${reversing.id}/reverse`, { reason }), tr('پرداخت برگشت خورد.')).then((ok) => ok && setReversing(null))}>{tr('برگشت')}</Button></>}>
          <p className="mb-2 text-sm text-ink-600">{tr('پرداخت پاک نمی‌شود؛ برگشت‌خورده علامت می‌خورد و آنچه تسویه کرده بود دوباره باز می‌شود. درست آن را دوباره ثبت کنید.')}</p>
          <Field label={tr('دلیل')} required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </Modal>
      )}
    </div>
  );
}

const depositStatus = (s: string) => ({ NONE: () => tr('پرداخت نشده'), HELD: () => tr('نزد مکان'), PARTIAL: () => tr('بخشی تعیین تکلیف شده'), REFUNDED: () => tr('عودت‌شده'), FORFEITED: () => tr('ضبط‌شده') } as Record<string, () => string>)[s]?.() ?? s;

function PaymentForm({ project: p, obligations, balances, purpose, preset, onClose }: { project: Project; obligations: Obligation[]; balances: Balances; purpose: Payment['purpose']; preset?: Obligation; onClose: () => void }) {
  const opts = useSiteOptions();
  const toast = useToast();
  const qc = useQueryClient();
  const open = obligations.filter((o) => ['OPEN', 'PARTIAL'].includes(o.status));
  const [key] = useState(clientKey);
  const [f, setF] = useState({ amount: preset?.outstanding.replace(/\.00$/, '') ?? (purpose === 'DEPOSIT_REFUND' ? balances.deposit.remaining.replace(/\.00$/, '') : purpose === 'CREDIT_REFUND' ? balances.credit.replace(/\.00$/, '') : ''), paidAt: new Date().toISOString().slice(0, 10), methodCode: preset?.kind === 'RENT' ? p.rentMethodCode ?? '' : preset?.kind === 'CHARGE' ? p.chargeMethodCode ?? '' : '', reference: '', chequeNumber: '', chequeBank: '', chequeDate: '', note: '' });
  const [pick, setPick] = useState<Record<string, string>>(preset ? { [preset.id]: preset.outstanding.replace(/\.00$/, '') } : {});
  const [manual, setManual] = useState(!!preset);
  const [busy, setBusy] = useState(false);
  const cheque = opts.all.find((o) => o.list === 'PAYMENT_METHOD' && o.code === f.methodCode)?.meta.isCheque;
  const save = async () => {
    setBusy(true);
    try {
      const allocations = purpose === 'OBLIGATIONS' && manual ? Object.entries(pick).filter(([, v]) => v && Number(v) > 0).map(([obligationId, amount]) => ({ obligationId, amount })) : undefined;
      await apiPost(`/site-projects/${p.id}/payments`, {
        purpose, amount: f.amount, paidAt: f.paidAt, methodCode: f.methodCode, reference: f.reference || null, chequeNumber: f.chequeNumber || null, chequeBank: f.chequeBank || null,
        chequeDate: f.chequeDate || null, note: f.note || null, allocations, clientKey: key,
      });
      toast(tr('پرداخت ثبت شد.')); await qc.invalidateQueries(); onClose();
    } catch (e) { toast(ask(e), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide onClose={onClose} title={pairLabel(PAYMENT_PURPOSE_LABELS, purpose)}
      footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!f.amount || !f.methodCode || (cheque && !f.chequeNumber)} onClick={() => void save()}>{tr('ثبت پرداخت')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={tr('مبلغ')} required><AmountInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} aria-label={tr('مبلغ')} /></Field>
        <Field label={tr('تاریخ پرداخت')} required><JalaliDateInput value={f.paidAt} onChange={(v) => setF({ ...f, paidAt: v })} label={tr('تاریخ پرداخت')} /></Field>
        <Field label={tr('نحوهٔ پرداخت')} required><Select value={f.methodCode} onChange={(e) => setF({ ...f, methodCode: e.target.value })}><option value="">—</option>{opts.choices('PAYMENT_METHOD').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
        <Field label={tr('شمارهٔ پیگیری / مرجع')}><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        {cheque && <>
          <Field label={tr('شمارهٔ چک')} required><Input value={f.chequeNumber} onChange={(e) => setF({ ...f, chequeNumber: e.target.value })} /></Field>
          <Field label={tr('بانک')}><Input value={f.chequeBank} onChange={(e) => setF({ ...f, chequeBank: e.target.value })} /></Field>
          <Field label={tr('تاریخ چک')}><JalaliDateInput value={f.chequeDate} onChange={(v) => setF({ ...f, chequeDate: v })} label={tr('تاریخ چک')} /></Field>
        </>}
        <div className="sm:col-span-3"><Field label={tr('یادداشت')}><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div>
      </div>
      {purpose === 'OBLIGATIONS' && (
        <div className="mt-4 space-y-2">
          <Checkbox label={tr('خودم مشخص می‌کنم بابت کدام اقلام است (وگرنه از قدیمی‌ترین سررسید)')} checked={manual} onChange={(e) => setManual(e.target.checked)} />
          {manual && (
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>{tr('قلم')}</Th><Th>{tr('سررسید')}</Th><Th>{tr('مانده')}</Th><Th>{tr('این پرداخت')}</Th></tr></thead>
              <tbody>{open.map((o) => (
                <Tr key={o.id}><Td>{kindLabel(o.kind)}<span className="block text-xs text-ink-500">{o.description ?? period(o)}</span></Td><Td>{formatDate(o.dueDate)}</Td><Td><Money value={o.outstanding} currency={p.currency} exact /></Td>
                  <Td><AmountInput value={pick[o.id] ?? ''} onChange={(v) => setPick({ ...pick, [o.id]: v })} aria-label={tr('مبلغ برای {0}', kindLabel(o.kind))} /></Td></Tr>
              ))}</tbody>
            </Table>
          )}
          <p className="text-xs text-ink-500">{tr('پرداخت بیش از اقلام باز، طبق تنظیمات سازمان پذیرفته نمی‌شود یا به‌صورت اضافه‌پرداخت نگه داشته می‌شود.')}</p>
        </div>
      )}
    </Modal>
  );
}

function ObligationForm({ project: p, onClose }: { project: Project; onClose: () => void }) {
  const opts = useSiteOptions();
  const toast = useToast();
  const qc = useQueryClient();
  const [o, setO] = useState({ kind: 'PENALTY', categoryCode: '', description: '', dueDate: new Date().toISOString().slice(0, 10), amount: '' });
  const save = async () => {
    try {
      await apiPost(`/site-projects/${p.id}/obligations`, { ...o, categoryCode: o.categoryCode || null, description: o.description || null });
      toast(tr('قلم ثبت شد.')); await qc.invalidateQueries(); onClose();
    } catch (e) { toast(ask(e), 'danger'); }
  };
  return (
    <Modal open onClose={onClose} title={tr('قلم تازه')} footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" disabled={!o.amount} onClick={() => void save()}>{tr('ثبت')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('نوع')}><Select value={o.kind} onChange={(e) => setO({ ...o, kind: e.target.value })}>{OBLIGATION_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}</Select></Field>
        <Field label={tr('دستهٔ هزینه')}><Select value={o.categoryCode} onChange={(e) => setO({ ...o, categoryCode: e.target.value })}><option value="">—</option>{opts.choices('CHARGE_CATEGORY').map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select></Field>
        <Field label={tr('مبلغ')} required><AmountInput value={o.amount} onChange={(v) => setO({ ...o, amount: v })} aria-label={tr('مبلغ')} /></Field>
        <Field label={tr('سررسید')} required><JalaliDateInput value={o.dueDate} onChange={(v) => setO({ ...o, dueDate: v })} label={tr('سررسید')} /></Field>
        <div className="sm:col-span-2"><Field label={tr('شرح')}><Input value={o.description} onChange={(e) => setO({ ...o, description: e.target.value })} /></Field></div>
      </div>
    </Modal>
  );
}

function DeductionForm({ project: p, obligations, remaining, onClose }: { project: Project; obligations: Obligation[]; remaining: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [d, setD] = useState({ amount: '', reason: '', obligationId: '' });
  const open = obligations.filter((o) => ['OPEN', 'PARTIAL'].includes(o.status) && o.kind !== 'DEPOSIT');
  const save = async () => {
    try {
      await apiPost(`/site-projects/${p.id}/deductions`, { amount: d.amount, reason: d.reason, obligationId: d.obligationId || null });
      toast(tr('کسر ثبت شد؛ مستندش را پیوست کنید تا همکار دیگری تأیید کند.')); await qc.invalidateQueries(); onClose();
    } catch (e) { toast(ask(e), 'danger'); }
  };
  return (
    <Modal open onClose={onClose} title={tr('کسر از ودیعه')} footer={<><Button onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" disabled={!d.amount || d.reason.trim().length < 3} onClick={() => void save()}>{tr('ثبت')}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-600">{tr('ماندهٔ قابل کسر:')} <Money value={remaining} currency={p.currency} exact /></p>
        <Field label={tr('مبلغ')} required><AmountInput value={d.amount} onChange={(v) => setD({ ...d, amount: v })} aria-label={tr('مبلغ')} /></Field>
        <Field label={tr('بابت قلم')} hint={tr('اگر مکان بدهی‌ای (اجاره، شارژ، جریمه) را از ودیعه برداشته، همان قلم با تأیید کسر تسویه می‌شود.')}>
          <Select value={d.obligationId} onChange={(e) => setD({ ...d, obligationId: e.target.value })}><option value="">{tr('— بابت خسارت یا هزینه‌ای بیرون از اقلام —')}</option>
            {open.map((o) => <option key={o.id} value={o.id}>{kindLabel(o.kind)} · {formatDate(o.dueDate)} · {o.outstanding}</option>)}</Select>
        </Field>
        <Field label={tr('دلیل')} required><Textarea value={d.reason} onChange={(e) => setD({ ...d, reason: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

/* ── the closure ─────────────────────────────────────────────────────────── */

const STEPS: Record<string, () => string> = {
  initiated: () => tr('شروع تسویه'), contract: () => tr('وضعیت قرارداد و بهره‌برداری'), rent: () => tr('اجارهٔ باقی‌مانده'), charge: () => tr('شارژ باقی‌مانده'),
  penalties: () => tr('جریمه‌ها و هزینه‌های اضافی'), others: () => tr('سایر تعهدات (نصب، حمل، ساخت)'), deposit: () => tr('تعیین تکلیف ودیعه: کسر و عودت'),
  deductions: () => tr('تصمیم دربارهٔ کسرهای پیشنهادی'), credit: () => tr('اضافه‌پرداختی نمانده'), settled: () => tr('تسویهٔ نهایی'), closed: () => tr('بستن پروژه'),
};

export function ClosurePanel({ project: p }: { project: Project }) {
  const { data, isLoading, error, refetch } = useQuery<{ state: string; steps: { key: string; done: boolean; outstanding?: string; remaining?: string; credit?: string }[]; verdict: { ok: boolean; messageFa?: string }; waivers: { id: string; reason: string; expiresAt: string }[]; closureStatement: Balances | null }>({
    queryKey: ['/site-projects', p.id, 'closure'], queryFn: () => apiGet(`/site-projects/${p.id}/closure`),
  });
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-600">{tr('بستن پروژه گام به گام: هر گام وقتی تیک می‌خورد که در دفتر مالی واقعاً انجام شده باشد. دکمه‌های «شروع تسویه»، «درخواست بستن» و «بستن پروژه» بالای صفحه‌اند.')}</p>
      <ol className="space-y-1.5">
        {data.steps.map((s, i) => (
          <li key={s.key} className={cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm ring-1', s.done ? 'bg-emerald-50/60 ring-emerald-200' : 'ring-ink-200')}>
            <span aria-hidden className={cx('grid size-6 place-items-center rounded-full text-xs font-bold', s.done ? 'bg-emerald-600 text-white' : 'bg-ink-100 text-ink-600')}>{s.done ? '✓' : i + 1}</span>
            <span className="flex-1">{STEPS[s.key]?.() ?? s.key}</span>
            {s.outstanding && Number(s.outstanding) > 0 && <Money value={s.outstanding} currency={p.currency} tone="danger" />}
            {s.remaining && Number(s.remaining) > 0 && <Money value={s.remaining} currency={p.currency} tone="danger" />}
            {s.credit && Number(s.credit) > 0 && <Money value={s.credit} currency={p.currency} tone="danger" />}
            <span className="sr-only">{s.done ? tr('انجام شد') : tr('مانده')}</span>
          </li>
        ))}
      </ol>
      {!data.verdict.ok && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">{trx(data.verdict.messageFa ?? '')}</p>}
      {data.waivers.length > 0 && <p className="text-sm text-ink-700">{tr('استثنای ثبت‌شده برای بستن با حساب باز: {0}', data.waivers.map((w) => w.reason).join('؛ '))}</p>}
      {data.closureStatement && (
        <Card title={tr('صورت‌وضعیت روز بستن')}>
          <dl className="grid grid-cols-2 gap-2 p-4 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-ink-500">{tr('جمع تعهدات')}</dt><dd><Money value={data.closureStatement.due} currency={p.currency} exact /></dd></div>
            <div><dt className="text-xs text-ink-500">{tr('پرداخت‌شده')}</dt><dd><Money value={data.closureStatement.paidOut} currency={p.currency} exact /></dd></div>
            <div><dt className="text-xs text-ink-500">{tr('کسر از ودیعه')}</dt><dd><Money value={data.closureStatement.deposit.deductionsApproved} currency={p.currency} exact /></dd></div>
            <div><dt className="text-xs text-ink-500">{tr('ودیعهٔ عودت‌شده')}</dt><dd><Money value={data.closureStatement.deposit.refunded} currency={p.currency} exact /></dd></div>
          </dl>
        </Card>
      )}
    </div>
  );
}
