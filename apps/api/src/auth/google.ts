import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { appUrl } from '../mail/notify.js';

/**
 * Google sign-in (Hivamis task 4) — OpenID Connect's authorization-code flow with PKCE and a nonce.
 *
 * The browser is sent to Google with a random state; Google sends it back with a code; the server
 * trades the code for an ID token, signed by Google, and checks its signature, issuer, audience,
 * expiry and nonce before believing a word of it. The state, verifier and nonce live in the database
 * for ten minutes and are spent on first use. What identifies the person is Google's `sub`, which
 * never changes; the email is accepted only when Google says it is verified.
 *
 * Audit SEC-5: the flow is bound to the browser that began it — a nonce in its cookie, the nonce's hash
 * with the state — so nobody can send another person to the end of their own sign-in and have them
 * land in the wrong account.
 *
 * The endpoints are settings, not constants, so a test can stand in for Google with its own keys.
 */

export const google = {
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  authUrl: env.GOOGLE_AUTH_URL,
  tokenUrl: env.GOOGLE_TOKEN_URL,
  jwksUrl: env.GOOGLE_JWKS_URL,
  issuer: env.GOOGLE_ISSUER,
  allowedDomains: env.GOOGLE_ALLOWED_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
};

export const googleConfigured = () => google.clientId.length > 0 && google.clientSecret.length > 0;
export const googleRedirectUri = () => appUrl('/api/v1/auth/google/callback');

let keys: { url: string; set: JWTVerifyGetKey } | null = null;
const jwks = () => {
  if (!keys || keys.url !== google.jwksUrl) keys = { url: google.jwksUrl, set: createRemoteJWKSet(new URL(google.jwksUrl)) };
  return keys.set;
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const b64url = (b: Buffer) => b.toString('base64url');

export type GoogleMode = 'LOGIN' | 'SIGNUP' | 'LINK';

/** The address to send the browser to, and the nonce its cookie must hold when it comes back. */
export async function startGoogle(mode: GoogleMode, userId: string | null = null, organizationId: string | null = null): Promise<{ url: string; binding: string }> {
  if (!googleConfigured()) throw new AppError(503, 'GOOGLE_OFF', 'ورود با حساب گوگل در این نصب پیکربندی نشده است.');
  const state = b64url(randomBytes(32));
  const codeVerifier = b64url(randomBytes(48));
  const nonce = b64url(randomBytes(24));
  const binding = b64url(randomBytes(32));
  await prisma.oAuthState.create({
    data: { stateHash: sha(state), bindingHash: sha(binding), provider: 'google', mode, codeVerifier, nonce, userId, organizationId, expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
  const url = new URL(google.authUrl);
  url.search = new URLSearchParams({
    client_id: google.clientId, redirect_uri: googleRedirectUri(), response_type: 'code', scope: 'openid email profile',
    state, nonce, code_challenge: b64url(createHash('sha256').update(codeVerifier).digest()), code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.toString(), binding };
}

export interface GoogleProfile { sub: string; email: string; name: string; domain: string }

/** Spends the state and returns who Google says this is, or throws a code the page can explain. */
export async function finishGoogle(code: string, state: string, binding: string | undefined): Promise<{ mode: GoogleMode; userId: string | null; organizationId: string | null; profile: GoogleProfile }> {
  const row = await prisma.oAuthState.findUnique({ where: { stateHash: sha(state) } });
  if (!row || row.consumedAt || row.expiresAt < new Date()) throw new AppError(400, 'GOOGLE_STATE', 'این درخواست ورود منقضی شده یا پیش‌تر به کار رفته است؛ دوباره تلاش کنید.');
  // Another browser's flow — someone else's link, followed here — is refused before anything is spent.
  if (!binding || !row.bindingHash || !safeEqual(sha(binding), row.bindingHash)) {
    throw new AppError(400, 'GOOGLE_BROWSER', 'این ورود در مرورگر دیگری آغاز شده است؛ از همین مرورگر دوباره با گوگل وارد شوید.');
  }
  const spent = await prisma.oAuthState.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (spent.count !== 1) throw new AppError(400, 'GOOGLE_STATE', 'این درخواست ورود منقضی شده یا پیش‌تر به کار رفته است؛ دوباره تلاش کنید.');

  let idToken: string;
  try {
    const res = await fetch(google.tokenUrl, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: google.clientId, client_secret: google.clientSecret, redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code', code_verifier: row.codeVerifier,
      }),
    });
    const body = await res.json() as { id_token?: string };
    if (!res.ok || !body.id_token) throw new Error(`token endpoint ${res.status}`);
    idToken = body.id_token;
  } catch {
    throw new AppError(502, 'GOOGLE_UNREACHABLE', 'پاسخی از گوگل نرسید؛ کمی بعد دوباره تلاش کنید.');
  }

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, jwks(), {
      issuer: [google.issuer, google.issuer.replace(/^https:\/\//, '')], audience: google.clientId,
    }));
  } catch {
    throw new AppError(401, 'GOOGLE_TOKEN', 'پاسخ گوگل تأیید نشد.');
  }
  if (payload.nonce !== row.nonce) throw new AppError(401, 'GOOGLE_TOKEN', 'پاسخ گوگل تأیید نشد.');
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  if (!email || payload.email_verified !== true) throw new AppError(401, 'GOOGLE_EMAIL', 'ایمیل این حساب گوگل تأییدشده نیست.');
  return {
    mode: row.mode as GoogleMode,
    userId: row.userId,
    organizationId: row.organizationId,
    profile: { sub: String(payload.sub), email, name: typeof payload.name === 'string' ? payload.name : email, domain: email.split('@')[1] ?? '' },
  };
}

/** A single-use, minute-long ticket the app trades for its session — no token travels in a URL. */
export async function createTicket(userId: string): Promise<string> {
  const ticket = b64url(randomBytes(32));
  await prisma.loginTicket.create({ data: { tokenHash: sha(ticket), userId, method: 'google', expiresAt: new Date(Date.now() + 60_000) } });
  return ticket;
}

export async function redeemTicket(ticket: string): Promise<string | null> {
  const row = await prisma.loginTicket.findUnique({ where: { tokenHash: sha(ticket) } });
  if (!row || row.consumedAt || row.expiresAt < new Date()) return null;
  const spent = await prisma.loginTicket.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
  return spent.count === 1 ? row.userId : null;
}

/* ── Linking by a verified address, after proof (audit SEC-5) ─────────────── */

export const OFFER_MAX_ATTEMPTS = 5;

/**
 * A Google account whose verified address is a person's work address. Linking it there and then let
 * anyone who controlled that address at Google — a recycled mailbox, a domain that changed hands —
 * walk into the account. The offer waits for the person to prove the account is theirs once.
 */
export async function offerLink(userId: string, profile: GoogleProfile): Promise<string> {
  const token = b64url(randomBytes(32));
  await prisma.identityLinkOffer.create({
    data: { tokenHash: sha(token), userId, provider: 'google', subject: profile.sub, email: profile.email, expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
  return token;
}

/** The live offer this token names, or null — expired, spent or out of tries. */
export async function liveOffer(token: string) {
  if (typeof token !== 'string' || !token || token.length > 100) return null;
  const row = await prisma.identityLinkOffer.findUnique({ where: { tokenHash: sha(token) }, include: { user: true } });
  if (!row || row.consumedAt || row.expiresAt < new Date() || row.attempts >= OFFER_MAX_ATTEMPTS) return null;
  return row;
}

