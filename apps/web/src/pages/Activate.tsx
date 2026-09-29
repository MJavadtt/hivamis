import { useEffect, useState } from 'react';
import { ApiError, apiGet, apiPost } from '../lib/api';
import { Button, Field, Input } from '../components/ui';
import { formatDate } from '../lib/format';

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
    apiGet<{ fullName: string; email: string; expiresAt: string }>(`/auth/activation/${token}`).then(setWho).catch((e: unknown) => setError((e as ApiError)?.message ?? 'این پیوند معتبر نیست.'));
  }, [token]);
  const strong = password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password);
  const submit = async () => {
    setBusy(true);
    try { await apiPost(`/auth/activation/${token}`, { password }); setDone(true); }
    catch (e: unknown) { setError((e as ApiError)?.message ?? 'انجام نشد.'); }
    finally { setBusy(false); }
  };
  return (
    <main dir="rtl" className="grid min-h-screen place-items-center bg-ink-50 p-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl bg-surface p-6 shadow-sm ring-1 ring-ink-200" data-testid="activate">
        <h1 className="text-lg font-semibold text-ink-900">هیوا او‌اس — گذاشتن رمز عبور</h1>
        {error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
        {done ? (
          <>
            <p className="text-sm text-emerald-800">رمز شما گذاشته شد. از این پس با ایمیل و همین رمز وارد شوید.</p>
            <a href="/login" className="inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm text-white">ورود به سامانه</a>
          </>
        ) : who && !error && (
          <>
            <p className="text-sm text-ink-700">{who.fullName} عزیز، برای حساب <span className="ltr">{who.email}</span> رمز بگذارید. این پیوند تا {formatDate(who.expiresAt)} و فقط یک بار کار می‌کند.</p>
            <Field label="رمز عبور" hint="دست‌کم ۱۲ نویسه، با حرف کوچک، حرف بزرگ و عدد لاتین">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="رمز عبور" autoComplete="new-password" className="ltr" />
            </Field>
            <Field label="تکرار رمز عبور">
              <Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} aria-label="تکرار رمز عبور" autoComplete="new-password" className="ltr" />
            </Field>
            {again && again !== password && <p className="text-xs text-rose-700">دو رمز یکی نیستند.</p>}
            <Button variant="primary" loading={busy} disabled={!strong || password !== again} onClick={() => void submit()}>گذاشتن رمز</Button>
          </>
        )}
      </div>
    </main>
  );
}
