import { useEffect, useState } from 'react';
import { ApiError, apiGet, apiPost } from '../lib/api';
import { Button, Field, Input } from '../components/ui';
import { formatDate } from '../lib/format';
import { tr } from '../i18n';
import { HivaLogo } from '../components/Brand';

/**
 * A person brought in by the onboarding import sets their first password here (roadmap #48): no
 * session, no shell — only the one-time link. The rules are the staff password rules.
 */
export default function Activate({ token }: { token: string }) {
  const [who, setWho] = useState<{ fullName: string; email: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiGet<{ fullName: string; email: string; expiresAt: string }>(`/auth/activation/${token}`).then(setWho).catch((e: unknown) => setError((e as ApiError)?.message ?? tr('این پیوند معتبر نیست.')));
  }, [token]);
  const strong = password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password);
  const submit = async () => {
    setBusy(true);
    try { await apiPost(`/auth/activation/${token}`, { password }); setDone(true); }
    catch (e: unknown) { setError((e as ApiError)?.message ?? tr('انجام نشد.')); }
    finally { setBusy(false); }
  };
  return (
    <main dir="rtl" className="grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl bg-surface p-6 shadow-sm ring-1 ring-ink-200" data-testid="activate">
        <HivaLogo kind="mark" className="h-10 text-ink-900" label={tr('هیوامیس')} />
        <h1 className="text-lg font-semibold text-ink-900">{tr('هیوامیس — گذاشتن رمز عبور')}</h1>
        {error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
        {done ? (
          <>
            <p className="text-sm text-emerald-800">{tr('رمز شما گذاشته شد. از این پس با ایمیل و همین رمز وارد شوید.')}</p>
            <a href="/login" className="btn-accent inline-block rounded-lg px-4 py-2 text-sm">{tr('ورود به سامانه')}</a>
          </>
        ) : who && !error && (
          <>
            <p className="text-sm text-ink-700">{tr('{0} عزیز، برای حساب', who.fullName)}{' '}<span className="ltr">{who.email}</span>{' '}{tr('رمز بگذارید. این پیوند تا {0} و فقط یک بار کار می‌کند.', formatDate(who.expiresAt))}</p>
            <Field label={tr('رمز عبور')} hint={tr('دست‌کم ۱۲ نویسه، با حرف کوچک، حرف بزرگ و عدد لاتین')}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label={tr('رمز عبور')} autoComplete="new-password" className="ltr" />
            </Field>
            <Field label={tr('تکرار رمز عبور')}>
              <Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} aria-label={tr('تکرار رمز عبور')} autoComplete="new-password" className="ltr" />
            </Field>
            {again && again !== password && <p className="text-xs text-rose-700">{tr('دو رمز یکی نیستند.')}</p>}
            <Button variant="primary" loading={busy} disabled={!strong || password !== again} onClick={() => void submit()}>{tr('گذاشتن رمز')}</Button>
          </>
        )}
      </div>
    </main>
  );
}
