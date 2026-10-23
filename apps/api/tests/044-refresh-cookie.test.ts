import { describe, it, expect, afterAll } from 'vitest';
import { call, closeApp, get, refreshCookieOf, refreshWith, signIn } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { createTicket } from '../src/auth/google.js';
import { cookieSecure } from '../src/auth/cookie.js';
import { hashToken } from '../src/auth/tokens.js';

/**
 * Audit SEC-4: the refresh token travels in a cookie no script can read, is spent only by a request
 * that shows it is the app's own, and is never in a response body.
 */

const cookieLine = (res: { headers: Record<string, unknown> }) => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : [String(raw ?? '')]).find((c) => c.startsWith('hiva_refresh=')) ?? '';
};
const withCookie = (token: string, extra: Record<string, string> = {}) => ({ cookie: `hiva_refresh=${encodeURIComponent(token)}`, ...extra });

describe('The refresh token’s cookie (audit SEC-4)', () => {
  afterAll(async () => { await closeApp(); });

  it('is set at sign-in — HttpOnly, SameSite=Strict, only for /api/v1/auth — and kept out of the body', async () => {
    const res = await call('POST', '/auth/login', { payload: { email: 'sales@hiva.local', password: 'Hiva@Dev2026!' } });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('refreshToken');
    const line = cookieLine(res);
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=Strict/);
    expect(line).toMatch(/Path=\/api\/v1\/auth(;|$)/);
    expect(line).toMatch(/Max-Age=604800/);
    // Development is plain http, where a browser would drop a Secure cookie.
    expect(line).not.toMatch(/Secure/);
    expect(await prisma.session.count({ where: { refreshTokenHash: hashToken(refreshCookieOf(res)!) } })).toBe(1);
  });

  it('is Secure over https, and kept over plain http even in production', async () => {
    expect(cookieSecure({ protocol: 'https' })).toBe(true);
    expect(cookieSecure({ protocol: 'http' })).toBe(false);
    // A server reached at http://its-address: a Secure cookie there is dropped, and every reload —
    // the language switch's among them — signed its people out (owner's report, 2026-10-23).
    const was = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = 'production';
    try {
      const res = await call('POST', '/auth/login', { payload: { email: 'sales@hiva.local', password: 'Hiva@Dev2026!' } });
      expect(cookieLine(res)).toMatch(/HttpOnly/);
      expect(cookieLine(res)).not.toMatch(/Secure/);
    } finally { (env as { NODE_ENV: string }).NODE_ENV = was; }
  });

  it('is set by every way in: a code to the mobile, and the ticket Google sign-in ends with', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'media@hiva.local' } });
    const ticket = await call('POST', '/auth/ticket', { payload: { ticket: await createTicket(user.id) } });
    expect(ticket.status).toBe(200);
    expect(ticket.body).not.toHaveProperty('refreshToken');
    expect(refreshCookieOf(ticket)).toBeTruthy();
  });

  it('is the only thing refresh reads: a token in the body is not looked at', async () => {
    const s = await signIn('designer@hiva.local');
    const bodyOnly = await call('POST', '/auth/refresh', { payload: { refreshToken: s.refresh }, headers: { 'x-hiva-refresh': '1' } });
    expect(bodyOnly.status).toBe(401);
    const ok = await refreshWith(s.refresh);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ accessToken: expect.any(String) });
    expect(ok.refresh).toBeTruthy();
    expect(ok.refresh).not.toBe(s.refresh);
    expect((await get('/auth/me', ok.body.accessToken)).status).toBe(200);
  });

  it('is spent only by a request that shows it is the app’s own', async () => {
    const s = await signIn('designer@hiva.local');
    const noHeader = await call('POST', '/auth/refresh', { headers: withCookie(s.refresh) });
    expect([noHeader.status, noHeader.body.error.code]).toEqual([403, 'CROSS_SITE']);
    const elsewhere = await refreshWith(s.refresh, { origin: 'https://evil.example' });
    expect(elsewhere.status).toBe(403);
    const crossSite = await refreshWith(s.refresh, { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    // None of the refusals spent it.
    expect(await prisma.session.count({ where: { refreshTokenHash: hashToken(s.refresh), revokedAt: null } })).toBe(1);
    // The app's origin (CORS_ORIGIN), and an organisation's own address, are the app.
    const app = await refreshWith(s.refresh, { origin: 'http://localhost:5173' });
    expect(app.status).toBe(200);
    const ownHost = await refreshWith(app.refresh!, { origin: 'https://hiva.agency.ir', host: 'hiva.agency.ir' });
    expect(ownHost.status).toBe(200);
  });

  it('is cleared when it can never work again, and at sign-out', async () => {
    const s = await signIn('finance@hiva.local');
    const next = await refreshWith(s.refresh);
    // The rotated-away token presented again: refused, and the browser told to forget it.
    const replay = await refreshWith(s.refresh);
    expect(replay.status).toBe(401);
    expect(cookieLine(replay)).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    void next;

    const t = await signIn('finance@hiva.local');
    const other = await signIn('finance@hiva.local');
    const noHeader = await call('POST', '/auth/logout', { token: t.access, headers: withCookie(t.refresh) });
    expect(noHeader.status).toBe(403);
    const out = await call('POST', '/auth/logout', { token: t.access, headers: withCookie(t.refresh, { 'x-hiva-refresh': '1' }) });
    expect(out.status).toBe(204);
    expect(cookieLine(out)).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    // This device only: the other stays signed in.
    expect((await refreshWith(t.refresh)).status).toBe(401);
    expect((await refreshWith(other.refresh)).status).toBe(200);
  });

  it('trades a token kept in localStorage before the cookie for one — once', async () => {
    const legacy = (await signIn('pmo@hiva.local')).refresh; // what an older build of the app stored
    const noHeader = await call('POST', '/auth/refresh/legacy', { payload: { refreshToken: legacy } });
    expect(noHeader.status).toBe(403);
    const traded = await call('POST', '/auth/refresh/legacy', { payload: { refreshToken: legacy }, headers: { 'x-hiva-refresh': '1' } });
    expect(traded.status).toBe(200);
    expect(traded.body).toEqual({ accessToken: expect.any(String) });
    const cookie = refreshCookieOf(traded)!;
    expect(cookie).toBeTruthy();
    expect((await refreshWith(cookie)).status).toBe(200);
    // Spent: a second trade is the replay it is.
    const again = await call('POST', '/auth/refresh/legacy', { payload: { refreshToken: legacy }, headers: { 'x-hiva-refresh': '1' } });
    expect(again.status).toBe(401);
  });
});
