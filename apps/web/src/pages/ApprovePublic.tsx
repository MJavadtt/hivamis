import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Field, Input, Textarea } from '../components/ui';
import { formatDateTime, formatNumber, localDigits } from '../lib/format';
import { locale, tr, trx } from '../i18n';

/*
 * Roadmap #35 — the page a client opens from the approval link. No account and no session: the
 * link's secret is the credential, and everything here talks to /public/approvals/:token only.
 */

export interface View {
  code: string; status: string; organization: string; message: string | null; contactName: string; contactEmail: string;
  subject: { type: 'DELIVERABLE' | 'PROPOSAL'; code: string; title: string; version: string; context: string | null };
  content: Record<string, string | null>; expiresAt: string; manifestHash: string; verification: 'EMAIL_CODE' | 'LINK' | 'PORTAL';
  files: { id: string; fileName: string; sizeBytes: number; sha256: string; viewed: boolean }[];
  decision: string | null; decidedAt: string | null; signerName: string | null; evidenceHash: string | null;
  /** In the portal (#34) a colleague sees the request; only its addressee decides. */
  forMe?: boolean;
}
export interface Receipt { code: string; status: string; decision: string; decidedAt: string; manifestHash: string; evidenceHash: string }

const CONTENT_FA: Record<string, string> = {
  description: tr('شرح'), format: tr('قالب'), executiveSummary: tr('خلاصه'), approach: tr('رویکرد'), deliverablesSummary: tr('خروجی‌ها'),
  timelineSummary: tr('زمان‌بندی'), salePrice: tr('مبلغ'), paymentTerms: tr('شرایط پرداخت'),
};
const CLOSED_FA: Record<string, string> = {
  EXPIRED: tr('مهلت این درخواست گذشته است.'), CANCELLED: tr('این درخواست از سوی فرستنده لغو شده یا دیگر معتبر نیست.'),
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/public/approvals/${path}`, { ...init, headers: { 'accept-language': locale(), ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(trx(body?.error?.message) || tr('خطای {0}', res.status)), { status: res.status });
  return body as T;
}

/** Where the page reads and writes: the link's public endpoints, or the portal's (#34). */
export interface ApprovalApi {
  load(): Promise<View>;
  file(id: string): Promise<Response>;
  code(): Promise<{ sentTo: string }>;
  decide(body: object): Promise<Receipt>;
}

const publicApi = (token: string): ApprovalApi => ({
  load: () => call<View>(token),
  file: (id) => fetch(`/api/v1/public/approvals/${token}/files/${id}`),
  code: () => call<{ sentTo: string }>(`${token}/code`, { method: 'POST' }),
  decide: (body) => call<Receipt>(`${token}/decision`, { method: 'POST', body: JSON.stringify(body) }),
});

export default function ApprovePublic({ token }: { token: string }) {
  const api = useMemo(() => publicApi(token), [token]);
  return <ApprovalDecision api={api} />;
}

export function ApprovalDecision({ api, embedded = false }: { api: ApprovalApi; embedded?: boolean }) {
  const Frame = embedded ? Plain : Page;
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [decision, setDecision] = useState<'APPROVE' | 'REQUEST_CHANGES'>('APPROVE');
  const [signerName, setSignerName] = useState('');
  const [comment, setComment] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.load().then(setView).catch((e) => setError(e.status === 404 ? tr('این پیوند معتبر نیست.') : e.message)), [api]);
  useEffect(() => { void load(); }, [load]);

  const download = async (f: View['files'][number]) => {
    try {
      const res = await api.file(f.id);
      if (!res.ok) { const b = await res.json().catch(() => null); throw new Error(trx(b?.error?.message) || tr('خطای {0}', res.status)); }
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = href; a.download = f.fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      setView((v) => v && { ...v, files: v.files.map((x) => (x.id === f.id ? { ...x, viewed: true } : x)) });
    } catch (e: any) { setNote(e.message); }
  };
  const sendCode = async () => {
    setNote(null);
    try { const r = await api.code(); setNote(tr('کد به {0} فرستاده شد؛ ده دقیقه معتبر است.', r.sentTo)); }
    catch (e: any) { setNote(e.message); }
  };
  const submit = async () => {
    setBusy(true); setNote(null);
    try {
      setReceipt(await api.decide({ decision, signerName, comment: comment.trim() || undefined, code: code.trim() || undefined, confirm }));
    } catch (e: any) { setNote(e.message); } finally { setBusy(false); }
  };

  if (error) return <Frame><p className="text-sm text-rose-700" data-testid="approve-error">{error}</p></Frame>;
  if (!view) return <Frame><p className="text-sm text-ink-500">{tr('در حال بارگذاری…')}</p></Frame>;

  const done = receipt ?? (view.decision ? { code: view.code, status: view.status, decision: view.decision, decidedAt: view.decidedAt!, manifestHash: view.manifestHash, evidenceHash: view.evidenceHash! } : null);
  const unseen = view.files.filter((f) => !f.viewed);
  const canSubmit = signerName.trim().length >= 3 && confirm && (decision === 'REQUEST_CHANGES' ? comment.trim().length >= 5 : unseen.length === 0)
    && (view.verification !== 'EMAIL_CODE' || code.trim().length === 6);
  const forMe = view.forMe !== false;

  return (
    <Frame org={view.organization}>
      <header className="space-y-1">
        <p className="text-xs text-ink-500">{view.subject.type === 'DELIVERABLE' ? tr('خروجی') : tr('پروپوزال')} · <span className="ltr">{view.subject.code}</span>{' '}{tr('· نسخهٔ')}{' '}<span className="ltr">{view.subject.version}</span></p>
        <h1 className="text-lg font-semibold text-ink-900">{view.subject.title}</h1>
        {view.subject.context && <p className="text-xs text-ink-500">{view.subject.context}</p>}
      </header>
      {view.message && <p className="rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700">{view.message}</p>}

      {Object.entries(view.content).some(([, v]) => v) && (
        <dl className="space-y-2 text-sm" data-testid="approve-content">
          {Object.entries(view.content).filter(([, v]) => v).map(([k, v]) => (
            <div key={k}><dt className="text-xs text-ink-500">{CONTENT_FA[k] ?? k}</dt><dd className="whitespace-pre-line text-ink-800">{k === 'salePrice' ? tr('{0} ریال', formatNumber(Number(v))) : v}</dd></div>
          ))}
        </dl>
      )}

      {view.files.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-medium text-ink-800">{tr('فایل‌ها')}</h2>
          <ul className="space-y-1.5" data-testid="approve-files">
            {view.files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm">
                <span className="flex-1">{f.fileName} <span className="text-xs text-ink-400">({localDigits(Math.ceil(f.sizeBytes / 1024))} KB)</span>
                  <span className="ltr block text-[12px] text-ink-400">SHA-256 {f.sha256}</span></span>
                {f.viewed && <span className="text-xs text-emerald-700">{tr('✓ دریافت شد')}</span>}
                {forMe && (!done || new Date(view.expiresAt) > new Date()) && view.status !== 'CANCELLED' && view.status !== 'EXPIRED' && (
                  <Button size="sm" variant="secondary" onClick={() => void download(f)}>{tr('دریافت')}</Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {done ? (
        <section className="space-y-1 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900" data-testid="approve-receipt">
          <p className="font-medium">{done.decision === 'APPROVE' ? tr('تأیید شما ثبت شد.') : tr('درخواست اصلاح شما ثبت شد.')}</p>
          <p className="text-xs">{tr('{0} — شناسه', formatDateTime(done.decidedAt))}{' '}<span className="ltr">{done.code}</span></p>
          <p className="text-xs">{tr('اثر انگشت آنچه دیدید:')}{' '}<code className="ltr break-all">{done.manifestHash}</code></p>
          <p className="text-xs">{tr('اثر انگشت تصمیم:')}{' '}<code className="ltr break-all">{done.evidenceHash}</code></p>
          <p className="text-[12.5px]">{tr('این دو را نگه دارید؛ با آن‌ها می‌توان نشان داد تصمیم شما و آنچه دیدید پس از ثبت تغییر نکرده است.')}</p>
        </section>
      ) : view.status !== 'PENDING' ? (
        <p className="rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700" data-testid="approve-closed">{CLOSED_FA[view.status] ?? tr('این درخواست بسته شده است.')}</p>
      ) : !forMe ? (
        <p className="rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700" data-testid="approve-not-mine">{tr('این درخواست برای {0} فرستاده شده است؛ تصمیمش با خود اوست.', view.contactName)}</p>
      ) : (
        <section className="space-y-3 border-t border-ink-100 pt-4" data-testid="approve-form">
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" name="decision" checked={decision === 'APPROVE'} onChange={() => setDecision('APPROVE')} />{' '}{tr('تأیید می‌کنم')}</label>
            <label className="flex items-center gap-2"><input type="radio" name="decision" checked={decision === 'REQUEST_CHANGES'} onChange={() => setDecision('REQUEST_CHANGES')} />{' '}{tr('اصلاح لازم است')}</label>
          </div>
          {decision === 'APPROVE' && unseen.length > 0 && <p className="text-xs text-amber-800">{tr('پیش از تأیید، هر فایل را دریافت و بررسی کنید: {0}', unseen.map((f) => f.fileName).join(tr('، ')))}</p>}
          <Field label={decision === 'APPROVE' ? tr('توضیح (اختیاری)') : tr('چه چیزی باید اصلاح شود')}>
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} aria-label={tr('توضیح')} />
          </Field>
          <Field label={tr('نام و نام خانوادگی')} hint={view.verification === 'PORTAL' ? tr('به‌جای امضا، همراه با حساب پورتال شما ثبت می‌شود.') : tr('به‌جای امضا ثبت می‌شود — این پیوند برای {0} فرستاده شده است.', view.contactName)}>
            <Input value={signerName} onChange={(e) => setSignerName(e.target.value)} aria-label={tr('نام و نام خانوادگی')} />
          </Field>
          {view.verification === 'EMAIL_CODE' && (
            <Field label={tr('کد یک‌بارمصرف')} hint={tr('به {0} فرستاده می‌شود.', view.contactEmail)}>
              <div className="flex gap-2">
                <Input value={code} onChange={(e) => setCode(e.target.value)} className="ltr w-32" inputMode="numeric" aria-label={tr('کد یک‌بارمصرف')} />
                <Button size="sm" variant="secondary" onClick={() => void sendCode()}>{tr('ارسال کد')}</Button>
              </div>
            </Field>
          )}
          <Checkbox checked={confirm} onChange={(e) => setConfirm(e.target.checked)}
            label={decision === 'APPROVE' ? tr('موارد بالا را همان‌طور که نشان داده شد دیده‌ام و تأیید می‌کنم.') : tr('موارد بالا را دیده‌ام و اصلاح آن را درخواست می‌کنم.')} />
          <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>{tr('ثبت تصمیم')}</Button>
          <p className="text-[12.5px] text-ink-500">{tr('با ثبت، نام شما، زمان، نشانی IP و مرورگر، و اثر انگشت فایل‌های بالا نگه داشته می‌شود. مهلت: {0}', formatDateTime(view.expiresAt))}</p>
        </section>
      )}
      {note && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="approve-note">{note}</p>}
    </Frame>
  );
}

function Plain({ children }: { org?: string; children: React.ReactNode }) {
  return <div className="space-y-5" dir="rtl">{children}</div>;
}

function Page({ org, children }: { org?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-full px-4 py-8" dir="rtl">
      <main className="mx-auto max-w-2xl space-y-5 rounded-xl bg-surface p-5 shadow-sm ring-1 ring-ink-200 sm:p-7">
        {org && <p className="text-xs font-medium text-brand-700">{tr('{0} — درخواست تأیید', org)}</p>}
        {children}
      </main>
    </div>
  );
}
