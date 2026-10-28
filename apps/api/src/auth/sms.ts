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

export interface TextOutcome {
  /** SENT: the provider accepted it — not that it arrived. SANDBOX: kept here, sent nowhere. */
  status: 'SENT' | 'SANDBOX' | 'FAILED';
  provider: string;
  providerRef: string | null;
  error: string | null;
}

/**
 * A free-text message — to a venue, or a colleague's reminder (ADR-103). Never throws: what happened is
 * the answer, to be written where the message is logged. Off answers FAILED; the sandbox keeps it and
 * says so; a provider's acceptance is SENT, and whether it arrived is the provider's to report later
 * (`textStatus`).
 */
export async function sendText(phone: string, text: string): Promise<TextOutcome> {
  const out = (status: TextOutcome['status'], providerRef: string | null = null, error: string | null = null): TextOutcome =>
    ({ status, provider: smsMode, providerRef, error: error?.slice(0, 500) ?? null });
  if (smsMode === 'off') return out('FAILED', null, 'ارسال پیامک در این نصب خاموش است.');
  if (smsMode === 'sandbox') return out('SANDBOX');
  try {
    if (smsMode === 'kavenegar') {
      const url = new URL(`https://api.kavenegar.com/v1/${encodeURIComponent(env.SMS_API_KEY)}/sms/send.json`);
      url.searchParams.set('receptor', phone);
      url.searchParams.set('message', text);
      if (env.SMS_SENDER) url.searchParams.set('sender', env.SMS_SENDER);
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = await res.json().catch(() => null) as { return?: { status?: number; message?: string }; entries?: { messageid?: number }[] } | null;
      if (!res.ok || body?.return?.status !== 200) return out('FAILED', null, body?.return?.message ?? `HTTP ${res.status}`);
      return out('SENT', body.entries?.[0]?.messageid != null ? String(body.entries[0].messageid) : null);
    }
    const res = await fetch(env.SMS_URL, {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', ...(env.SMS_API_KEY ? { authorization: `Bearer ${env.SMS_API_KEY}` } : {}) },
      body: JSON.stringify({ to: phone, text, ...(env.SMS_SENDER ? { from: env.SMS_SENDER } : {}) }),
    });
    if (!res.ok) return out('FAILED', null, `HTTP ${res.status}`);
    const body = await res.json().catch(() => null) as { id?: string | number } | null;
    return out('SENT', body?.id != null ? String(body.id) : null);
  } catch (e) {
    return out('FAILED', null, (e as Error).message);
  }
}

/**
 * What the provider says became of a message it accepted: DELIVERED or UNDELIVERED when it knows,
 * null while it is still on its way or the provider does not say (the http adapter).
 */
export async function textStatus(providerRef: string): Promise<'DELIVERED' | 'UNDELIVERED' | null> {
  if (smsMode !== 'kavenegar') return null;
  try {
    const url = new URL(`https://api.kavenegar.com/v1/${encodeURIComponent(env.SMS_API_KEY)}/sms/status.json`);
    url.searchParams.set('messageid', providerRef);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null) as { entries?: { status?: number }[] } | null;
    // Kavenegar: 10 delivered to the handset; 11 and 14 undelivered; 6 failed at the operator.
    const status = body?.entries?.[0]?.status;
    return status === 10 ? 'DELIVERED' : status === 11 || status === 14 || status === 6 ? 'UNDELIVERED' : null;
  } catch {
    return null;
  }
}
