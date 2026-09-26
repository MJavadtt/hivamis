/**
 * Where e-invoices go (roadmap #32). An adapter: the live half needs the taxpayer's registered
 * private key and certificate, which no repository can hold.
 *
 *   MOADIAN_MODE=off      nothing is sent; submissions are prepared, validated and queued
 *   MOADIAN_MODE=sandbox  an in-process stand-in that accepts what passes validation — for
 *                         training and for walking the lifecycle; it is NOT the tax authority
 *   MOADIAN_MODE=live     the direct API, following the public SDKs (Jooyeshgar/moadian):
 *                         nonce → token (a JWS of {nonce, clientId}) → `server-information` for
 *                         the authority's key → `invoice` with each invoice signed (JWS) and
 *                         encrypted (JWE) → `inquiry-by-reference-id`
 *
 * The live transport has been written to the published SDK, not exercised against the authority;
 * the first submissions in a new installation should go to the authority's own test environment
 * (MOADIAN_URL) before production.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { env } from '../env.js';
import { jweEncrypt, jwsSign } from './jose.js';

export interface SubmitResult { taxId: string; referenceNumber: string | null; error: string | null }
export interface InquiryResult { referenceNumber: string; status: 'ACCEPTED' | 'REJECTED' | 'PENDING'; errors: unknown[] }
export interface TaxGateway {
  channel: 'sandbox' | 'live';
  submit(clientId: string, items: { taxId: string; payload: object }[]): Promise<SubmitResult[]>;
  inquire(clientId: string, referenceNumbers: string[]): Promise<InquiryResult[]>;
}

/** Accepts what reached it — everything that reaches it has passed validateForTax. */
export const sandboxGateway: TaxGateway = {
  channel: 'sandbox',
  async submit(_clientId, items) { return items.map((i) => ({ taxId: i.taxId, referenceNumber: `SBX-${i.taxId}`, error: null })); },
  async inquire(_clientId, refs) { return refs.map((r) => ({ referenceNumber: r, status: 'ACCEPTED' as const, errors: [] })); },
};

const asPem = (key: string) => (key.includes('-----BEGIN') ? key : `-----BEGIN PUBLIC KEY-----\n${key.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`);
const certBase64 = (pem: string) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

export function directGateway(opts: { baseUrl: string; privateKeyPem: string; certificatePem?: string; fetchImpl?: typeof fetch }): TaxGateway {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
  const cert = opts.certificatePem ? certBase64(opts.certificatePem) : undefined;
  const call = async (method: 'GET' | 'POST', path: string, token?: string, body?: unknown) => {
    const res = await f(new URL(path, base), {
      method, signal: AbortSignal.timeout(20_000),
      headers: { accept: '*/*', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 300)}`);
    return json;
  };
  const token = async (clientId: string) => {
    const r = await call('GET', 'nonce?timeToLive=30');
    const nonce = r?.nonce ?? r?.result?.nonce;
    if (!nonce) throw new Error('no nonce in response');
    return jwsSign({ nonce, clientId }, opts.privateKeyPem, cert);
  };
  const serverKey = async (tok: string) => {
    const r = await call('GET', 'server-information', tok);
    const keys = r?.publicKeys ?? r?.result?.publicKeys ?? [];
    const k = keys[0];
    if (!k?.key || !k?.id) throw new Error('no public key in server-information');
    return { pem: asPem(String(k.key)), kid: String(k.id) };
  };
  return {
    channel: 'live',
    async submit(clientId, items) {
      const tok = await token(clientId);
      const key = await serverKey(tok);
      const body = items.map((i) => ({
        payload: jweEncrypt(jwsSign(i.payload, opts.privateKeyPem, cert), key.pem, key.kid),
        header: { requestTraceId: randomUUID(), fiscalId: clientId },
      }));
      const r = await call('POST', 'invoice', tok, body);
      const results: any[] = r?.result ?? r ?? [];
      return items.map((i, n) => {
        const x = results[n] ?? {};
        const ref = x.referenceNumber ?? x.referenceId ?? null;
        return { taxId: i.taxId, referenceNumber: ref, error: ref ? null : JSON.stringify(x.errorDetail ?? x.error ?? x).slice(0, 500) };
      });
    },
    async inquire(clientId, refs) {
      const tok = await token(clientId);
      const r = await call('GET', `inquiry-by-reference-id?${refs.map((x) => `referenceIds=${encodeURIComponent(x)}`).join('&')}`, tok);
      const rows: any[] = Array.isArray(r) ? r : r?.result ?? [];
      return refs.map((ref) => {
        const x = rows.find((y) => (y.referenceNumber ?? y.referenceId) === ref) ?? {};
        const s = String(x.status ?? '').toUpperCase();
        return {
          referenceNumber: ref,
          status: s === 'SUCCESS' ? 'ACCEPTED' : s === 'FAILED' ? 'REJECTED' : 'PENDING',
          errors: x.data?.error ?? x.errors ?? [],
        } as InquiryResult;
      });
    },
  };
}

/** The gateway this installation is configured for, or null when sending is off. */
export function configuredGateway(): TaxGateway | null {
  if (env.MOADIAN_MODE === 'sandbox') return sandboxGateway;
  if (env.MOADIAN_MODE === 'live' && env.MOADIAN_PRIVATE_KEY_PATH) {
    return directGateway({
      baseUrl: env.MOADIAN_URL,
      privateKeyPem: readFileSync(env.MOADIAN_PRIVATE_KEY_PATH, 'utf8'),
      certificatePem: env.MOADIAN_CERTIFICATE_PATH ? readFileSync(env.MOADIAN_CERTIFICATE_PATH, 'utf8') : undefined,
    });
  }
  return null;
}
