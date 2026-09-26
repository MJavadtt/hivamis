import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ACCOUNT_KEYS } from '@hiva/contracts';
import { call, closeApp, get, login, move, post, put, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { parseCsv } from '../src/forms/bulk.js';
import { balanced, invoiceVoucher, paymentVoucher, reversalVoucher, type PaymentRow } from '../src/accounting/vouchers.js';
import { DEFAULT_LAYOUT, formatDate, layoutProblems, renderCsv, type Settings } from '../src/accounting/export.js';

const DAY = 86_400_000;
const day = (offset: number) => {
  const d = new Date(Date.now() + offset * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const CODES = Object.fromEntries(ACCOUNT_KEYS.map((k, i) => [k, String(1101 + i * 100)])) as Record<(typeof ACCOUNT_KEYS)[number], string>;

describe('Vouchers — double entry, to the rial', () => {
  const inv = {
    id: 'i1', code: 'INV-000001', number: 'F-7', issueDate: new Date('2026-09-20T00:00:00Z'), companyId: 'c1', company: { legalName: 'شرکت نمونه' },
    total: 1_100_000.4, taxAmount: 100_000, fxRate: 1,
    lines: [{ description: 'پخش تلویزیونی', quantity: 1, unitPrice: 800_000, passThrough: true }, { description: 'کارمزد', quantity: 1, unitPrice: 200_000 }],
  };
  it('an invoice: receivable against revenue, media clearing for the pass-through, VAT — rounding lands in revenue', () => {
    const v = invoiceVoucher(inv, 'D-17');
    expect(v.lines.map((l) => [l.account, l.debit, l.credit, l.detail])).toEqual([
      ['receivable', 1_100_000, 0, 'D-17'], ['revenue', 0, 200_000, null], ['mediaClearing', 0, 800_000, null], ['vat', 0, 100_000, null],
    ]);
    expect(balanced(v)).toBe(true);
    expect(balanced(invoiceVoucher({ ...inv, total: 1_100_000.6 }, null))).toBe(true);
  });

  it('a cancellation after posting is the same voucher the other way round, on its own day', () => {
    const on = new Date('2026-09-25T00:00:00Z');
    const r = reversalVoucher(inv, 'D-17', on);
    expect(r).toMatchObject({ kind: 'REVERSAL', date: on });
    expect(r.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['receivable', 0, 1_100_000], ['revenue', 200_000, 0], ['mediaClearing', 800_000, 0], ['vat', 100_000, 0]]);
    expect(balanced(r)).toBe(true);
  });

  const receipt = (over: Partial<PaymentRow>): PaymentRow => ({
    id: 'p1', direction: 'IN', amount: 0, occurredAt: new Date('2026-09-22T00:00:00Z'), method: 'TRANSFER', reference: 'TR-9', settledOriginal: null, mediaOrderId: null,
    invoice: null, project: null, supplier: null, ...over,
  });
  it('a receipt on a foreign invoice clears it at the booked rate; the difference is exchange gain or loss', () => {
    const usd = { kind: 'INVOICE', number: 'F-8', companyId: 'c1', currency: 'USD', fxRate: 1_000_000, company: { legalName: 'شرکت نمونه' } };
    const gain = paymentVoucher(receipt({ amount: 4_400_000_000, settledOriginal: 4_000, invoice: usd }), { c1: 'D-17' }, 'IRR');
    expect(gain.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['bank', 4_400_000_000, 0], ['receivable', 0, 4_000_000_000], ['fxGain', 0, 400_000_000]]);
    expect(gain.lines[1]!.detail).toBe('D-17');
    const loss = paymentVoucher(receipt({ amount: 3_600_000_000, settledOriginal: 4_000, invoice: usd, method: 'CASH' }), {}, 'IRR');
    expect(loss.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['cash', 3_600_000_000, 0], ['fxLoss', 400_000_000, 0], ['receivable', 0, 4_000_000_000]]);
    expect([gain, loss].every(balanced)).toBe(true);
  });

  it('money against a proforma, or with no invoice, is an advance; money out is project cost — or media clearing', () => {
    const proforma = { kind: 'PROFORMA', number: 'P-1', companyId: 'c1', currency: 'IRR', fxRate: 1, company: { legalName: 'شرکت نمونه' } };
    expect(paymentVoucher(receipt({ amount: 500, invoice: proforma }), { c1: 'D-17' }, 'IRR').lines.map((l) => [l.account, l.detail])).toEqual([['bank', null], ['clientAdvance', 'D-17']]);
    const out = receipt({ direction: 'OUT', amount: 900, supplier: { name: 'صداوسیما' } });
    expect(paymentVoucher(out, {}, 'IRR').lines.map((l) => [l.account, l.debit, l.credit])).toEqual([['projectCost', 900, 0], ['bank', 0, 900]]);
    expect(paymentVoucher({ ...out, mediaOrderId: 'm1' }, {}, 'IRR').lines[0]!.account).toBe('mediaClearing');
  });
});

describe('The file, in the organisation’s own columns', () => {
  const settings: Settings = { accounts: CODES, clientCodes: {}, layout: DEFAULT_LAYOUT };
  const v = invoiceVoucher({
    id: 'i1', code: 'INV-000001', number: '=HYPERLINK("x")', issueDate: new Date('2026-09-20T00:00:00Z'), companyId: 'c1', company: { legalName: 'شرکت, "نمونه"' },
    total: 110, taxAmount: 10, fxRate: 1, lines: [],
  }, null);
  it('writes a BOM, the headers, Latin digits and a Jalali date; text a spreadsheet would run is written as text', () => {
    const csv = renderCsv([v], 41, settings);
    expect(csv.startsWith('﻿')).toBe(true);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(DEFAULT_LAYOUT.columns.map((c) => c.header));
    expect(rows).toHaveLength(4);
    expect(rows[1]!.slice(0, 2)).toEqual(['41', '1405/06/29']);
    expect(rows[1]![2]).toBe('فاکتور =HYPERLINK("x") — شرکت, "نمونه"');         // quoted, round-trips
    expect(rows[1]!.slice(4, 5)).toEqual([CODES.receivable]);
    expect(rows.slice(1).map((r) => r[3])).toEqual(['1', '2', '3']);
    expect(csv).not.toMatch(/[۰-۹]/);
    const guarded = renderCsv([{ ...v, reference: '=1+1' }], 1, settings);
    expect(parseCsv(guarded)[1]!.at(-1)).toBe("'=1+1");
  });

  it('can be one signed amount column, Gregorian dates — and refuses a layout no package could import', () => {
    const layout = { dateFormat: 'GREGORIAN' as const, columns: [{ field: 'voucherNo' as const, header: 'Doc' }, { field: 'date' as const, header: 'Date' }, { field: 'accountCode' as const, header: 'Acc' }, { field: 'amount' as const, header: 'Amt' }] };
    const rows = parseCsv(renderCsv([v], 1, { ...settings, layout }));
    expect(rows.slice(1).map((r) => r[3])).toEqual(['110', '-100', '-10']);
    expect(rows[1]![1]).toBe('2026-09-20');
    expect(formatDate(new Date('2026-03-21T00:00:00Z'), 'JALALI')).toBe('1405/01/01');
    expect(layoutProblems(layout)).toEqual([]);
    expect(layoutProblems({ ...layout, columns: layout.columns.filter((c) => c.field !== 'amount') }).map((p) => p.code)).toEqual(['LAYOUT_NO_AMOUNT']);
    expect(layoutProblems({ ...layout, columns: [...layout.columns, { field: 'date' as const, header: 'again' }].filter((c) => c.field !== 'accountCode') }).map((p) => p.code)).toEqual(['LAYOUT_DUPLICATE', 'LAYOUT_NO_ACCOUNT']);
  });
});

describe('Batches — each record posted once, reversals after cancellation', () => {
  let T: Record<string, string>;
  let companyId: string, projectId: string;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    T = { finance: await login('finance@hiva.local'), am: await login('account.manager@hiva.local'), designer: await login('designer@hiva.local') };
    for (const [offset, rate] of [[-20, 1_000_000], [-10, 1_100_000]] as const) {
      expectOk(await post('/fx/rates', T.finance, { currency: 'USD', rate, effectiveDate: day(offset) }), `rate ${offset}`);
    }
    const org = await prisma.organization.findFirstOrThrow();
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
    companyId = (await prisma.company.create({ data: { organizationId: org.id, legalName: 'شرکت حسابداری آزمون', accountOwnerId: owner.id } })).id;
    projectId = (await prisma.project.create({ data: { organizationId: org.id, code: await nextCode(prisma, 'project'), name: 'پروژهٔ خروجی حسابداری', companyId, accountOwnerId: owner.id, state: 'ACTIVE' } })).id;
    const invoice = async (key: string, extra: Record<string, unknown>, issue = true) => {
      ids[key] = expectOk(await post('/invoices', T.finance, {
        kind: 'INVOICE', companyId, projectId, number: `ACC-${key}`, issueDate: day(-20), taxPercent: 10,
        lines: [{ description: 'خدمات کمپین', quantity: 1, unitPrice: 1_000_000 }], ...extra,
      }), key).id;
      if (issue) expectOk(await move('invoice', ids[key]!, 'issue', T.finance), `issue ${key}`);
    };
    await invoice('rial', {});
    await invoice('usd', { currency: 'USD', lines: [{ description: 'کمپین منطقه‌ای', quantity: 1, unitPrice: 10_000 }], taxPercent: 0 });
    await invoice('proforma', { kind: 'PROFORMA' }, false);
    await invoice('draft', {}, false);
    await invoice('voided', {});
    expectOk(await move('invoice', ids.voided!, 'cancel', T.finance, 'صدور اشتباه'), 'cancel before posting');
    ids.usdReceipt = expectOk(await post('/payments', T.finance, { invoiceId: ids.usd, direction: 'IN', amount: 4_000, currency: 'USD', occurredAt: day(-10), reference: 'SW-1' }), 'usd receipt').id;
    ids.advance = expectOk(await post('/payments', T.finance, { invoiceId: ids.proforma, direction: 'IN', amount: 300_000, occurredAt: day(-9) }), 'advance').id;
    ids.cost = expectOk(await post('/payments', T.finance, { projectId, direction: 'OUT', amount: 250_000, method: 'CASH', occurredAt: day(-8) }), 'cost').id;
  });
  afterAll(async () => { await closeApp(); });

  it('is read by finance, set and posted only by who may settle', async () => {
    expect((await get('/accounting/settings', T.designer)).status).toBe(403);
    expect((await get('/accounting/preview', T.am, { to: day(0) })).status).toBe(200);
    expect((await put('/accounting/settings', T.am, { accounts: CODES, layout: DEFAULT_LAYOUT })).status).toBe(403);
    expect((await post('/accounting/exports', T.am, { to: day(0) })).status).toBe(403);
  });

  it('will not post before every account used has a code, and names the ones missing', async () => {
    const p = expectOk(await get('/accounting/preview', T.finance, { to: day(0) }), 'preview');
    expect(p.problems.map((x: any) => x.code)).toContain('ACCOUNT_CODE_MISSING');
    expect(p.problems.find((x: any) => x.code === 'ACCOUNT_CODE_MISSING').message).toContain('سود تسعیر ارز');
    const refused = await post('/accounting/exports', T.finance, { to: day(0) });
    expect(refused.body.error.code).toBe('ACCOUNTING_EXPORT_BLOCKED');

    const bad = await put('/accounting/settings', T.finance, { accounts: CODES, layout: { ...DEFAULT_LAYOUT, columns: DEFAULT_LAYOUT.columns.filter((c) => c.field !== 'accountCode') } });
    expect(bad.body.error.details.problems.map((x: any) => x.code)).toEqual(['LAYOUT_NO_ACCOUNT']);
    const stranger = await put('/accounting/settings', T.finance, { accounts: CODES, clientCodes: { '00000000-0000-4000-8000-000000000000': 'X' }, layout: DEFAULT_LAYOUT });
    expect(stranger.body.error.details.problems.map((x: any) => x.code)).toEqual(['CLIENT_UNKNOWN']);
    expectOk(await put('/accounting/settings', T.finance, { accounts: CODES, clientCodes: { [companyId]: 'T-3001' }, layout: DEFAULT_LAYOUT }), 'settings');
    const s = expectOk(await get('/accounting/settings', T.finance), 'read back');
    expect(s).toMatchObject({ saved: true, clientCodes: { [companyId]: 'T-3001' } });
    expect(s.clients.map((c: any) => c.id)).toContain(companyId);
  });

  it('previews balanced vouchers — not drafts, not proformas, not what was cancelled before it was posted', async () => {
    const p = expectOk(await get('/accounting/preview', T.finance, { to: day(0) }), 'preview');
    expect(p.problems).toEqual([]);
    expect(p.debitTotal).toBe(p.creditTotal);
    const mine = (id: string) => p.vouchers.filter((v: any) => v.sourceId === id);
    expect(mine(ids.draft!)).toEqual([]);
    expect(mine(ids.proforma!)).toEqual([]);
    expect(mine(ids.voided!)).toEqual([]);
    expect(mine(ids.rial!)[0].lines.map((l: any) => [l.account, l.debit, l.credit, l.detail])).toEqual([['receivable', 1_100_000, 0, 'T-3001'], ['revenue', 0, 1_000_000, null], ['vat', 0, 100_000, null]]);
    expect(mine(ids.usdReceipt!)[0].lines.map((l: any) => [l.account, l.debit, l.credit])).toEqual([['bank', 4_400_000_000, 0], ['receivable', 0, 4_000_000_000], ['fxGain', 0, 400_000_000]]);
    expect(mine(ids.advance!)[0].lines.map((l: any) => l.account)).toEqual(['bank', 'clientAdvance']);
    expect(mine(ids.cost!)[0].lines.map((l: any) => l.account)).toEqual(['projectCost', 'cash']);
    // Nothing was marked by looking.
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: ids.rial } })).accountingExportId).toBeNull();
  });

  let first: any;
  it('posts a batch: numbered, its file kept, every record marked — and a second batch finds nothing left', async () => {
    first = expectOk(await post('/accounting/exports', T.finance, { to: day(0) }), 'export');
    expect(first.content).toBeUndefined();
    expect(Number(first.debitTotal)).toBe(Number(first.creditTotal));
    for (const k of ['rial', 'usd']) expect((await prisma.invoice.findUniqueOrThrow({ where: { id: ids[k] } })).accountingExportId).toBe(first.id);
    for (const k of ['draft', 'proforma', 'voided']) expect((await prisma.invoice.findUniqueOrThrow({ where: { id: ids[k] } })).accountingExportId).toBeNull();
    for (const k of ['usdReceipt', 'advance', 'cost']) expect((await prisma.payment.findUniqueOrThrow({ where: { id: ids[k] } })).accountingExportId).toBe(first.id);
    expect((await post('/accounting/exports', T.finance, { to: day(0) })).body.error.code).toBe('ACCOUNTING_NOTHING_TO_EXPORT');

    const list = expectOk(await get('/accounting/exports', T.finance), 'history');
    expect(list[0]).toMatchObject({ id: first.id, number: first.number, createdBy: 'لیلا موسوی' });
  });

  it('gives back the same file each time, and records each download', async () => {
    const a = await call('GET', `/accounting/exports/${first.id}/file`, { token: T.am });
    const b = await call('GET', `/accounting/exports/${first.id}/file`, { token: T.finance });
    expect(a.status).toBe(200);
    expect(a.body).toBe(b.body);
    const rows = parseCsv(a.body);
    expect(rows[0]![0]).toBe('شماره سند');
    const debit = rows.slice(1).reduce((s, r) => s + Number(r[7]), 0), credit = rows.slice(1).reduce((s, r) => s + Number(r[8]), 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(Number(first.debitTotal));
    const code = (await prisma.invoice.findUniqueOrThrow({ where: { id: ids.rial } })).code;
    expect(rows.filter((r) => r[9] === code).map((r) => r[5])).toEqual(['T-3001', '', '']);   // the client's detail code on its line
    expect(await prisma.auditEvent.count({ where: { action: 'EXPORT', entityType: 'accountingExport', entityId: first.id } })).toBe(2);
    expect((await get(`/accounting/exports/${first.id}/file`, T.designer)).status).toBe(403);
  });

  it('reverses an invoice cancelled after it was posted, in the next batch, and numbers vouchers on', async () => {
    expectOk(await move('invoice', ids.rial!, 'cancel', T.finance, 'ابطال پس از ثبت'), 'cancel after posting');
    const p = expectOk(await get('/accounting/preview', T.finance, { to: day(0) }), 'preview');
    expect(p.counts).toMatchObject({ reversals: 1 });
    const second = expectOk(await post('/accounting/exports', T.finance, { to: day(0) }), 'second');
    expect(second.number).toBe(first.number + 1);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: ids.rial } });
    expect(inv).toMatchObject({ accountingExportId: first.id, accountingReversalExportId: second.id });

    const lastOfFirst = Math.max(...parseCsv((await prisma.accountingExport.findUniqueOrThrow({ where: { id: first.id } })).content).slice(1).map((r) => Number(r[0])));
    const rows = parseCsv((await prisma.accountingExport.findUniqueOrThrow({ where: { id: second.id } })).content).slice(1);
    expect(Number(rows[0]![0])).toBe(lastOfFirst + 1);
    const rev = rows.filter((r) => r[9] === inv.code);
    expect(rev.map((r) => [r[4], r[7], r[8]])).toEqual([[CODES.receivable, '0', '1100000'], [CODES.revenue, '1000000', '0'], [CODES.vat, '100000', '0']]);
    expect(rev[0]![2]).toContain('ابطال');
    expect((await post('/accounting/exports', T.finance, { to: day(0) })).body.error.code).toBe('ACCOUNTING_NOTHING_TO_EXPORT');
  });

  it('two batches at once: one posts, the other finds the records taken — never both', async () => {
    const extra = expectOk(await post('/payments', T.finance, { projectId, direction: 'IN', amount: 77_000, occurredAt: day(0) }), 'extra').id;
    const results = await Promise.all([post('/accounting/exports', T.finance, { to: day(0) }), post('/accounting/exports', T.finance, { to: day(0) })]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    expect([409, 422]).toContain(statuses[1]);
    const posted = await prisma.payment.findUniqueOrThrow({ where: { id: extra } });
    expect(posted.accountingExportId).toBe(results.find((r) => r.status === 201)!.body.id);
  });
});
