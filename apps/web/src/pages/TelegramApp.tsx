import { useEffect, useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, localDigits, sep } from '../lib/format';
import { Button, EmptyState, LoadingBlock, StateBadge, Tabs } from '../components/ui';
import { BookingEditor, BookingPage } from './Bookings';
import { tr } from '../i18n';
import { BrandLockup } from '../components/Brand';

/**
 * The Telegram Mini App (audit F-9, step 3): Hivamis's own page, opened from the organisation's bot.
 *
 * Telegram hands the page its signed launch data in the address fragment, which never reaches a
 * server. It is read once, taken out of the address at once, and traded at
 * `POST /auth/telegram/webapp` for the ordinary session of the person whose Telegram account it is —
 * linked earlier, from a signed-in session, by a code sent to the bot. No Telegram script is loaded:
 * the page's policy allows only its own, and the fragment carries all it needs.
 *
 * Inside, it is the meeting bookings: what is coming, what waits on the person's approval, and a new
 * booking — the same pages, rules and buttons as in the browser.
 */

/** The launch data, from the fragment Telegram adds (or from its script, where a page loads one). */
export function launchData(): string | null {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('tgWebAppData');
  const fromScript = (window as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData;
  return fromHash || fromScript || null;
}

/** Tells the Telegram app the page is ready, and to open it full height, where it listens. */
function tellTelegram(event: 'web_app_ready' | 'web_app_expand') {
  const proxy = (window as { TelegramWebviewProxy?: { postEvent: (e: string, d: string) => void } }).TelegramWebviewProxy;
  try { proxy?.postEvent(event, ''); } catch { /* not inside Telegram */ }
}

export default function TelegramApp() {
  const { user, signInWith } = useAuth();
  const [problem, setProblem] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const data = launchData();
    // Out of the address before anything else: history, a screenshot, a shared link never carry it.
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
    tellTelegram('web_app_ready');
    tellTelegram('web_app_expand');
    if (!data) return;
    setJoining(true);
    apiPost<{ accessToken: string }>('/auth/telegram/webapp', { initData: data })
      .then((session) => signInWith(session))
      .catch((e) => setProblem((e as Error).message))
      .finally(() => setJoining(false));
  }, [signInWith]);

  if (joining) return <LoadingBlock label={tr('در حال ورود از تلگرام…')} />;
  if (!user) {
    return (
      <main className="grid min-h-screen place-items-center p-4">
        <div className="w-full max-w-sm space-y-3 rounded-xl bg-surface p-6 text-center shadow-sm ring-1 ring-ink-200" data-testid="tg-problem">
          <p role="alert" className="text-sm leading-6 text-ink-800">{problem ?? tr('این صفحه از درون تلگرام، با دکمهٔ ربات سازمان باز می‌شود.')}</p>
          <a href="/" className="text-sm font-medium text-brand-700 underline">{tr('ورود به هیوامیس در مرورگر')}</a>
        </div>
      </main>
    );
  }
  return (
    <div className="mx-auto min-h-screen max-w-2xl" data-testid="tg-app">
      <header className="flex items-center gap-2 px-4 py-3">
        <Link to="/tg" className="flex-1"><BrandLockup /></Link>
        <span className="text-xs text-ink-500">{user.fullName}</span>
      </header>
      <Routes>
        <Route path="/tg" element={<Home />} />
        <Route path="/tg/bookings/:id" element={<BookingPage />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </div>
  );
}

interface Row { id: string; code: string; title: string; state: string; startsAt: string; room: { name: string } | null; placeNote: string | null; organizer: { fullName: string } }

function Home() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'mine' | 'approve'>('mine');
  const [writing, setWriting] = useState(false);
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const { data, isLoading } = useQuery<{ items: Row[] }>({
    queryKey: ['/bookings', 'tg', tab],
    queryFn: () => apiGet('/bookings', tab === 'mine' ? { scope: 'mine', from, pageSize: '50' } : { scope: 'approve', pageSize: '50' }),
  });
  const items = tab === 'mine'
    ? [...(data?.items ?? [])].filter((b) => !['CANCELLED', 'REJECTED'].includes(b.state)).sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    : data?.items ?? [];
  return (
    <div className="space-y-3 px-4 pb-8">
      <Button variant="primary" className="w-full" onClick={() => setWriting(true)}>{tr('رزرو تازه')}</Button>
      {can('meeting.approve') && (
        <Tabs tabs={[{ key: 'mine', label: tr('جلسه‌های پیش رو') }, { key: 'approve', label: tr('در انتظار تأیید من') }]} active={tab} onChange={(k) => setTab(k as typeof tab)} />
      )}
      {isLoading ? <LoadingBlock /> : !items.length ? (
        <EmptyState title={tab === 'approve' ? tr('رزروی در انتظار تأیید شما نیست') : tr('جلسهٔ پیش رویی نیست')} />
      ) : (
        <ul className="space-y-2" data-testid="tg-bookings">
          {items.map((b) => (
            <li key={b.id}>
              <Link to={`/tg/bookings/${b.id}`} className="block rounded-xl bg-surface px-4 py-3 shadow-sm ring-1 ring-ink-200">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-ink-900">{b.title}</span>
                  <StateBadge state={b.state} />
                </span>
                <span className="mt-1 block text-xs text-ink-600">
                  {formatDateTime(b.startsAt)}{sep()}{b.room?.name ?? b.placeNote ?? '—'}
                  {tab === 'approve' && <>{sep()}{b.organizer.fullName}</>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && <p className="text-center text-[12.5px] text-ink-400">{tr('{0} رزرو', localDigits(items.length))}</p>}
      {writing && <BookingEditor onClose={() => setWriting(false)} onSaved={(id) => navigate(`/tg/bookings/${id}`)} />}
    </div>
  );
}
