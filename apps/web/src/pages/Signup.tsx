import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { Button, Field, Input, Select, Textarea } from '../components/ui';
import { GoogleButton } from './Login';
import { localDigits } from '../lib/format';
import { loc, tr } from '../i18n';
import { HivaLogo } from '../components/Brand';

/**
 * Asking to join (Hivamis task 4) — with a mobile proved by a code, or with a Google account. It
 * records a request; the system administrator approves it and chooses the unit and roles, so nothing
 * is granted here. No session, no shell.
 */

interface Options { organization: string; open: boolean; phone: boolean; google: boolean; units: { code: string; nameFa: string; nameEn: string }[] }

const OUTCOME: Record<string, string> = {
  sent: tr('درخواست شما ثبت شد. پس از تأیید مدیر سیستم، با همان روش وارد شوید.'),
  pending: tr('درخواست شما پیش‌تر ثبت شده و در انتظار تأیید مدیر سیستم است.'),
};
const PROBLEM: Record<string, string> = {
  HAS_ACCOUNT: tr('با این حساب گوگل یا ایمیل آن پیش‌تر حسابی ساخته شده است؛ وارد شوید.'),
  DOMAIN: tr('این سازمان عضویت با حساب گوگلِ این دامنه را نمی‌پذیرد.'),
  SIGNUP_CLOSED: tr('درخواست عضویت در این سازمان بسته است.'),
  CANCELLED: tr('ورود با گوگل نیمه‌کاره ماند.'),
};

export default function Signup() {
  const [options, setOptions] = useState<Options | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', code: '', departmentCode: '', note: '' });
  const [codeSent, setCodeSent] = useState(false);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<Options>('/auth/signup/options').then(setOptions).catch((e) => setError((e as Error).message));
    // Back from Google: the outcome is in the fragment, which never reaches a server.
    const back = new URLSearchParams(window.location.hash.slice(1));
    if (back.get('done')) setDone(OUTCOME[back.get('done')!] ?? OUTCOME.sent!);
    if (back.get('error')) setError(PROBLEM[back.get('error')!] ?? tr('انجام نشد.'));
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
  }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const sendCode = () => run(async () => {
    const r = await apiPost<{ resendAfterSeconds: number }>('/auth/signup/phone/start', { phone: form.phone });
    setCodeSent(true); setWait(r.resendAfterSeconds);
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!codeSent) return void sendCode();
    return void run(async () => {
      await apiPost('/auth/signup', { ...form, departmentCode: form.departmentCode || null, note: form.note || null });
      setDone(OUTCOME.sent!);
    });
  };

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <HivaLogo kind="mark" className="mx-auto mb-3 h-12 text-ink-900" label={tr('هیوامیس')} />
          <h1 className="text-xl font-semibold text-ink-900">{tr('درخواست عضویت')}</h1>
          {options && <p className="mt-1 text-sm text-ink-500">{tr('در هیوامیسِ {0}', options.organization)}</p>}
        </div>
        <div className="space-y-4 rounded-xl bg-surface p-6 shadow-sm ring-1 ring-ink-200" data-testid="signup">
          {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">{error}</p>}
          {done ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200" data-testid="signup-done">{done}</p>
          ) : options && !options.open ? (
            <p className="text-sm text-ink-600">{tr('درخواست عضویت در این سازمان بسته است. از مدیر سیستم بخواهید حسابی برایتان بسازد.')}</p>
          ) : options && (
            <>
              <p className="text-xs leading-6 text-ink-500">{tr('درخواست شما به مدیر سیستم می‌رسد؛ او واحد و نقش شما را تعیین و تأیید می‌کند. تا آن زمان دسترسی‌ای داده نمی‌شود.')}</p>
              {options.google && <GoogleButton mode="signup" label={tr('درخواست با حساب گوگل')} onError={setError} />}
              {options.google && options.phone && (
                <div className="flex items-center gap-2 text-[12.5px] text-ink-400"><span className="h-px flex-1 bg-ink-200" />{tr('یا با شمارهٔ همراه')}<span className="h-px flex-1 bg-ink-200" /></div>
              )}
              {options.phone && (
                <form onSubmit={submit} className="space-y-3">
                  <Field label={tr('نام و نام خانوادگی')} required><Input value={form.fullName} onChange={(e) => set({ fullName: e.target.value })} required autoComplete="name" /></Field>
                  <Field label={tr('ایمیل کاری')} required><Input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} required autoComplete="email" className="ltr" /></Field>
                  <Field label={tr('شمارهٔ همراه')} required hint={codeSent ? tr('کد شش‌رقمی به این شماره پیامک شد.') : undefined}>
                    <Input type="tel" inputMode="tel" value={form.phone} onChange={(e) => { set({ phone: e.target.value }); setCodeSent(false); }} required autoComplete="tel" className="ltr" placeholder="0912 123 4567" />
                  </Field>
                  {codeSent && (
                    <Field label={tr('کد پیامک‌شده')} required>
                      <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={form.code} onChange={(e) => set({ code: e.target.value })} required autoFocus className="ltr text-center tracking-[0.5em]" aria-label={tr('کد پیامک‌شده')} />
                    </Field>
                  )}
                  {codeSent && (
                    <button type="button" disabled={wait > 0 || busy} onClick={() => void sendCode()} className="text-xs text-brand-700 underline disabled:text-ink-400 disabled:no-underline">
                      {wait > 0 ? tr('فرستادن دوبارهٔ کد تا {0} ثانیهٔ دیگر', localDigits(wait)) : tr('فرستادن دوبارهٔ کد')}
                    </button>
                  )}
                  <Field label={tr('واحد (اختیاری)')}>
                    <Select value={form.departmentCode} onChange={(e) => set({ departmentCode: e.target.value })} aria-label={tr('واحد')}>
                      <option value="">{tr('— نمی‌دانم —')}</option>
                      {options.units.map((u) => <option key={u.code} value={u.code}>{loc(u, 'name')}</option>)}
                    </Select>
                  </Field>
                  <Field label={tr('توضیح برای مدیر سیستم (اختیاری)')}><Textarea rows={2} value={form.note} onChange={(e) => set({ note: e.target.value })} maxLength={500} /></Field>
                  <Button type="submit" variant="primary" loading={busy} className="w-full">{codeSent ? tr('ثبت درخواست') : tr('فرستادن کد')}</Button>
                </form>
              )}
            </>
          )}
        </div>
        <p className="mt-4 text-center text-sm text-ink-600">{tr('حساب دارید؟')}{' '}<a href="/" className="font-medium text-brand-700 underline">{tr('ورود')}</a></p>
      </div>
    </main>
  );
}
