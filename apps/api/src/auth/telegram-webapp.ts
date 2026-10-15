import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The Telegram Mini App's launch data (audit F-9). Telegram signs it with a key derived from the bot
 * token: HMAC-SHA256 over the fields sorted by name, one `key=value` per line, `hash` left out, with
 * HMAC-SHA256("WebAppData", token) as the key. Only the server holds the token, so only Telegram
 * could have made a payload that checks.
 *
 * The signature has no nonce, so Telegram's own advice — trust it for a day — would let a captured
 * payload sign in for a day. An hour is enough to open the app; the route also takes each payload
 * once (finding 4 of docs/telegram-integration.md).
 */

export const INIT_DATA_TTL_S = 3600;
/** A phone's clock a little ahead of ours is not a forgery. */
const SKEW_S = 60;

export type InitDataCheck =
  | { ok: true; telegramId: string; username: string | null; authDate: number; hash: string }
  | { ok: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'STALE' };

export function verifyInitData(initData: string, botToken: string, nowS = Math.floor(Date.now() / 1000)): InitDataCheck {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash) || params.getAll('hash').length !== 1) return { ok: false, reason: 'MALFORMED' };
  params.delete('hash');
  const fields = [...params.entries()];
  if (new Set(fields.map(([k]) => k)).size !== fields.length) return { ok: false, reason: 'MALFORMED' };
  const checkString = fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return { ok: false, reason: 'BAD_SIGNATURE' };

  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return { ok: false, reason: 'MALFORMED' };
  if (nowS - authDate > INIT_DATA_TTL_S || authDate - nowS > SKEW_S) return { ok: false, reason: 'STALE' };
  let user: { id?: unknown; username?: unknown };
  try { user = JSON.parse(params.get('user') ?? ''); } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (typeof user?.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) return { ok: false, reason: 'MALFORMED' };
  return { ok: true, telegramId: String(user.id), username: typeof user.username === 'string' ? user.username : null, authDate, hash };
}

/** What is kept to refuse a payload's second use: never the payload itself. */
export const initDataSeal = (hash: string) => createHash('sha256').update(`telegram-webapp:${hash}`).digest('hex');
