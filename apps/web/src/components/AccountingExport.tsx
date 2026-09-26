import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_KEYS, ACCOUNT_LABELS, ACCOUNTING_FIELDS, ACCOUNTING_FIELD_LABELS, type AccountKey, type AccountingField } from '@hiva/contracts';
import { apiGet, apiPost, apiPut, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, StatTile, Table, Td, Th, Tr, useToast } from './ui';
import { JalaliDateInput } from './JalaliDateInput';
import { formatCurrency, formatDate, formatDateTime, formatNumber, localDateOnly, toPersianDigits } from '../lib/format';

/* Roadmap #33 — vouchers for the accounting package, in the organisation's own chart and columns. */

interface Column { field: AccountingField; header: string }
interface Layout { columns: Column[]; dateFormat: 'JALALI' | 'GREGORIAN' }
interface Settings {
  accounts: Partial<Record<AccountKey, string>>; clientCodes: Record<string, string>; layout: Layout; saved: boolean;
  defaultLayout: Layout; clients: { id: string; legalName: string }[];
}
interface Problem { code: string; message: string }
interface Line { account: AccountKey; detail: string | null; description: string; debit: number; credit: number }
interface Voucher { kind: string; sourceId: string; reference: string; date: string; description: string; lines: Line[] }
interface Preview {
  counts: { invoices: number; reversals: number; receipts: number; payments: number }; lines: number; debitTotal: number; creditTotal: number;
  problems: Problem[]; warnings: Problem[]; vouchers: Voucher[]; more: number; accounts: Partial<Record<AccountKey, string>>;
}

const KIND_FA: Record<string, string> = { INVOICE: 'فاکتور', REVERSAL: 'برگشت', RECEIPT: 'دریافت', PAYMENT: 'پرداخت' };
const rial = (n: number | string) => `${formatNumber(Number(n))} ریال`;

export function AccountingTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [to, setTo] = useState(() => localDateOnly(new Date()));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: s } = useQuery<Settings>({ queryKey: ['/accounting/settings'], queryFn: () => apiGet('/accounting/settings') });
  const { data: p } = useQuery<Preview>({ queryKey: ['/accounting/preview', to], queryFn: () => apiGet('/accounting/preview', { to }), enabled: !!to });
  const { data: history } = useQuery<any[]>({ queryKey: ['/accounting/exports'], queryFn: () => apiGet('/accounting/exports') });
  if (!s || !p || !history) return null;

  const empty = p.counts.invoices + p.counts.reversals + p.counts.receipts + p.counts.payments === 0;
  const post = async () => {
    setBusy(true);
    try {
      const exp = await apiPost<{ id: string; number: number; vouchers: number; fileName: string }>('/accounting/exports', { to });
      toast(`خروجی شمارهٔ ${toPersianDigits(exp.number)} با ${toPersianDigits(exp.vouchers)} سند ثبت شد.`);
      await downloadFile(`/accounting/exports/${exp.id}/file`, exp.fileName);
      await qc.invalidateQueries();
    } catch (e: any) { toast(e?.message ?? 'ثبت خروجی ناموفق بود.', 'danger'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <Card title="سندهای ثبت‌نشده" subtitle="هر فاکتور، ابطال، دریافت و پرداختی که هنوز به نرم‌افزار حسابداری نرفته — تا تاریخی که انتخاب می‌کنید."
        action={<div className="w-40"><JalaliDateInput value={to} onChange={setTo} id="accounting-to" /></div>}>
        <div className="space-y-3 px-4 py-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile label="فاکتور" value={toPersianDigits(p.counts.invoices)} />
            <StatTile label="برگشت (ابطال پس از ثبت)" value={toPersianDigits(p.counts.reversals)} tone={p.counts.reversals ? 'warning' : 'neutral'} />
            <StatTile label="دریافت" value={toPersianDigits(p.counts.receipts)} />
            <StatTile label="پرداخت" value={toPersianDigits(p.counts.payments)} />
            <StatTile label="جمع بدهکار = بستانکار" value={formatCurrency(p.debitTotal)} tone={p.debitTotal === p.creditTotal ? 'success' : 'danger'} />
          </div>
          {p.problems.length > 0 && (
            <ul className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800" data-testid="accounting-problems">
              {p.problems.map((x) => <li key={x.code}>· {x.message}</li>)}
            </ul>
          )}
          {p.warnings.length > 0 && (
            <ul className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="accounting-warnings">
              {p.warnings.map((x) => <li key={x.code}>· {x.message}</li>)}
            </ul>
          )}
          {can('finance.settle') && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" loading={busy} disabled={empty || p.problems.length > 0} onClick={() => void post()}>ثبت خروجی و دریافت فایل</Button>
              <span className="text-[11px] text-ink-500">پس از ثبت، این سندها در خروجی بعدی نمی‌آیند؛ فایل هر خروجی را می‌توان دوباره گرفت.</span>
            </div>
          )}
        </div>
        {empty ? <EmptyState title="تا این تاریخ سند ثبت‌نشده‌ای نمانده است" /> : <VoucherTable preview={p} />}
      </Card>

      <Card title="خروجی‌های ثبت‌شده" subtitle="هر خروجی شماره دارد و فایلش همان‌طور که نوشته شد نگه داشته می‌شود.">
        {!history.length ? <EmptyState title="هنوز خروجی‌ای ثبت نشده" /> : (
          <Table>
            <thead className="bg-ink-50/60"><tr><Th>شماره</Th><Th>تا تاریخ</Th><Th>سند / ردیف</Th><Th>جمع</Th><Th>ثبت</Th><Th /></tr></thead>
            <tbody data-testid="accounting-history">
              {history.map((x) => (
                <Tr key={x.id}>
                  <Td className="text-xs">{toPersianDigits(x.number)}</Td>
                  <Td className="text-xs">{formatDate(x.periodTo)}</Td>
                  <Td className="text-xs">{toPersianDigits(x.vouchers)} / {toPersianDigits(x.lines)}</Td>
                  <Td className="text-xs">{formatCurrency(x.debitTotal)}</Td>
                  <Td className="text-[11px]">{x.createdBy ?? '—'} · {formatDateTime(x.createdAt)}</Td>
                  <Td><Button size="sm" variant="ghost" onClick={() => void downloadFile(`/accounting/exports/${x.id}/file`, x.fileName).catch((e) => toast(e?.message ?? 'دریافت ناموفق بود.', 'danger'))}>دریافت فایل</Button></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="سرفصل‌ها و قالب فایل" subtitle="کدهای حساب از دفتر حساب‌های خود سازمان، و ستون‌ها به ترتیبی که صفحهٔ ورود اطلاعات نرم‌افزار حسابداری می‌خواهد."
        action={can('finance.settle') ? <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{s.saved ? 'ویرایش' : 'تنظیم'}</Button> : undefined}>
        <dl className="grid gap-x-6 gap-y-1 px-4 py-3 text-xs sm:grid-cols-2" data-testid="accounting-settings">
          {ACCOUNT_KEYS.map((k) => (
            <div key={k} className="flex justify-between gap-2 border-b border-ink-100 py-1">
              <dt className="text-ink-500">{ACCOUNT_LABELS[k]}</dt>
              <dd className="ltr">{s.accounts[k] ?? <span className="text-ink-300">—</span>}</dd>
            </div>
          ))}
        </dl>
        <p className="px-4 pb-3 text-[11px] text-ink-500">
          ستون‌ها: {s.layout.columns.map((c) => c.header).join('، ')} · تاریخ {s.layout.dateFormat === 'JALALI' ? 'شمسی' : 'میلادی'} · کد تفصیلی برای {toPersianDigits(Object.keys(s.clientCodes).length)} مشتری
        </p>
      </Card>
      {editing && <SettingsModal settings={s} onClose={() => setEditing(false)} />}
    </div>
  );
}

function VoucherTable({ preview }: { preview: Preview }) {
  return (
    <>
      <Table>
        <thead className="bg-ink-50/60"><tr><Th>تاریخ</Th><Th>سند</Th><Th>حساب</Th><Th>تفصیلی</Th><Th>بدهکار</Th><Th>بستانکار</Th></tr></thead>
        <tbody data-testid="accounting-vouchers">
          {preview.vouchers.map((v) => v.lines.map((l, i) => (
            <Tr key={`${v.kind}-${v.sourceId}-${i}`}>
              <Td className="text-[11px]">{i === 0 ? formatDate(v.date) : ''}</Td>
              <Td className="text-[11px]">{i === 0 ? <><Badge tone={v.kind === 'REVERSAL' ? 'warning' : 'neutral'}>{KIND_FA[v.kind]}</Badge> <span className="ltr">{v.reference}</span><span className="block text-ink-500">{v.description}</span></> : ''}</Td>
              <Td className="text-[11px]">{ACCOUNT_LABELS[l.account]} <span className="ltr text-ink-400">{preview.accounts[l.account] ?? '؟'}</span></Td>
              <Td className="ltr text-[11px]">{l.detail ?? ''}</Td>
              <Td className="text-[11px]">{l.debit ? rial(l.debit) : ''}</Td>
              <Td className="text-[11px]">{l.credit ? rial(l.credit) : ''}</Td>
            </Tr>
          )))}
        </tbody>
      </Table>
      {preview.more > 0 && <p className="px-4 py-2 text-[11px] text-ink-500">و {toPersianDigits(preview.more)} سند دیگر — همه در فایل می‌آیند.</p>}
    </>
  );
}

function SettingsModal({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const [accounts, setAccounts] = useState<Partial<Record<AccountKey, string>>>(settings.accounts);
  const [clientCodes, setClientCodes] = useState<Record<string, string>>(settings.clientCodes);
  const [layout, setLayout] = useState<Layout>(settings.layout);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const setColumn = (i: number, c: Partial<Column>) => setLayout({ ...layout, columns: layout.columns.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const move = (i: number, by: number) => {
    const cols = [...layout.columns];
    const [c] = cols.splice(i, 1);
    cols.splice(i + by, 0, c!);
    setLayout({ ...layout, columns: cols });
  };
  const unused = ACCOUNTING_FIELDS.filter((f) => !layout.columns.some((c) => c.field === f));
  const save = async () => {
    setBusy(true); setProblems([]);
    try {
      await apiPut('/accounting/settings', {
        accounts: Object.fromEntries(Object.entries(accounts).filter(([, v]) => v?.trim())),
        clientCodes: Object.fromEntries(Object.entries(clientCodes).filter(([, v]) => v.trim())),
        layout,
      });
      toast('تنظیمات خروجی حسابداری ذخیره شد.'); await qc.invalidateQueries(); onClose();
    } catch (e: any) {
      setProblems(((e?.body?.details?.problems as Problem[]) ?? []).map((x) => x.message));
      toast(e?.message ?? 'ذخیره ناموفق بود.', 'danger');
    } finally { setBusy(false); }
  };
  return (
    <Modal open wide title="سرفصل‌ها و قالب فایل حسابداری" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>انصراف</Button><Button variant="primary" loading={busy} onClick={() => void save()}>ذخیره</Button></>}>
      <div className="space-y-5" data-testid="accounting-settings-form">
        <section>
          <h4 className="mb-2 text-xs font-semibold text-ink-700">کد حساب هر سرفصل</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            {ACCOUNT_KEYS.map((k) => (
              <Field key={k} label={ACCOUNT_LABELS[k]}>
                <Input value={accounts[k] ?? ''} onChange={(e) => setAccounts({ ...accounts, [k]: e.target.value })} className="ltr" aria-label={ACCOUNT_LABELS[k]} />
              </Field>
            ))}
          </div>
        </section>

        <section>
          <h4 className="mb-1 text-xs font-semibold text-ink-700">ستون‌های فایل</h4>
          <p className="mb-2 text-[11px] text-ink-500">به همان ترتیب و با همان عنوانی که صفحهٔ ورود سند در نرم‌افزار حسابداری شما می‌خواهد.</p>
          <ol className="space-y-1.5">
            {layout.columns.map((c, i) => (
              <li key={`${c.field}-${i}`} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                <Select value={c.field} aria-label={`محتوای ستون ${i + 1}`} onChange={(e) => setColumn(i, { field: e.target.value as AccountingField })}>
                  {ACCOUNTING_FIELDS.map((f) => <option key={f} value={f}>{ACCOUNTING_FIELD_LABELS[f]}</option>)}
                </Select>
                <Input value={c.header} aria-label={`عنوان ستون ${i + 1}`} onChange={(e) => setColumn(i, { header: e.target.value })} />
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="بالاتر">↑</Button>
                  <Button size="sm" variant="ghost" disabled={i === layout.columns.length - 1} onClick={() => move(i, 1)} aria-label="پایین‌تر">↓</Button>
                  <Button size="sm" variant="ghost" disabled={layout.columns.length === 1} onClick={() => setLayout({ ...layout, columns: layout.columns.filter((_, j) => j !== i) })} aria-label="حذف ستون">×</Button>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {unused.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setLayout({ ...layout, columns: [...layout.columns, { field: unused[0]!, header: ACCOUNTING_FIELD_LABELS[unused[0]!] }] })}>افزودن ستون</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setLayout(settings.defaultLayout)}>قالب پیش‌فرض</Button>
            <label className="ms-auto flex items-center gap-2 text-xs text-ink-600">
              تاریخ
              <Select value={layout.dateFormat} aria-label="قالب تاریخ" onChange={(e) => setLayout({ ...layout, dateFormat: e.target.value as Layout['dateFormat'] })}>
                <option value="JALALI">شمسی (۱۴۰۵/۰۷/۰۴)</option>
                <option value="GREGORIAN">میلادی (2026-09-26)</option>
              </Select>
            </label>
          </div>
        </section>

        <section>
          <h4 className="mb-1 text-xs font-semibold text-ink-700">کد تفصیلی مشتریان</h4>
          {!settings.clients.length ? <p className="text-[11px] text-ink-500">هنوز با مشتری‌ای سند مالی نداشته‌اید.</p> : (
            <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
              {settings.clients.map((c) => (
                <label key={c.id} className="grid grid-cols-[1fr_8rem] items-center gap-2 text-xs text-ink-700">
                  <span className="truncate">{c.legalName}</span>
                  <Input value={clientCodes[c.id] ?? ''} className="ltr" aria-label={`کد تفصیلی ${c.legalName}`} onChange={(e) => setClientCodes({ ...clientCodes, [c.id]: e.target.value })} />
                </label>
              ))}
            </div>
          )}
        </section>
        {problems.length > 0 && <ul className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{problems.map((x) => <li key={x}>· {x}</li>)}</ul>}
      </div>
    </Modal>
  );
}
