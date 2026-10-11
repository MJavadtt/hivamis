import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { requestHost } from '../lib/tenant.js';
import { ttlToMs } from './tokens.js';

/**
 * Audit SEC-4: the refresh token lives in a cookie the page's script cannot read.
 *
 * It sat in localStorage, where any script on the page could read a credential good for seven days.
 * Now it is `HttpOnly`, `SameSite=Strict`, sent only to `/api/v1/auth`, and `Secure` in production
 * (a browser drops a Secure cookie over plain http, which development is). Response bodies no longer
 * carry it. The access token stays in memory, as before.
 */

export const REFRESH_COOKIE = 'hiva_refresh';
const PATH = '/api/v1/auth';

const options = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: PATH,
});

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, { ...options(), maxAge: Math.floor(ttlToMs(env.REFRESH_TOKEN_TTL) / 1000) });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, options());
}

export const refreshCookie = (req: FastifyRequest): string | undefined => req.cookies?.[REFRESH_COOKIE] || undefined;

const ALLOWED = new Set(
  [...env.CORS_ORIGIN.split(','), env.PUBLIC_APP_URL]
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => { try { return new URL(o).origin; } catch { return ''; } })
    .filter(Boolean),
);

/**
 * A browser sends the cookie with any request to these paths, a page elsewhere's included. What such
 * a page cannot do is add a header of its own (a cross-site fetch with one is preflighted, and CORS
 * refuses it) or claim an Origin it does not have. So a request that spends the cookie must carry
 * `X-Hiva-Refresh: 1`, and its Origin — when the browser sends one — must be the app's: an origin in
 * CORS_ORIGIN or PUBLIC_APP_URL, or the very host it came to (an organisation's own address).
 */
export function assertFromTheApp(req: FastifyRequest): void {
  const refuse = () => new AppError(403, 'CROSS_SITE', 'این درخواست از خودِ برنامه نیامده است.');
  if (req.headers['x-hiva-refresh'] !== '1') throw refuse();
  if (req.headers['sec-fetch-site'] === 'cross-site') throw refuse();
  const origin = req.headers.origin;
  if (!origin) return;
  let url: URL;
  try { url = new URL(origin); } catch { throw refuse(); }
  if (ALLOWED.has(url.origin) || url.hostname.toLowerCase() === requestHost(req)) return;
  throw refuse();
}

/**
 * Audit SEC-5: the nonce that binds a Google sign-in to the browser that began it. Lax, not Strict:
 * Google's answer arrives as a top-level navigation from another site, and Strict would keep it out.
 */
export const OAUTH_COOKIE = 'hiva_oauth';
const OAUTH_PATH = '/api/v1/auth/google';

export function setOAuthCookie(reply: FastifyReply, binding: string): void {
  reply.setCookie(OAUTH_COOKIE, binding, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: OAUTH_PATH, maxAge: 600 });
}
export function clearOAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(OAUTH_COOKIE, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: OAUTH_PATH });
}
export const oauthCookie = (req: FastifyRequest): string | undefined => req.cookies?.[OAUTH_COOKIE] || undefined;

