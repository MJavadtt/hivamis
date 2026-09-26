import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { closeApp, get, login, move, post, put, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { daysSinceEpoch, memoryIdToNumber, taxIdChecks, taxIdFor, verhoeffDigit, verhoeffValid } from '../src/tax/taxid.js';
import { jweDecrypt, jweEncrypt, jwsSign, jwsVerify } from '../src/tax/jose.js';
import { directGateway } from '../src/tax/gateway.js';
import { buildTaxInvoice, validateForTax, type SellerProfile } from '../src/tax/invoice.js';

const keys = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

describe('The tax number', () => {
  it('is 22 characters: memory id, day and serial in hex, and a Verhoeff digit over their decimal forms', () => {
    // The textbook Verhoeff vector: 236 → 3, and 2363 checks.
    expect(verhoeffDigit('236')).toBe(3);
    expect(verhoeffValid('2363')).toBe(true);
    expect(memoryIdToNumber('A1B2C3')).toBe('651662673');
    const issued = new Date('2023-05-01T00:00:00Z');
    expect(daysSinceEpoch(issued)).toBe(19478);
    const id = taxIdFor('a1b2c3', issued, 1);
    expect(id).toHaveLength(22);
    expect(id.slice(0, 6)).toBe('A1B2C3');                          // memory id, upper-cased
    expect(id.slice(6, 11)).toBe('04C16');                         // 19478 in hex
    expect(id.slice(11, 21)).toBe('0000000001');
    expect(verhoeffValid(`${memoryIdToNumber('A1B2C3')}019478000000000001${id.at(-1)}`)).toBe(true);
    expect(taxIdChecks(id)).toBe(true);
    expect(taxIdChecks(`${id.slice(0, 20)}${id[20] === '0' ? '1' : '0'}${id.at(-1)}`)).toBe(false);   // one character off
  });
});

describe('The two envelopes', () => {
  it('signs with the taxpayer’s key (sigT critical, certificate attached) and encrypts for the authority’s', () => {
    const taxpayer = keys(), authority = keys();
    const jws = jwsSign({ hello: 'سلام' }, taxpayer.privateKey, 'CERTBASE64', new Date('2026-09-27T08:00:00Z'));
    const v = jwsVerify(jws, taxpayer.publicKey)!;
    expect(v.payload).toEqual({ hello: 'سلام' });
    expect(v.header).toMatchObject({ alg: 'RS256', sigT: '2026-09-27T08:00:00Z', crit: ['sigT'], x5c: ['CERTBASE64'] });
    expect(jwsVerify(jws, authority.publicKey)).toBeNull();
    const jwe = jweEncrypt(jws, authority.publicKey, 'kid-7');
    expect(jwe.split('.')).toHaveLength(5);
    const opened = jweDecrypt(jwe, authority.privateKey);
    expect(opened.header).toEqual({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: 'kid-7' });
    expect(opened.plaintext).toBe(jws);
    const parts = jwe.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => jweDecrypt(parts.join('.'), authority.privateKey)).toThrow();
  });

  it('speaks the direct API: nonce, token, the authority’s key, a signed and encrypted invoice, an inquiry', async () => {
    const taxpayer = keys(), authority = keys();
    const seen: { url: string; auth: string | null; body: any }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: (init?.headers as any)?.authorization ?? null, body: init?.body ? JSON.parse(String(init.body)) : null });
      const reply = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('nonce')) return reply({ nonce: 'N-42', expDate: 'x' });
      if (url.includes('server-information')) return reply({ publicKeys: [{ key: authority.publicKey.replace(/-----[A-Z ]+-----|\s/g, ''), id: 'kid-1' }] });
      if (url.endsWith('/invoice')) return reply({ result: [{ uid: 'u1', referenceNumber: 'REF-1' }] });
      if (url.includes('inquiry-by-reference-id')) return reply({ result: [{ referenceNumber: 'REF-1', status: 'SUCCESS' }] });
      return new Response('?', { status: 404 });
    }) as typeof fetch;
    const gw = directGateway({ baseUrl: 'https://tax.example/requestsmanager/api/v2/', privateKeyPem: taxpayer.privateKey, fetchImpl: fakeFetch });
    const invoice = { header: { taxid: 'A1B2C304C160000000001X', tbill: 1000 }, body: [] };
    const [sent] = await gw.submit('A1B2C3', [{ taxId: invoice.header.taxid, payload: invoice }]);
    expect(sent).toMatchObject({ referenceNumber: 'REF-1', error: null });

    const token = seen.find((s) => s.url.endsWith('/invoice'))!.auth!.replace('Bearer ', '');
    expect(jwsVerify(token, taxpayer.publicKey)!.payload).toEqual({ nonce: 'N-42', clientId: 'A1B2C3' });
    const [packet] = seen.find((s) => s.url.endsWith('/invoice'))!.body;
    expect(packet.header).toMatchObject({ fiscalId: 'A1B2C3' });
    expect(packet.header.requestTraceId).toMatch(/^[0-9a-f-]{36}$/);
    const inner = jweDecrypt(packet.payload, authority.privateKey);
    expect(inner.header.kid).toBe('kid-1');
    expect(jwsVerify(inner.plaintext, taxpayer.publicKey)!.payload).toEqual(invoice);   // exactly what was prepared

    expect(await gw.inquire('A1B2C3', ['REF-1'])).toEqual([{ referenceNumber: 'REF-1', status: 'ACCEPTED', errors: [] }]);
  });
});

describe('What the authority would refuse — found before sending', () => {
  const seller: SellerProfile = { memoryId: 'A1B2C3', sellerTaxId: '10101010101', economicCode: null, postalCode: null, branchCode: null, defaultServiceCode: '2720000114542', defaultUnitCode: '1627' };
  const buyer = { legalName: 'شرکت نمونه', nationalId: '14000000001', economicCode: null, postalCode: '1234567890' };
  const invoice = {
    kind: 'INVOICE', state: 'ISSUED', number: 'F-1', issueDate: new Date('2026-09-20T08:00:00Z'), taxPercent: 10, total: 110_000_000, fxRate: 1, currency: 'IRR',
    lines: [{ description: 'طراحی کمپین', quantity: 1, unitPrice: 60_000_000 }, { description: 'تولید تیزر', quantity: 2, unitPrice: 20_000_000 }],
  };
  it('builds the header and lines in whole rials, VAT per line, the bill equal to the invoice', () => {
    const p = buildTaxInvoice(invoice, buyer, seller, 'ORIGINAL', null, 'T'.repeat(22), 7);
    expect(p.header).toMatchObject({ inty: 1, inp: 1, ins: 1, inno: '7', tob: 2, bid: '14000000001', bpc: '1234567890', tprdis: 100_000_000, tvam: 10_000_000, tbill: 110_000_000 });
    expect(p.body[1]).toMatchObject({ sstid: '2720000114542', am: 2, fee: 20_000_000, prdis: 40_000_000, vra: 10, vam: 4_000_000, tsstam: 44_000_000 });
    expect(validateForTax(invoice, buyer, seller, 'ORIGINAL', null)).toEqual([]);
  });
  it('names each problem: no profile, a buyer without a postal code, a proforma, lines that disagree with the total', () => {
    expect(validateForTax(invoice, buyer, null, 'ORIGINAL', null)[0]!.field).toBe('profile');
    expect(validateForTax(invoice, { ...buyer, postalCode: null }, seller, 'ORIGINAL', null).map((x) => x.field)).toEqual(['bpc']);
    expect(validateForTax({ ...invoice, kind: 'PROFORMA' }, buyer, seller, 'ORIGINAL', null).map((x) => x.field)).toEqual(['kind']);
    expect(validateForTax({ ...invoice, total: 120_000_000 }, buyer, seller, 'ORIGINAL', null).map((x) => x.field)).toEqual(['tbill']);
    expect(validateForTax(invoice, buyer, seller, 'CANCELLATION', null).map((x) => x.field)).toEqual(['irtaxid']);
  });
});

describe('Reporting, correcting and cancelling', () => {
  let T: Record<string, string>;
  let invoiceId: string;
  const original = env.MOADIAN_MODE;
  beforeAll(async () => {
    T = { finance: await login('finance@hiva.local'), designer: await login('designer@hiva.local') };
    const company = await prisma.company.findFirstOrThrow();
    const project = await prisma.project.findFirstOrThrow({ where: { companyId: company.id } }).catch(() => null);
    invoiceId = expectOk(await post('/invoices', T.finance, {
      kind: 'INVOICE', companyId: company.id, projectId: project?.id, number: 'TAX-1', issueDate: new Date(Date.now() - 86_400_000).toISOString(), taxPercent: 10,
      lines: [{ description: 'خدمات تبلیغات', quantity: 1, unitPrice: 50_000_000 }],
    }), 'invoice').id;
    expectOk(await move('invoice', invoiceId, 'issue', T.finance), 'issue');
  });
  afterAll(async () => { env.MOADIAN_MODE = original; await closeApp(); });

  it('refuses to send until the profile and the buyer are complete, and says what is missing', async () => {
    const before = expectOk(await get(`/invoices/${invoiceId}/tax`, T.finance), 'preview');
    expect(before.subjects).toEqual(['ORIGINAL']);
    expect(before.problems.map((p: any) => p.field)).toContain('profile');
    const refused = await post(`/invoices/${invoiceId}/tax`, T.finance, { subject: 'ORIGINAL' });
    expect(refused.body.error.code).toBe('TAX_INVOICE_INVALID');

    expect((await put('/tax/profile', T.designer, {})).status).toBe(403);
    // A malformed profile is refused field by field, in Persian — not with a generic validation error.
    const bad = await put('/tax/profile', T.finance, { memoryId: 'A1B2C', sellerTaxId: '123', defaultServiceCode: '272000011454', defaultUnitCode: '1627' });
    expect(bad.body.error.code).toBe('TAX_PROFILE_INVALID');
    expect(bad.body.error.details.problems.map((p: any) => p.field)).toEqual(['memoryId', 'sellerTaxId', 'defaultServiceCode']);
    expectOk(await put('/tax/profile', T.finance, { memoryId: 'a1b2c3', sellerTaxId: '10101010101', defaultServiceCode: '2720000114542', defaultUnitCode: '1627' }), 'profile');
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expectOk(await put(`/companies/${inv.companyId}/tax-identifiers`, T.finance, { nationalId: '14000000001', postalCode: '1234567890' }), 'buyer ids');
    expect(expectOk(await get(`/invoices/${invoiceId}/tax`, T.finance), 'ready').problems).toEqual([]);
  });

  it('with sending off, prepares and queues — and an invoice in the queue cannot be cancelled here', async () => {
    env.MOADIAN_MODE = 'off';
    const s = expectOk(await post(`/invoices/${invoiceId}/tax`, T.finance, { subject: 'ORIGINAL' }), 'queued');
    expect(s).toMatchObject({ status: 'QUEUED', subject: 'ORIGINAL', channel: null });
    expect(taxIdChecks(s.taxId)).toBe(true);
    expect(s.taxId.slice(0, 6)).toBe('A1B2C3');
    expect(s.payload.header.tbill).toBe(55_000_000);
    const blocked = await move('invoice', invoiceId, 'cancel', T.finance, 'اشتباه در صدور');
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toContain('در صف');
  });

  it('sends when sending is on; accepted, it can only be corrected or cancelled — there first, then here', async () => {
    env.MOADIAN_MODE = 'sandbox';
    const queued = await prisma.taxSubmission.findFirstOrThrow({ where: { invoiceId } });
    const answered = expectOk(await post(`/tax/submissions/${queued.id}/inquire`, T.finance, {}), 'send and inquire');
    expect(answered).toMatchObject({ status: 'ACCEPTED', channel: 'sandbox' });
    expect(answered.referenceNumber).toBe(`SBX-${queued.taxId}`);

    expect((await post(`/invoices/${invoiceId}/tax`, T.finance, { subject: 'ORIGINAL' })).body.error.code).toBe('TAX_SUBJECT_NOT_ALLOWED');
    expect((await move('invoice', invoiceId, 'cancel', T.finance, 'اشتباه در صدور')).body.error.message).toContain('ابطالی');

    const cancellation = expectOk(await post(`/invoices/${invoiceId}/tax`, T.finance, { subject: 'CANCELLATION' }), 'cancellation');
    expect(cancellation).toMatchObject({ subject: 'CANCELLATION', status: 'ACCEPTED', referenceTaxId: queued.taxId });
    expect(cancellation.payload.header).toMatchObject({ ins: 3, irtaxid: queued.taxId });
    expect(cancellation.taxId).not.toBe(queued.taxId);
    expectOk(await move('invoice', invoiceId, 'cancel', T.finance, 'اشتباه در صدور'), 'cancel here too');
    expect((await post(`/invoices/${invoiceId}/tax`, T.finance, { subject: 'CORRECTION' })).body.error.code).toBe('TAX_ALREADY_CANCELLED');
  });

  it('lists what the authority has not accepted yet', async () => {
    const r = expectOk(await get('/reports/tax', T.finance), 'report');
    expect(r.mode).toBe('sandbox');
    expect(r.pending.find((x: any) => x.id === invoiceId)).toBeUndefined();     // cancelled, so no longer owed
    expect(r.totals.notReported).toBeGreaterThanOrEqual(0);
  });
});
