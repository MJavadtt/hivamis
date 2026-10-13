/**
 * Signing a headless browser in and out, for the scripts that look at the running app (the
 * visibility, contrast and screen sweeps). Development only: they use the seed's published test
 * password, and only on localhost.
 *
 * The session is the app's own since audit SEC-4: the refresh token is an HttpOnly cookie, set by
 * the sign-in answer, and the page restores from it. A request made through the context shares its
 * cookies, so signing in that way is signing the page in.
 */
import type { BrowserContext } from 'playwright-core';

export const TEST_PASSWORD = process.env.AUDIT_PASSWORD ?? 'Hiva@Dev2026!';
/** Says which sessions are a script's, so they can be told apart (and signed out) later. */
export const SCRIPT_AGENT = 'Mozilla/5.0 Claude/verification-headless';
const FROM_THE_APP = { 'x-hiva-refresh': '1' };

export function assertLocal(...urls: string[]): void {
  for (const u of urls) {
    if (!['localhost', '127.0.0.1'].includes(new URL(u).hostname)) throw new Error(`refusing to run against ${u}: development only`);
  }
}

/**
 * Signs the context in as `email`; the next page it opens restores the session. `base` is wherever
 * /api/v1 answers — the web server's proxy, or the API itself.
 */
export async function signIn(context: BrowserContext, base: string, email: string, password = TEST_PASSWORD): Promise<{ ok: true } | { ok: false; status: number }> {
  const r = await context.request.post(`${base}/api/v1/auth/login`, { data: { email, password }, headers: { ...FROM_THE_APP, origin: base } });
  if (!r.ok()) return { ok: false, status: r.status() };
  // The hint the app reads before it asks the server to restore a session (lib/api.ts).
  await context.addInitScript(() => { try { localStorage.setItem('hiva.signedIn', '1'); } catch { /* none */ } });
  return { ok: true };
}

/** Ends the session the context holds, rather than leaving it to expire. */
export async function signOut(context: BrowserContext, base: string): Promise<void> {
  const headers = { ...FROM_THE_APP, origin: base };
  const fresh = await context.request.post(`${base}/api/v1/auth/refresh`, { headers }).catch(() => null);
  if (!fresh?.ok()) return;
  const { accessToken } = await fresh.json() as { accessToken: string };
  await context.request.post(`${base}/api/v1/auth/logout`, { headers: { ...headers, authorization: `Bearer ${accessToken}` } }).catch(() => undefined);
}
