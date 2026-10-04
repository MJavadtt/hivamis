import { useEffect, useState } from 'react';
import { apiPost, setRefreshToken } from '../lib/api';
import { tr } from '../i18n';

/**
 * Where Google sends the browser back (Hivamis task 4). The server put a single-use ticket in the
 * fragment — which no server ever sees — and this page trades it for a session, then opens the app.
 */

const PROBLEM: Record<string, string> = {
  NO_ACCOUNT: tr('این حساب گوگل به هیچ حسابی در هیوامیس وصل نیست. اگر عضو سازمان هستید، درخواست عضویت بدهید یا با ایمیل و رمز وارد شوید و حساب گوگل را از صفحهٔ خودتان وصل کنید.'),
  LOCKED: tr('حساب کاربری موقتاً قفل شده است. چند دقیقه دیگر تلاش کنید.'),
  CANCELLED: tr('ورود با گوگل نیمه‌کاره ماند.'),
  GOOGLE_STATE: tr('این درخواست ورود منقضی شده یا پیش‌تر به کار رفته است؛ دوباره تلاش کنید.'),
  GOOGLE_EMAIL: tr('ایمیل این حساب گوگل تأییدشده نیست.'),
  GOOGLE_TOKEN: tr('پاسخ گوگل تأیید نشد.'),
  GOOGLE_UNREACHABLE: tr('پاسخی از گوگل نرسید؛ کمی بعد دوباره تلاش کنید.'),
};

export default function GoogleReturn() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const back = new URLSearchParams(window.location.hash.slice(1));
    history.replaceState(null, '', window.location.pathname);
    const ticket = back.get('ticket');
    if (!ticket) { setError(PROBLEM[back.get('error') ?? ''] ?? tr('ورود با گوگل انجام نشد.')); return; }
    apiPost<{ refreshToken: string }>('/auth/ticket', { ticket })
      .then((s) => { setRefreshToken(s.refreshToken); window.location.replace('/'); })
      .catch((e) => setError((e as Error).message));
  }, []);
  return (
    <main className="grid min-h-screen place-items-center bg-ink-100 p-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl bg-surface p-6 text-center shadow-sm ring-1 ring-ink-200" data-testid="google-return">
        {error ? (
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
