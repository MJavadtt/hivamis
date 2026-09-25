import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENCIES, CURRENCY_LABELS, type Currency } from '@hiva/contracts';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EntitySelect } from '../pages/Forms';
import { JalaliDateInput } from './JalaliDateInput';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, StatTile, Table, Td, Textarea, Th, Tr, useToast } from './ui';
import { formatCurrency, formatDate, formatNumber, localDateOnly, toPersianDigits } from '../lib/format';

/* Roadmap #28 — amounts in more than one currency, each converted at the rate of its own day. */

export const currencyFa = (c: string) => CURRENCY_LABELS[c as Currency] ?? c;

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
      <span className="text-[10px] text-ink-400">{formatCurrency(base as number)}</span>
    </span>
  );
}

export function CurrencySelect({ value, onChange, label = 'ارز' }: { value: string; onChange: (v: string) => void; label?: string }) {
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
  if (!data) return <p className="text-[11px] text-ink-400">در حال یافتن نرخ…</p>;
  if (data.rate == null) {
    return <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800" data-testid="fx-preview">برای {currencyFa(currency)} در این تاریخ یا پیش از آن نرخی ثبت نشده است؛ ثبت ممکن نیست تا نرخ آن روز در «مالی ← نرخ ارز» ثبت شود.</p>;
  }
  if (!data.usable) {
    return <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="fx-preview">آخرین نرخ {currencyFa(currency)} مربوط به {formatDate(data.effectiveDate)} است ({toPersianDigits(data.ageDays ?? 0)} روز پیش)؛ کهنه‌تر از {toPersianDigits(data.maxAgeDays ?? 7)} روز پذیرفته نمی‌شود.</p>;
  }
  return (
    <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-700" data-testid="fx-preview">
      به نرخ {formatDate(data.effectiveDate)}: هر {currencyFa(currency)} = {formatNumber(data.rate)} ریال
      {amount > 0 && <> ← <strong>{formatNumber(Math.round(amount * Number(data.rate)))} ریال</strong></>}
      <span className="block text-[10px] text-ink-400">این نرخ با سند ذخیره می‌شود و با تغییر نرخ‌های بعدی جابه‌جا نمی‌شود.</span>
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
    <Card title="نرخ ارز" subtitle={`نرخ هر ارز به ریال، به تاریخ. هر سند ارزی با نرخ روز خودش ثبت می‌شود و آن را نگه می‌دارد؛ نرخ کهنه‌تر از ${toPersianDigits(data.maxAgeDays)} روز برای سند تازه پذیرفته نمی‌شود.`}
      action={can('finance.rates') ? (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>ورود گروهی</Button>
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>ثبت نرخ</Button>
        </div>
      ) : undefined}>
      <Table>
        <thead className="bg-ink-50/60"><tr><Th>ارز</Th><Th>آخرین نرخ</Th><Th>تاریخ</Th><Th>وضعیت</Th><Th>سابقه</Th></tr></thead>
        <tbody data-testid="fx-rates">
          {data.currencies.map((c) => (
            <Tr key={c.currency}>
              <Td className="text-sm">{c.labelFa} <span className="text-[10px] text-ink-400">{c.currency}</span></Td>
              <Td className="nums text-sm">{c.latest ? `${formatNumber(c.latest.rate)} ریال` : '—'}</Td>
              <Td className="text-xs">{c.latest ? formatDate(c.latest.effectiveDate) : '—'}</Td>
              <Td>{!c.latest ? <Badge tone="neutral">بی‌نرخ</Badge> : c.latest.stale ? <Badge tone="warning">کهنه — {toPersianDigits(c.latest.ageDays)} روز</Badge> : <Badge tone="success">به‌روز</Badge>}</Td>
              <Td>
                {c.history.length > 0 && <button className="text-xs text-brand-700 underline" onClick={() => setOpen(open === c.currency ? null : c.currency)}>{toPersianDigits(c.history.length)} نرخ</button>}
                {open === c.currency && (
                  <ul className="mt-1 space-y-0.5 text-[11px] text-ink-600">
                    {c.history.map((h) => <li key={h.id}>{formatDate(h.effectiveDate)}: {formatNumber(h.rate)}{h.source === 'IMPORT' ? ' (ورود گروهی)' : ''}{h.note ? ` — ${h.note}` : ''}</li>)}
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
      toast(r.replaced ? `نرخ جایگزین شد؛ ${toPersianDigits(r.replaced.recordsKeepingPrevious)} سند با نرخ قبلی ثبت شده و همان را نگه می‌دارد.` : 'نرخ ثبت شد.');
      await qc.invalidateQueries(); onClose();
    } catch (e: any) {
      if (e?.body?.code === 'REASON_REQUIRED') setNeedsReason(true);
      toast(e?.message ?? 'ثبت نرخ ناموفق بود.', 'danger');
    } finally { setBusy(false); }
  };
  return (
    <Modal open title="ثبت نرخ ارز" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>انصراف</Button><Button variant="primary" loading={busy} disabled={!(Number(v.rate) > 0)} onClick={() => void save()}>ثبت</Button></>}>
      <div className="grid gap-3">
        <Field label="ارز" required>
          <Select value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })} aria-label="ارز">
            {CURRENCIES.filter((c) => c !== 'IRR').map((c) => <option key={c} value={c}>{currencyFa(c)} ({c})</option>)}
          </Select>
        </Field>
        <Field label="از تاریخ" required><JalaliDateInput mode="date" value={v.effectiveDate} onChange={(d) => setV({ ...v, effectiveDate: d || v.effectiveDate })} /></Field>
        <Field label={`نرخ — ریال برای هر ${currencyFa(v.currency)}`} required><Input type="number" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} className="ltr" aria-label="نرخ" /></Field>
        <Field label="توضیح" hint={needsReason ? 'برای این روز نرخی ثبت شده است؛ دلیل جایگزینی را بنویسید.' : 'منبع نرخ، یا دلیل اصلاح'}>
          <Input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} aria-label="توضیح" />
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
    <Modal open title="ورود گروهی نرخ‌ها" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>بستن</Button><Button variant="primary" loading={busy} disabled={csv.trim().length < 5} onClick={() => void run()}>ورود</Button></>}>
      <Field label="هر سطر: تاریخ، ارز، نرخ" hint="تاریخ شمسی (۱۴۰۵/۰۷/۰۱) یا میلادی (2026-09-23). روزی که نرخ دارد بازنویسی نمی‌شود؛ اختلاف فهرست می‌شود.">
        <Textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} className="ltr" aria-label="نرخ‌ها" />
      </Field>
      {result && (
        <div className="mt-3 space-y-1 text-xs" data-testid="fx-import-result">
          <p>{toPersianDigits(result.created)} نرخ تازه، {toPersianDigits(result.unchanged)} تکراری.</p>
          {result.conflicts.map((c: any) => <p key={c.line} className="text-amber-800">سطر {toPersianDigits(c.line)}: برای {currencyFa(c.currency)} در {formatDate(c.effectiveDate)} نرخ {formatNumber(c.existing)} ثبت است — {formatNumber(c.proposed)} اعمال نشد.</p>)}
          {result.errors.map((e: any) => <p key={e.line} className="text-rose-700">سطر {toPersianDigits(e.line)}: {e.messageFa}</p>)}
        </div>
      )}
    </Modal>
  );
}

/* ── What the rate did ─────────────────────────────────────────────────── */

/** A gain or a loss said in words — a sign character wanders in right-to-left text. */
const signed = (v: number | null | undefined) => (v == null ? '—' : v === 0 ? 'بدون اثر' : `${formatCurrency(Math.abs(v))} ${v > 0 ? 'سود' : 'زیان'}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? 'text-ink-500' : v > 0 ? 'text-emerald-700' : 'text-rose-700');

export function FxReport() {
  const { data } = useQuery<any>({ queryKey: ['/reports/fx'], queryFn: () => apiGet('/reports/fx') });
  if (!data) return null;
  if (!data.byCurrency.length) return <Card title="اثر نرخ ارز"><EmptyState title="سند ارزی ثبت نشده" description="فاکتور، دریافت، هزینه یا قراردادی به ارز دیگری ثبت نشده است." /></Card>;
  return (
    <div className="space-y-5" data-testid="fx-report">
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="سود/زیان تحقق‌یافتهٔ ارزی" value={signed(data.totals.realised)} hint="دریافت‌ها با نرخ روز دریافت، در برابر نرخ روز صدور فاکتور" />
        <StatTile label="سود/زیان تحقق‌نیافته" value={signed(data.totals.unrealised)} hint="مطالبات باز با آخرین نرخ، در برابر نرخ ثبت‌شده" tone="warning" />
      </div>
      <Card title="به تفکیک ارز">
        <Table>
          <thead className="bg-ink-50/60"><tr><Th>ارز</Th><Th>آخرین نرخ</Th><Th>مطالبات باز</Th><Th>قرارداد</Th><Th>هزینهٔ ارزی</Th><Th>تحقق‌یافته</Th><Th>تحقق‌نیافته</Th></tr></thead>
          <tbody>
            {data.byCurrency.map((c: any) => (
              <Tr key={c.currency}>
                <Td className="text-sm">{c.labelFa}</Td>
                <Td className="text-xs">{c.currentRate ? `${formatNumber(c.currentRate)} — ${formatDate(c.currentRateDate)}` : 'بی‌نرخ'}</Td>
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
        <Card title="مطالبات ارزی باز" subtitle="با نرخ روز صدور ثبت شده‌اند؛ ستون آخر یعنی اگر امروز وصول شوند، چقدر ریال بیشتر یا کمتر می‌شوند.">
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>فاکتور</Th><Th>مشتری</Th><Th>مانده</Th><Th>ثبت‌شده</Th><Th>به نرخ امروز</Th><Th>اختلاف</Th></tr></thead>
            <tbody>
              {data.receivables.map((r: any) => (
                <Tr key={r.id}>
                  <Td className="ltr text-xs">{r.number}</Td>
                  <Td className="text-xs">{r.company?.legalName}</Td>
                  <Td className="text-xs">{money(r.outstanding, r.currency)}</Td>
                  <Td className="text-xs">{formatCurrency(r.bookedBase)} <span className="text-[10px] text-ink-400">({formatDate(r.bookedRateDate)})</span></Td>
                  <Td className="text-xs">{formatCurrency(r.currentBase)}</Td>
                  <Td className={`text-xs ${tone(r.unrealised)}`}>{signed(r.unrealised)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {data.contracts.length > 0 && (
        <Card title="قراردادهای ارزی" subtitle="ارزش قرارداد به نرخ روز ثبت، در برابر همان مبلغ به نرخ امروز — پاسخ «این پروژه هنوز به ریال سودآور است؟».">
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>قرارداد</Th><Th>مبلغ</Th><Th>ثبت‌شده</Th><Th>امروز</Th><Th>تغییر</Th></tr></thead>
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
      toast('سند مالی صادر شد.'); await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? 'صدور ناموفق بود.', 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide title="صدور سند مالی" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>انصراف</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>صدور</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="نوع"><Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} aria-label="نوع"><option value="INVOICE">فاکتور</option><option value="PROFORMA">پیش‌فاکتور</option></Select></Field>
        <Field label="شماره" required><Input value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} className="ltr" aria-label="شماره" /></Field>
        <Field label="مشتری" required><EntitySelect entity="company" value={v.companyId} onChange={(x) => setV({ ...v, companyId: x })} /></Field>
        <Field label="پروژه"><EntitySelect entity="project" value={v.projectId} onChange={(x) => setV({ ...v, projectId: x })} /></Field>
        <Field label="تاریخ صدور" required><JalaliDateInput mode="date" value={v.issueDate} onChange={(d) => setV({ ...v, issueDate: d || v.issueDate })} /></Field>
        <Field label="سررسید"><JalaliDateInput mode="date" value={v.dueDate || null} onChange={(d) => setV({ ...v, dueDate: d })} /></Field>
        <Field label="ارز" hint="قیمت ردیف‌ها به همین ارز است"><CurrencySelect value={v.currency} onChange={(c) => setV({ ...v, currency: c })} /></Field>
        <Field label="مالیات (٪)"><Input type="number" value={v.taxPercent} onChange={(e) => setV({ ...v, taxPercent: e.target.value })} className="ltr" aria-label="مالیات" /></Field>
      </div>
      <div className="mt-4 space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_5rem_8rem_auto] gap-2">
            <Input placeholder="شرح" value={l.description} aria-label="شرح" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            <Input type="number" value={l.quantity} aria-label="تعداد" className="ltr" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
            <Input type="number" placeholder="قیمت واحد" value={l.unitPrice} aria-label="قیمت واحد" className="ltr" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />
            <Button size="sm" variant="ghost" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>حذف</Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { description: '', quantity: '1', unitPrice: '' }])}>ردیف تازه</Button>
      </div>
      <p className="mt-3 text-sm text-ink-700">جمع با مالیات: <strong>{money(total, v.currency)}</strong></p>
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
      toast('تراکنش ثبت شد.'); await qc.invalidateQueries(); onClose();
    } catch (e: any) { toast(e?.message ?? 'ثبت ناموفق بود.', 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title="ثبت دریافت/پرداخت" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>انصراف</Button><Button variant="primary" loading={busy} disabled={!(Number(v.amount) > 0)} onClick={() => void save()}>ثبت</Button></>}>
      <div className="grid gap-3">
        <Field label="جهت"><Select value={v.direction} onChange={(e) => setV({ ...v, direction: e.target.value })} aria-label="جهت"><option value="IN">دریافت</option><option value="OUT">پرداخت</option></Select></Field>
        {v.direction === 'IN' && (
          <Field label="بابت فاکتور">
            <Select value={v.invoiceId} onChange={(e) => pick(e.target.value)} aria-label="فاکتور">
              <option value="">—</option>
              {(invoices?.items ?? []).filter((i) => i.state !== 'PAID' && i.state !== 'CANCELLED').map((i) => (
                <option key={i.id} value={i.id}>{i.number} — {i.company?.legalName} — {money(i.originalTotal ?? i.total, i.currency)}</option>
              ))}
            </Select>
          </Field>
        )}
        {invoice && invoice.currency !== 'IRR' && (
          <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-700">
            این فاکتور به {currencyFa(invoice.currency)} است: {money(invoice.originalPaidAmount ?? 0, invoice.currency)} از {money(invoice.originalTotal, invoice.currency)} تسویه شده. دریافت را به {currencyFa(invoice.currency)} یا به ریال ثبت کنید؛ ریال با نرخ روز دریافت به {currencyFa(invoice.currency)} شمرده می‌شود.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="مبلغ" required><Input type="number" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} className="ltr" aria-label="مبلغ" /></Field>
          <Field label="ارز مبلغ"><CurrencySelect value={v.currency} onChange={(c) => setV({ ...v, currency: c })} label="ارز مبلغ" /></Field>
        </div>
        <Field label="تاریخ" required><JalaliDateInput mode="date" value={v.occurredAt} onChange={(d) => setV({ ...v, occurredAt: d || v.occurredAt })} /></Field>
        <Field label="روش"><Select value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })} aria-label="روش"><option value="TRANSFER">انتقال</option><option value="CHEQUE">چک</option><option value="CASH">نقد</option><option value="OTHER">سایر</option></Select></Field>
        <Field label="مرجع"><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} className="ltr" aria-label="مرجع" /></Field>
        <FxPreview currency={v.currency} amount={Number(v.amount || 0)} on={v.occurredAt} />
      </div>
    </Modal>
  );
}
