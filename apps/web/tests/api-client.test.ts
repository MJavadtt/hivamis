import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ApiError, api, apiPost, getAccessToken, markSignedIn, setAccessToken, wasSignedIn,
} from '../src/lib/api';

/** A fetch stub that records calls and replays a scripted sequence of responses. */
function stubFetch(responses: { status: number; body?: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}
const path = (c: { url: string }) => c.url.replace(/^https?:\/\/[^/]+/, '');
const headersOf = (c: { init?: RequestInit }) => (c.init?.headers ?? {}) as Record<string, string>;

beforeEach(() => {
  setAccessToken(null);
  localStorage.clear();
});

describe('Token storage (audit SEC-4)', () => {
  /** An XSS that can read localStorage must find no credential there — neither token. */
  it('keeps the access token in memory, and only a hint that there is a session in storage', () => {
    setAccessToken('access-1');
    markSignedIn(true);
    expect(getAccessToken()).toBe('access-1');
    expect(wasSignedIn()).toBe(true);
    expect(JSON.stringify(localStorage)).not.toContain('access-1');
    expect(Object.keys(localStorage)).toEqual(['hiva.signedIn']);
  });

  it('forgets the hint rather than storing a false one', () => {
    markSignedIn(true);
    markSignedIn(false);
    expect(wasSignedIn()).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('trades a token an older build left in localStorage for the cookie, once, and deletes it', async () => {
    localStorage.setItem('hiva.refresh', 'old-refresh');
    setAccessToken('stale');
    const { calls } = stubFetch([
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'expired' } } },
      { status: 200, body: { accessToken: 'fresh' } },
      { status: 200, body: { ok: true } },
    ]);
    await expect(api('/projects')).resolves.toEqual({ ok: true });
    const trade = calls[1]!;
    expect(path(trade)).toBe('/api/v1/auth/refresh/legacy');
    expect(JSON.parse(String(trade.init?.body))).toEqual({ refreshToken: 'old-refresh' });
    expect(headersOf(trade)['x-hiva-refresh']).toBe('1');
    expect(localStorage.getItem('hiva.refresh')).toBeNull();
    expect(wasSignedIn()).toBe(true);
  });

  it('deletes the old token even when the trade is refused — it has had its one try', async () => {
    localStorage.setItem('hiva.refresh', 'spent');
    setAccessToken('stale');
    stubFetch([
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'expired' } } },
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'session invalid' } } },
    ]);
    await expect(api('/projects')).rejects.toBeInstanceOf(ApiError);
    expect(localStorage.getItem('hiva.refresh')).toBeNull();
    expect(wasSignedIn()).toBe(false);
  });

  it('says it is the app on every call that sets or spends the cookie', async () => {
    const { calls } = stubFetch([{ status: 204 }]);
    await apiPost('/auth/logout');
    expect(headersOf(calls[0]!)['x-hiva-refresh']).toBe('1');
    const other = stubFetch([{ status: 200, body: {} }]);
    await apiPost('/tasks', {});
    expect(headersOf(other.calls[0]!)['x-hiva-refresh']).toBeUndefined();
  });
});

describe('401 → refresh → retry', () => {
  it('refreshes once from the cookie and replays the original request', async () => {
    setAccessToken('stale');
    markSignedIn(true);
    const { calls } = stubFetch([
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'expired' } } },
      { status: 200, body: { accessToken: 'fresh' } },
      { status: 200, body: { ok: true } },
    ]);

    await expect(api('/projects')).resolves.toEqual({ ok: true });

    expect(calls.map(path)).toEqual([
      '/api/v1/projects', '/api/v1/auth/refresh', '/api/v1/projects',
    ]);
    // The cookie carries the refresh token: nothing of it is in the request this script builds.
    expect(calls[1]!.init?.body).toBeUndefined();
    expect(headersOf(calls[1]!)['x-hiva-refresh']).toBe('1');
    expect(calls[1]!.init?.credentials).toBe('same-origin');
    expect(getAccessToken()).toBe('fresh');
    expect(headersOf(calls[2]!).authorization).toBe('Bearer fresh');
  });

  /**
   * The single-flight collapse is the subtle part: two views hitting a stale token at once must
   * produce ONE refresh, or the second spends a token the first already rotated — which, since
   * Batch B, trips reuse detection and revokes every session the user has.
   */
  it('collapses concurrent 401s into a single refresh', async () => {
    setAccessToken('stale');
    markSignedIn(true);
    const { calls } = stubFetch([
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'expired' } } },
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'expired' } } },
      { status: 200, body: { accessToken: 'fresh' } },
      { status: 200, body: { ok: true } },
    ]);

    await Promise.all([api('/projects'), api('/tasks')]).catch(() => undefined);

    const refreshes = calls.filter((c) => c.url.includes('/auth/refresh'));
    expect(refreshes).toHaveLength(1);
  });

  it('allows a fresh refresh after the in-flight one settles', async () => {
    setAccessToken('stale');
    markSignedIn(true);
    stubFetch([
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'expired' } } },
      { status: 200, body: { accessToken: 'fresh' } },
      { status: 200, body: { ok: true } },
    ]);
    await api('/projects');

    // queueMicrotask clears the latch; a later 401 must be able to refresh again rather than
    // reusing a settled promise forever.
    const second = stubFetch([
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'expired' } } },
      { status: 200, body: { accessToken: 'fresher' } },
      { status: 200, body: { ok: true } },
    ]);
    await api('/tasks');
    expect(second.calls.some((c) => c.url.includes('/auth/refresh'))).toBe(true);
    expect(getAccessToken()).toBe('fresher');
  });

  it('gives up without asking when this browser was never signed in', async () => {
    setAccessToken('stale');
    const { calls } = stubFetch([
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'expired' } } },
    ]);
    await expect(api('/projects')).rejects.toBeInstanceOf(ApiError);
    expect(calls.filter((c) => c.url.includes('/auth/refresh'))).toHaveLength(0);
  });

  it('gives up when the refresh itself is rejected, and forgets the session', async () => {
    setAccessToken('stale');
    markSignedIn(true);
    stubFetch([
      { status: 401, body: { error: { code: 'SESSION_REVOKED', message: 'session over' } } },
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'session invalid' } } },
    ]);
    await expect(api('/projects')).rejects.toBeInstanceOf(ApiError);
    expect(wasSignedIn()).toBe(false);
  });
});

describe('Error surfacing', () => {
  it('carries the server’s Persian message and code', async () => {
    stubFetch([{ status: 422, body: { error: { code: 'GOVERNANCE', message: 'بریف ناقص است', rule: 'Doc_H §A' } } }]);
    await expect(api('/briefs/x')).rejects.toMatchObject({
      status: 422,
      body: { code: 'GOVERNANCE', message: 'بریف ناقص است' },
    });
  });

  it('does not mistake a non-JSON error body for a parse failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));
    await expect(api('/projects')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('A server that is not there', () => {
  // "errore 500" (the third list): the API was stopped, and the development server's proxy answered
  // the sign-in with a bare 500. The person should read that the server cannot be reached.
  const UNREACHABLE = 'سرور در دسترس نیست؛ چند لحظهٔ دیگر دوباره تلاش کنید.';
  const reply = (status: number, body: string | null, type = 'text/plain') =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } })));

  it('reads a bare 500 from the proxy, and nginx’s 502, as the server being unreachable', async () => {
    reply(500, null);
    const bare = await api('/auth/login', { method: 'POST', body: {} }).catch((e) => e);
    expect(bare).toBeInstanceOf(ApiError);
    expect(bare.body.code).toBe('UNREACHABLE');
    expect(bare.message).toBe(UNREACHABLE);
    reply(502, '<html><body>502 Bad Gateway</body></html>', 'text/html');
    expect((await api('/projects').catch((e) => e)).message).toBe(UNREACHABLE);
  });

  it('keeps the API’s own 500 — it answers in JSON — and an ordinary 404 as they are', async () => {
    reply(500, JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'خطای داخلی سرور رخ داد.' } }), 'application/json');
    const own = await api('/projects').catch((e) => e);
    expect(own.body.code).toBe('INTERNAL_ERROR');
    expect(own.message).toBe('خطای داخلی سرور رخ داد.');
    reply(404, null);
    expect((await api('/nowhere').catch((e) => e)).message).toBe('خطای ۴۰۴');
  });

  it('says the same when the request reaches nothing at all, and lets an abort be an abort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const none = await api('/projects').catch((e) => e);
    expect(none).toBeInstanceOf(ApiError);
    expect(none.status).toBe(0);
    expect(none.message).toBe(UNREACHABLE);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }));
    expect((await api('/projects').catch((e) => e)).name).toBe('AbortError');
  });
});
