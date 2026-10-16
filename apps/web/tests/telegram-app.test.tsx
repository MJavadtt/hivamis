import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { getAccessToken, markSignedIn, setAccessToken } from '../src/lib/api';
import TelegramApp, { launchData } from '../src/pages/TelegramApp';

/**
 * Audit F-9, step 3: the Mini App reads Telegram's signed launch data from the address fragment,
 * takes it out of the address at once, trades it once for a session, and opens on the person's
 * bookings. An account nobody linked is told how to link it.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', email: 'd@hiva.local', fullName: 'بهراد مهرنیا', jobTitle: null, locale: 'fa', mustChangePassword: false, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: ['meeting.book'] };
const DATA = 'query_id=AA1&user=%7B%22id%22%3A5550001%7D&auth_date=1792150000&hash=' + 'a'.repeat(64);

function mount(answer: (path: string, body: any) => Response | undefined) {
  const sent: { path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ path: p, body });
    return answer(p, body) ?? json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider>
        <MemoryRouter initialEntries={['/tg']}><TelegramApp /></MemoryRouter>
      </AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

beforeEach(() => {
  localStorage.clear();
  setAccessToken(null); markSignedIn(false);
  window.history.replaceState(null, '', `/tg#tgWebAppData=${encodeURIComponent(DATA)}&tgWebAppVersion=8.0&tgWebAppPlatform=ios`);
});

describe('The Telegram Mini App', () => {
  it('trades the launch data once for a session, out of the address at once, and opens on the bookings', async () => {
    expect(launchData()).toBe(DATA);
    const sent = mount((p) => {
      if (p === '/auth/telegram/webapp') return json({ accessToken: 'tg-session' });
      if (p === '/auth/me') return json(ME);
      if (p === '/bookings') return json({ items: [{ id: 'b1', code: 'BKG-000001', title: 'بازبینی کمپین', state: 'CONFIRMED', startsAt: '2026-10-20T07:30:00.000Z', room: { name: 'اتاق جلسهٔ دماوند' }, placeNote: null, organizer: { fullName: 'بهراد مهرنیا' } }], total: 1, page: 1, pageSize: 50 });
      return undefined;
    });
    expect(window.location.hash).toBe('');
    await screen.findByTestId('tg-app');
    expect((await screen.findByTestId('tg-bookings')).textContent).toContain('بازبینی کمپین');
    expect(sent.filter((x) => x.path === '/auth/telegram/webapp')).toEqual([{ path: '/auth/telegram/webapp', body: { initData: DATA } }]);
    expect(getAccessToken()).toBe('tg-session');
  });

  it('tells an account nobody linked how to link it', async () => {
    mount((p) => (p === '/auth/telegram/webapp'
      ? json({ error: { code: 'TELEGRAM_NOT_LINKED', message: 'این حساب تلگرام به هیوامیس وصل نیست. در هیوامیس «اتصال پیام‌رسان» را بزنید و کدی را که می‌گیرد برای همین ربات بفرستید.' } }, 401)
      : undefined));
    await waitFor(() => expect(screen.getByTestId('tg-problem').textContent).toContain('اتصال پیام‌رسان'));
    expect(window.location.hash).toBe('');
  });
});
