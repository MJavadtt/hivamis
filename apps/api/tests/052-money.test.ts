import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, expectOk, login, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { money, sumOf, toMoney } from '../src/lib/money.js';
import { buildTaxInvoice, type SellerProfile } from '../src/tax/invoice.js';

/**
 * Audit CALC-2: amounts were added up in floating point and rounded with Math.round — where 0.1 + 0.2
 * is 0.30000000000000004, 1.005 rounds to 1.00 and −2.5 rounds to −2. Each case here is one where
 * float and decimal disagree, and the system now gives the decimal answer.
 */
describe('Money computed exactly (audit CALC-2)', () => {
  it('adds and rounds as a person would: two places, half away from zero, once', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the float the code used to do
    expect(sumOf([0.1, 0.2]).toNumber()).toBe(0.3);
    expect(Math.round(1.005 * 100) / 100).toBe(1); // the old r2()
    expect(toMoney(1.005)).toBe(1.01);
    expect(Math.round(-2.5)).toBe(-2); // half towards +∞
    expect(toMoney(-2.5, 0)).toBe(-3);
    expect(toMoney(2.5, 0)).toBe(3);
    expect(toMoney(money('123456789012.345'))).toBe(123456789012.35);
  });

  it('prices an e-invoice line from the exact product, not a float a hair below the half', () => {
    const seller: SellerProfile = { memoryId: 'A1B2C3', sellerTaxId: '10101010101', economicCode: null, postalCode: null, branchCode: null, defaultServiceCode: '2720000114542', defaultUnitCode: '1627' };
    const buyer = { legalName: 'شرکت نمونه', nationalId: '14000000001', economicCode: null, postalCode: '1234567890' };
    // 1.005 × 100 is 100.5; in floating point, 100.49999999999999 — and Math.round made it 100.
    expect(Math.round(1.005 * 100)).toBe(100);
    const built = buildTaxInvoice({
      kind: 'INVOICE', state: 'ISSUED', number: 'F-9', issueDate: new Date('2026-09-20T08:00:00Z'), taxPercent: 10, total: 111, fxRate: 100, currency: 'USD',
      lines: [{ description: 'خدمت', quantity: 1, unitPrice: 1.005 }],
    }, buyer, seller, 'ORIGINAL', null, 'T'.repeat(22), 1);
    expect(built.body[0]).toMatchObject({ fee: 101, prdis: 101, vam: 10 });
  });

  describe('a project settled to the rial', () => {
    let finance: string, projectId: string;
    beforeAll(async () => {
      finance = await login('finance@hiva.local');
      const org = await prisma.organization.findFirstOrThrow();
      const company = await prisma.company.findFirstOrThrow({ where: { organizationId: org.id } });
      const owner = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
      projectId = (await prisma.project.create({
        data: { organizationId: org.id, code: await nextCode(prisma, 'project'), name: 'تسویهٔ دقیق', companyId: company.id, accountOwnerId: owner.id, state: 'ACTIVE', contractValue: 0.3 },
      })).id;
      // Billed 0.1 and 0.2; received 0.3, all against the second. In floats the balance is 5.55e-17.
      for (const [total, paid] of [[0.1, 0], [0.2, 0.3]] as const) {
        await prisma.invoice.create({
          data: { organizationId: org.id, code: await nextCode(prisma, 'invoice'), kind: 'INVOICE', number: `P-${total}`, companyId: company.id, projectId, issueDate: new Date(), subtotal: total, total, paidAmount: paid, state: 'ISSUED', createdById: owner.id },
        });
      }
    });
    afterAll(async () => { await closeApp(); });

    it('reads as fully settled — not as a balance of 0.00000000000000006 still owed', async () => {
      expect(0.1 + 0.2 - 0.3).not.toBe(0);
      const s = expectOk(await post(`/projects/${projectId}/settle`, finance, { notes: 'تسویه' }), 'settle');
      expect(s.status).toBe('FULLY_SETTLED');
      expect(Number(s.balance)).toBe(0);
    });
  });
});
