import { useEffect, useState } from 'react';
import { apiPost, markSignedIn } from '../lib/api';
import { tr } from '../i18n';
import { Button, Field, Input } from '../components/ui';
import { localDigits } from '../lib/format';

/**
 * Where Google sends the browser back (Hivamis task 4). The server put a single-use ticket in the
 * fragment — which no server ever sees — and this page trades it for a session, then opens the app.
 *
 * Audit SEC-5: a Google account whose address is a person's work address, but not yet linked, comes
 * back with a link offer instead. The person proves the account is theirs once — its password, or a
 * code to its mobile — and only then is it linked and signed in.
 */

const PROBLEM: Record<string, string> = {
  NO_ACCOUNT: tr('این حساب گوگل به هیچ حسابی در هیوامیس وصل نیست. اگر عضو سازمان هستید، درخواست عضویت بدهید یا با ایمیل و رمز وارد شوید و حساب گوگل را از صفحهٔ خودتان وصل کنید.'),
  LOCKED: tr('حساب کاربری موقتاً قفل شده است. چند دقیقه دیگر تلاش کنید.'),
  CANCELLED: tr('ورود با گوگل نیمه‌کاره ماند.'),
  GOOGLE_STATE: tr('این درخواست ورود منقضی شده یا پیش‌تر به کار رفته است؛ دوباره تلاش کنید.'),
  GOOGLE_BROWSER: tr('این ورود در مرورگر دیگری آغاز شده است؛ از همین مرورگر دوباره با گوگل وارد شوید.'),
  GOOGLE_EMAIL: tr('ایمیل این حساب گوگل تأییدشده نیست.'),
  GOOGLE_TOKEN: tr('پاسخ گوگل تأیید نشد.'),
  GOOGLE_UNREACHABLE: tr('پاسخی از گوگل نرسید؛ کمی بعد دوباره تلاش کنید.'),
  DOMAIN: tr('حساب‌های گوگلِ این دامنه در این سازمان پذیرفته نیستند؛ با حساب گوگل کاری‌تان وارد شوید.'),
};

/** Signed in: the answer set the refresh cookie, and the app restores the session from it. */
const openApp = () => { markSignedIn(true); window.location.replace('/'); };

export default function GoogleReturn() {
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<string | null>(null);
  useEffect(() => {
    const back = new URLSearchParams(window.location.hash.slice(1));
    history.replaceState(null, '', window.location.pathname);
    const link = back.get('link');
    if (link) { setOffer(link); return; }
    const ticket = back.get('ticket');
    if (!ticket) { setError(PROBLEM[back.get('error') ?? ''] ?? tr('ورود با گوگل انجام نشد.')); return; }
    apiPost('/auth/ticket', { ticket })
      .then(openApp)
      .catch((e) => setError((e as Error).message));
  }, []);
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl bg-surface p-6 text-center shadow-sm ring-1 ring-ink-200" data-testid="google-return">
        {offer ? <LinkProof token={offer} /> : error ? (
          <>
            <p role="alert" className="text-sm leading-6 text-rose-700">{error}</p>
            <div className="flex justify-center gap-4 text-sm">
              <a href="/" className="font-medium text-brand-700 underline">{tr('ورود')}</a>
              <a href="/signup" className="font-medium text-brand-700 underline">{tr('درخواست عضویت')}</a>
            </div>
          </>
        ) : <p className="text-sm text-ink-600">{tr('در حال ورود…')}</p>}
      </div>
    </main>
  );
}

interface Offer { email: string; fullName: string; password: boolean; phone: string | null }

function LinkProof({ token }: { token: string }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiPost<Offer>('/auth/google/offer', { token })
      .then(setOffer)
      .catch((e) => { setGone(true); setProblem((e as Error).message); });
  }, [token]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setProblem(null);
    try { await work(); } catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };
  const confirm = (proof: { password: string } | { code: string }) => run(async () => {
    await apiPost('/auth/google/offer/confirm', { token, ...proof });
    openApp();
  });

  if (gone || (offer && !offer.password && !offer.phone)) {
    return (
      <>
        <p role="alert" className="text-sm leading-6 text-rose-700">
          {problem ?? tr('این حساب نه رمز دارد نه شمارهٔ همراه تأییدشده؛ نخست از راه دیگری وارد شوید، سپس حساب گوگل را از صفحهٔ خودتان وصل کنید.')}
        </p>
        <a href="/" className="text-sm font-medium text-brand-700 underline">{tr('ورود')}</a>
      </>
    );
  }
  if (!offer) return <p className="text-sm text-ink-600">{tr('در حال ورود…')}</p>;
  return (
    <div className="space-y-4 text-start" data-testid="google-link-proof">
      <h1 className="text-base font-semibold text-ink-900">{tr('وصل کردن حساب گوگل')}</h1>
      <p className="text-sm leading-6 text-ink-600">
        {tr('حساب گوگل {0} همان نشانی حساب {1} در هیوامیس است. برای وصل کردنش، یک بار ثابت کنید که این حساب از آنِ شماست.', offer.email, offer.fullName)}
      </p>
      {offer.password && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void confirm({ password }); }}>
          <Field label={tr('رمز عبور هیوامیس')}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="ltr" />
          </Field>
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!password}>{tr('وصل کن و وارد شو')}</Button>
        </form>
      )}
      {offer.phone && (
        <div className="space-y-2">
          {!sent ? (
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void run(async () => { await apiPost('/auth/google/offer/code', { token }); setSent(true); })}>
              {tr('فرستادن کد به {0}', localDigits(offer.phone))}
            </Button>
          ) : (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void confirm({ code }); }}>
              <Field label={tr('کد پیامک‌شده')}>
                <Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" className="ltr" />
              </Field>
              <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!code}>{tr('وصل کن و وارد شو')}</Button>
            </form>
          )}
        </div>
      )}
      {problem && <p role="alert" className="text-sm text-rose-700">{problem}</p>}
    </div>
  );
}
