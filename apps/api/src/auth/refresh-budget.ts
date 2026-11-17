import { env } from '../env.js';
import { AppError } from '../lib/errors.js';

/**
 * How often one session may be renewed (found by the visual pass, audit UI-V). The limit used to be
 * the address's, ten a minute: an office behind one NAT address shares one, so at nine in the
 * morning the eleventh person to open the app was told the server was unreachable. A session is one
 * person on one device. Ten a minute was still too few (2026-11-16): each page opened or reloaded
 * spends one, and someone reloading a page that would not open was locked out for a minute; the
 * address keeps the general limit (RATE_LIMIT_MAX), which bounds anyone presenting made-up cookies.
 *
 * Counted by the session's family, which every rotation keeps: a new token does not mean a new
 * budget. In memory, per process — as the address limit was.
 */
const WINDOW_MS = 60_000;
const spent = new Map<string, number[]>();

export function assertRenewalBudget(familyId: string, now = Date.now()): void {
  const recent = (spent.get(familyId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= env.REFRESH_RATE_LIMIT_MAX) {
    spent.set(familyId, recent);
    throw new AppError(429, 'RATE_LIMITED', 'تعداد درخواست‌ها بیش از حد مجاز است.');
  }
  recent.push(now);
  spent.set(familyId, recent);
  // Families seen once and gone (a signed-out device) are dropped as the map grows.
  if (spent.size > 5000) for (const [k, v] of spent) if (!v.some((t) => now - t < WINDOW_MS)) spent.delete(k);
}
