import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { AppError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * Audit SEC-10: wrong passwords and codes slow down the network that sends them, not the account.
 *
 * Five wrong tries used to lock an account for fifteen minutes, from anywhere: anyone who knew an
 * address could keep its owner out, a minute's work every quarter of an hour. Now each failure is
 * kept against the pair (what was typed, the client's /24 or /64). The first three cost nothing;
 * after that each try waits twice as long as the last; at ten the pair is blocked for fifteen
 * minutes. Another network — the owner at their desk — is untouched. The account itself is never
 * locked: fifty failures in an hour, from wherever, raise a security alert instead (security/anomalies).
 *
 * The pair is keyed on the identifier as typed, not on the account, so an address with no account
 * slows down exactly as one with an account does: the delay says nothing about who exists.
 */

export const WINDOW_MS = 15 * 60_000;
export const FREE_TRIES = 3;
export const BLOCK_AT = 10;
export const BLOCK_MS = 15 * 60_000;

/** The client's network: an IPv4 /24, an IPv6 /64. A single address is too cheap to change. */
export function networkOf(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.\d+$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (isIP(ip) === 6) {
    const [head = '', tail = ''] = ip.toLowerCase().split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
  }
  return ip || 'unknown';
}

/** How long this pair must wait before its next try is even looked at; 0 when it need not. */
export async function waitSeconds(identifier: string, ip: string): Promise<number> {
  const recent = await prisma.signInFailure.findMany({
    where: { identifier, network: networkOf(ip), createdAt: { gte: new Date(Date.now() - WINDOW_MS) } },
    orderBy: { createdAt: 'desc' }, take: BLOCK_AT, select: { createdAt: true },
  });
  const n = recent.length;
  if (n <= FREE_TRIES) return 0;
  const last = recent[0]!.createdAt.getTime();
  const pause = n >= BLOCK_AT ? BLOCK_MS : 2 ** (n - FREE_TRIES - 1) * 1000;
  return Math.max(0, Math.ceil((last + pause - Date.now()) / 1000));
}

export const tooSoon = (seconds: number) =>
  new AppError(429, 'TOO_MANY_TRIES', `تلاش‌های نادرست زیاد بود؛ ${seconds} ثانیهٔ دیگر دوباره امتحان کنید.`, { retryAfterSeconds: seconds });

/** Refuses a pair still waiting out its last failure, before any password or code is checked. */
export async function assertMayTry(identifier: string, ip: string): Promise<void> {
  const seconds = await waitSeconds(identifier, ip);
  if (seconds > 0) throw tooSoon(seconds);
}

export async function recordFailure(identifier: string, ip: string): Promise<void> {
  await prisma.signInFailure.create({ data: { identifier, network: networkOf(ip) } });
}

/** A success clears the pair: its owner, having got in, is not made to wait next time. */
export async function clearFailures(identifier: string, ip: string): Promise<void> {
  await prisma.signInFailure.deleteMany({ where: { identifier, network: networkOf(ip) } });
}

/** What is older than any window that reads it. Run with the security scan. */
export const pruneFailures = () => prisma.signInFailure.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 3_600_000) } } });

let dummy: Promise<string> | null = null;
/**
 * The cost of checking a password, paid when there is none to check — no such address, an inactive
 * account, one that signs in only by mobile — so the answer takes as long either way.
 */
export async function spendPasswordTime(plain: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(18).toString('base64'));
  await verifyPassword(await dummy, plain);
}
