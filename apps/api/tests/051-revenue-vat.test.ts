import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, expectOk, get, login, patch, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { lastMonths, loadRevenueData, positionAt } from '../src/finance/revenue.js';

/**
 * Audit CALC-1: work in progress compared an invoice's total — VAT included — with revenue earned on a
 * contract value written without it, so every invoiced project looked billed ahead of its work. The
 * organisation now says how its contract values are written, and invoices are compared on that footing.
 */

const DAY = 86_400_000;
const now = new Date();
const [m2, m1] = lastMonths(3, now);
const at = (m: { start: Date }, days: number) => new Date(m.start.getTime() + days * DAY + 10 * 3_600_000);

let org: string, projectId: string, admin: string, finance: string;

beforeAll(async () => {
  admin = await login('admin@hiva.local');
  finance = await login('finance@hiva.local');
  org = (await prisma.organization.findFirstOrThrow()).id;
  const companyId = (await prisma.company.findFirstOrThrow({ where: { organizationId: org } })).id;
  const ownerId = (await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } })).id;
  // A 1,000,000,000 job, its single milestone done: fully earned, and billed once with 10% VAT —
  // 900,000,000 of the agency's work and 100,000,000 of media passed through for a vendor.
  projectId = (await prisma.project.create({
    data: { organizationId: org, code: await nextCode(prisma, 'project'), name: 'کمپین با مالیات', companyId, accountOwnerId: ownerId, state: 'ACTIVE', contractValue: 1_000_000_000, revenueMethod: 'MILESTONE', createdAt: at(m2!, 1) },
  })).id;
  await prisma.milestone.create({ data: { projectId, name: 'تحویل', dueDate: at(m2!, 10), revenueShare: 100, completedAt: at(m2!, 10) } });
  await prisma.invoice.create({
    data: {
      organizationId: org, code: await nextCode(prisma, 'invoice'), kind: 'INVOICE', number: 'VAT-1', companyId, projectId,
      issueDate: at(m1!, 5), subtotal: 1_000_000_000, taxPercent: 10, taxAmount: 100_000_000, total: 1_100_000_000, state: 'ISSUED', createdById: ownerId,
      lines: [
        { description: 'خدمات', quantity: 1, unitPrice: 900_000_000 },
        { description: 'رسانه', quantity: 1, unitPrice: 100_000_000, passThrough: true },
      ],
    },
  });
});
afterAll(async () => {
  await prisma.organization.update({ where: { id: org }, data: { contractValueIncludesTax: false } });
  await closeApp();
});

describe('Invoices compared on the contract value’s footing (audit CALC-1)', () => {
  it('without VAT — the default — compares the subtotal less pass-through: nothing is billed ahead', async () => {
    const pos = positionAt(await loadRevenueData(prisma, org, [projectId]), projectId, now);
    // Earned 1,000,000,000 of contract value; billed 900,000,000 of own work, before VAT.
    expect(pos).toMatchObject({ recognised: 1_000_000_000, invoiced: 900_000_000, wip: 100_000_000 });
    const report = expectOk(await get('/reports/revenue', finance), 'report');
    expect(report.contractValueIncludesTax).toBe(false);
    expect(report.projects.find((p: { id: string }) => p.id === projectId)).toMatchObject({ invoiced: 900_000_000, wip: 100_000_000 });
  });

  it('with VAT, compares the total less pass-through and its VAT', async () => {
    expect((await patch('/organization', admin, { contractValueIncludesTax: true })).status).toBe(200);
    const pos = positionAt(await loadRevenueData(prisma, org, [projectId]), projectId, now);
    // 1,100,000,000 billed, less the 100,000,000 pass-through and its 10,000,000 VAT.
    expect(pos).toMatchObject({ invoiced: 990_000_000, wip: 10_000_000 });
    expect(await prisma.auditEvent.count({ where: { entityType: 'organization', after: { path: ['contractValueIncludesTax'], equals: true } } })).toBe(1);
    expect((await patch('/organization', admin, { contractValueIncludesTax: false })).status).toBe(200);
  });

  it('leaves a closed month as it was closed; the setting moves only what is still open', async () => {
    const closed = expectOk(await post('/revenue/periods/close', finance, { period: m1!.period }), 'close');
    const frozenInvoiced = closed.totals.invoiced as number;
    await patch('/organization', admin, { contractValueIncludesTax: true });
    const report = expectOk(await get('/reports/revenue', finance), 'report');
    // Read now, this month's invoices would count their VAT; closed, it keeps what it was closed with.
    expect(report.months.find((m: { period: string }) => m.period === m1!.period)).toMatchObject({ closed: true, invoiced: frozenInvoiced });
    // The project, still open, is measured on the new footing.
    expect(report.projects.find((p: { id: string }) => p.id === projectId)).toMatchObject({ invoiced: 990_000_000 });
    await patch('/organization', admin, { contractValueIncludesTax: false });
  });
});
