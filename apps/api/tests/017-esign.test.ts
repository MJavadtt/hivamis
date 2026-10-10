import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { app, call, closeApp, get, login, move, post, upload, tinyPdf, expectOk, createContact } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { nextCode } from '../src/lib/codes.js';
import { clientMail } from '../src/mail/client.js';
import { callbackSignatureValid, httpProvider } from '../src/esign/provider.js';
import { runESign } from '../src/esign/service.js';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const tokenOf = (url: string) => url.split('/esign-sandbox/')[1]!;
const sb = (token: string, suffix = '') => `/esign/sandbox/${token}${suffix}`;

/** A real one-page PDF, so the signed copy can be counted. */
async function onePager(): Promise<Buffer> {
  const d = await PDFDocument.create();
  d.addPage([595, 842]);
  return Buffer.from(await d.save());
}

describe('The HTTP provider speaks the documented contract', () => {
  it('creates, reads back, fetches the signed PDF and voids — with the key, and the document as sent', async () => {
    const seen: { url: string; method: string; auth: string | null; body: any }[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, method: init?.method ?? 'GET', auth: (init?.headers as any)?.authorization ?? null, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/envelopes') ) return Response.json({ id: 'P-9', signers: [{ externalId: 's1', url: 'https://sign.example/s1' }] });
      if (url.endsWith('/envelopes/P-9')) return Response.json({ status: 'COMPLETED', signers: [{ externalId: 's1', status: 'SIGNED', signedAt: '2026-09-28T08:00:00Z', certificate: { subject: 'CN=Maryam', serial: '01AB', issuer: 'CA' } }] });
      if (url.endsWith('/envelopes/P-9/document')) return new Response(tinyPdf('signed'));
      if (url.endsWith('/envelopes/P-9/void')) return Response.json({});
      return new Response('?', { status: 404 });
    }) as typeof fetch;
    const p = httpProvider({ baseUrl: 'https://esign.example/api/', apiKey: 'K', fetchImpl: fake });
    const created = await p.create({
      externalId: 'e1', title: 'قرارداد', document: { fileName: 'c.pdf', content: Buffer.from('%PDF-x'), sha256: 'abc' },
      signers: [{ externalId: 's1', name: 'مریم', email: 'm@x.example', order: 1 }], callbackUrl: 'https://app/api/v1/esign/callback', expiresAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(created).toEqual({ id: 'P-9', signers: [{ externalId: 's1', url: 'https://sign.example/s1' }] });
    expect(seen[0]).toMatchObject({ url: 'https://esign.example/api/envelopes', method: 'POST', auth: 'Bearer K' });
    expect(seen[0]!.body.document).toEqual({ fileName: 'c.pdf', contentBase64: Buffer.from('%PDF-x').toString('base64'), sha256: 'abc' });
    expect((await p.status('P-9')).status).toBe('COMPLETED');
    expect((await p.signedDocument('P-9')).subarray(0, 5).toString()).toBe('%PDF-');
    await p.void('P-9', 'اشتباه');
    expect(seen.at(-1)).toMatchObject({ method: 'POST', body: { reason: 'اشتباه' } });
  });

  it('takes a callback only with an HMAC over the exact bytes', () => {
    const body = Buffer.from('{"id":"P-9"}');
    const good = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(callbackSignatureValid(body, good, 's3cret')).toBe(true);
    expect(callbackSignatureValid(Buffer.from('{"id":"P-8"}'), good, 's3cret')).toBe(false);
    expect(callbackSignatureValid(body, good, '')).toBe(false);
    expect(callbackSignatureValid(body, undefined, 's3cret')).toBe(false);
  });
});

describe('A contract signed electronically', () => {
  let T: Record<string, string>;
  let companyId: string, contactId: string, legalId: string, designerId: string;
  const contracts: Record<string, string> = {};
  const files: Record<string, string> = {};
  let pdf: Buffer;
  const original = { mode: env.ESIGN_MODE, url: env.ESIGN_URL, secret: env.ESIGN_WEBHOOK_SECRET, mail: { ...clientMail } };

  beforeAll(async () => {
    env.ESIGN_MODE = 'sandbox';
    clientMail.enabled = () => false;
    T = { legal: await login('legal@hiva.local'), designer: await login('designer@hiva.local') };
    const org = await prisma.organization.findFirstOrThrow();
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
    legalId = (await prisma.user.findFirstOrThrow({ where: { email: 'legal@hiva.local' } })).id;
    designerId = (await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } })).id;
    companyId = (await prisma.company.create({ data: { organizationId: org.id, legalName: 'شرکت امضای آزمون', accountOwnerId: owner.id } })).id;
    contactId = (await createContact({ companyId, fullName: 'مریم احمدی', email: 'maryam@sign.example' })).id;
    pdf = await onePager();
    for (const [key, state] of [['main', 'PENDING_SIGNATURE'], ['declined', 'PENDING_SIGNATURE'], ['http', 'PENDING_SIGNATURE'], ['lapse', 'PENDING_SIGNATURE'], ['draft', 'DRAFTING']] as const) {
      contracts[key] = (await prisma.contract.create({
        data: { organizationId: org.id, code: await nextCode(prisma, 'contract'), companyId, title: `قرارداد ${key}`, contractValue: 1_000_000_000, startDate: new Date(), endDate: new Date(Date.now() + 90 * 86_400_000), state, createdById: owner.id },
      })).id;
      files[key] = expectOk(await upload(T.legal, { name: `${key}.pdf`, type: 'application/pdf', content: pdf }, { contractId: contracts[key]! }), `pdf ${key}`).id;
    }
  });
  afterAll(async () => {
    env.ESIGN_MODE = original.mode; env.ESIGN_URL = original.url; env.ESIGN_WEBHOOK_SECRET = original.secret;
    Object.assign(clientMail, original.mail);
    vi.unstubAllGlobals();
    await closeApp();
  });

  const body = (key: string, extra: Record<string, unknown> = {}) => ({ documentId: files[key], clientContactId: contactId, agencyUserId: legalId, ...extra });

  it('is sent only by a signatory, for a contract awaiting signature, as its own PDF, to signers who can sign', async () => {
    const o = expectOk(await get(`/contracts/${contracts.main}/signature-options`, T.legal), 'options');
    expect(o).toMatchObject({ mode: 'sandbox', eligible: true, inFlight: null });
    expect(o.signatories.map((u: any) => u.id)).toContain(legalId);
    expect(o.signatories.map((u: any) => u.id)).not.toContain(designerId);

    expect((await post(`/contracts/${contracts.main}/signatures`, T.designer, body('main'))).status).toBe(403);
    expect((await post(`/contracts/${contracts.draft}/signatures`, T.legal, body('draft'))).body.error.code).toBe('ESIGN_WRONG_STATE');
    expect((await post(`/contracts/${contracts.main}/signatures`, T.legal, body('main', { documentId: files.declined }))).body.error.code).toBe('ESIGN_DOCUMENT');
    const txt = expectOk(await upload(T.legal, { name: 'notes.txt', type: 'text/plain', content: 'متن' }, { contractId: contracts.main! }), 'txt').id;
    expect((await post(`/contracts/${contracts.main}/signatures`, T.legal, body('main', { documentId: txt }))).body.error.code).toBe('ESIGN_NOT_PDF');
    expect((await post(`/contracts/${contracts.main}/signatures`, T.legal, body('main', { agencyUserId: designerId }))).body.error.code).toBe('ESIGN_AGENCY_SIGNER');
    const stranger = (await prisma.contact.findFirstOrThrow({ where: { companyId: { not: companyId }, email: { not: null } } })).id;
    expect((await post(`/contracts/${contracts.main}/signatures`, T.legal, body('main', { clientContactId: stranger }))).body.error.code).toBe('ESIGN_CLIENT_SIGNER');
  });

  let links: any[];
  it('freezes the PDF’s hash, hands the links over once with mail off, and holds off a signature recorded by hand', async () => {
    const r = expectOk(await post(`/contracts/${contracts.main}/signatures`, T.legal, body('main')), 'send');
    expect(r.envelope).toMatchObject({ status: 'SENT', provider: 'sandbox', originalSha256: sha(pdf), code: expect.stringMatching(/^ESG-/) });
    expect(r.envelope.signers.map((s: any) => [s.order, s.party, s.email])).toEqual([[1, 'CLIENT', 'maryam@sign.example'], [2, 'AGENCY', 'legal@hiva.local']]);
    expect(r.envelope.signers[0].tokenHash).toBeUndefined();
    links = r.links;
    expect(links.map((l: any) => l.url)).toEqual([expect.stringMatching(/\/esign-sandbox\/[\w-]{43}$/), expect.stringMatching(/\/esign-sandbox\/[\w-]{43}$/)]);
    expect((await post(`/contracts/${contracts.main}/signatures`, T.legal, body('main'))).body.error.code).toBe('ESIGN_IN_FLIGHT');

    const manual = await move('contract', contracts.main!, 'sign', T.legal);
    expect(manual.status).toBe(422);
    expect(manual.body.error.message).toContain(r.envelope.code);
  });

  it('signs in order on the sandbox page — which says it is a sandbox — and signs the contract when the last one signs', async () => {
    const client = tokenOf(links[0].url), agency = tokenOf(links[1].url);
    const view = expectOk(await call('GET', sb(client)), 'view');
    expect(view).toMatchObject({ sandbox: true, signer: { party: 'CLIENT', status: 'PENDING' }, document: { sha256: sha(pdf) }, waitingFor: null });
    expect(view.issuer).toContain('بدون اعتبار حقوقی');
    const a = await app();
    expect(sha((await a.inject({ method: 'GET', url: `/api/v1${sb(client, '/document')}` })).rawPayload)).toBe(sha(pdf));
    expect((await call('POST', sb(agency, '/sign'), { payload: { signerName: 'سعید تقوی', confirm: true } })).body.error.code).toBe('ESIGN_ORDER');

    expect(expectOk(await call('POST', sb(client, '/sign'), { payload: { signerName: 'مریم احمدی', confirm: true } }), 'client signs').status).toBe('SENT');
    expect((await call('POST', sb(client, '/sign'), { payload: { signerName: 'مریم احمدی', confirm: true } })).body.error.code).toBe('ESIGN_ALREADY');
    const done = expectOk(await call('POST', sb(agency, '/sign'), { payload: { signerName: 'سعید تقوی', confirm: true } }), 'agency signs');
    expect(done).toMatchObject({ status: 'COMPLETED', applied: true, error: null });

    const c = await prisma.contract.findUniqueOrThrow({ where: { id: contracts.main } });
    expect(c.state).toBe('SIGNED');
    expect(c.signedDate).not.toBeNull();
    const moved = await prisma.stateTransition.findFirstOrThrow({ where: { entityId: contracts.main, toState: 'SIGNED' } });
    expect(moved.actorId).toBe(legalId);
    const e = await prisma.signatureEnvelope.findFirstOrThrow({ where: { contractId: contracts.main }, include: { signers: { orderBy: { order: 'asc' } }, events: { orderBy: { seq: 'asc' } }, signedDocument: true } });
    expect(e.events.map((x) => x.kind)).toEqual(['SENT', 'SIGNED', 'SIGNED', 'COMPLETED', 'APPLIED']);
    expect((e.signers[0]!.certificate as any)).toMatchObject({ sandbox: true, subject: 'مریم احمدی <maryam@sign.example>' });
    // The signed copy: the original page, then the sandbox's own page saying it is not a signature.
    const signed = await a.inject({ method: 'GET', url: `/api/v1/documents/${e.signedDocumentId}/download`, headers: { authorization: `Bearer ${T.legal}` } });
    expect(e.signedDocument!.tags).toEqual(['e-signed']);
    expect(e.signedDocument!.checksum).toBe(e.signedSha256);
    expect(sha(signed.rawPayload)).toBe(e.signedSha256);
    expect((await PDFDocument.load(signed.rawPayload)).getPageCount()).toBeGreaterThanOrEqual(2);
    expect(await prisma.notification.count({ where: { userId: legalId, kind: 'ESIGN_COMPLETED' } })).toBe(1);
    expect((await call('POST', sb(client, '/sign'), { payload: { signerName: 'مریم احمدی', confirm: true } })).body.error.code).toBe('ESIGN_CLOSED');
  }, 60_000);

  it('stops at a decline, leaves the contract where it was, and can be voided by a signatory', async () => {
    const r = expectOk(await post(`/contracts/${contracts.declined}/signatures`, T.legal, body('declined')), 'send');
    const client = tokenOf(r.links[0].url);
    expect(expectOk(await call('POST', sb(client, '/decline'), { payload: { reason: 'بند ۷ باید اصلاح شود' } }), 'decline').status).toBe('DECLINED');
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contracts.declined } })).state).toBe('PENDING_SIGNATURE');
    expect(await prisma.notification.count({ where: { userId: legalId, kind: 'ESIGN_DECLINED' } })).toBe(1);

    const again = expectOk(await post(`/contracts/${contracts.declined}/signatures`, T.legal, body('declined')), 'resend');
    expect((await post(`/esign/envelopes/${again.envelope.id}/void`, T.designer, { reason: 'اشتباه' })).status).toBe(403);
    expectOk(await post(`/esign/envelopes/${again.envelope.id}/void`, T.legal, { reason: 'نسخهٔ اشتباه فرستاده شد' }), 'void');
    expect((await call('POST', sb(tokenOf(again.links[0].url), '/sign'), { payload: { signerName: 'مریم احمدی', confirm: true } })).body.error.code).toBe('ESIGN_CLOSED');
    // Nothing in flight now: the signature may be recorded by hand, as for a paper contract.
    expectOk(await move('contract', contracts.declined!, 'sign', T.legal), 'manual');
  });

  it('lapses at its date', async () => {
    const r = expectOk(await post(`/contracts/${contracts.lapse}/signatures`, T.legal, body('lapse')), 'send');
    await prisma.signatureEnvelope.update({ where: { id: r.envelope.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await runESign();
    expect((await prisma.signatureEnvelope.findUniqueOrThrow({ where: { id: r.envelope.id } })).status).toBe('EXPIRED');
  });

  it('through a provider over HTTP: signed callbacks only, the status read back, the certificate kept', async () => {
    env.ESIGN_MODE = 'http'; env.ESIGN_URL = 'https://esign.example'; env.ESIGN_WEBHOOK_SECRET = 's3cret';
    let state: 'SENT' | 'COMPLETED' = 'SENT';
    let signerIds: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/envelopes') && init?.method === 'POST') {
        const b = JSON.parse(String(init.body));
        signerIds = b.signers.map((s: any) => s.externalId);
        expect(b.document.sha256).toBe(sha(pdf));
        return Response.json({ id: 'PRV-1', signers: signerIds.map((id) => ({ externalId: id, url: `https://sign.example/${id}` })) });
      }
      if (url.endsWith('/envelopes/PRV-1')) {
        return Response.json({ status: state, signers: signerIds.map((id, i) => state === 'COMPLETED'
          ? { externalId: id, status: 'SIGNED', signedAt: `2026-09-28T0${8 + i}:00:00Z`, ip: '5.160.1.2', certificate: { subject: `CN=Signer ${i + 1}`, serial: `0${i}AB`, issuer: 'Test CA', notAfter: '2028-01-01' } }
          : { externalId: id, status: 'PENDING' }) });
      }
      if (url.endsWith('/envelopes/PRV-1/document')) return new Response(await onePager());
      return new Response('?', { status: 404 });
    }));
    const r = expectOk(await post(`/contracts/${contracts.http}/signatures`, T.legal, body('http')), 'send');
    expect(r.envelope).toMatchObject({ provider: 'http', providerRef: 'PRV-1' });
    expect(r.links.map((l: any) => l.url)).toEqual(signerIds.map((id) => `https://sign.example/${id}`));

    const a = await app();
    const raw = JSON.stringify({ id: 'PRV-1' });
    const hmac = (s: string) => `sha256=${createHmac('sha256', 's3cret').update(s).digest('hex')}`;
    const forged = await a.inject({ method: 'POST', url: '/api/v1/esign/callback', headers: { 'content-type': 'application/json', 'x-hiva-signature': hmac('{"id":"other"}') }, payload: raw });
    expect(forged.statusCode).toBe(401);
    state = 'COMPLETED';
    const ok = await a.inject({ method: 'POST', url: '/api/v1/esign/callback', headers: { 'content-type': 'application/json', 'x-hiva-signature': hmac(raw) }, payload: raw });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ status: 'COMPLETED', applied: true });
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contracts.http } })).state).toBe('SIGNED');
    const signers = await prisma.signatureSigner.findMany({ where: { envelopeId: r.envelope.id }, orderBy: { order: 'asc' } });
    expect(signers.map((s) => [s.status, (s.certificate as any).issuer, s.ip])).toEqual([['SIGNED', 'Test CA', '5.160.1.2'], ['SIGNED', 'Test CA', '5.160.1.2']]);
    // A second callback finds nothing left to do — completed once.
    const twice = await a.inject({ method: 'POST', url: '/api/v1/esign/callback', headers: { 'content-type': 'application/json', 'x-hiva-signature': hmac(raw) }, payload: raw });
    expect(JSON.parse(twice.body)).toEqual({ status: 'COMPLETED' });
    expect(await prisma.document.count({ where: { contractId: contracts.http, tags: { has: 'e-signed' } } })).toBe(1);
  }, 60_000);

  it('keeps its log append-only', async () => {
    const ev = await prisma.signatureEvent.findFirstOrThrow();
    await expect(prisma.signatureEvent.update({ where: { id: ev.id }, data: { kind: 'X' } })).rejects.toThrow(/append-only/);
  });
});
