import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { getRefreshToken, refreshSession, setAccessToken, setRefreshToken } from '../src/lib/api';
import { persianNumber, formatNumber, formatCurrency } from '../src/lib/format';
import { Checkbox } from '../src/components/ui';

/**
 * Hivamis task 10 — the sweep: what it found in the web app, held down.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', email: 'p@hiva.local', fullName: 'پریسا', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: [], locale: 'fa', mustChangePassword: false };

function Probe() {
  const { user, loading, unreachable } = useAuth();
  return <p data-testid="probe">{loading ? 'loading' : user ? `in:${user.fullName}` : unreachable ? 'unreachable' : 'out'}</p>;
}
const mount = () => render(<LocaleProvider><AuthProvider><Probe /></AuthProvider></LocaleProvider>);

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Numbers as Persian writes them', () => {
  it('uses «٫» for the decimal point and «٬» between thousands, and leaves an address alone', () => {
    expect(persianNumber('4,400,000.5')).toBe('۴٬۴۰۰٬۰۰۰٫۵');
    expect(persianNumber('12.5')).toBe('۱۲٫۵');
    expect(persianNumber('192.168.1.10')).toBe('۱۹۲.۱۶۸.۱.۱۰');
    expect(persianNumber('1405/07/13')).toBe('۱۴۰۵/۰۷/۱۳');
    expect(formatNumber(4400000)).toBe('۴٬۴۰۰٬۰۰۰');
    expect(formatCurrency(4_300_000_000)).toBe('۴٫۳ میلیارد ریال');
  });
});

describe('A stored session', () => {
  it('is kept when the server does not answer, and taken up when it does', async () => {
    setRefreshToken('r1');
    let up = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
      if (!up) throw new TypeError('Failed to fetch');
      if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r2' });
      if (p === '/auth/me') return json(ME);
      return json({});
    }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId('probe').textContent).toBe('unreachable');
    // Before the sweep, any failure here deleted the token: a server restart signed everyone out.
    expect(getRefreshToken()).toBe('r1');
    up = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByTestId('probe').textContent).toBe('in:پریسا');
    expect(getRefreshToken()).toBe('r2');
  });

  it('is dropped when the server refuses it, and a server error is not a refusal', async () => {
    setRefreshToken('r1');
    let status = 503;
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'X', message: 'x' } }, status)));
    const view = mount();
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('unreachable'));
    expect(getRefreshToken()).toBe('r1');
    view.unmount();
    status = 401;
    mount();
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('out'));
    expect(getRefreshToken()).toBeNull();
  });

  it('is refreshed one tab at a time, through a lock, with the token stored at that moment', async () => {
    setRefreshToken('r-old');
    setAccessToken(null);
    const sent: string[] = [];
    const request = vi.fn(async (_name: string, run: () => Promise<unknown>) => {
      // Another tab rotated the token while this one waited for the lock.
      setRefreshToken('r-new');
      return run();
    });
    vi.stubGlobal('navigator', { ...navigator, locks: { request } });
    vi.stubGlobal('fetch', vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).refreshToken);
      return json({ accessToken: 't', refreshToken: 'r-next' });
    }));
    expect(await Promise.all([refreshSession(), refreshSession()])).toEqual([true, true]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe('hiva.refresh');
    expect(sent).toEqual(['r-new']);
  });
});

describe('The shared checkbox', () => {
  it('is named by its label', () => {
    render(<Checkbox label="ثبت با وجود شمارهٔ تکراری" />);
    expect(screen.getByRole('checkbox', { name: 'ثبت با وجود شمارهٔ تکراری' })).toBeDefined();
  });
});
