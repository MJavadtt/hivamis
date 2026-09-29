import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ONBOARDING_IMPORT_LABELS, type OnboardingImport } from '@hiva/contracts';
import { apiGet, apiPatch, apiPost, apiPut, apiUpload, downloadFile } from '../lib/api';
import { Badge, Button, Card, EmptyState, Input, Select, useToast } from './ui';
import { JALALI_WEEKDAYS, formatDate, toPersianDigits } from '../lib/format';

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
  CREATE: { tone: 'success', fa: 'ساخته می‌شود' }, SKIP: { tone: 'neutral', fa: 'از قبل هست' }, INVALID: { tone: 'danger', fa: 'مشکل دارد' },
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
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e: any) { toast(e?.message ?? 'انجام نشد.', 'danger'); } finally { setBusy(false); } };
  const check = (f: File) => run(async () => { setFile(f); setResult(null); setPreview(await apiUpload<Preview>(`/onboarding/import/${kind}/preview`, form(f))); });
  const write = () => run(async () => {
    const r = await apiUpload<CommitResult>(`/onboarding/import/${kind}/commit`, form(file!));
    setResult(r); setPreview(r.preview);
    toast(`${toPersianDigits(r.created.length)} مورد ساخته شد.`);
    onDone?.();
  });
  return (
    <Card title={ONBOARDING_IMPORT_LABELS[kind]} subtitle="از الگو شروع کنید یا فایل خودتان را بدهید — اکسل (xlsx) یا CSV؛ سرستون‌ها به فارسی یا انگلیسی."
      action={<Button size="sm" variant="ghost" onClick={() => void downloadFile(`/onboarding/templates/${kind}`, `hiva-${kind}.csv`)}>الگوی خالی</Button>}>
      <div className="space-y-3 px-4 py-3 text-sm" data-testid={`import-${kind}`}>
        {columns && (
          <details>
            <summary className="cursor-pointer text-xs text-ink-500">ستون‌ها و طرز پر کردن هرکدام</summary>
            <ul className="mt-1 grid gap-1 text-xs sm:grid-cols-2">
              {columns.map((c) => <li key={c.key}><span className="font-medium">{c.labelFa}</span>{c.required && <span className="text-rose-600"> *</span>} — <span className="text-ink-500">{c.hintFa}</span></li>)}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input ref={input} type="file" accept=".xlsx,.csv,text/csv" className="hidden" data-testid={`file-${kind}`} onChange={(e) => { const f = e.target.files?.[0]; if (f) void check(f); e.target.value = ''; }} />
          <Button size="sm" variant="secondary" loading={busy && !preview} onClick={() => input.current?.click()}>{file ? 'فایل دیگر' : 'انتخاب فایل'}</Button>
          {file && <span className="text-xs text-ink-500">{file.name}</span>}
        </div>
        {preview && (
          <>
            {preview.header.missing.length > 0 && <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">این ستون‌ها در فایل نیست: {preview.header.missing.join('، ')}</p>}
            {preview.header.unknown.length > 0 && <p className="text-[11px] text-ink-400">ستون‌هایی که شناخته نشد و نادیده گرفته می‌شود: {preview.header.unknown.join('، ')}</p>}
            <p className="text-xs" data-testid={`summary-${kind}`}>
              {toPersianDigits(preview.summary.create)} ساخته می‌شود · {toPersianDigits(preview.summary.skip)} از قبل هست · {toPersianDigits(preview.summary.invalid)} مشکل دارد
            </p>
            <ol className="max-h-72 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200 text-xs" data-testid={`rows-${kind}`}>
              {preview.rows.map((r) => (
                <li key={r.line} className="flex flex-wrap items-start gap-2 px-2 py-1.5">
                  <span className="w-10 text-ink-400">ردیف {toPersianDigits(r.line)}</span>
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].fa}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{r.label}</span>
                    {r.issues.map((i) => <span key={i} className="block text-rose-700">· {i}</span>)}
                    {r.notes.map((n) => <span key={n} className="block text-ink-500">· {n}</span>)}
                  </span>
                </li>
              ))}
            </ol>
            {!result && <Button variant="primary" size="sm" loading={busy} disabled={!preview.summary.create || preview.header.missing.length > 0} onClick={() => void write()}>
              ساختن {toPersianDigits(preview.summary.create)} مورد{preview.summary.invalid ? ' (ردیف‌های مشکل‌دار کنار گذاشته می‌شوند)' : ''}
            </Button>}
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
      <p>{toPersianDigits(result.created.length)} مورد ساخته شد{result.failed.length ? ` و ${toPersianDigits(result.failed.length)} مورد نوشته نشد` : ''}.</p>
      {result.failed.map((f) => <p key={f.line} className="text-rose-700">ردیف {toPersianDigits(f.line)} ({f.label}): {f.messageFa}</p>)}
      {result.activations.some((a) => a.emailed) && <p>پیوند گذاشتن رمز برای {toPersianDigits(result.activations.filter((a) => a.emailed).length)} نفر ایمیل شد.</p>}
      {links.length > 0 && (
        <div className="space-y-1 rounded bg-amber-50 p-2 text-amber-900" data-testid="activation-links">
          <p className="font-medium">ایمیل سازمان پیکربندی نشده است؛ این پیوندها را خودتان به هر نفر برسانید. فقط همین یک بار نمایش داده می‌شوند و تا {formatDate(links[0]!.expiresAt)} کار می‌کنند.</p>
          {links.map((a) => (
            <div key={a.email} className="flex flex-wrap items-center gap-2">
              <span className="w-40 truncate">{a.label}</span>
              <code className="ltr block flex-1 truncate rounded bg-white px-2 py-0.5 text-[11px]">{a.url}</code>
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(a.url)}>رونوشت</Button>
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
    } catch (e: any) { toast(e?.message ?? 'خوانده نشد.', 'danger'); }
  };
  const save = async (confirm: boolean) => {
    try {
      await apiPut('/onboarding/units', { map: Object.fromEntries(Object.entries(map).filter(([, c]) => c)) });
      if (confirm) await apiPost('/onboarding/confirm/units');
      toast(confirm ? 'نگاشت واحدها ذخیره و تأیید شد.' : 'نگاشت واحدها ذخیره شد.');
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['/onboarding/units'] });
      onChanged?.();
    } catch (e: any) { toast(e?.message ?? 'ذخیره نشد.', 'danger'); }
  };
  const people = (name: string) => scanned.find((s) => s.name === name)?.people;
  return (
    <Card title="واحدها" subtitle="نام واحدها در سازمان شما، هرکدام روی یکی از ده واحد Doc_H — قوانین برای این ده نوشته شده‌اند. فایل کاربران را بدهید تا نام‌ها از آن خوانده و پیشنهاد شوند.">
      <div className="space-y-3 px-4 py-3 text-sm" data-testid="unit-map">
        <input ref={input} type="file" accept=".xlsx,.csv,text/csv" className="hidden" data-testid="file-units" onChange={(e) => { const f = e.target.files?.[0]; if (f) void scan(f); e.target.value = ''; }} />
        <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>خواندن نام واحدها از فایل کاربران</Button>
        {scanned.filter((s) => s.resolved && !map[s.name]).length > 0 && (
          <p className="text-xs text-ink-500">خودبه‌خود شناخته شد: {scanned.filter((s) => s.resolved && !map[s.name]).map((s) => `${s.name} ← ${s.resolved}`).join('، ')}</p>
        )}
        {!names.length ? <EmptyState title="هنوز نامی نگاشته نشده" description="اگر فایل کاربران کد واحدهای Doc_H (مثل CR) را دارد، این گام لازم نیست." /> : (
          <ul className="space-y-1.5">
            {names.map((n) => (
              <li key={n} className="flex flex-wrap items-center gap-2">
                <span className="w-48 truncate">{n}</span>
                {people(n) != null && <span className="text-[11px] text-ink-400">{toPersianDigits(people(n)!)} نفر</span>}
                <Select value={map[n] ?? ''} onChange={(e) => setDraft({ ...map, [n]: e.target.value })} aria-label={`واحد Doc_H برای ${n}`} className="w-auto">
                  <option value="">— انتخاب کنید —</option>
                  {data.departments.map((d) => <option key={d.code} value={d.code}>{d.nameFa} ({d.code})</option>)}
                </Select>
                {scanned.find((s) => s.name === n)?.suggestion === map[n] && map[n] && <Badge tone="info">پیشنهاد</Badge>}
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={!draft} onClick={() => void save(false)}>ذخیره</Button>
          <Button size="sm" variant="primary" onClick={() => void save(true)}>ذخیره و تأیید</Button>
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
      toast(confirm ? 'تقویم کاری تأیید شد.' : 'تقویم کاری ذخیره شد.');
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['/organization'] });
      onChanged?.();
    } catch (e: any) { toast(e?.message ?? 'ذخیره نشد.', 'danger'); }
  };
  const hour = (label: string, key: 'workStartHour' | 'workEndHour' | 'breakHours') => (
    <label className="flex items-center gap-1 text-xs">{label}
      <Input type="number" value={cal[key]} min={0} max={24} onChange={(e) => setDraft({ ...cal, [key]: Number(e.target.value) })} aria-label={label} className="w-16" />
    </label>
  );
  return (
    <div className="space-y-5">
      <Card title="هفتهٔ کاری" subtitle="همهٔ مهلت‌های SLA با همین ساعت‌ها و روزها سنجیده می‌شوند. واحدی که روزهای دیگری کار می‌کند، در «مدیریت سیستم ← تقویم کاری» جدا تنظیم می‌شود.">
        <div className="space-y-3 px-4 py-3 text-sm" data-testid="org-calendar">
          <div className="flex flex-wrap gap-2">
            {WEEK.map((d, i) => (
              <label key={d} className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={cal.workingDays.includes(d)} onChange={(e) => setDraft({ ...cal, workingDays: e.target.checked ? [...cal.workingDays, d] : cal.workingDays.filter((x) => x !== d) })} aria-label={`روز کاری ${JALALI_WEEKDAYS[i]}`} /> {JALALI_WEEKDAYS[i]}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">{hour('شروع', 'workStartHour')}{hour('پایان', 'workEndHour')}{hour('ساعت استراحت', 'breakHours')}</div>
          <p className="text-xs text-ink-500">{toPersianDigits(org.holidays.length)} روز تعطیل ثبت شده{org.holidays.length ? ` — نزدیک‌ترین: ${org.holidays.filter((h) => h.date >= new Date().toISOString().slice(0, 10)).slice(0, 3).map((h) => `${h.title} (${formatDate(h.date)})`).join('، ')}` : ''}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={!draft} onClick={() => void save(false)}>ذخیره</Button>
            <Button size="sm" variant="primary" onClick={() => void save(true)}>درست است؛ تأیید</Button>
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
      toast(confirm ? 'مهلت‌ها تأیید شد.' : 'مهلت‌ها ذخیره شد.');
      setEdits({});
      await qc.invalidateQueries({ queryKey: ['/sla-policies'] });
      onChanged?.();
    } catch (e: any) { toast(e?.message ?? 'ذخیره نشد.', 'danger'); }
  };
  return (
    <Card title="مهلت‌های SLA" subtitle="مهلت‌هایی که Doc_H گذاشته، به ساعت کاری. اگر قرارداد یا عرف سازمان شما عدد دیگری است، همین‌جا عوض کنید؛ تغییر در رهگیری حسابرسی می‌ماند.">
      <ul className="divide-y divide-ink-100 px-4 text-sm" data-testid="sla-step">
        {data.map((p) => (
          <li key={p.code} className="flex flex-wrap items-center gap-2 py-2">
            <span className="min-w-0 flex-1">{p.labelFa}{p.docRef && <span className="text-[11px] text-ink-400"> — {p.docRef}</span>}</span>
            <Input type="number" min={0.5} step={0.5} value={edits[p.code] ?? String(Number(p.hours))} onChange={(e) => setEdits({ ...edits, [p.code]: e.target.value })} aria-label={`ساعت ${p.labelFa}`} className="w-20" />
            <span className="text-xs text-ink-500">ساعت کاری</span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 px-4 pb-3">
        <Button size="sm" variant="secondary" disabled={!Object.keys(edits).length} onClick={() => void save(false)}>ذخیره</Button>
        <Button size="sm" variant="primary" onClick={() => void save(true)}>درست است؛ تأیید</Button>
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
      if (r.url) setShown({ ...shown, [id]: r.url }); else toast('پیوند تازه ایمیل شد.');
      await qc.invalidateQueries({ queryKey: ['/onboarding/activations'] });
    } catch (e: any) { toast(e?.message ?? 'انجام نشد.', 'danger'); }
  };
  return (
    <Card title="هنوز رمز نگذاشته‌اند" subtitle="پیوند تازه، پیوند پیشین را از کار می‌اندازد.">
      <ul className="divide-y divide-ink-100 px-4 text-sm" data-testid="pending-activations">
        {data.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="min-w-0 flex-1">{u.fullName} <span className="ltr text-xs text-ink-400">{u.email}</span></span>
            <span className="text-[11px] text-ink-400">{u.linkExpiresAt ? `پیوند تا ${formatDate(u.linkExpiresAt)}` : 'پیوند منقضی'}</span>
            <Button size="sm" variant="ghost" onClick={() => void fresh(u.id)}>پیوند تازه</Button>
            {shown[u.id] && <code className="ltr block w-full truncate rounded bg-amber-50 px-2 py-0.5 text-[11px]">{shown[u.id]}</code>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
