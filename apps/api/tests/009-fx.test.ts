import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, get, login, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { formatJalali } from '../src/lib/jalali.js';

let T: Record<string, string>;
const DAY = 86_400_000;
/** A calendar day as the page sends it: «YYYY-MM-DD» for the local date `offset` days from today. */
const day = (offset: number) => {
  const d = new Date(Date.now() + offset * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let companyId: string;
let projectId: string;

beforeAll(async () => {
  T = {
    finance: await login('finance@hiva.local'),
    designer: await login('designer@hiva.local'),
    accountManager: await login('account.manager@hiva.local'),
    ceo: await login('ceo@hiva.local'),
  };
  // The dollar's history these tests read: 1,000,000 twenty days ago, 1,100,000 ten days ago, 1,200,000 today.
  for (const [offset, rate] of [[-20, 1_000_000], [-10, 1_100_000], [0, 1_200_000]] as const) {
    expectOk(await post('/fx/rates', T.finance, { currency: 'USD', rate, effectiveDate: day(offset) }), `rate ${offset}`);
  }
  const org = await prisma.organization.findFirstOrThrow();
  const company = await prisma.company.findFirstOrThrow();
  const owner = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
  companyId = company.id;
  projectId = (await prisma.project.create({
    data: { organizationId: org.id, code: await nextCode(prisma, 'project'), name: 'کمپین منطقه‌ای دلاری', companyId, accountOwnerId: owner.id, state: 'ACTIVE' },
  })).id;
});
afterAll(async () => { await closeApp(); });

const invoice = (extra: Record<string, unknown>) => post('/invoices', T.finance, {
  kind: 'INVOICE', companyId, projectId, number: `FX-${Math.random().toString(36).slice(2, 8)}`,
  issueDate: day(-20), lines: [{ description: 'خدمات کمپین', quantity: 1, unitPrice: 10_000 }], ...extra,
});

describe('Rates: a history, kept honestly', () => {
  it('lists each currency with its latest rate and how old it is', async () => {
    const r = expectOk(await get('/fx/rates', T.finance), 'rates');
    expect(r.base).toBe('IRR');
    const usd = r.currencies.find((c: any) => c.currency === 'USD');
    expect(Number(usd.latest.rate)).toBe(1_200_000);
    expect(usd.latest.stale).toBe(false);
    expect(usd.history).toHaveLength(3);
    expect(r.currencies.find((c: any) => c.currency === 'GBP').latest).toBeNull();
  });

  it('looks up the rate in force on a day — never one from after it', async () => {
    const r = expectOk(await get('/fx/rate', T.finance, { currency: 'USD', on: day(-15) }), 'lookup');
    expect(Number(r.rate)).toBe(1_000_000);                 // the −20 rate, not the −10 one
    expect(r.ageDays).toBe(5);
    expect(r.usable).toBe(true);
    expect(expectOk(await get('/fx/rate', T.finance, { currency: 'USD', on: day(-25) }), 'before history').rate).toBeNull();
  });

  it('refuses a rate for the base currency, and anyone without the rates permission', async () => {
    expect((await post('/fx/rates', T.finance, { currency: 'IRR', rate: 1, effectiveDate: day(0) })).body.error.code).toBe('FX_BASE_CURRENCY');
    expect((await post('/fx/rates', T.designer, { currency: 'USD', rate: 1, effectiveDate: day(0) })).status).toBe(403);
  });

  it('imports history in Jalali or ISO dates, never overwriting a day already recorded', async () => {
    const j = formatJalali(new Date(Date.now() - 40 * DAY)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
    const r = expectOk(await post('/fx/rates/import', T.finance, {
      csv: `date,currency,rate\n${j},EUR,1250000\n${day(-20)},USD,999999\n${day(-10)},USD,1100000\n2026-13-45,USD,1\n${day(-3)},XYZ,5\n${day(-3)},EUR,-4`,
    }), 'import');
    expect(r.created).toBe(1);
    expect(r.unchanged).toBe(1);                              // same day, same rate
    expect(r.conflicts).toHaveLength(1);                      // same day, different rate: listed, not applied
    expect(r.conflicts[0]).toMatchObject({ currency: 'USD', proposed: 999_999 });
    expect(r.errors.map((e: any) => e.line)).toEqual([5, 6, 7]);
    const kept = expectOk(await get('/fx/rate', T.finance, { currency: 'USD', on: day(-20) }), 'kept');
    expect(Number(kept.rate)).toBe(1_000_000);
  });
});

describe('A figure in another currency is converted once, at its own day’s rate, and keeps it', () => {
  it('books a dollar invoice at the issue date’s rate', async () => {
    const inv = expectOk(await invoice({ currency: 'USD', taxPercent: 10 }), 'usd invoice');
    expect(inv.currency).toBe('USD');
    expect(Number(inv.originalTotal)).toBe(11_000);
    expect(Number(inv.fxRate)).toBe(1_000_000);
    expect(Number(inv.total)).toBe(11_000_000_000);             // what every report sums, in rials
    expect(Number(inv.subtotal) + Number(inv.taxAmount)).toBe(Number(inv.total));
    expect(Number(inv.originalPaidAmount)).toBe(0);
  });

  it('refuses a figure with no rate for its day, or only a stale one — and says which currency and day', async () => {
    const missing = await invoice({ currency: 'GBP' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('FX_RATE_MISSING');
    expect(missing.body.error.message).toContain('پوند انگلیس');
    // EUR's only rate is forty days old.
    const stale = await invoice({ currency: 'EUR', issueDate: day(0) });
    expect(stale.body.error.code).toBe('FX_RATE_STALE');
    expect(stale.body.error.details.ageDays).toBe(40);
    // A base-currency invoice needs no rate at all.
    expect(Number(expectOk(await invoice({}), 'rial').fxRate)).toBe(1);
  });

  it('settles in the invoice’s currency: a rate that moved is an exchange gain, not a dispute', async () => {
    const inv = expectOk(await invoice({ currency: 'USD' }), 'invoice');   // 10,000 USD at 1,000,000

    const noCurrency = await post('/payments', T.finance, { invoiceId: inv.id, direction: 'IN', amount: 4_000, occurredAt: day(-10) });
    expect(noCurrency.body.error.code).toBe('FX_CURRENCY_REQUIRED');       // never guessed: off by a factor of a million
    const wrong = await post('/payments', T.finance, { invoiceId: inv.id, direction: 'IN', amount: 4_000, currency: 'EUR', occurredAt: day(-10) });
    expect(wrong.body.error.code).toBe('FX_CURRENCY_MISMATCH');

    // 4,000 dollars ten days later, when the dollar was 1,100,000 …
    const p1 = expectOk(await post('/payments', T.finance, { invoiceId: inv.id, direction: 'IN', amount: 4_000, currency: 'USD', occurredAt: day(-10) }), 'usd receipt');
    expect(Number(p1.amount)).toBe(4_400_000_000);
    expect(Number(p1.settledOriginal)).toBe(4_000);
    let now = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(now.state).toBe('PARTIALLY_PAID');
    expect(Number(now.paidAmount)).toBe(4_000_000_000);                     // at the invoice's own rate

    // … and the rest paid in rials, at that day's rate: 6,600,000,000 rials settles 6,000 dollars.
    const p2 = expectOk(await post('/payments', T.finance, { invoiceId: inv.id, direction: 'IN', amount: 6_600_000_000, currency: 'IRR', occurredAt: day(-10) }), 'rial receipt');
    expect(Number(p2.settledOriginal)).toBe(6_000);
    now = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(now.state).toBe('PAID');
    expect(Number(now.paidAmount)).toBe(Number(now.total));                 // outstanding 0 in base

    // The project settles as settled, not as a 1,000,000,000-rial discrepancy.
    const all = await prisma.invoice.findMany({ where: { projectId, state: { not: 'CANCELLED' } } });
    for (const other of all.filter((i) => i.id !== inv.id)) await prisma.invoice.update({ where: { id: other.id }, data: { state: 'CANCELLED' } });
    const settled = expectOk(await post(`/projects/${projectId}/settle`, T.ceo, {}), 'settle');
    expect(settled.status ?? settled.settlement?.status).toBe('FULLY_SETTLED');

    const report = expectOk(await get('/reports/fx', T.finance), 'fx report');
    const gains = report.realised.filter((r: any) => r.invoice.id === inv.id);
    expect(gains.map((g: any) => g.gainLoss).reduce((a: number, b: number) => a + b, 0)).toBe(1_000_000_000);
  });

  it('revalues what is still open at today’s rate, beside what it was booked at', async () => {
    const inv = expectOk(await invoice({ currency: 'USD', lines: [{ description: 'مرحلهٔ دوم', quantity: 1, unitPrice: 1_000 }] }), 'open');
    const report = expectOk(await get('/reports/fx', T.finance), 'fx report');
    const row = report.receivables.find((r: any) => r.id === inv.id);
    expect(row).toMatchObject({ outstanding: 1_000, bookedBase: 1_000_000_000, currentBase: 1_200_000_000, unrealised: 200_000_000 });
    expect(report.byCurrency.find((c: any) => c.currency === 'USD').currentRate).toBe(1_200_000);
  });

  it('keeps a booked figure where it is when the day’s rate is corrected — and says how many keep the old one', async () => {
    const inv = expectOk(await invoice({ currency: 'USD' }), 'invoice');
    const noReason = await post('/fx/rates', T.finance, { currency: 'USD', rate: 1_050_000, effectiveDate: day(-20) });
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const fixed = expectOk(await post('/fx/rates', T.finance, { currency: 'USD', rate: 1_050_000, effectiveDate: day(-20), note: 'نرخ مرجع اصلاح شد' }), 'correct');
    expect(fixed.replaced.recordsKeepingPrevious).toBeGreaterThan(0);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(Number(after.fxRate)).toBe(1_000_000);
    expect(Number(after.total)).toBe(10_000_000_000);
    const audited = await prisma.auditEvent.findFirst({ where: { entityType: 'exchangeRate', action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect(audited?.reason).toBe('نرخ مرجع اصلاح شد');
  });
});

describe('Costs and contracts in another currency', () => {
  it('converts a foreign external cost at today’s rate, keeping internal cost in base', async () => {
    const wo = await prisma.workOrder.findFirstOrThrow({ where: { targetDepartmentCode: 'CR' } });
    const creative = await login('creative@hiva.local');
    const r = expectOk(await post(`/work-orders/${wo.id}/cost`, creative, {
      departmentCode: 'CR', internalCost: 50_000_000, externalCost: 300, externalCurrency: 'USD',
    }), 'cost');
    const cd = await prisma.costDeclaration.findFirstOrThrow({ where: { workOrderId: wo.id }, orderBy: { createdAt: 'desc' } });
    expect(cd.externalCurrency).toBe('USD');
    expect(Number(cd.originalExternalCost)).toBe(300);
    expect(Number(cd.externalCost)).toBe(360_000_000);
    expect(Number(cd.internalCost)).toBe(50_000_000);
    expect(r).toBeTruthy();
    // No foreign money, no rate needed: a zero in dollars is just a zero.
    expectOk(await post(`/work-orders/${wo.id}/cost`, creative, { departmentCode: 'CR', internalCost: 1, externalCost: 0, externalCurrency: 'GBP' }), 'zero');
  });

  it('books a dollar contract and its amendments at the rate of the day each was recorded', async () => {
    const c = expectOk(await post('/contracts', T.accountManager, {
      companyId, projectId, title: 'قرارداد دلاری', contractValue: 20_000, currency: 'USD', startDate: day(0), endDate: day(180),
    }), 'contract');
    expect(Number(c.contractValue)).toBe(24_000_000_000);
    expect(Number(c.originalValue)).toBe(20_000);
    await prisma.contract.update({ where: { id: c.id }, data: { state: 'SIGNED' } });
    const legal = await login('ceo@hiva.local');
    expectOk(await post(`/contracts/${c.id}/amendments`, legal, {
      amendmentNumber: 'A-1', effectiveDate: day(0), changes: 'افزودن کشور دوم', valueDelta: 5_000,
    }), 'amendment');
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(Number(after.originalValue)).toBe(25_000);
    expect(Number(after.contractValue)).toBe(30_000_000_000);
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.contractCurrency).toBe('USD');
    expect(Number(project.originalContractValue)).toBe(25_000);
  });
});
