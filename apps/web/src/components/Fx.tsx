import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENCIES, CURRENCY_LABELS, type Currency } from '@hiva/contracts';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EntitySelect } from '../pages/Forms';
import { JalaliDateInput } from './JalaliDateInput';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, StatTile, Table, Td, Textarea, Th, Tr, useToast } from './ui';
import { formatCurrency, formatDate, formatNumber, localDateOnly, localDigits } from '../lib/format';
import { loc, tr, trx } from '../i18n';

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
                  <Td className="ltr text-xs">{r.number}</Td>
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

export function NewInvoiceModal({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState({ kind: 'INVOICE', companyId: '', projectId: '', number: '', issueDate: localDateOnly(new Date()), dueDate: '', currency: 'IRR', taxPercent: '10' });
  const [lines, setLines] = useState([{ description: '', quantity: '1', unitPrice: '' }]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const subtotal = lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.unitPrice || 0), 0);
  const total = subtotal * (1 + Number(v.taxPercent || 0) / 100);
  const valid = v.companyId && v.number.trim() && lines.every((l) => l.description.trim() && Number(l.unitPrice) >= 0 && l.unitPrice !== '');
  const save = async () => {
    setBusy(true);
    try {
      await apiPost('/invoices', {
        kind: v.kind, companyId: v.companyId, projectId: v.projectId || undefined, number: v.number.trim(),
        issueDate: v.issueDate, dueDate: v.dueDate || undefined, currency: v.currency, taxPercent: Number(v.taxPercent || 0),
        lines: lines.map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })),
      });
      toast(tr('سند مالی صادر شد.')); await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? tr('صدور ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide title={tr('صدور سند مالی')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>{tr('صدور')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('نوع')}><Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} aria-label={tr('نوع')}><option value="INVOICE">{tr('فاکتور')}</option><option value="PROFORMA">{tr('پیش‌فاکتور')}</option></Select></Field>
        <Field label={tr('شماره')} required><Input value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} className="ltr" aria-label={tr('شماره')} /></Field>
        <Field label={tr('مشتری')} required><EntitySelect entity="company" value={v.companyId} onChange={(x) => setV({ ...v, companyId: x })} /></Field>
        <Field label={tr('پروژه')}><EntitySelect entity="project" value={v.projectId} onChange={(x) => setV({ ...v, projectId: x })} /></Field>
        <Field label={tr('تاریخ صدور')} required><JalaliDateInput mode="date" value={v.issueDate} onChange={(d) => setV({ ...v, issueDate: d || v.issueDate })} /></Field>
        <Field label={tr('سررسید')}><JalaliDateInput mode="date" value={v.dueDate || null} onChange={(d) => setV({ ...v, dueDate: d })} /></Field>
        <Field label={tr('ارز')} hint={tr('قیمت ردیف‌ها به همین ارز است')}><CurrencySelect value={v.currency} onChange={(c) => setV({ ...v, currency: c })} /></Field>
        <Field label={tr('مالیات (٪)')}><Input type="number" value={v.taxPercent} onChange={(e) => setV({ ...v, taxPercent: e.target.value })} className="ltr" aria-label={tr('مالیات')} /></Field>
      </div>
      <div className="mt-4 space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_5rem_8rem_auto] gap-2">
            <Input placeholder={tr('شرح')} value={l.description} aria-label={tr('شرح')} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            <Input type="number" value={l.quantity} aria-label={tr('تعداد')} className="ltr" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
            <Input type="number" placeholder={tr('قیمت واحد')} value={l.unitPrice} aria-label={tr('قیمت واحد')} className="ltr" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />
            <Button size="sm" variant="ghost" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>{tr('حذف')}</Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { description: '', quantity: '1', unitPrice: '' }])}>{tr('ردیف تازه')}</Button>
      </div>
      <p className="mt-3 text-sm text-ink-700">{tr('جمع با مالیات:')}{' '}<strong>{money(total, v.currency)}</strong></p>
      <div className="mt-2"><FxPreview currency={v.currency} amount={total} on={v.issueDate} /></div>
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
        <Field label={tr('روش')}><Select value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })} aria-label={tr('روش')}><option value="TRANSFER">{tr('انتقال بانکی')}</option><option value="CHEQUE">{tr('چک')}</option><option value="CASH">{tr('نقد')}</option><option value="OTHER">{tr('سایر')}</option></Select></Field>
        <Field label={tr('مرجع')}><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} className="ltr" aria-label={tr('مرجع')} /></Field>
        <FxPreview currency={v.currency} amount={Number(v.amount || 0)} on={v.occurredAt} />
      </div>
    </Modal>
  );
}
