import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Field, Input, Textarea } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { locale, tr, trx } from '../i18n';
import { fallbackMessage } from '../lib/api';
import { HivaLogo } from '../components/Brand';

/*
 * Roadmap #36 — the e-signature sandbox's signing page. It stands in for a provider's page so the
 * lifecycle can be walked end to end, and says on its face that nothing signed here is a signature.
 */

interface View {
  sandbox: true; issuer: string; organization: string; envelope: string; status: string; expiresAt: string;
  contract: { title: string; code: string }; document: { fileName: string; sha256: string };
  signer: { name: string; email: string; party: string; status: string; signedAt: string | null };
  signers: { order: number; name: string; party: string; status: string; signedAt: string | null }[];
  waitingFor: string | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/esign/sandbox/${path}`, { ...init, headers: { 'accept-language': locale(), ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(trx(body?.error?.message) || fallbackMessage(res.status)), { status: res.status });
  return body as T;
}

export default function ESignSandbox({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => call<View>(token).then(setView).catch((e) => setError(e.status === 404 ? tr('این پیوند معتبر نیست.') : e.message)), [token]);
  useEffect(() => { void load(); }, [load]);

  const download = async () => {
    const res = await fetch(`/api/v1/esign/sandbox/${token}/document`);
    if (!res.ok) { setNote(fallbackMessage(res.status)); return; }
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = href; a.download = view?.document.fileName ?? 'contract.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  };
  const act = async (path: 'sign' | 'decline', body: object) => {
    setBusy(true); setNote(null);
    try { await call(`${token}/${path}`, { method: 'POST', body: JSON.stringify(body) }); await load(); }
    catch (e: any) { setNote(e.message); } finally { setBusy(false); }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-full px-4 py-8" dir="rtl">
      <main className="mx-auto max-w-2xl space-y-4 rounded-xl bg-surface p-5 shadow-sm ring-1 ring-ink-200 sm:p-7">
        <HivaLogo kind="mark" className="h-7 text-ink-900" label={tr('هیوامیس')} />
        <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900" data-testid="esign-sandbox-banner">{tr('محیط آزمایشی امضای الکترونیکی — آنچه اینجا «امضا» می‌شود امضای حقوقی نیست.')}</p>
        {children}
      </main>
    </div>
  );
  if (error) return shell(<p className="text-sm text-rose-700">{error}</p>);
  if (!view) return shell(<p className="text-sm text-ink-500">{tr('در حال بارگذاری…')}</p>);
  const open = view.status === 'SENT' && view.signer.status === 'PENDING';
  return shell(
    <>
      <header className="space-y-1">
        <p className="text-xs text-ink-500">{tr('{0} · پاکت', view.organization)}{' '}<span className="ltr">{view.envelope}</span></p>
        <h1 className="text-lg font-semibold text-ink-900">{view.contract.title}</h1>
        <p className="text-xs text-ink-500">{tr('امضاکننده: {0}', view.signer.name)}{' '}<span className="ltr">({view.signer.email})</span></p>
      </header>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm">
        <span className="flex-1">{view.document.fileName}<span className="ltr block text-[12px] text-ink-400">SHA-256 {view.document.sha256}</span></span>
        <Button size="sm" variant="secondary" onClick={() => void download()}>{tr('دریافت قرارداد')}</Button>
      </div>
      <ol className="space-y-1 text-sm" data-testid="esign-sandbox-signers">
        {view.signers.map((s) => <li key={s.order}>{s.order}. {s.name} — {s.status === 'SIGNED' ? tr('امضا کرد ({0})', formatDateTime(s.signedAt)) : s.status === 'DECLINED' ? tr('رد کرد') : tr('در انتظار')}</li>)}
      </ol>
      {view.signer.status === 'SIGNED' ? <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900" data-testid="esign-sandbox-done">{tr('امضای آزمایشی شما در {0} ثبت شد.', formatDateTime(view.signer.signedAt))}</p>
        : !open ? <p className="rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700">{tr('این پاکت دیگر امضا نمی‌پذیرد.')}</p>
        : view.waitingFor ? <p className="rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700" data-testid="esign-sandbox-wait">{tr('نخست {0} باید امضا کند.', view.waitingFor)}</p>
        : declining ? (
          <div className="space-y-2">
            <Field label={tr('دلیل رد')}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} aria-label={tr('دلیل رد')} /></Field>
            <div className="flex gap-2">
              <Button variant="danger" loading={busy} disabled={reason.trim().length < 5} onClick={() => void act('decline', { reason })}>{tr('رد قرارداد')}</Button>
              <Button variant="ghost" onClick={() => setDeclining(false)}>{tr('بازگشت')}</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3" data-testid="esign-sandbox-form">
            <Field label={tr('نام و نام خانوادگی')}><Input value={name} onChange={(e) => setName(e.target.value)} aria-label={tr('نام امضاکننده')} /></Field>
            <Checkbox checked={confirm} onChange={(e) => setConfirm(e.target.checked)} label={tr('قرارداد بالا را خوانده‌ام و می‌دانم این امضا آزمایشی است.')} />
            <div className="flex gap-2">
              <Button variant="primary" loading={busy} disabled={name.trim().length < 3 || !confirm} onClick={() => void act('sign', { signerName: name, confirm: true })}>{tr('امضای آزمایشی')}</Button>
              <Button variant="ghost" onClick={() => setDeclining(true)}>{tr('رد')}</Button>
            </div>
            <p className="text-[12.5px] text-ink-500">{tr('صادرکنندهٔ گواهی آزمایشی: {0}. مهلت: {1}', view.issuer, formatDateTime(view.expiresAt))}</p>
          </div>
        )}
      {note && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{note}</p>}
    </>,
  );
}
