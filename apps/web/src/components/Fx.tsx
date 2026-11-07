import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENCIES, CURRENCY_LABELS, type Currency } from '@hiva/contracts';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EntitySelect } from '../pages/Forms';
import { JalaliDateInput } from './JalaliDateInput';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Modal, Select, StatTile, Table, Td, Textarea, Th, Tr, useToast } from './ui';
import { DraftScope, useDraftState } from '../lib/drafts';
import { formatCurrency, formatDate, formatNumber, localDateOnly, localDigits } from '../lib/format';
import { loc, tr, trx } from '../i18n';

/** How a payment was made, in words — the payments list showed TRANSFER as the API spells it (audit UI-V). */
export const PAYMENT_METHODS: Record<string, string> = {
  TRANSFER: tr('انتقال بانکی'), CHEQUE: tr('چک'), CASH: tr('نقد'), OTHER: tr('سایر'),
};

/* Roadmap #28 — amounts in more than one currency, each converted at the rate of its own day. */

export const currencyFa = (c: string) => trx(CURRENCY_LABELS[c as Currency] ?? c);

/** A figure in its own currency: rials abbreviated as everywhere else, others exact with their name. */
export function money(value: number | string | null | undefined, currency = 'IRR'): string {
  if (currency === 'IRR') return formatCurrency(value);
  if (value === null || value === undefined || value === '') return '—';
  return `${formatNumber(value, Number(value) % 1 ? 2 : 0)} ${currencyFa(currency)}`;
}

/** An amount as it was written, with its rial value under it when it was written in something else. */
export function Amount({ base, original, currency }: { base: unknown; original?: unknown; currency?: string }) {
  if (!currency || currency === 'IRR' || original == null) return <span title={formatNumber(base as number)}>{formatCurrency(base as number)}</span>;
  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="font-medium">{money(original as number, currency)}</span>
      <span className="text-[12px] text-ink-400">{formatCurrency(base as number)}</span>
    </span>
  );
}

export function CurrencySelect({ value, onChange, label = tr('ارز') }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {CURRENCIES.map((c) => <option key={c} value={c}>{currencyFa(c)} ({c})</option>)}
    </Select>
  );
}

interface RateLookup { rate: string | number | null; effectiveDate: string | null; ageDays: number | null; usable: boolean; maxAgeDays?: number }

/** What a figure will be in rials, at the rate in force on its day — shown while it is typed. */
export function FxPreview({ currency, amount, on }: { currency: string; amount: number; on: string | null }) {
  const enabled = currency !== 'IRR';
  const { data } = useQuery<RateLookup>({
    queryKey: ['/fx/rate', currency, on],
    queryFn: () => apiGet('/fx/rate', { currency, on: on ?? undefined }),
    enabled,
  });
  if (!enabled) return null;
  if (!data) return <p className="text-[12.5px] text-ink-400">{tr('در حال یافتن نرخ…')}</p>;
  if (data.rate == null) {
    return <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800" data-testid="fx-preview">{tr('برای {0} در این تاریخ یا پیش از آن نرخی ثبت نشده است؛ ثبت ممکن نیست تا نرخ آن روز در «مالی ← نرخ ارز» ثبت شود.', currencyFa(currency))}</p>;
  }
  if (!data.usable) {
    return <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="fx-preview">{tr('آخرین نرخ {0} مربوط به {1} است ({2} روز پیش)؛ کهنه‌تر از {3} روز پذیرفته نمی‌شود.', currencyFa(currency), formatDate(data.effectiveDate), localDigits(data.ageDays ?? 0), localDigits(data.maxAgeDays ?? 7))}</p>;
  }
  return (
    <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-700" data-testid="fx-preview">{tr('به نرخ {0}: هر {1} = {2} ریال', formatDate(data.effectiveDate), currencyFa(currency), formatNumber(data.rate))}{amount > 0 && <> ← <strong>{tr('{0} ریال', formatNumber(Math.round(amount * Number(data.rate))))}</strong></>}
      <span className="block text-[12px] text-ink-400">{tr('این نرخ با سند ذخیره می‌شود و با تغییر نرخ‌های بعدی جابه‌جا نمی‌شود.')}</span>
    </p>
  );
}

/* ── Rates ─────────────────────────────────────────────────────────────── */

interface RatesPayload {
  base: string; maxAgeDays: number;
  currencies: { currency: string; labelFa: string; latest: { rate: string; effectiveDate: string; ageDays: number; stale: boolean } | null;
    history: { id: string; rate: string; effectiveDate: string; source: string; note: string | null }[] }[];
}

export function FxRates() {
  const { can } = useAuth();
  const { data } = useQuery<RatesPayload>({ queryKey: ['/fx/rates'], queryFn: () => apiGet('/fx/rates') });
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return null;
  return (
    <Card title={tr('نرخ ارز')} subtitle={tr('نرخ هر ارز به ریال، به تاریخ. هر سند ارزی با نرخ روز خودش ثبت می‌شود و آن را نگه می‌دارد؛ نرخ کهنه‌تر از {0} روز برای سند تازه پذیرفته نمی‌شود.', localDigits(data.maxAgeDays))}
      action={can('finance.rates') ? (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>{tr('ورود گروهی')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>{tr('ثبت نرخ')}</Button>
        </div>
      ) : undefined}>
      <Table>
        <thead className="bg-ink-50/60"><tr><Th>{tr('ارز')}</Th><Th>{tr('آخرین نرخ')}</Th><Th>{tr('تاریخ')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('سابقه')}</Th></tr></thead>
        <tbody data-testid="fx-rates">
          {data.currencies.map((c) => (
            <Tr key={c.currency}>
              <Td className="text-sm">{loc(c, 'label')} <span className="text-[12px] text-ink-400">{c.currency}</span></Td>
              <Td className="nums text-sm">{c.latest ? tr('{0} ریال', formatNumber(c.latest.rate)) : '—'}</Td>
              <Td className="text-xs">{c.latest ? formatDate(c.latest.effectiveDate) : '—'}</Td>
              <Td>{!c.latest ? <Badge tone="neutral">{tr('بی‌نرخ')}</Badge> : c.latest.stale ? <Badge tone="warning">{tr('کهنه — {0} روز', localDigits(c.latest.ageDays))}</Badge> : <Badge tone="success">{tr('به‌روز')}</Badge>}</Td>
              <Td>
                {c.history.length > 0 && <button className="text-xs text-brand-700 underline" onClick={() => setOpen(open === c.currency ? null : c.currency)}>{tr('{0} نرخ', localDigits(c.history.length))}</button>}
                {open === c.currency && (
                  <ul className="mt-1 space-y-0.5 text-[12.5px] text-ink-600">
                    {c.history.map((h) => <li key={h.id}>{formatDate(h.effectiveDate)}: {formatNumber(h.rate)}{h.source === 'IMPORT' ? tr(' (ورود گروهی)') : ''}{h.note ? ` — ${h.note}` : ''}</li>)}
                  </ul>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {adding && <RateModal onClose={() => setAdding(false)} />}
      {importing && <ImportModal onClose={() => setImporting(false)} />}
    </Card>
  );
}

function RateModal({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState({ currency: 'USD', rate: '', effectiveDate: localDateOnly(new Date()), note: '' });
  const [busy, setBusy] = useState(false);
  const [needsReason, setNeedsReason] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const save = async () => {
    setBusy(true);
    try {
      const r = await apiPost<{ replaced: { recordsKeepingPrevious: number } | null }>('/fx/rates', { ...v, rate: Number(v.rate), note: v.note || undefined });
      toast(r.replaced ? tr('نرخ جایگزین شد؛ {0} سند با نرخ قبلی ثبت شده و همان را نگه می‌دارد.', localDigits(r.replaced.recordsKeepingPrevious)) : tr('نرخ ثبت شد.'));
      await qc.invalidateQueries(); onClose();
    } catch (e: any) {
      if (e?.body?.code === 'REASON_REQUIRED') setNeedsReason(true);
      toast(e?.message ?? tr('ثبت نرخ ناموفق بود.'), 'danger');
    } finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('ثبت نرخ ارز')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!(Number(v.rate) > 0)} onClick={() => void save()}>{tr('ثبت')}</Button></>}>
      <div className="grid gap-3">
        <Field label={tr('ارز')} required>
          <Select value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })} aria-label={tr('ارز')}>
            {CURRENCIES.filter((c) => c !== 'IRR').map((c) => <option key={c} value={c}>{currencyFa(c)} ({c})</option>)}
          </Select>
        </Field>
        <Field label={tr('از تاریخ')} required><JalaliDateInput mode="date" value={v.effectiveDate} onChange={(d) => setV({ ...v, effectiveDate: d || v.effectiveDate })} /></Field>
        <Field label={tr('نرخ — ریال برای هر {0}', currencyFa(v.currency))} required><Input type="number" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} className="ltr" aria-label={tr('نرخ')} /></Field>
        <Field label={tr('توضیح')} hint={needsReason ? tr('برای این روز نرخی ثبت شده است؛ دلیل جایگزینی را بنویسید.') : tr('منبع نرخ، یا دلیل اصلاح')}>
          <Input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} aria-label={tr('توضیح')} />
        </Field>
      </div>
    </Modal>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const run = async () => {
    setBusy(true);
    try { setResult(await apiPost('/fx/rates/import', { csv })); await qc.invalidateQueries({ queryKey: ['/fx/rates'] }); }
    finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('ورود گروهی نرخ‌ها')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{tr('بستن')}</Button><Button variant="primary" loading={busy} disabled={csv.trim().length < 5} onClick={() => void run()}>{tr('ورود نرخ‌ها')}</Button></>}>
      <Field label={tr('هر سطر: تاریخ، ارز، نرخ')} hint={tr('تاریخ شمسی (۱۴۰۵/۰۷/۰۱) یا میلادی (2026-09-23). روزی که نرخ دارد بازنویسی نمی‌شود؛ اختلاف فهرست می‌شود.')}>
        <Textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} className="ltr" aria-label={tr('نرخ‌ها')} />
      </Field>
      {result && (
        <div className="mt-3 space-y-1 text-xs" data-testid="fx-import-result">
          <p>{tr('{0} نرخ تازه، {1} تکراری.', localDigits(result.created), localDigits(result.unchanged))}</p>
          {result.conflicts.map((c: any) => <p key={c.line} className="text-amber-800">{tr('سطر {0}: برای {1} در {2} نرخ {3} ثبت است — {4} اعمال نشد.', localDigits(c.line), currencyFa(c.currency), formatDate(c.effectiveDate), formatNumber(c.existing), formatNumber(c.proposed))}</p>)}
          {result.errors.map((e: any) => <p key={e.line} className="text-rose-700">{tr('سطر {0}:', localDigits(e.line))}{' '}{loc(e, 'message')}</p>)}
        </div>
      )}
    </Modal>
  );
}

/* ── What the rate did ─────────────────────────────────────────────────── */

/** A gain or a loss said in words — a sign character wanders in right-to-left text. */
const signed = (v: number | null | undefined) => (v == null ? '—' : v === 0 ? tr('بدون اثر') : `${formatCurrency(Math.abs(v))} ${v > 0 ? tr('سود') : tr('زیان')}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? 'text-ink-500' : v > 0 ? 'text-emerald-700' : 'text-rose-700');

export function FxReport() {
  const { data } = useQuery<any>({ queryKey: ['/reports/fx'], queryFn: () => apiGet('/reports/fx') });
  if (!data) return null;
  if (!data.byCurrency.length) return <Card title={tr('اثر نرخ ارز')}><EmptyState title={tr('سند ارزی ثبت نشده')} description={tr('فاکتور، دریافت، هزینه یا قراردادی به ارز دیگری ثبت نشده است.')} /></Card>;
  return (
    <div className="space-y-5" data-testid="fx-report">
      <div className="grid grid-cols-2 gap-3">
        <StatTile label={tr('سود/زیان تحقق‌یافتهٔ ارزی')} value={signed(data.totals.realised)} hint={tr('دریافت‌ها با نرخ روز دریافت، در برابر نرخ روز صدور فاکتور')} />
        <StatTile label={tr('سود/زیان تحقق‌نیافته')} value={signed(data.totals.unrealised)} hint={tr('مطالبات باز با آخرین نرخ، در برابر نرخ ثبت‌شده')} tone="warning" />
      </div>
      <Card title={tr('به تفکیک ارز')}>
        <Table>
          <thead className="bg-ink-50/60"><tr><Th>{tr('ارز')}</Th><Th>{tr('آخرین نرخ')}</Th><Th>{tr('مطالبات باز')}</Th><Th>{tr('قرارداد')}</Th><Th>{tr('هزینهٔ ارزی')}</Th><Th>{tr('تحقق‌یافته')}</Th><Th>{tr('تحقق‌نیافته')}</Th></tr></thead>
          <tbody>
            {data.byCurrency.map((c: any) => (
              <Tr key={c.currency}>
                <Td className="text-sm">{loc(c, 'label')}</Td>
                <Td className="text-xs">{c.currentRate ? `${formatNumber(c.currentRate)} — ${formatDate(c.currentRateDate)}` : tr('بی‌نرخ')}</Td>
                <Td className="text-xs">{money(c.receivable, c.currency)}</Td>
                <Td className="text-xs">{money(c.contracted, c.currency)}</Td>
                <Td className="text-xs">{money(c.foreignCost, c.currency)}</Td>
                <Td className={`text-xs ${tone(c.realised)}`}>{signed(c.realised)}</Td>
                <Td className={`text-xs ${tone(c.unrealised)}`}>{signed(c.unrealised)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {data.receivables.length > 0 && (
        <Card title={tr('مطالبات ارزی باز')} subtitle={tr('با نرخ روز صدور ثبت شده‌اند؛ ستون آخر یعنی اگر امروز وصول شوند، چقدر ریال بیشتر یا کمتر می‌شوند.')}>
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('فاکتور')}</Th><Th>{tr('مشتری')}</Th><Th>{tr('مانده')}</Th><Th>{tr('ثبت‌شده')}</Th><Th>{tr('به نرخ امروز')}</Th><Th>{tr('اختلاف')}</Th></tr></thead>
            <tbody>
              {data.receivables.map((r: any) => (
                <Tr key={r.id}>
                  <Td className="ltr text-xs whitespace-nowrap">{r.number}</Td>
                  <Td className="text-xs">{r.company?.legalName}</Td>
                  <Td className="text-xs">{money(r.outstanding, r.currency)}</Td>
                  <Td className="text-xs">{formatCurrency(r.bookedBase)} <span className="text-[12px] text-ink-400">({formatDate(r.bookedRateDate)})</span></Td>
                  <Td className="text-xs">{formatCurrency(r.currentBase)}</Td>
                  <Td className={`text-xs ${tone(r.unrealised)}`}>{signed(r.unrealised)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {data.contracts.length > 0 && (
        <Card title={tr('قراردادهای ارزی')} subtitle={tr('ارزش قرارداد به نرخ روز ثبت، در برابر همان مبلغ به نرخ امروز — پاسخ «این پروژه هنوز به ریال سودآور است؟».')}>
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('قرارداد')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('ثبت‌شده')}</Th><Th>{tr('امروز')}</Th><Th>{tr('تغییر')}</Th></tr></thead>
            <tbody>
              {data.contracts.map((c: any) => (
                <Tr key={c.id}>
                  <Td className="text-xs"><Link to={`/contracts/${c.id}`} className="text-brand-700 hover:underline">{c.title}</Link></Td>
                  <Td className="text-xs">{money(c.original, c.currency)}</Td>
                  <Td className="text-xs">{formatCurrency(c.bookedBase)}</Td>
                  <Td className="text-xs">{formatCurrency(c.currentBase)}</Td>
                  <Td className={`text-xs ${tone(c.change)}`}>{signed(c.change)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

/* ── Issuing and receiving ─────────────────────────────────────────────── */

/** A company invoices are issued in, and the form it prints them on (ADR-125). */
export interface InvoiceSeller { id: string; form: string; shortName: string; legalName: string; economicCode: string | null; nationalId: string | null; province: string | null; county: string | null; city: string | null; address: string | null; postalCode: string | null; phone: string | null; bankName: string | null; accountNumber: string | null; iban: string | null }

const BUYER_FIELDS = [
  ['legalName', tr('نام شخص حقوقی')], ['economicCode', tr('شمارهٔ اقتصادی')], ['nationalId', tr('شناسهٔ ملی')], ['postalCode', tr('کد پستی ده‌رقمی')],
  ['province', tr('استان')], ['county', tr('شهرستان')], ['city', tr('شهر')], ['phone', tr('تلفن / نمابر')], ['address', tr('نشانی')],
] as const;
type BuyerKey = (typeof BUYER_FIELDS)[number][0];
type Buyer = Record<BuyerKey, string>;
const EMPTY_BUYER = Object.fromEntries(BUYER_FIELDS.map(([k]) => [k, ''])) as Buyer;
const asBuyer = (b: Partial<Record<BuyerKey, string | null>> | null | undefined): Buyer =>
  Object.fromEntries(BUYER_FIELDS.map(([k]) => [k, b?.[k] ?? ''])) as Buyer;

interface Line { code: string; description: string; quantity: string; unit: string; unitPrice: string; discount: string; passThrough?: boolean; mediaOrderId?: string }
const NEW_LINE: Line = { code: '', description: '', quantity: '1', unit: '', unitPrice: '', discount: '' };
const lineNet = (l: Line) => Number(l.quantity || 0) * Number(l.unitPrice || 0) - Number(l.discount || 0);

/** «هیوا» or «خط تیره»: the first thing a new invoice asks, since it decides the form it prints on. */
function SellerChoice({ sellers, value, onPick }: { sellers: InvoiceSeller[]; value: string; onPick: (id: string) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label={tr('فروشنده')}>
      {sellers.map((s) => (
        <button key={s.id} type="button" role="radio" aria-checked={value === s.id} onClick={() => onPick(s.id)}
          className={`rounded-xl px-4 py-4 text-right ring-1 transition ${value === s.id ? 'bg-brand-50 ring-2 ring-brand-500' : 'bg-surface ring-ink-200 hover:ring-brand-400'}`}>
          <span className="block text-lg font-bold text-ink-900">{s.shortName}</span>
          <span className="mt-1 block text-xs text-ink-500">{s.legalName}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Issuing an invoice — or editing one (the owner, 2026-10-30; ADR-110): a draft by whoever issues
 * invoices, any by the system administrator. The server recomputes the totals and says no where the
 * books need it — below what was received, posted to accounting, awaited by the tax system.
 *
 * ADR-125 (the owner, 2026-11-07): a new one asks first which company issues it, هیوا or خط تیره; the
 * buyer is then read from the client's record and can be typed over; and it prints on that company's
 * own form, in Excel or PDF.
 */
export function NewInvoiceModal(props: { onClose: () => void; invoiceId?: string }) {
  // The company chosen is kept with the rest of the dialog's draft — the dialog's, not the page's, so its
  // notice says it was brought back and «حذف پیش‌نویس» forgets it with the rest.
  const draftKey = props.invoiceId ? `invoice:${props.invoiceId}` : 'invoice:new';
  return <DraftScope title={props.invoiceId ? tr('ویرایش سند مالی') : tr('صدور سند مالی')} draftKey={draftKey}><InvoiceDialog {...props} draftKey={draftKey} /></DraftScope>;
}

function InvoiceDialog({ onClose, invoiceId, draftKey }: { onClose: () => void; invoiceId?: string; draftKey: string }) {
  const [v, setV] = useState({ kind: 'INVOICE', companyId: '', projectId: '', number: '', issueDate: localDateOnly(new Date()), dueDate: '', currency: 'IRR', taxPercent: '10', saleTerms: '', notes: '' });
  const [lines, setLines] = useState<Line[]>([{ ...NEW_LINE }]);
  const [buyer, setBuyer] = useState<Buyer>(EMPTY_BUYER);
  // Sent only when it says something new: an edit that leaves the buyer alone does not report it again.
  const [buyerTouched, setBuyerTouched] = useState(false);
  const [fillCompany, setFillCompany] = useState(true);
  const [picked, setPicked] = useDraftState<string>(tr('فروشنده'), '');
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const { data: was } = useQuery<any>({ queryKey: [`/invoices/${invoiceId}`], queryFn: () => apiGet(`/invoices/${invoiceId}`), enabled: !!invoiceId });
  const { data: sellerList } = useQuery<InvoiceSeller[]>({ queryKey: ['/invoice-sellers'], queryFn: () => apiGet('/invoice-sellers') });
  const sellers = Array.isArray(sellerList) ? sellerList : sellerList === undefined ? undefined : [];
  const sellerId = picked || was?.sellerId || '';
  const seller = sellers?.find((s) => s.id === sellerId);
  // The invoice as it stands, once: in its own currency, as its lines were written.
  useEffect(() => {
    if (!was) return;
    setV({
      kind: was.kind, companyId: was.companyId, projectId: was.projectId ?? '', number: was.number, issueDate: String(was.issueDate).slice(0, 10),
      dueDate: was.dueDate ? String(was.dueDate).slice(0, 10) : '', currency: was.currency, taxPercent: String(Number(was.taxPercent)), saleTerms: was.saleTerms ?? '', notes: was.notes ?? '',
    });
    setLines((was.lines as { code?: string; description: string; quantity: number; unit?: string; unitPrice: number; discount?: number; passThrough?: boolean; mediaOrderId?: string }[]).map((l) => ({
      code: l.code ?? '', description: l.description, quantity: String(l.quantity), unit: l.unit ?? '', unitPrice: String(l.unitPrice), discount: l.discount ? String(l.discount) : '',
      // A media invoice's marks (#31) go back as they came: the line bills a vendor's media, not the agency's work.
      ...(l.passThrough !== undefined ? { passThrough: l.passThrough } : {}), ...(l.mediaOrderId ? { mediaOrderId: l.mediaOrderId } : {}),
    })));
    if (was.buyer) setBuyer(asBuyer(was.buyer));
    else if (was.companyId) void apiGet<Buyer>(`/invoices/buyer/${was.companyId}`).then((b) => setBuyer(asBuyer(b))).catch(() => undefined);
  }, [was]);
  /** A client chosen: its record is the buyer, to be completed or typed over. */
  const pickCompany = (companyId: string) => {
    setV((x) => ({ ...x, companyId }));
    setBuyerTouched(true);
    if (!companyId) { setBuyer(EMPTY_BUYER); return; }
    void apiGet<Buyer>(`/invoices/buyer/${companyId}`).then((b) => setBuyer(asBuyer(b))).catch(() => undefined);
  };
  const subtotal = lines.reduce((s, l) => s + lineNet(l), 0);
  const total = subtotal * (1 + Number(v.taxPercent || 0) / 100);
  const overDiscount = lines.some((l) => lineNet(l) < 0);
  const valid = v.companyId && v.number.trim() && !overDiscount && lines.every((l) => l.description.trim() && Number(l.unitPrice) >= 0 && l.unitPrice !== '');
  const save = async () => {
    setBusy(true);
    const body = {
      kind: v.kind, companyId: v.companyId, number: v.number.trim(), issueDate: v.issueDate, currency: v.currency, taxPercent: Number(v.taxPercent || 0),
      ...(sellerId ? { sellerId } : {}),
      lines: lines.map((l) => ({
        description: l.description.trim(), quantity: Number(l.quantity), unitPrice: Number(l.unitPrice),
        ...(l.code.trim() ? { code: l.code.trim() } : {}), ...(l.unit.trim() ? { unit: l.unit.trim() } : {}), ...(Number(l.discount) > 0 ? { discount: Number(l.discount) } : {}),
        ...(l.passThrough !== undefined ? { passThrough: l.passThrough } : {}), ...(l.mediaOrderId ? { mediaOrderId: l.mediaOrderId } : {}),
      })),
      ...(!invoiceId || buyerTouched ? { buyer, fillCompany } : {}),
    };
    try {
      if (invoiceId) {
        const after = await apiPatch<{ taxCorrectionDue?: boolean }>(`/invoices/${invoiceId}`, { ...body, projectId: v.projectId || null, dueDate: v.dueDate || null, saleTerms: v.saleTerms || null, notes: v.notes.trim() || null });
        toast(after.taxCorrectionDue ? tr('سند مالی ویرایش شد. این سند در سامانهٔ مؤدیان پذیرفته شده بود؛ «اصلاحی» آن را بفرستید.') : tr('سند مالی ویرایش شد.'));
      } else {
        await apiPost('/invoices', { ...body, projectId: v.projectId || undefined, dueDate: v.dueDate || undefined, saleTerms: v.saleTerms || undefined, notes: v.notes.trim() || undefined });
        toast(tr('سند مالی صادر شد. فایل Excel و PDF آن را از ردیفش در فهرست بگیرید.'));
      }
      await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? tr('صدور ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  const setLine = (i: number, k: keyof Line, value: string) => setLines(lines.map((x, j) => (j === i ? { ...x, [k]: value } : x)));
  const asking = !invoiceId && (!sellerId || choosing);

  return (
    <Modal open wide draftKey={draftKey} title={invoiceId ? tr('ویرایش سند مالی {0}', was?.number ?? '') : tr('صدور سند مالی')} onClose={onClose}
      footer={asking
        ? <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
        : <><Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!valid || (!!invoiceId && !was)} onClick={() => void save()}>{invoiceId ? tr('ذخیره') : tr('صدور')}</Button></>}>
      {asking ? (
        <div data-testid="seller-choice">
          <p className="mb-3 text-sm font-bold text-ink-800">{tr('این سند به نام کدام شرکت صادر شود؟')}</p>
          {!sellers ? <p className="text-sm text-ink-500">{tr('در حال بارگذاری…')}</p>
            : sellers.length ? <SellerChoice sellers={sellers} value={sellerId} onPick={(id) => { setPicked(id); setChoosing(false); }} />
              : <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">{tr('هیچ شرکتی برای صدور سند تعریف نشده است. با مدیر سیستم تماس بگیرید.')}</p>}
          <p className="mt-3 text-xs text-ink-500">{tr('سند روی فرم همان شرکت چاپ می‌شود: Excel و PDF.')}</p>
        </div>
      ) : (<>
      {was?.accountingExportId && <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">{tr('این سند به خروجی حسابداری رفته است: مبلغ، مشتری، فروشنده، نوع و تاریخش دیگر عوض نمی‌شود.')}</p>}
      {invoiceId && !sellerId ? (
        <section aria-label={tr('فروشنده')} className="mb-4 rounded-lg bg-amber-50 px-3 py-3">
          <p className="mb-2 text-xs text-amber-900">{tr('این سند پیش از فرم‌های شرکت صادر شده است. برای گرفتن Excel و PDF با فرم شرکت، فروشنده را برگزینید.')}</p>
          {sellers && <SellerChoice sellers={sellers} value={sellerId} onPick={setPicked} />}
        </section>
      ) : (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-ink-50 px-3 py-2" data-testid="seller-picked">
          <span className="text-sm"><span className="text-ink-500">{tr('فروشنده:')}</span>{' '}<strong>{seller?.shortName ?? '—'}</strong>{seller && <span className="text-xs text-ink-500"> — {seller.legalName}</span>}</span>
          <Button size="sm" variant="ghost" onClick={() => setChoosing(true)} disabled={!!invoiceId && !!was?.accountingExportId}>{tr('تغییر فروشنده')}</Button>
        </div>
      )}
      {invoiceId && choosing && sellers && <div className="mb-4"><SellerChoice sellers={sellers} value={sellerId} onPick={(id) => { setPicked(id); setChoosing(false); }} /></div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('نوع')}><Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} aria-label={tr('نوع')}><option value="INVOICE">{tr('فاکتور')}</option><option value="PROFORMA">{tr('پیش‌فاکتور')}</option></Select></Field>
        <Field label={tr('شماره')} required><Input value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} className="ltr" aria-label={tr('شماره')} /></Field>
        <Field label={tr('مشتری')} required><EntitySelect entity="company" value={v.companyId} onChange={pickCompany} /></Field>
        <Field label={tr('پروژه')}><EntitySelect entity="project" value={v.projectId} onChange={(x) => setV({ ...v, projectId: x })} /></Field>
        <Field label={tr('تاریخ صدور')} required><JalaliDateInput mode="date" value={v.issueDate} onChange={(d) => setV({ ...v, issueDate: d || v.issueDate })} /></Field>
        <Field label={tr('سررسید')}><JalaliDateInput mode="date" value={v.dueDate || null} onChange={(d) => setV({ ...v, dueDate: d })} /></Field>
        <Field label={tr('ارز')} hint={tr('قیمت ردیف‌ها به همین ارز است')}><CurrencySelect value={v.currency} onChange={(c) => setV({ ...v, currency: c })} /></Field>
        <Field label={tr('مالیات (٪)')}><Input type="number" value={v.taxPercent} onChange={(e) => setV({ ...v, taxPercent: e.target.value })} className="ltr" aria-label={tr('مالیات')} /></Field>
      </div>
      {v.companyId && (
        <section aria-label={tr('مشخصات خریدار')} className="mt-4 rounded-lg ring-1 ring-ink-200 px-3 py-3">
          <p className="mb-2 text-sm font-bold text-ink-800">{tr('مشخصات خریدار')}</p>
          <p className="mb-3 text-xs text-ink-500">{tr('از پروندهٔ مشتری خوانده شد؛ هر چه را لازم است کامل یا اصلاح کنید.')}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {BUYER_FIELDS.map(([k, label]) => (
              <div key={k} className={k === 'address' ? 'sm:col-span-3' : k === 'legalName' ? 'sm:col-span-2' : ''}>
                <Field label={label}><Input value={buyer[k]} onChange={(e) => { setBuyer({ ...buyer, [k]: e.target.value }); setBuyerTouched(true); }}
                  className={['economicCode', 'nationalId', 'postalCode', 'phone'].includes(k) ? 'ltr' : ''} /></Field>
              </div>
            ))}
          </div>
          <div className="mt-3"><Checkbox label={tr('جاهای خالیِ پروندهٔ مشتری هم با همین‌ها پر شود')} checked={fillCompany} onChange={(e) => setFillCompany(e.target.checked)} /></div>
        </section>
      )}
      <section aria-label={tr('مشخصات کالا یا خدمات')} className="mt-4 space-y-2">
        <p className="text-sm font-bold text-ink-800">{tr('مشخصات کالا یا خدمات')}</p>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded-lg bg-ink-50/60 p-2 sm:grid-cols-[5rem_1fr_4.5rem_5rem_8rem_7rem_auto] sm:bg-transparent sm:p-0">
            <Input placeholder={tr('کد کالا')} value={l.code} aria-label={tr('کد کالا')} className="ltr" onChange={(e) => setLine(i, 'code', e.target.value)} />
            <Input placeholder={tr('شرح')} value={l.description} aria-label={tr('شرح')} className="col-span-2 sm:col-span-1" onChange={(e) => setLine(i, 'description', e.target.value)} />
            <Input type="number" value={l.quantity} aria-label={tr('تعداد')} className="ltr" onChange={(e) => setLine(i, 'quantity', e.target.value)} />
            <Input placeholder={tr('واحد')} value={l.unit} aria-label={tr('واحد')} onChange={(e) => setLine(i, 'unit', e.target.value)} />
            <Input type="number" placeholder={tr('قیمت واحد')} value={l.unitPrice} aria-label={tr('قیمت واحد')} className="ltr" onChange={(e) => setLine(i, 'unitPrice', e.target.value)} />
            <Input type="number" placeholder={tr('تخفیف')} value={l.discount} aria-label={tr('تخفیف')} className="ltr" onChange={(e) => setLine(i, 'discount', e.target.value)} />
            <Button size="sm" variant="ghost" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>{tr('حذف')}</Button>
            {l.passThrough && <span className="col-span-2 text-xs text-ink-500 sm:col-span-7">{tr('هزینهٔ عبوری رسانه: در درآمد آژانس شمرده نمی‌شود.')}</span>}
          </div>
        ))}
        {overDiscount && <p className="text-xs text-rose-700">{tr('تخفیف یک ردیف از مبلغ کل آن بیشتر است.')}</p>}
        <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { ...NEW_LINE }])}>{tr('ردیف تازه')}</Button>
      </section>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label={tr('شرایط و نحوهٔ فروش')}><Select value={v.saleTerms} onChange={(e) => setV({ ...v, saleTerms: e.target.value })} aria-label={tr('شرایط و نحوهٔ فروش')}>
          <option value="">{tr('— مشخص نشده —')}</option><option value="CASH">{tr('نقدی')}</option><option value="CREDIT">{tr('غیر نقدی')}</option>
        </Select></Field>
      </div>
      <div className="mt-4"><Field label={tr('یادداشت')} hint={tr('در بخش «توضیحات» فرم چاپ می‌شود.')}><Textarea value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} aria-label={tr('یادداشت')} /></Field></div>
      <p className="mt-3 text-sm text-ink-700">{tr('جمع با مالیات:')}{' '}<strong>{money(total, v.currency)}</strong></p>
      <div className="mt-2"><FxPreview currency={v.currency} amount={total} on={v.issueDate} /></div>
      </>)}
    </Modal>
  );
}

export function NewPaymentModal({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState({ direction: 'IN', invoiceId: '', amount: '', currency: 'IRR', occurredAt: localDateOnly(new Date()), method: 'TRANSFER', reference: '' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const { data: invoices } = useQuery<{ items: any[] }>({ queryKey: ['/invoices', 'open'], queryFn: () => apiGet('/invoices', { pageSize: 100 }) });
  const invoice = invoices?.items.find((i) => i.id === v.invoiceId);
  const pick = (id: string) => {
    const inv = invoices?.items.find((i) => i.id === id);
    // A foreign invoice defaults to its own currency — but the field stays visible, because a
    // receipt in rials against it is common and must be said, not assumed.
    setV({ ...v, invoiceId: id, currency: inv?.currency ?? v.currency });
  };
  const save = async () => {
    setBusy(true);
    try {
      await apiPost('/payments', {
        direction: v.direction, invoiceId: v.invoiceId || undefined, amount: Number(v.amount), currency: v.currency,
        occurredAt: v.occurredAt, method: v.method, reference: v.reference || undefined,
      });
      toast(tr('تراکنش ثبت شد.')); await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? tr('ثبت ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('ثبت دریافت/پرداخت')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!(Number(v.amount) > 0)} onClick={() => void save()}>{tr('ثبت')}</Button></>}>
      <div className="grid gap-3">
        <Field label={tr('جهت')}><Select value={v.direction} onChange={(e) => setV({ ...v, direction: e.target.value })} aria-label={tr('جهت')}><option value="IN">{tr('دریافتی')}</option><option value="OUT">{tr('پرداخت')}</option></Select></Field>
        {v.direction === 'IN' && (
          <Field label={tr('بابت فاکتور')}>
            <Select value={v.invoiceId} onChange={(e) => pick(e.target.value)} aria-label={tr('فاکتور')}>
              <option value="">—</option>
              {(invoices?.items ?? []).filter((i) => i.state !== 'PAID' && i.state !== 'CANCELLED').map((i) => (
                <option key={i.id} value={i.id}>{i.number} — {i.company?.legalName} — {money(i.originalTotal ?? i.total, i.currency)}</option>
              ))}
            </Select>
          </Field>
        )}
        {invoice && invoice.currency !== 'IRR' && (
          <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-700">{tr('این فاکتور به {0} است: {1} از {2} تسویه شده. دریافت را به {3} یا به ریال ثبت کنید؛ ریال با نرخ روز دریافت به {4} شمرده می‌شود.', currencyFa(invoice.currency), money(invoice.originalPaidAmount ?? 0, invoice.currency), money(invoice.originalTotal, invoice.currency), currencyFa(invoice.currency), currencyFa(invoice.currency))}</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('مبلغ')} required><Input type="number" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} className="ltr" aria-label={tr('مبلغ')} /></Field>
          <Field label={tr('ارز مبلغ')}><CurrencySelect value={v.currency} onChange={(c) => setV({ ...v, currency: c })} label={tr('ارز مبلغ')} /></Field>
        </div>
        <Field label={tr('تاریخ')} required><JalaliDateInput mode="date" value={v.occurredAt} onChange={(d) => setV({ ...v, occurredAt: d || v.occurredAt })} /></Field>
        <Field label={tr('روش')}><Select value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })} aria-label={tr('روش')}>{Object.entries(PAYMENT_METHODS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</Select></Field>
        <Field label={tr('مرجع')}><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} className="ltr" aria-label={tr('مرجع')} /></Field>
        <FxPreview currency={v.currency} amount={Number(v.amount || 0)} on={v.occurredAt} />
      </div>
    </Modal>
  );
}
