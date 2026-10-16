import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { apiGet, apiPost } from '../lib/api';
import { Button, Field, Input, cx } from '../components/ui';
import { localDigits } from '../lib/format';
import { tr } from '../i18n';
import { HivaLogo } from '../components/Brand';

/**
 * Signing in (Hivamis task 4): with the work email and password, with a code sent to one's mobile,
 * or with a Google account — whichever this installation offers. Signing in proves who someone is;
 * what they may do is still their roles'.
 */

export interface Methods {
  organization: string; password: boolean; phone: boolean; google: boolean;
  signup: { open: boolean; phone: boolean; google: boolean };
}

export function useMethods() {
  const [methods, setMethods] = useState<Methods | null>(null);
  useEffect(() => { apiGet<Methods>('/auth/methods').then(setMethods).catch(() => setMethods(null)); }, []);
  return methods;
}

/** Off to Google; it sends the browser back to /auth/google. */
export async function goToGoogle(mode: 'login' | 'signup'): Promise<void> {
  const { url } = await apiGet<{ url: string }>('/auth/google/start', { mode });
  window.location.assign(url);
}

export function GoogleButton({ label, onError, mode }: { label: string; mode: 'login' | 'signup'; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button type="button" variant="secondary" className="w-full" loading={busy}
      onClick={async () => { setBusy(true); try { await goToGoogle(mode); } catch (e) { onError((e as Error).message); setBusy(false); } }}>
      <svg aria-hidden viewBox="0 0 24 24" className="size-4"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7Z" /><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.2v3.1A12 12 0 0 0 12 24Z" /><path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.2a12 12 0 0 0 0 10.8l4.1-3.1Z" /><path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.2 6.6l4.1 3.1c1-2.9 3.6-4.9 6.7-4.9Z" /></svg>
      {label}
    </Button>
  );
}

export default function Login() {
  const { signIn, signInWith } = useAuth();
  const methods = useMethods();
  const [way, setWay] = useState<'password' | 'phone'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [wait, setWait] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError((err as Error)?.message ?? tr('ورود ناموفق بود.')); } finally { setBusy(false); }
  };

  const sendCode = () => run(async () => {
    const r = await apiPost<{ resendAfterSeconds: number }>('/auth/phone/start', { phone });
    setCodeSent(true); setCode(''); setWait(r.resendAfterSeconds);
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (way === 'password') return void run(() => signIn(email.trim().toLowerCase(), password));
    if (!codeSent) return void sendCode();
    return void run(async () => signInWith(await apiPost('/auth/phone/verify', { phone, code })));
  };

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          {/* The owner's logo, whole: the mark, «Hiva» and its line (2026-10-16). */}
          <HivaLogo className="mx-auto mb-4 h-28 text-ink-900 sm:h-32" label="Hiva — Branding | Creativity" />
          <h1 className="text-xl font-semibold text-ink-900">{tr('هیوامیس')}</h1>
          {/* Whose sign-in this is — on an installation with several organisations, the one of this address (roadmap #50). */}
          {methods?.organization && <p className="mt-1 text-sm font-bold text-ink-700" dir="auto" data-testid="login-org">{methods.organization}</p>}
          <p className="mt-1 text-sm text-ink-500">{tr('سیستم‌عامل سازمانی — ورود به سامانه')}</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-xl bg-surface p-6 shadow-sm ring-1 ring-ink-200">
          {methods?.phone && (
            <div role="tablist" aria-label={tr('روش ورود')} className="grid grid-cols-2 gap-1 rounded-lg bg-ink-100 p-1 text-sm">
              {(['password', 'phone'] as const).map((w) => (
                <button key={w} type="button" role="tab" aria-selected={way === w} onClick={() => { setWay(w); setError(null); }}
                  className={cx('rounded-md px-3 py-1.5 font-medium', way === w ? 'bg-surface text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-700')}>
                  {w === 'password' ? tr('ایمیل و رمز') : tr('شمارهٔ همراه')}
                </button>
              ))}
            </div>
          )}

          {way === 'password' ? (
            <>
              <Field label={tr('ایمیل سازمانی')} required>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required className="ltr" placeholder="name@hiva.local" />
              </Field>
              <Field label={tr('رمز عبور')} required>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required className="ltr" />
              </Field>
            </>
          ) : (
            <>
              <Field label={tr('شمارهٔ همراه')} required hint={codeSent ? tr('اگر این شماره به حسابی وصل باشد، کد شش‌رقمی به آن پیامک شد.') : undefined}>
                <Input type="tel" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setCodeSent(false); }} autoComplete="tel" required className="ltr" placeholder="0912 123 4567" />
              </Field>
              {codeSent && (
                <Field label={tr('کد پیامک‌شده')} required>
                  <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus className="ltr text-center tracking-[0.5em]" aria-label={tr('کد پیامک‌شده')} />
                </Field>
              )}
              {codeSent && (
                <button type="button" disabled={wait > 0 || busy} onClick={() => void sendCode()} className="text-xs text-brand-700 underline disabled:text-ink-400 disabled:no-underline">
                  {wait > 0 ? tr('فرستادن دوبارهٔ کد تا {0} ثانیهٔ دیگر', localDigits(wait)) : tr('فرستادن دوبارهٔ کد')}
                </button>
              )}
            </>
          )}

          {error && (
            <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">{error}</p>
          )}

          <Button type="submit" variant="primary" loading={busy} className="w-full">
            {way === 'phone' && !codeSent ? tr('فرستادن کد') : tr('ورود')}
          </Button>

          {methods?.google && (
            <>
              <div className="flex items-center gap-2 text-[12.5px] text-ink-400"><span className="h-px flex-1 bg-ink-200" />{tr('یا')}<span className="h-px flex-1 bg-ink-200" /></div>
              <GoogleButton mode="login" label={tr('ورود با حساب گوگل')} onError={setError} />
            </>
          )}
        </form>

        {methods?.signup.open && (
          <p className="mt-4 text-center text-sm text-ink-600">
            {tr('حساب ندارید؟')}{' '}<a href="/signup" className="font-medium text-brand-700 underline">{tr('درخواست عضویت')}</a>
          </p>
        )}
        <p className="mt-3 text-center text-xs text-ink-400">{tr('دسترسی شما بر اساس نقش سازمانی و قوانین حاکم بر فرآیند تعیین می‌شود.')}</p>
      </div>
    </div>
  );
}
