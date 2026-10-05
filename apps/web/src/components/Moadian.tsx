import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, StatTile, Table, Td, Th, Tr, useToast } from './ui';
import { formatCurrency, formatDate, formatDateTime, localDigits } from '../lib/format';
import { loc, tr, trx } from '../i18n';

/* Roadmap #32 — reporting invoices to سامانهٔ مؤدیان. */

export const TAX_STATUS: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral' | 'info']> = {
  NOT_REPORTED: [tr('گزارش‌نشده'), 'neutral'], QUEUED: [tr('در صف'), 'info'], SENT: [tr('در انتظار پاسخ'), 'warning'],
  ACCEPTED: [tr('پذیرفته'), 'success'], REJECTED: [tr('رد شده'), 'danger'], FAILED: [tr('ارسال ناموفق'), 'danger'],
};
const SUBJECT_FA: Record<string, string> = { ORIGINAL: tr('اصلی'), CORRECTION: tr('اصلاحی'), CANCELLATION: tr('ابطالی') };

export function TaxBadge({ submission }: { submission?: { status: string; subject: string } | null }) {
  if (!submission) return <Badge tone="neutral">{tr('گزارش‌نشده')}</Badge>;
  const [fa, tone] = TAX_STATUS[submission.status] ?? [submission.status, 'neutral'];
  return <Badge tone={tone}>{submission.subject === 'ORIGINAL' ? fa : `${SUBJECT_FA[submission.subject]}: ${fa}`}</Badge>;
}

interface Profile { memoryId: string; sellerTaxId: string; economicCode: string | null; postalCode: string | null; branchCode: string | null; defaultServiceCode: string; defaultUnitCode: string }

export function MoadianTab() {
  const { can } = useAuth();
  const { data: p } = useQuery<{ profile: Profile | null; mode: string; modeFa: string; problems: { messageFa: string }[] }>({ queryKey: ['/tax/profile'], queryFn: () => apiGet('/tax/profile') });
  const { data: r } = useQuery<any>({ queryKey: ['/reports/tax'], queryFn: () => apiGet('/reports/tax') });
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (!p || !r) return null;
  return (
    <div className="space-y-5">
      <div className={`rounded-lg px-4 py-2 text-xs ${p.mode === 'live' ? 'bg-emerald-50 text-emerald-900' : p.mode === 'sandbox' ? 'bg-amber-50 text-amber-900' : 'bg-ink-50 text-ink-700'}`} data-testid="moadian-mode">
        {loc(p, 'mode')}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={tr('گزارش‌نشده')} value={localDigits(r.totals.notReported)} tone={r.totals.notReported ? 'warning' : 'success'} />
        <StatTile label={tr('در صف / در انتظار پاسخ')} value={localDigits(r.totals.queued + r.totals.sent)} />
        <StatTile label={tr('رد شده یا ناموفق')} value={localDigits(r.totals.rejected + r.totals.failed)} tone={r.totals.rejected + r.totals.failed ? 'danger' : 'neutral'} />
        <StatTile label={tr('پذیرفته')} value={localDigits(r.totals.accepted)} tone="success" />
      </div>

      <Card title={tr('مشخصات مؤدی')} subtitle={tr('حافظهٔ مالیاتی و شناسه‌هایی که هر صورت‌حساب الکترونیکی با آن صادر می‌شود.')}
        action={can('finance.settle') ? <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{p.profile ? tr('ویرایش') : tr('ثبت')}</Button> : undefined}>
        {!p.profile ? <EmptyState title={tr('مشخصات مؤدی ثبت نشده')} description={tr('تا ثبت نشود، هیچ فاکتوری به سامانه گزارش نمی‌شود.')} /> : (
          <dl className="grid gap-x-6 gap-y-1 px-4 py-3 text-xs sm:grid-cols-3" data-testid="moadian-profile">
            <div><dt className="text-ink-400">{tr('حافظهٔ مالیاتی')}</dt><dd className="ltr">{p.profile.memoryId}</dd></div>
            <div><dt className="text-ink-400">{tr('شمارهٔ اقتصادی فروشنده')}</dt><dd className="ltr">{p.profile.sellerTaxId}</dd></div>
            <div><dt className="text-ink-400">{tr('شناسهٔ کالا/خدمت پیش‌فرض')}</dt><dd className="ltr">{p.profile.defaultServiceCode}</dd></div>
          </dl>
        )}
      </Card>

      <Card title={tr('فاکتورهایی که سامانه هنوز نپذیرفته')} subtitle={tr('قدیمی‌ترین نخست — هر ردیف را باز کنید تا ببینید چه کم است یا سامانه چه گفته.')}>
        {!r.pending.length ? <EmptyState title={tr('همهٔ فاکتورهای صادرشده پذیرفته شده‌اند')} /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>{tr('فاکتور')}</Th><Th>{tr('مشتری')}</Th><Th>{tr('صدور')}</Th><Th>{tr('مبلغ')}</Th><Th>{tr('وضعیت')}</Th><Th /></tr></thead>
            <tbody data-testid="moadian-pending">
              {r.pending.map((x: any) => (
                <Tr key={x.id}>
                  <Td className="ltr text-xs">{x.number}</Td>
                  <Td className="text-xs">{x.client}</Td>
                  <Td className="text-xs">{formatDate(x.issueDate)} <span className="text-ink-400">{tr('({0} روز پیش)', localDigits(x.ageDays))}</span></Td>
                  <Td className="text-xs">{formatCurrency(x.total)}</Td>
                  <Td><Badge tone={(TAX_STATUS[x.status] ?? ['', 'neutral'])[1]}>{(TAX_STATUS[x.status] ?? [x.status])[0]}</Badge></Td>
                  <Td><Button size="sm" variant="ghost" onClick={() => setOpen(x.id)}>{tr('باز کردن')}</Button></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && <ProfileModal profile={p.profile} onClose={() => setEditing(false)} />}
      {open && <InvoiceTax invoiceId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ProfileModal({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const [v, setV] = useState({
    memoryId: profile?.memoryId ?? '', sellerTaxId: profile?.sellerTaxId ?? '', economicCode: profile?.economicCode ?? '', postalCode: profile?.postalCode ?? '',
    branchCode: profile?.branchCode ?? '', defaultServiceCode: profile?.defaultServiceCode ?? '', defaultUnitCode: profile?.defaultUnitCode ?? '',
  });
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const field = (k: keyof typeof v, label: string, hint?: string) => (
    <Field label={label} hint={hint}><Input value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} className="ltr" aria-label={label} /></Field>
  );
  const save = async () => {
    setBusy(true); setProblems([]);
    try {
      await apiPut('/tax/profile', { ...v, economicCode: v.economicCode || null, postalCode: v.postalCode || null, branchCode: v.branchCode || null });
      toast(tr('مشخصات مؤدی ذخیره شد.')); await qc.invalidateQueries(); onClose();
    } catch (e: any) {
      setProblems(((e?.body?.details?.problems as { messageFa: string }[]) ?? []).map((x) => trx(x.messageFa)));
      toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger');
    } finally { setBusy(false); }
  };
  return (
    <Modal open title={tr('مشخصات مؤدی در سامانهٔ مؤدیان')} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{tr('ذخیره')}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {field('memoryId', tr('شناسهٔ حافظهٔ مالیاتی'), tr('شش نویسه، از کارپوشهٔ سامانه'))}
        {field('sellerTaxId', tr('شمارهٔ اقتصادی / شناسهٔ ملی فروشنده'))}
        {field('economicCode', tr('کد اقتصادی'))}
        {field('postalCode', tr('کد پستی'))}
        {field('branchCode', tr('کد شعبه'), tr('اگر صورت‌حساب از شعبه صادر می‌شود'))}
        {field('defaultServiceCode', tr('شناسهٔ کالا/خدمت پیش‌فرض'), tr('۱۳ رقم'))}
        {field('defaultUnitCode', tr('کد واحد اندازه‌گیری'))}
      </div>
      {problems.length > 0 && <ul className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{problems.map((x) => <li key={x}>· {x}</li>)}</ul>}
    </Modal>
  );
}

/** One invoice and the tax authority: what is missing, what was sent, what it said. */
export function InvoiceTax({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery<any>({ queryKey: ['/invoices', invoiceId, 'tax'], queryFn: () => apiGet(`/invoices/${invoiceId}/tax`) });
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries();
  const submit = async (subject: string) => {
    setBusy(true);
    try {
      const s = await apiPost<{ status: string; taxId: string }>(`/invoices/${invoiceId}/tax`, { subject });
      toast(tr('گزارش {0} با شمارهٔ مالیاتی {1} — {2}.', SUBJECT_FA[subject], s.taxId, (TAX_STATUS[s.status] ?? [s.status])[0])); await refresh();
    } catch (e: any) { toast(e?.message ?? tr('گزارش ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  const inquire = async (id: string) => { await apiPost(`/tax/submissions/${id}/inquire`, {}); await refresh(); };
  return (
    <Modal open wide title={tr('سامانهٔ مؤدیان')} onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>{tr('بستن')}</Button>}>
      {!data ? null : (
        <div className="space-y-4" data-testid="invoice-tax">
          <p className="text-[12.5px] text-ink-500">{loc(data, 'mode')}</p>
          {data.problems.length > 0 && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="tax-problems">
              <p className="font-medium">{tr('پیش از گزارش باید درست شود:')}</p>
              <ul className="mt-1 space-y-0.5">{data.problems.map((p: any) => <li key={p.field}>· {loc(p, 'message')}</li>)}</ul>
              {data.problems.some((p: any) => ['bid', 'bpc'].includes(p.field)) && can('finance.invoice') && <BuyerIds invoiceId={invoiceId} onSaved={refresh} />}
            </div>
          )}
          {can('finance.invoice') && data.subjects.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.subjects.map((s: string) => (
                <Button key={s} variant={s === 'CANCELLATION' ? 'danger' : 'primary'} size="sm" loading={busy} disabled={data.problems.length > 0} onClick={() => void submit(s)}>
                  {s === 'ORIGINAL' ? tr('گزارش به سامانه') : s === 'CORRECTION' ? tr('صورت‌حساب اصلاحی') : tr('صورت‌حساب ابطالی')}
                </Button>
              ))}
            </div>
          )}
          {data.cancelled && <p className="text-xs text-ink-600">{tr('این فاکتور در سامانه ابطال شده است.')}</p>}
          {data.payload && (
            <p className="text-xs text-ink-600">{tr('مبلغ کل گزارش‌شونده:')}{' '}<strong>{tr('{0} ریال', localDigits(Number(data.payload.header.tbill).toLocaleString('en-US')))}</strong>{tr('{0}(بدون مالیات {1} + ارزش افزوده {2}) در {3} ردیف', ' ', localDigits(Number(data.payload.header.tadis).toLocaleString('en-US')), localDigits(Number(data.payload.header.tvam).toLocaleString('en-US')), localDigits(data.payload.body.length))}</p>
          )}
          {data.submissions.length > 0 && (
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>{tr('گزارش')}</Th><Th>{tr('شمارهٔ مالیاتی')}</Th><Th>{tr('وضعیت')}</Th><Th>{tr('زمان')}</Th><Th /></tr></thead>
              <tbody data-testid="tax-submissions">
                {[...data.submissions].reverse().map((s: any) => (
                  <Tr key={s.id}>
                    <Td className="text-xs">{SUBJECT_FA[s.subject]}</Td>
                    <Td className="ltr text-[12.5px]">{s.taxId}{s.referenceTaxId && <span className="block text-ink-400">↩ {s.referenceTaxId}</span>}</Td>
                    <Td>
                      <Badge tone={(TAX_STATUS[s.status] ?? ['', 'neutral'])[1]}>{(TAX_STATUS[s.status] ?? [s.status])[0]}</Badge>
                      {s.channel === 'sandbox' && <span className="ms-1 text-[12px] text-amber-700">{tr('آزمایشی')}</span>}
                      {s.errors && <pre className="ltr mt-1 max-w-xs whitespace-pre-wrap text-[12px] text-rose-700">{JSON.stringify(s.errors)}</pre>}
                    </Td>
                    <Td className="text-[12.5px]">{formatDateTime(s.respondedAt ?? s.submittedAt ?? s.createdAt)}</Td>
                    <Td>{['QUEUED', 'SENT'].includes(s.status) && can('finance.invoice') && <Button size="sm" variant="ghost" onClick={() => void inquire(s.id)}>{tr('پیگیری')}</Button>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      )}
    </Modal>
  );
}

function BuyerIds({ invoiceId, onSaved }: { invoiceId: string; onSaved: () => void }) {
  const { data: inv } = useQuery<any>({ queryKey: ['/invoices', invoiceId], queryFn: () => apiGet(`/invoices/${invoiceId}`) });
  const [v, setV] = useState<{ nationalId: string; postalCode: string } | null>(null);
  const toast = useToast();
  if (!inv) return null;
  const cur = v ?? { nationalId: inv.company?.nationalId ?? '', postalCode: inv.company?.postalCode ?? '' };
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" data-testid="buyer-ids">
      <Input value={cur.nationalId} onChange={(e) => setV({ ...cur, nationalId: e.target.value })} className="ltr" aria-label={tr('شناسهٔ ملی خریدار')} placeholder={tr('شناسهٔ ملی خریدار')} />
      <Input value={cur.postalCode} onChange={(e) => setV({ ...cur, postalCode: e.target.value })} className="ltr" aria-label={tr('کد پستی خریدار')} placeholder={tr('کد پستی خریدار')} />
      <Button size="sm" variant="secondary" onClick={async () => {
        try { await apiPut(`/companies/${inv.companyId}/tax-identifiers`, cur); toast(tr('شناسه‌های خریدار ذخیره شد.')); onSaved(); }
        catch (e: any) { toast(e?.message ?? tr('ذخیره ناموفق بود.'), 'danger'); }
      }}>{tr('ذخیره')}</Button>
    </div>
  );
}
