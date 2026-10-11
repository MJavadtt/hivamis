import { prisma } from '../db.js';
import { env, smsMode } from '../env.js';
import { AppError } from '../lib/errors.js';

/**
 * SMS for one-time codes (Hivamis task 4).
 *
 * `sandbox` keeps each message in the database, code and all — a stand-in for a provider while one is
 * not configured, on a developer's machine only: the API refuses it in production and with several
 * organisations (audit SEC-6), and the outbox shows a code only when it opens no account or is the
 * reader's own.
 * `kavenegar` sends through Kavenegar's verify/lookup with the template in SMS_TEMPLATE; `http` POSTs
 * { to, text } to SMS_URL for any other provider behind a small adapter. Outside the sandbox the code
 * is never stored: the outbox keeps the text with the code masked, to show what went where and why
 * it failed.
 */

export type CodePurpose = 'LOGIN' | 'SIGNUP' | 'VERIFY_PHONE';

const PURPOSE_FA: Record<CodePurpose, string> = {
  LOGIN: 'کد ورود شما به هیوامیس: {code}',
  SIGNUP: 'کد درخواست عضویت شما در هیوامیس: {code}',
  VERIFY_PHONE: 'کد تأیید شمارهٔ همراه شما در هیوامیس: {code}',
};

export const smsAvailable = () => smsMode !== 'off';

/** A code's digits hidden — what the outbox shows of a code that is not the reader's to see. */
export const maskCode = (text: string) => text.replace(/[0-9۰-۹]{4,8}/g, '••••••');

/**
 * Sends a one-time code. Throws SMS_FAILED when the provider refuses or cannot be reached. `userId` is
 * whose account the code opens — none for asking to join.
 */
export async function sendCode(phone: string, code: string, purpose: CodePurpose, userId: string | null = null): Promise<void> {
  const text = PURPOSE_FA[purpose].replace('{code}', code);
  const masked = PURPOSE_FA[purpose].replace('{code}', '••••••');
  const record = (body: string, status: 'SENT' | 'FAILED' | 'SANDBOX', error?: string) =>
    prisma.smsMessage.create({ data: { phone, text: body, provider: smsMode, status, error: error?.slice(0, 500) ?? null, purpose, userId } }).catch(() => undefined);
  if (smsMode === 'off') throw new AppError(503, 'SMS_OFF', 'ارسال پیامک در این نصب خاموش است.');
  if (smsMode === 'sandbox') { await record(text, 'SANDBOX'); return; }

  try {
    let res: Response;
    if (smsMode === 'kavenegar') {
      const url = new URL(`https://api.kavenegar.com/v1/${encodeURIComponent(env.SMS_API_KEY)}/verify/lookup.json`);
      url.searchParams.set('receptor', phone);
      url.searchParams.set('token', code);
      url.searchParams.set('template', env.SMS_TEMPLATE);
      res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    } else {
      res = await fetch(env.SMS_URL, {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/json', ...(env.SMS_API_KEY ? { authorization: `Bearer ${env.SMS_API_KEY}` } : {}) },
        body: JSON.stringify({ to: phone, text }),
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await record(masked, 'SENT');
  } catch (e) {
    await record(masked, 'FAILED', (e as Error).message);
    throw new AppError(502, 'SMS_FAILED', 'ارسال پیامک ممکن نشد؛ کمی بعد دوباره تلاش کنید.');
  }
}
