import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IMPORT_KIND_LABELS, IMPORT_KINDS, type ImportKind } from '@hiva/contracts';
import { apiGet, apiUpload, downloadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, localDigits } from '../../lib/format';
import { PageBody, PageHeader } from '../../components/Shell';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Select, Table, Td, Th, Tr, cx, useToast } from '../../components/ui';
import { tr, trx } from '../../i18n';
import { SitesNav, pairLabel } from './shared';

/**
 * Excel in and out (ADR-103) — «امکان اینپورت و اکسپورت با فایل اکسل». In: a template per kind, the file
 * checked row by row before anything is written, the columns matched by header (and re-mapped where
 * they were named otherwise), and the good rows written together — the bad ones only left out when the
 * person says so. Out: every list as a sheet.
 */

interface Column { key: string; fa: string; required?: boolean; hint?: string }
interface RowResult { row: number; action: 'CREATE' | 'UPDATE' | 'ERROR'; code?: string | null; label: string; errors: string[]; warnings: string[] }
interface Outcome { kind: ImportKind; dryRun: boolean; totalRows: number; mapping: Record<string, string>; unmatched: string[]; created: number; updated: number; failed: number; rows: RowResult[]; importId?: string }

const NEEDS: Record<ImportKind, string> = { VENUES: 'venue.manage', CONTACTS: 'venue.write', SITE_PROJECTS: 'site.write', OBLIGATIONS: 'rental.manage' };
const EXPORTS: { kind: string; label: () => string; perm: string }[] = [
  { kind: 'venues', label: () => tr('مکان‌ها'), perm: 'venue.read' }, { kind: 'contacts', label: () => tr('مخاطبان مکان‌ها'), perm: 'venue.read' },
  { kind: 'projects', label: () => tr('پروژه‌های استقرار'), perm: 'site.read' }, { kind: 'obligations', label: () => tr('جدول اجاره و تعهدات'), perm: 'rental.read' },
  { kind: 'payments', label: () => tr('پرداخت‌ها'), perm: 'rental.read' }, { kind: 'deposits', label: () => tr('ودیعه‌ها'), perm: 'rental.read' },
];

export default function ExcelPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const kinds = IMPORT_KINDS.filter((k) => can(NEEDS[k]));
  const [kind, setKind] = useState<ImportKind>(kinds[0] ?? 'VENUES');
  const [mode, setMode] = useState<'CREATE' | 'UPSERT'>('CREATE');
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: columns } = useQuery<Column[]>({ queryKey: ['/site-data/columns', kind], queryFn: () => apiGet(`/site-data/columns/${kind}`), enabled: kinds.includes(kind) });
  const { data: history } = useQuery<{ id: string; kind: ImportKind; mode: string; fileName: string; totalRows: number; created: number; updated: number; failed: number; createdAt: string; createdBy: { fullName: string } }[]>({
    queryKey: ['/site-data/imports'], queryFn: () => apiGet('/site-data/imports'), enabled: kinds.length > 0,
  });
  const send = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      if (Object.keys(mapping).length) form.append('mapping', JSON.stringify(mapping));
      form.append('file', file);
      const r = await apiUpload<Outcome>(`/site-data/import/${kind}?mode=${mode}&dryRun=${dryRun}&skipInvalid=${skip}`, form);
      setOutcome(r);
      if (!dryRun) { toast(tr('{0} ردیف تازه و {1} به‌روزرسانی ثبت شد.', localDigits(r.created), localDigits(r.updated))); await qc.invalidateQueries(); }
    } catch (e: any) {
      toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger');
      if (e?.code === 'MISSING_COLUMNS') setOutcome(null);
    } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title={tr('ورود و خروج اکسل')} subtitle={tr('ورود مکان‌ها، مخاطبان، پروژه‌ها و تعهدات با بررسی ردیف‌به‌ردیف؛ خروجی هر فهرست')} />
      <PageBody>
        <SitesNav />
        <div className="grid gap-5 lg:grid-cols-3">
          {kinds.length > 0 && (
            <Card className="lg:col-span-2" title={tr('ورود از اکسل')} subtitle={tr('نخست بررسی، سپس ثبت؛ چیزی بی‌اجازه بازنویسی نمی‌شود')}>
              <div className="space-y-3 p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={tr('نوع')}><Select value={kind} onChange={(e) => { setKind(e.target.value as ImportKind); setOutcome(null); setMapping({}); }}>{kinds.map((k) => <option key={k} value={k}>{pairLabel(IMPORT_KIND_LABELS, k)}</option>)}</Select></Field>
                  <Field label={tr('ردیف‌های هم‌کد')} hint={mode === 'UPSERT' ? tr('ردیفی که کد رکورد موجود را دارد، آن را به‌روز می‌کند.') : tr('فقط رکورد تازه؛ کد موجود خطاست.')}>
                    <Select value={mode} onChange={(e) => setMode(e.target.value as 'CREATE' | 'UPSERT')}><option value="CREATE">{tr('فقط ثبت تازه')}</option><option value="UPSERT">{tr('ثبت تازه و به‌روزرسانی')}</option></Select>
                  </Field>
                  <Field label={tr('الگو')}><Button onClick={() => void downloadFile(`/site-data/templates/${kind}`, `${kind.toLowerCase()}-template.xlsx`)}>{tr('دریافت الگوی خالی')}</Button></Field>
                </div>
                <Field label={tr('فایل xlsx')}><Input type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setOutcome(null); }} /></Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button loading={busy} disabled={!file} onClick={() => void send(true)}>{tr('بررسی (بدون ثبت)')}</Button>
                  {outcome?.dryRun && <>
                    {outcome.failed > 0 && <Checkbox label={tr('ردیف‌های خطادار کنار گذاشته شوند')} checked={skip} onChange={(e) => setSkip(e.target.checked)} />}
                    <Button variant="primary" loading={busy} disabled={(outcome.failed > 0 && !skip) || !(outcome.created + outcome.updated)} onClick={() => void send(false)}>{tr('ثبت {0} ردیف', localDigits(outcome.created + outcome.updated))}</Button>
                  </>}
                </div>
                {outcome && (
                  <div className="space-y-2" role="status">
                    <p className="text-sm">
                      {outcome.dryRun ? tr('بررسی: ') : tr('ثبت شد: ')}
                      <Badge tone="success">{tr('{0} تازه', localDigits(outcome.created))}</Badge> <Badge tone="info">{tr('{0} به‌روزرسانی', localDigits(outcome.updated))}</Badge> <Badge tone={outcome.failed ? 'danger' : 'neutral'}>{tr('{0} خطا', localDigits(outcome.failed))}</Badge>
                    </p>
                    {outcome.unmatched.length > 0 && columns && (
                      <div className="rounded-lg bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
                        <p className="mb-2">{tr('این ستون‌ها شناخته نشدند؛ اگر یکی از ستون‌های الگوست، نگاشتش کنید و دوباره بررسی کنید:')}</p>
                        <div className="grid gap-2 sm:grid-cols-2">{outcome.unmatched.map((h) => (
                          <label key={h} className="flex items-center gap-2 text-xs"><span className="w-32 truncate font-semibold">{h}</span>
                            <Select value={mapping[h] ?? ''} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })} aria-label={tr('نگاشت {0}', h)}>
                              <option value="">{tr('— خوانده نشود —')}</option>{columns.map((c) => <option key={c.key} value={c.key}>{trx(c.fa)}</option>)}
                            </Select></label>
                        ))}</div>
                      </div>
                    )}
                    <Table>
                      <thead className="bg-ink-50/60"><tr><Th>{tr('ردیف')}</Th><Th>{tr('نتیجه')}</Th><Th>{tr('رکورد')}</Th><Th>{tr('توضیح')}</Th></tr></thead>
                      <tbody>{outcome.rows.map((r) => (
                        <Tr key={r.row} className={cx(r.action === 'ERROR' && 'bg-rose-50/50')}>
                          <Td><span className="nums">{localDigits(r.row)}</span></Td>
                          <Td><Badge tone={r.action === 'ERROR' ? 'danger' : r.action === 'UPDATE' ? 'info' : 'success'}>{r.action === 'ERROR' ? tr('خطا') : r.action === 'UPDATE' ? tr('به‌روزرسانی') : tr('تازه')}</Badge></Td>
                          <Td><span className="text-xs">{r.label}{r.code && ` (${r.code})`}</span></Td>
                          <Td><ul className="text-xs">{r.errors.map((e, i) => <li key={i} className="text-rose-700">{trx(e)}</li>)}{r.warnings.map((w, i) => <li key={`w${i}`} className="text-amber-700">{trx(w)}</li>)}</ul></Td>
                        </Tr>
                      ))}</tbody>
                    </Table>
                  </div>
                )}
                {columns && !outcome && (
                  <details className="text-xs text-ink-600"><summary className="cursor-pointer font-semibold">{tr('ستون‌های این الگو')}</summary>
                    <ul className="mt-1 space-y-0.5">{columns.map((c) => <li key={c.key}><b>{trx(c.fa)}</b>{c.required && ' *'} <code className="ltr">{c.key}</code>{c.hint && ` — ${trx(c.hint)}`}</li>)}</ul>
                  </details>
                )}
              </div>
            </Card>
          )}
          <Card title={tr('خروجی اکسل')} subtitle={tr('فهرست کامل؛ از هر صفحه هم با فیلترهای همان صفحه')}>
            <ul className="divide-y divide-ink-100">{EXPORTS.filter((x) => can(x.perm)).map((x) => (
              <li key={x.kind} className="flex items-center justify-between px-5 py-2 text-sm"><span>{x.label()}</span>
                <Button size="sm" onClick={() => void downloadFile(`/site-data/export/${x.kind}${x.kind === 'obligations' ? '?status=all' : ''}`, `${x.kind}.xlsx`)}>{tr('دریافت')}</Button></li>
            ))}</ul>
          </Card>
        </div>
        {kinds.length > 0 && (
          <Card className="mt-5" title={tr('سابقهٔ ورودها')}>
            {!history?.length ? <EmptyState title={tr('هنوز فایلی وارد نشده')} /> : (
              <Table><thead className="bg-ink-50/60"><tr><Th>{tr('زمان')}</Th><Th>{tr('نوع')}</Th><Th>{tr('فایل')}</Th><Th>{tr('ردیف‌ها')}</Th><Th>{tr('تازه / به‌روز / کنار گذاشته')}</Th><Th>{tr('توسط')}</Th></tr></thead>
                <tbody>{history.map((h) => (
                  <Tr key={h.id}><Td><span className="text-xs">{formatDateTime(h.createdAt)}</span></Td><Td>{pairLabel(IMPORT_KIND_LABELS, h.kind)}</Td><Td><span className="text-xs">{h.fileName}</span></Td>
                    <Td>{localDigits(h.totalRows)}</Td><Td><span className="nums text-xs">{localDigits(h.created)} / {localDigits(h.updated)} / {localDigits(h.failed)}</span></Td><Td><span className="text-xs">{h.createdBy.fullName}</span></Td></Tr>
                ))}</tbody></Table>
            )}
          </Card>
        )}
      </PageBody>
    </>
  );
}
