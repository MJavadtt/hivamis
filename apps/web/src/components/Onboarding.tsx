import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ONBOARDING_IMPORT_LABELS, type OnboardingImport } from '@hiva/contracts';
import { apiGet, apiPatch, apiPost, apiPut, apiUpload, downloadFile } from '../lib/api';
import { Badge, Button, Card, EmptyState, Input, Select, useToast } from './ui';
import { formatDate, localDigits, weekdayShort } from '../lib/format';
import { loc, pair, tr, trx } from '../i18n';

/*
 * Roadmap #48 — getting an organisation started from what it already has. Every import is a
 * preview first (nothing written) and then the valid rows; a file run twice creates nothing twice.
 */

interface Column { key: string; labelFa: string; required?: boolean; hintFa: string }
interface Row { line: number; label: string; status: 'CREATE' | 'SKIP' | 'INVALID'; issues: string[]; notes: string[] }
interface Preview { kind: OnboardingImport; header: { missing: string[]; unknown: string[] }; rows: Row[]; summary: { create: number; skip: number; invalid: number } }
interface CommitResult {
  preview: Preview; created: { line: number; label: string }[]; failed: { line: number; label: string; messageFa: string }[];
  activations: { line: number; label: string; email: string; url: string; emailed: boolean; expiresAt: string }[];
}
const STATUS: Record<Row['status'], { tone: 'success' | 'neutral' | 'danger'; fa: string }> = {
  CREATE: { tone: 'success', fa: tr('ساخته می‌شود') }, SKIP: { tone: 'neutral', fa: tr('از قبل هست') }, INVALID: { tone: 'danger', fa: tr('مشکل دارد') },
};

/** One import: template, the columns explained, a preview of every row, then the valid ones written. */
export function ImportPanel({ kind, onDone }: { kind: OnboardingImport; onDone?: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: columns } = useQuery<Column[]>({ queryKey: [`/onboarding/columns/${kind}`], queryFn: () => apiGet(`/onboarding/columns/${kind}`) });
  const form = (f: File) => { const d = new FormData(); d.append('file', f); return d; };
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); } finally { setBusy(false); } };
  const check = (f: File) => run(async () => { setFile(f); setResult(null); setPreview(await apiUpload<Preview>(`/onboarding/import/${kind}/preview`, form(f))); });
  const write = () => run(async () => {
    const r = await apiUpload<CommitResult>(`/onboarding/import/${kind}/commit`, form(file!));
    setResult(r); setPreview(r.preview);
    toast(tr('{0} مورد ساخته شد.', localDigits(r.created.length)));
    onDone?.();
  });
  return (
    <Card title={trx(ONBOARDING_IMPORT_LABELS[kind])} subtitle={tr('از الگو شروع کنید یا فایل خودتان را بدهید — اکسل (xlsx) یا CSV؛ سرستون‌ها به فارسی یا انگلیسی.')}
      action={<Button size="sm" variant="ghost" onClick={() => void downloadFile(`/onboarding/templates/${kind}`, `hiva-${kind}.csv`)}>{tr('الگوی خالی')}</Button>}>
      <div className="space-y-3 px-4 py-3 text-sm" data-testid={`import-${kind}`}>
        {columns && (
          <details>
            <summary className="cursor-pointer text-xs text-ink-500">{tr('ستون‌ها و طرز پر کردن هرکدام')}</summary>
            <ul className="mt-1 grid gap-1 text-xs sm:grid-cols-2">
              {columns.map((c) => <li key={c.key}><span className="font-medium">{loc(c, 'label')}</span>{c.required && <span className="text-rose-600"> *</span>} — <span className="text-ink-500">{loc(c, 'hint')}</span></li>)}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input ref={input} type="file" accept=".xlsx,.csv,text/csv" className="hidden" data-testid={`file-${kind}`} onChange={(e) => { const f = e.target.files?.[0]; if (f) void check(f); e.target.value = ''; }} />
          <Button size="sm" variant="secondary" loading={busy && !preview} onClick={() => input.current?.click()}>{file ? tr('فایل دیگر') : tr('انتخاب فایل')}</Button>
          {file && <span className="text-xs text-ink-500">{file.name}</span>}
        </div>
        {preview && (
          <>
            {preview.header.missing.length > 0 && <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">{tr('این ستون‌ها در فایل نیست: {0}', preview.header.missing.join(tr('، ')))}</p>}
            {preview.header.unknown.length > 0 && <p className="text-[11px] text-ink-400">{tr('ستون‌هایی که شناخته نشد و نادیده گرفته می‌شود: {0}', preview.header.unknown.join(tr('، ')))}</p>}
            <p className="text-xs" data-testid={`summary-${kind}`}>{tr('{0} ساخته می‌شود · {1} از قبل هست · {2} مشکل دارد', localDigits(preview.summary.create), localDigits(preview.summary.skip), localDigits(preview.summary.invalid))}</p>
            <ol className="max-h-72 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200 text-xs" data-testid={`rows-${kind}`}>
              {preview.rows.map((r) => (
                <li key={r.line} className="flex flex-wrap items-start gap-2 px-2 py-1.5">
                  <span className="w-10 text-ink-400">{tr('ردیف {0}', localDigits(r.line))}</span>
                  <Badge tone={STATUS[r.status].tone}>{pair(STATUS[r.status])}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{r.label}</span>
                    {r.issues.map((i) => <span key={i} className="block text-rose-700">· {i}</span>)}
                    {r.notes.map((n) => <span key={n} className="block text-ink-500">· {n}</span>)}
                  </span>
                </li>
              ))}
            </ol>
            {!result && <Button variant="primary" size="sm" loading={busy} disabled={!preview.summary.create || preview.header.missing.length > 0} onClick={() => void write()}>{tr('ساختن {0} مورد{1}', localDigits(preview.summary.create), preview.summary.invalid ? tr(' (ردیف‌های مشکل‌دار کنار گذاشته می‌شوند)') : '')}</Button>}
          </>
        )}
        {result && <ImportResult result={result} />}
      </div>
    </Card>
  );
}

function ImportResult({ result }: { result: CommitResult }) {
  const links = result.activations.filter((a) => !a.emailed);
  return (
    <div className="space-y-2 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-900" data-testid="import-result">
      <p>{tr('{0} مورد ساخته شد{1}.', localDigits(result.created.length), result.failed.length ? tr(' و {0} مورد نوشته نشد', localDigits(result.failed.length)) : '')}</p>
      {result.failed.map((f) => <p key={f.line} className="text-rose-700">{tr('ردیف {0} ({1}): {2}', localDigits(f.line), f.label, f.messageFa)}</p>)}
      {result.activations.some((a) => a.emailed) && <p>{tr('پیوند گذاشتن رمز برای {0} نفر ایمیل شد.', localDigits(result.activations.filter((a) => a.emailed).length))}</p>}
      {links.length > 0 && (
        <div className="space-y-1 rounded bg-amber-50 p-2 text-amber-900" data-testid="activation-links">
          <p className="font-medium">{tr('ایمیل سازمان پیکربندی نشده است؛ این پیوندها را خودتان به هر نفر برسانید. فقط همین یک بار نمایش داده می‌شوند و تا {0} کار می‌کنند.', formatDate(links[0]!.expiresAt))}</p>
          {links.map((a) => (
            <div key={a.email} className="flex flex-wrap items-center gap-2">
              <span className="w-40 truncate">{a.label}</span>
              <code className="ltr block flex-1 truncate rounded bg-white px-2 py-0.5 text-[11px]">{a.url}</code>
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(a.url)}>{tr('رونوشت')}</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface UnitScan { name: string; people: number; resolved: string | null; suggestion: string | null }

/** The organisation's unit names, each on one of Doc_H's ten. */
export function UnitMapStep({ onChanged }: { onChanged?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const { data } = useQuery<{ departments: { code: string; nameFa: string }[]; map: Record<string, string> }>({ queryKey: ['/onboarding/units'], queryFn: () => apiGet('/onboarding/units') });
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [scanned, setScanned] = useState<UnitScan[]>([]);
  if (!data) return null;
  const map = draft ?? data.map;
  const names = [...new Set([...Object.keys(map), ...scanned.filter((s) => !s.resolved || map[s.name]).map((s) => s.name)])];
  const scan = async (f: File) => {
    const d = new FormData(); d.append('file', f);
    try {
      const found = await apiUpload<UnitScan[]>('/onboarding/units/scan', d);
      setScanned(found);
      // Suggestions fill the names still unmapped; nothing is saved until a person says so.
      setDraft({ ...map, ...Object.fromEntries(found.filter((u) => !u.resolved && u.suggestion && !map[u.name]).map((u) => [u.name, u.suggestion!])) });
    } catch (e: any) { toast(e?.message ?? tr('خوانده نشد.'), 'danger'); }
  };
  const save = async (confirm: boolean) => {
    try {
      await apiPut('/onboarding/units', { map: Object.fromEntries(Object.entries(map).filter(([, c]) => c)) });
      if (confirm) await apiPost('/onboarding/confirm/units');
      toast(confirm ? tr('نگاشت واحدها ذخیره و تأیید شد.') : tr('نگاشت واحدها ذخیره شد.'));
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['/onboarding/units'] });
      onChanged?.();
    } catch (e: any) { toast(e?.message ?? tr('ذخیره نشد.'), 'danger'); }
  };
  const people = (name: string) => scanned.find((s) => s.name === name)?.people;
  return (
    <Card title={tr('واحدها')} subtitle={tr('نام واحدها در سازمان شما، هرکدام روی یکی از ده واحد Doc_H — قوانین برای این ده نوشته شده‌اند. فایل کاربران را بدهید تا نام‌ها از آن خوانده و پیشنهاد شوند.')}>
      <div className="space-y-3 px-4 py-3 text-sm" data-testid="unit-map">
        <input ref={input} type="file" accept=".xlsx,.csv,text/csv" className="hidden" data-testid="file-units" onChange={(e) => { const f = e.target.files?.[0]; if (f) void scan(f); e.target.value = ''; }} />
        <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>{tr('خواندن نام واحدها از فایل کاربران')}</Button>
        {scanned.filter((s) => s.resolved && !map[s.name]).length > 0 && (
          <p className="text-xs text-ink-500">{tr('خودبه‌خود شناخته شد: {0}', scanned.filter((s) => s.resolved && !map[s.name]).map((s) => `${s.name} ← ${s.resolved}`).join(tr('، ')))}</p>
        )}
        {!names.length ? <EmptyState title={tr('هنوز نامی نگاشته نشده')} description={tr('اگر فایل کاربران کد واحدهای Doc_H (مثل CR) را دارد، این گام لازم نیست.')} /> : (
          <ul className="space-y-1.5">
            {names.map((n) => (
              <li key={n} className="flex flex-wrap items-center gap-2">
                <span className="w-48 truncate">{n}</span>
                {people(n) != null && <span className="text-[11px] text-ink-400">{tr('{0} نفر', localDigits(people(n)!))}</span>}
                <Select value={map[n] ?? ''} onChange={(e) => setDraft({ ...map, [n]: e.target.value })} aria-label={tr('واحد Doc_H برای {0}', n)} className="w-auto">
                  <option value="">{tr('— انتخاب کنید —')}</option>
                  {data.departments.map((d) => <option key={d.code} value={d.code}>{loc(d, 'name')} ({d.code})</option>)}
                </Select>
                {scanned.find((s) => s.name === n)?.suggestion === map[n] && map[n] && <Badge tone="info">{tr('پیشنهاد')}</Badge>}
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={!draft} onClick={() => void save(false)}>{tr('ذخیره')}</Button>
          <Button size="sm" variant="primary" onClick={() => void save(true)}>{tr('ذخیره و تأیید')}</Button>
        </div>
      </div>
    </Card>
  );
}

const WEEK = [6, 0, 1, 2, 3, 4, 5];

/** The organisation's working week, and its holidays. */
export function CalendarStep({ onChanged }: { onChanged?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: org } = useQuery<{ workingDays: number[]; workStartHour: number; workEndHour: number; breakHours: number; holidays: { date: string; title: string }[] }>({ queryKey: ['/organization'], queryFn: () => apiGet('/organization') });
  const [draft, setDraft] = useState<{ workingDays: number[]; workStartHour: number; workEndHour: number; breakHours: number } | null>(null);
  if (!org) return null;
  const cal = draft ?? { workingDays: org.workingDays, workStartHour: org.workStartHour, workEndHour: org.workEndHour, breakHours: org.breakHours };
  const save = async (confirm: boolean) => {
    try {
      if (draft) await apiPatch('/organization', draft);
      if (confirm) await apiPost('/onboarding/confirm/calendar');
      toast(confirm ? tr('تقویم کاری تأیید شد.') : tr('تقویم کاری ذخیره شد.'));
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['/organization'] });
      onChanged?.();
    } catch (e: any) { toast(e?.message ?? tr('ذخیره نشد.'), 'danger'); }
  };
  const hour = (label: string, key: 'workStartHour' | 'workEndHour' | 'breakHours') => (
    <label className="flex items-center gap-1 text-xs">{label}
      <Input type="number" value={cal[key]} min={0} max={24} onChange={(e) => setDraft({ ...cal, [key]: Number(e.target.value) })} aria-label={label} className="w-16" />
    </label>
  );
  return (
    <div className="space-y-5">
      <Card title={tr('هفتهٔ کاری')} subtitle={tr('همهٔ مهلت‌های SLA با همین ساعت‌ها و روزها سنجیده می‌شوند. واحدی که روزهای دیگری کار می‌کند، در «مدیریت سیستم ← تقویم کاری» جدا تنظیم می‌شود.')}>
        <div className="space-y-3 px-4 py-3 text-sm" data-testid="org-calendar">
          <div className="flex flex-wrap gap-2">
            {WEEK.map((d, i) => (
              <label key={d} className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={cal.workingDays.includes(d)} onChange={(e) => setDraft({ ...cal, workingDays: e.target.checked ? [...cal.workingDays, d] : cal.workingDays.filter((x) => x !== d) })} aria-label={tr('روز کاری {0}', weekdayShort(i))} /> {weekdayShort(i)}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">{hour(tr('شروع'), 'workStartHour')}{hour(tr('پایان'), 'workEndHour')}{hour(tr('ساعت استراحت'), 'breakHours')}</div>
          <p className="text-xs text-ink-500">{tr('{0} روز تعطیل ثبت شده{1}', localDigits(org.holidays.length), org.holidays.length ? tr(' — نزدیک‌ترین: {0}', org.holidays.filter((h) => h.date >= new Date().toISOString().slice(0, 10)).slice(0, 3).map((h) => `${h.title} (${formatDate(h.date)})`).join(tr('، '))) : '')}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={!draft} onClick={() => void save(false)}>{tr('ذخیره')}</Button>
            <Button size="sm" variant="primary" onClick={() => void save(true)}>{tr('درست است؛ تأیید')}</Button>
          </div>
        </div>
      </Card>
      <ImportPanel kind="holidays" onDone={() => { void qc.invalidateQueries({ queryKey: ['/organization'] }); onChanged?.(); }} />
    </div>
  );
}

interface Policy { id: string; code: string; labelFa: string; hours: string; warnAt: string; docRef: string | null; isActive: boolean }

/** Doc_H's SLA hours as this organisation will hold them. */
export function SlaStep({ onChanged }: { onChanged?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery<Policy[]>({ queryKey: ['/sla-policies'], queryFn: () => apiGet('/sla-policies') });
  const [edits, setEdits] = useState<Record<string, string>>({});
  if (!data) return null;
  const save = async (confirm: boolean) => {
    try {
      for (const [code, hours] of Object.entries(edits)) await apiPatch(`/sla-policies/${code}`, { hours: Number(hours) });
      if (confirm) await apiPost('/onboarding/confirm/sla');
      toast(confirm ? tr('مهلت‌ها تأیید شد.') : tr('مهلت‌ها ذخیره شد.'));
      setEdits({});
      await qc.invalidateQueries({ queryKey: ['/sla-policies'] });
      onChanged?.();
    } catch (e: any) { toast(e?.message ?? tr('ذخیره نشد.'), 'danger'); }
  };
  return (
    <Card title={tr('مهلت‌های SLA')} subtitle={tr('مهلت‌هایی که Doc_H گذاشته، به ساعت کاری. اگر قرارداد یا عرف سازمان شما عدد دیگری است، همین‌جا عوض کنید؛ تغییر در رهگیری حسابرسی می‌ماند.')}>
      <ul className="divide-y divide-ink-100 px-4 text-sm" data-testid="sla-step">
        {data.map((p) => (
          <li key={p.code} className="flex flex-wrap items-center gap-2 py-2">
            <span className="min-w-0 flex-1">{loc(p, 'label')}{p.docRef && <span className="text-[11px] text-ink-400"> — {p.docRef}</span>}</span>
            <Input type="number" min={0.5} step={0.5} value={edits[p.code] ?? String(Number(p.hours))} onChange={(e) => setEdits({ ...edits, [p.code]: e.target.value })} aria-label={tr('ساعت {0}', p.labelFa)} className="w-20" />
            <span className="text-xs text-ink-500">{tr('ساعت کاری')}</span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 px-4 pb-3">
        <Button size="sm" variant="secondary" disabled={!Object.keys(edits).length} onClick={() => void save(false)}>{tr('ذخیره')}</Button>
        <Button size="sm" variant="primary" onClick={() => void save(true)}>{tr('درست است؛ تأیید')}</Button>
      </div>
    </Card>
  );
}

/** Imported people who have not set a password yet, and a fresh link for any of them. */
export function PendingActivations() {
  const qc = useQueryClient();
  const toast = useToast();
  const [shown, setShown] = useState<Record<string, string>>({});
  const { data } = useQuery<{ id: string; email: string; fullName: string; linkExpiresAt: string | null }[]>({ queryKey: ['/onboarding/activations'], queryFn: () => apiGet('/onboarding/activations') });
  if (!data?.length) return null;
  const fresh = async (id: string) => {
    try {
      const r = await apiPost<{ url: string | null; emailed: boolean }>(`/users/${id}/activation`);
      if (r.url) setShown({ ...shown, [id]: r.url }); else toast(tr('پیوند تازه ایمیل شد.'));
      await qc.invalidateQueries({ queryKey: ['/onboarding/activations'] });
    } catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  return (
    <Card title={tr('هنوز رمز نگذاشته‌اند')} subtitle={tr('پیوند تازه، پیوند پیشین را از کار می‌اندازد.')}>
      <ul className="divide-y divide-ink-100 px-4 text-sm" data-testid="pending-activations">
        {data.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="min-w-0 flex-1">{u.fullName} <span className="ltr text-xs text-ink-400">{u.email}</span></span>
            <span className="text-[11px] text-ink-400">{u.linkExpiresAt ? tr('پیوند تا {0}', formatDate(u.linkExpiresAt)) : tr('پیوند منقضی')}</span>
            <Button size="sm" variant="ghost" onClick={() => void fresh(u.id)}>{tr('پیوند تازه')}</Button>
            {shown[u.id] && <code className="ltr block w-full truncate rounded bg-amber-50 px-2 py-0.5 text-[11px]">{shown[u.id]}</code>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
