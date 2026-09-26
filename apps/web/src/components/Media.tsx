import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MEDIA_CHANNELS, MEDIA_CHANNEL_LABELS, type MediaChannel } from '@hiva/contracts';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Code, WorkflowActions } from './common';
import { CurrencySelect, FxPreview, money } from './Fx';
import { JalaliDateInput } from './JalaliDateInput';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, StateBadge, StatTile, Table, Td, Th, Tr, useToast } from './ui';
import { formatCurrency, formatDate, localDateOnly, toPersianDigits } from '../lib/format';

/* Roadmap #31 — media bought on a client's behalf: the vendor's net passes through, the commission is the agency's. */

export const channelFa = (c: string) => MEDIA_CHANNEL_LABELS[c as MediaChannel] ?? c;
const MEDIA_UNITS = ['ME', 'A', 'M'];

interface MediaOrder {
  id: string; code: string; state: string; channel: string; placement: string; flightStart: string; flightEnd: string;
  pricingModel: 'COMMISSION' | 'MARKUP'; commissionPercent: string; currency: string;
  clientAmount: string; netAmount: string; agencyRevenue: string; originalClientAmount: string | null; originalNetAmount: string | null;
  vendorInvoiceAmount: string | null; vendorInvoiceNumber: string | null; discrepancyNote: string | null; proofNote: string | null;
  supplier: { id: string; name: string }; clientInvoice: { id: string; number: string } | null;
  availableTransitions: any[];
}

/** Commission under COMMISSION, markup under MARKUP — named as the deal names it. */
const pctLabel = (o: Pick<MediaOrder, 'pricingModel' | 'commissionPercent'>) =>
  `${o.pricingModel === 'COMMISSION' ? 'کمیسیون' : 'کارمزد'} ${toPersianDigits(Number(o.commissionPercent))}٪`;

export function ProjectMedia({ projectId }: { projectId: string }) {
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const { data } = useQuery<{ items: MediaOrder[] }>({ queryKey: ['/media-orders', projectId], queryFn: () => apiGet('/media-orders', { projectId, pageSize: 100 }) });
  const [creating, setCreating] = useState(false);
  const [invoicing, setInvoicing] = useState<MediaOrder | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['/media-orders', projectId] });
  const orders = data?.items ?? [];
  const live = orders.filter((o) => o.state !== 'CANCELLED');
  const total = (k: 'clientAmount' | 'netAmount' | 'agencyRevenue') => live.reduce((s, o) => s + Number(o[k]), 0);
  const billable = orders.filter((o) => ['BOOKED', 'AIRED', 'RECONCILED'].includes(o.state) && !o.clientInvoice);
  const mayBuy = can('media.buy') && (can('pricing.set_price') || MEDIA_UNITS.includes(user?.department?.code ?? ''));
  const [billing, setBilling] = useState(false);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <StatTile label="صورت‌حساب مشتری بابت رسانه" value={formatCurrency(total('clientAmount'))} />
        <StatTile label="عبوری به رسانه‌ها" value={formatCurrency(total('netAmount'))} hint="درآمد آژانس نیست" />
        <StatTile label="سهم آژانس" value={formatCurrency(total('agencyRevenue'))} tone="success" hint="هنگام پخش شناسایی می‌شود" />
      </div>
      <Card title="سفارش‌های خرید رسانه"
        action={<div className="flex gap-2">
          {can('finance.invoice') && selected.length > 0 && <Button size="sm" variant="secondary" onClick={() => setBilling(true)}>صورت‌حساب {toPersianDigits(selected.length)} سفارش</Button>}
          {mayBuy && <Button size="sm" variant="primary" onClick={() => setCreating(true)}>سفارش رسانهٔ تازه</Button>}
        </div>}>
        {!orders.length ? <EmptyState title="سفارش رسانه‌ای ثبت نشده" /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th /><Th>سفارش</Th><Th>رسانه</Th><Th>پخش</Th><Th>مشتری / عبوری / آژانس</Th><Th>صورت‌حساب</Th><Th>وضعیت</Th><Th /></tr></thead>
            <tbody data-testid="media-orders">
              {orders.map((o) => (
                <Tr key={o.id}>
                  <Td>{can('finance.invoice') && billable.includes(o) && (
                    <input type="checkbox" aria-label={`انتخاب ${o.code}`} checked={selected.includes(o.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, o.id] : selected.filter((x) => x !== o.id))} />
                  )}</Td>
                  <Td className="text-xs"><Code>{o.code}</Code><p className="mt-0.5 text-ink-700">{channelFa(o.channel)} — {o.placement}</p></Td>
                  <Td className="text-xs">{o.supplier.name}<p className="text-[10px] text-ink-400">{pctLabel(o)}</p></Td>
                  <Td className="text-xs">{formatDate(o.flightStart)} تا {formatDate(o.flightEnd)}</Td>
                  <Td className="text-xs">
                    {money(o.originalClientAmount ?? o.clientAmount, o.currency)}
                    <p className="text-[10px] text-ink-400">عبوری {money(o.originalNetAmount ?? o.netAmount, o.currency)} · آژانس {formatCurrency(o.agencyRevenue)}</p>
                  </Td>
                  <Td className="text-xs">{o.clientInvoice ? <span className="ltr">{o.clientInvoice.number}</span> : <span className="text-ink-400">—</span>}
                    {o.vendorInvoiceAmount != null && <p className="text-[10px] text-ink-500">رسانه: {money(o.vendorInvoiceAmount, o.currency)}</p>}
                  </Td>
                  <Td><StateBadge state={o.state} /></Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      {can('finance.payment') && ['BOOKED', 'AIRED'].includes(o.state) && <Button size="sm" variant="ghost" onClick={() => setInvoicing(o)}>صورت‌حساب رسانه</Button>}
                      <WorkflowActions entity="mediaOrder" id={o.id} transitions={o.availableTransitions} onDone={() => void refresh()} />
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating && <NewMediaOrder projectId={projectId} onClose={() => setCreating(false)} />}
      {invoicing && <VendorInvoice order={invoicing} onClose={() => setInvoicing(null)} />}
      {billing && <BillMedia projectId={projectId} orders={orders.filter((o) => selected.includes(o.id))} onClose={(done) => { setBilling(false); if (done) setSelected([]); }} />}
    </div>
  );
}

/** The intermediary invoice: the client billed for the chosen orders, pass-through and commission apart. */
function BillMedia({ projectId, orders, onClose }: { projectId: string; orders: MediaOrder[]; onClose: (done: boolean) => void }) {
  const [v, setV] = useState({ number: '', issueDate: localDateOnly(new Date()), taxPercent: '0' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const currency = orders[0]?.currency ?? 'IRR';
  const net = orders.reduce((s, o) => s + Number(o.originalNetAmount ?? o.netAmount), 0);
  const client = orders.reduce((s, o) => s + Number(o.originalClientAmount ?? o.clientAmount), 0);
  const save = async () => {
    setBusy(true);
    try {
      await apiPost(`/projects/${projectId}/media-billing`, { orderIds: orders.map((o) => o.id), number: v.number.trim(), issueDate: v.issueDate, taxPercent: Number(v.taxPercent || 0) });
      toast('صورت‌حساب رسانه صادر شد: هزینهٔ عبوری و کمیسیون در ردیف‌های جدا.');
      await qc.invalidateQueries(); onClose(true);
    } catch (e: any) {
      toast([e?.message, ...((e?.body?.details?.problems as string[]) ?? [])].filter(Boolean).join(' — '), 'danger');
    } finally { setBusy(false); }
  };
  return (
    <Modal open title="صورت‌حساب رسانه به مشتری" onClose={() => onClose(false)}
      footer={<><Button variant="ghost" onClick={() => onClose(false)}>انصراف</Button><Button variant="primary" loading={busy} disabled={!v.number.trim()} onClick={() => void save()}>صدور</Button></>}>
      <div className="grid gap-3">
        <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-700" data-testid="media-bill-split">
          {toPersianDigits(orders.length)} سفارش: هزینهٔ عبوری رسانه {money(net, currency)} + {orders[0]?.pricingModel === 'MARKUP' ? 'کارمزد' : 'کمیسیون'} آژانس {money(client - net, currency)} = <strong>{money(client, currency)}</strong>
        </p>
        <Field label="شمارهٔ صورت‌حساب" required><Input value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} className="ltr" aria-label="شمارهٔ صورت‌حساب" /></Field>
        <Field label="تاریخ صدور"><JalaliDateInput mode="date" value={v.issueDate} onChange={(d) => setV({ ...v, issueDate: d || v.issueDate })} /></Field>
        <Field label="مالیات (٪)"><Input type="number" value={v.taxPercent} onChange={(e) => setV({ ...v, taxPercent: e.target.value })} className="ltr" aria-label="مالیات" /></Field>
      </div>
    </Modal>
  );
}

function NewMediaOrder({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const today = localDateOnly(new Date());
  const [v, setV] = useState({ supplierId: '', channel: 'TV', placement: '', flightStart: today, flightEnd: today, pricingModel: 'COMMISSION', amount: '', commissionPercent: '15', currency: 'IRR' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const { data: suppliers } = useQuery<{ items: { id: string; name: string; departmentCode: string | null }[] }>({ queryKey: ['/suppliers', 'media'], queryFn: () => apiGet('/suppliers', { pageSize: 200 }) });
  const amount = Number(v.amount || 0), pct = Number(v.commissionPercent || 0) / 100;
  const client = v.pricingModel === 'COMMISSION' ? amount : amount * (1 + pct);
  const net = v.pricingModel === 'COMMISSION' ? amount * (1 - pct) : amount;
  const save = async () => {
    setBusy(true);
    try {
      await apiPost('/media-orders', { projectId, ...v, amount, commissionPercent: Number(v.commissionPercent) });
      toast('سفارش رسانه ثبت شد (پیش‌نویس).'); await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? 'ثبت ناموفق بود.', 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide title="سفارش خرید رسانه" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>انصراف</Button><Button variant="primary" loading={busy} disabled={!v.supplierId || v.placement.trim().length < 3 || !(amount > 0)} onClick={() => void save()}>ثبت</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="رسانه (تأمین‌کننده)" required>
          <Select value={v.supplierId} onChange={(e) => setV({ ...v, supplierId: e.target.value })} aria-label="رسانه">
            <option value="">—</option>
            {(suppliers?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="نوع رسانه">
          <Select value={v.channel} onChange={(e) => setV({ ...v, channel: e.target.value })} aria-label="نوع رسانه">
            {MEDIA_CHANNELS.map((c) => <option key={c} value={c}>{channelFa(c)}</option>)}
          </Select>
        </Field>
        <div className="sm:col-span-2"><Field label="جایگاه و شرح" required><Input value={v.placement} onChange={(e) => setV({ ...v, placement: e.target.value })} aria-label="جایگاه" placeholder="مثلاً: تیزر ۳۰ ثانیه، پیش از اخبار ۲۱، ۲۰ نوبت" /></Field></div>
        <Field label="آغاز پخش"><JalaliDateInput mode="date" value={v.flightStart} onChange={(d) => setV({ ...v, flightStart: d || v.flightStart })} /></Field>
        <Field label="پایان پخش"><JalaliDateInput mode="date" value={v.flightEnd} onChange={(d) => setV({ ...v, flightEnd: d || v.flightEnd })} /></Field>
        <Field label="مدل قیمت" hint={v.pricingModel === 'COMMISSION' ? 'مشتری ناخالص را می‌پردازد؛ رسانه کمیسیون آژانس را کسر می‌کند' : 'رسانه خالص را می‌گیرد؛ مشتری خالص به‌علاوهٔ کارمزد آژانس را می‌پردازد'}>
          <Select value={v.pricingModel} onChange={(e) => setV({ ...v, pricingModel: e.target.value })} aria-label="مدل قیمت">
            <option value="COMMISSION">کمیسیون از ناخالص</option><option value="MARKUP">کارمزد روی خالص</option>
          </Select>
        </Field>
        <Field label={v.pricingModel === 'COMMISSION' ? 'درصد کمیسیون' : 'درصد کارمزد'}><Input type="number" value={v.commissionPercent} onChange={(e) => setV({ ...v, commissionPercent: e.target.value })} className="ltr" aria-label="درصد" /></Field>
        <Field label={v.pricingModel === 'COMMISSION' ? 'مبلغ ناخالص رسانه' : 'مبلغ خالص رسانه'} required><Input type="number" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} className="ltr" aria-label="مبلغ رسانه" /></Field>
        <Field label="ارز"><CurrencySelect value={v.currency} onChange={(c) => setV({ ...v, currency: c })} /></Field>
      </div>
      {amount > 0 && (
        <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-700" data-testid="media-split">
          مشتری: <strong>{money(client, v.currency)}</strong> · عبوری به رسانه: {money(net, v.currency)} · سهم آژانس: <strong>{money(client - net, v.currency)}</strong>
        </p>
      )}
      <div className="mt-2"><FxPreview currency={v.currency} amount={client} on={null} /></div>
    </Modal>
  );
}

function VendorInvoice({ order, onClose }: { order: MediaOrder; onClose: () => void }) {
  const expected = Number(order.originalNetAmount ?? order.netAmount);
  const [v, setV] = useState({ number: order.vendorInvoiceNumber ?? '', amount: order.vendorInvoiceAmount ?? String(expected), invoiceDate: localDateOnly(new Date()), discrepancyNote: order.discrepancyNote ?? '' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const diff = Number(v.amount || 0) - expected;
  const off = Math.abs(diff) > Math.max(1, expected * 0.005);
  const save = async () => {
    setBusy(true);
    try {
      await apiPost(`/media-orders/${order.id}/vendor-invoice`, { ...v, amount: Number(v.amount), discrepancyNote: v.discrepancyNote || undefined });
      toast('صورت‌حساب رسانه ثبت شد.'); await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? 'ثبت ناموفق بود.', 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`صورت‌حساب رسانه — ${order.code}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>انصراف</Button><Button variant="primary" loading={busy} disabled={!v.number.trim() || !(Number(v.amount) > 0)} onClick={() => void save()}>ثبت</Button></>}>
      <div className="grid gap-3">
        <p className="text-xs text-ink-600">خالص رزروشده: <strong>{money(expected, order.currency)}</strong></p>
        <Field label="شمارهٔ صورت‌حساب رسانه" required><Input value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} className="ltr" aria-label="شماره" /></Field>
        <Field label={`مبلغ (${order.currency})`} required><Input type="number" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} className="ltr" aria-label="مبلغ صورت‌حساب" /></Field>
        <Field label="تاریخ"><JalaliDateInput mode="date" value={v.invoiceDate} onChange={(d) => setV({ ...v, invoiceDate: d || v.invoiceDate })} /></Field>
        {off && (
          <>
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="media-discrepancy">اختلاف با رزرو: {money(diff, order.currency)} — برای تطبیق، دلیل آن را بنویسید.</p>
            <Field label="دلیل اختلاف"><Input value={v.discrepancyNote} onChange={(e) => setV({ ...v, discrepancyNote: e.target.value })} aria-label="دلیل اختلاف" /></Field>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ── The organisation's media ──────────────────────────────────────────── */

export function MediaReport() {
  const { data } = useQuery<any>({ queryKey: ['/reports/media'], queryFn: () => apiGet('/reports/media') });
  if (!data) return null;
  if (!data.totals.orders) return <Card title="رسانه"><EmptyState title="سفارش رسانه‌ای ثبت نشده" /></Card>;
  const exc = data.exceptions;
  const Exception = ({ title, rows, hint }: { title: string; rows: any[]; hint: string }) => (
    <Card title={`${title} (${toPersianDigits(rows.length)})`} subtitle={hint}>
      {!rows.length ? <p className="px-4 py-3 text-xs text-emerald-700">موردی نیست.</p> : (
        <ul className="divide-y divide-ink-100 text-xs">
          {rows.map((o) => <li key={o.id} className="px-4 py-2"><Code>{o.code}</Code> {o.placement} — {o.supplier.name} — {o.project.name} — {money(o.clientAmount)}{o.discrepancyNote ? <span className="text-ink-500"> — {o.discrepancyNote}</span> : null}</li>)}
        </ul>
      )}
    </Card>
  );
  return (
    <div className="space-y-5" data-testid="media-report">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="صورت‌حساب رسانه به مشتریان" value={formatCurrency(data.totals.billings)} />
        <StatTile label="عبوری به رسانه‌ها" value={formatCurrency(data.totals.passThrough)} hint="درآمد آژانس نیست" />
        <StatTile label="درآمد آژانس از رسانه" value={formatCurrency(data.totals.revenue)} tone="success" />
        <StatTile label="نرخ مؤثر" value={data.totals.effectivePercent == null ? '—' : `${toPersianDigits(data.totals.effectivePercent)}٪`} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {[['به تفکیک نوع رسانه', data.byChannel], ['به تفکیک رسانه', data.byVendor]].map(([title, rows]) => (
          <Card key={title as string} title={title as string}>
            <Table>
              <thead className="bg-ink-50/60"><tr><Th /><Th>صورت‌حساب</Th><Th>عبوری</Th><Th>آژانس</Th><Th>٪</Th></tr></thead>
              <tbody>
                {(rows as any[]).map((r) => (
                  <Tr key={r.key}><Td className="text-xs">{r.labelFa}</Td><Td className="text-xs">{formatCurrency(r.billings)}</Td><Td className="text-xs">{formatCurrency(r.passThrough)}</Td><Td className="text-xs">{formatCurrency(r.revenue)}</Td><Td className="text-xs">{r.effectivePercent == null ? '—' : toPersianDigits(r.effectivePercent)}</Td></Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Exception title="پخش‌شده، صورت‌حساب‌نشده" rows={exc.unbilled} hint="آژانس رسانهٔ مشتری را از جیب خود تأمین می‌کند" />
        <Exception title="پایان پخش، بی‌گواهی" rows={exc.unproven} hint="دورهٔ پخش تمام شده و گواهی پخش ثبت نشده" />
        <Exception title="در انتظار صورت‌حساب رسانه" rows={exc.awaitingVendorInvoice} hint="بدهی‌ای که هنوز کسی ندیده" />
        <Exception title="اختلاف با صورت‌حساب رسانه" rows={exc.discrepancies} hint="رسانه چیزی جز رزرو صورت‌حساب کرده است" />
      </div>
      <p className="text-[11px] text-ink-400"><Badge tone="neutral">{toPersianDigits(data.totals.orders)} سفارش</Badge> — عبوری در درآمد و حاشیهٔ پروژه‌ها شمرده نمی‌شود؛ کمیسیون هنگام پخش شناسایی می‌شود.</p>
    </div>
  );
}
