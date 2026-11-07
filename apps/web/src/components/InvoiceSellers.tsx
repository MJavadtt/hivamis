import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut, downloadFile, downloadPdf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Card, Field, Input, LoadingBlock, useToast } from './ui';
import type { InvoiceSeller } from './Fx';
import { tr } from '../i18n';

/**
 * The companies invoices are issued in (the owner, 2026-11-07; ADR-125): what each one's form prints
 * in «مشخصات فروشنده», and its bank. A correction here prints on invoices issued from now on; one
 * already issued keeps what it printed.
 */

const FIELDS = [
  ['shortName', tr('نام کوتاه'), ''], ['legalName', tr('نام شخص حقوقی'), 'sm:col-span-2'],
  ['economicCode', tr('شمارهٔ اقتصادی'), 'ltr'], ['nationalId', tr('شناسهٔ ملی'), 'ltr'], ['postalCode', tr('کد پستی ده‌رقمی'), 'ltr'],
  ['province', tr('استان'), ''], ['county', tr('شهرستان'), ''], ['city', tr('شهر'), ''],
  ['address', tr('نشانی'), 'sm:col-span-3'], ['phone', tr('تلفن / نمابر'), 'ltr'],
  ['bankName', tr('بانک'), ''], ['accountNumber', tr('شمارهٔ حساب'), 'ltr'], ['iban', tr('شمارهٔ شبا'), 'ltr sm:col-span-2'],
] as const;
type Key = (typeof FIELDS)[number][0];

function SellerCard({ seller }: { seller: InvoiceSeller }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const editable = can('finance.settle');
  const [v, setV] = useState<Record<Key, string>>(() => Object.fromEntries(FIELDS.map(([k]) => [k, seller[k] ?? ''])) as Record<Key, string>);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setV(Object.fromEntries(FIELDS.map(([k]) => [k, seller[k] ?? ''])) as Record<Key, string>); }, [seller]);
  const save = async () => {
    setBusy(true);
    try {
      await apiPut(`/invoice-sellers/${seller.id}`, Object.fromEntries(FIELDS.map(([k]) => [k, v[k].trim() || null])));
      await qc.invalidateQueries({ queryKey: ['/invoice-sellers'] });
      toast(tr('مشخصات {0} ذخیره شد.', seller.shortName));
    } catch (e: any) {
      // What exactly was refused — a wrong IBAN says so — rather than only that something was.
      const why = (e?.issues as { message: string }[] | undefined)?.map((i) => i.message).join(' ');
      toast(why || e?.message || tr('ذخیره ناموفق بود.'), 'danger');
    } finally { setBusy(false); }
  };
  return (
    <Card title={seller.shortName} subtitle={tr('فرم چاپی: {0}', seller.form === 'hiva' ? tr('فاکتور هیوا') : tr('فاکتور خط تیره'))}
      footer={editable ? <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={!v.shortName.trim() || v.legalName.trim().length < 2} onClick={() => void save()}>{tr('ذخیره')}</Button></div> : undefined}>
      <div className="grid gap-3 sm:grid-cols-3">
        {FIELDS.map(([k, label, cls]) => (
          <div key={k} className={cls.replace('ltr', '').trim()}>
            <Field label={label}><Input value={v[k]} readOnly={!editable} onChange={(e) => setV({ ...v, [k]: e.target.value })} className={cls.includes('ltr') ? 'ltr' : ''} /></Field>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function InvoiceSellers() {
  const { data } = useQuery<InvoiceSeller[]>({ queryKey: ['/invoice-sellers'], queryFn: () => apiGet('/invoice-sellers') });
  if (!data) return <LoadingBlock />;
  if (!Array.isArray(data)) return null;
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-600">{tr('هر سند مالی به نام یکی از این شرکت‌ها صادر و روی فرم همان شرکت چاپ می‌شود. اصلاح این مشخصات در سندهای بعدی چاپ می‌شود؛ سندی که صادر شده همان را نگه می‌دارد که چاپ کرده است.')}</p>
      {data.map((s) => <SellerCard key={s.id} seller={s} />)}
    </div>
  );
}

/** An invoice on its company's form, in Excel or PDF; one from before the forms has neither until a seller is chosen. */
export function InvoiceDownloads({ invoice }: { invoice: { id: string; number: string; kind: string; seller?: { shortName: string } | null } }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null);
  const run = async (what: 'xlsx' | 'pdf') => {
    setBusy(what);
    try {
      if (what === 'xlsx') await downloadFile(`/invoices/${invoice.id}/workbook`, `${invoice.kind === 'PROFORMA' ? tr('پیش‌فاکتور') : tr('فاکتور')} ${invoice.number}.xlsx`);
      else await downloadPdf('invoice', invoice.id);
    } catch (e: any) { toast(e?.message ?? e?.body?.message ?? tr('دریافت ناموفق بود.'), 'danger'); } finally { setBusy(null); }
  };
  const noSeller = !invoice.seller;
  // Small, beside the row's other actions: a list this wide has no room for two full buttons.
  const link = 'rounded px-1 py-0.5 text-xs font-medium text-brand-700 hover:bg-ink-100 disabled:cursor-not-allowed disabled:text-ink-300 disabled:hover:bg-transparent';
  return (
    <span className="inline-flex items-center">
      <button type="button" className={link} disabled={noSeller || !!busy} title={noSeller ? tr('اول فروشنده را در ویرایش سند برگزینید') : tr('فرم Excel')}
        aria-label={tr('Excel سند {0}', invoice.number)} aria-busy={busy === 'xlsx'} onClick={() => void run('xlsx')}>Excel</button>
      <button type="button" className={link} disabled={!!busy} title={tr('PDF')} aria-label={tr('PDF سند {0}', invoice.number)} aria-busy={busy === 'pdf'} onClick={() => void run('pdf')}>PDF</button>
    </span>
  );
}
