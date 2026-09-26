/**
 * Where a contract goes to be signed (roadmap #36). An adapter: a signature with legal weight is
 * made with a certificate from a licensed certification authority, on the provider's side, and no
 * repository holds those.
 *
 *   ESIGN_MODE=off      sending for e-signature is refused; a signature is recorded by hand
 *   ESIGN_MODE=sandbox  an in-process stand-in: its signing page is ours, its "certificate" says
 *                       SANDBOX, and the signed PDF carries a page saying it is not a signature
 *   ESIGN_MODE=http     a provider behind the REST contract below — in practice a thin bridge in
 *                       front of the organisation's chosen provider
 *
 * The REST contract (Authorization: Bearer ESIGN_API_KEY):
 *   POST {ESIGN_URL}/envelopes                 {externalId, title, document:{fileName, contentBase64, sha256},
 *                                               signers:[{externalId, name, email, order}], callbackUrl, expiresAt}
 *                                               → {id, signers:[{externalId, url}]}
 *   GET  {ESIGN_URL}/envelopes/{id}            → {status: SENT|COMPLETED|DECLINED|EXPIRED,
 *                                               signers:[{externalId, status, signedAt?, declineReason?, ip?, certificate?}]}
 *   GET  {ESIGN_URL}/envelopes/{id}/document   → the signed PDF
 *   POST {ESIGN_URL}/envelopes/{id}/void       {reason}
 *   and a callback to callbackUrl, body {id}, header X-Hiva-Signature: sha256=<HMAC-SHA256(body, ESIGN_WEBHOOK_SECRET)>.
 *   The callback only says "look again": the status is always read back from the provider.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

export type ProviderStatus = 'SENT' | 'COMPLETED' | 'DECLINED' | 'EXPIRED';
export interface Certificate { subject: string; serial: string; issuer: string; notAfter?: string; sandbox?: boolean }
export interface SignerState { externalId: string; status: 'PENDING' | 'SIGNED' | 'DECLINED'; signedAt?: string | null; declineReason?: string | null; ip?: string | null; certificate?: Certificate | null }
export interface CreateRequest {
  externalId: string; title: string;
  document: { fileName: string; content: Buffer; sha256: string };
  signers: { externalId: string; name: string; email: string; order: number }[];
  callbackUrl: string; expiresAt: Date;
}
export interface ESignProvider {
  name: 'sandbox' | 'http';
  create(req: CreateRequest): Promise<{ id: string; signers: { externalId: string; url: string }[] }>;
  status(id: string): Promise<{ status: ProviderStatus; signers: SignerState[] }>;
  signedDocument(id: string): Promise<Buffer>;
  void(id: string, reason: string): Promise<void>;
}

export const esignMode = (): 'off' | 'sandbox' | 'http' => env.ESIGN_MODE ?? (env.NODE_ENV === 'production' ? 'off' : 'sandbox');

export function httpProvider(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): ESignProvider {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await f(`${base}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${opts.apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
    return res;
  };
  return {
    name: 'http',
    async create(req) {
      const r = await (await call('POST', '/envelopes', {
        externalId: req.externalId, title: req.title,
        document: { fileName: req.document.fileName, contentBase64: req.document.content.toString('base64'), sha256: req.document.sha256 },
        signers: req.signers, callbackUrl: req.callbackUrl, expiresAt: req.expiresAt.toISOString(),
      })).json() as { id?: string; signers?: { externalId: string; url: string }[] };
      if (!r.id) throw new Error('provider returned no envelope id');
      return { id: r.id, signers: r.signers ?? [] };
    },
    async status(id) {
      const r = await (await call('GET', `/envelopes/${encodeURIComponent(id)}`)).json() as { status?: string; signers?: SignerState[] };
      const status = (['SENT', 'COMPLETED', 'DECLINED', 'EXPIRED'] as const).find((s) => s === r.status) ?? 'SENT';
      return { status, signers: r.signers ?? [] };
    },
    async signedDocument(id) {
      return Buffer.from(await (await call('GET', `/envelopes/${encodeURIComponent(id)}/document`)).arrayBuffer());
    },
    async void(id, reason) { await call('POST', `/envelopes/${encodeURIComponent(id)}/void`, { reason }); },
  };
}

/** The provider's callback is taken only with a valid signature over the exact bytes it sent. */
export function callbackSignatureValid(raw: Buffer, header: string | undefined, secret = env.ESIGN_WEBHOOK_SECRET): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const given = Buffer.from(header.slice(7));
  return expected.length === given.length && timingSafeEqual(expected, given);
}
