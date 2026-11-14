import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, get, login, move, patch, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { priceMedia } from '../src/routes/media.js';
import { loadRevenueData, positionAt } from '../src/finance/revenue.js';

let T: Record<string, string>;
let projectId: string, vendorId: string;
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY);

beforeAll(async () => {
  T = {
    media: await login('media@hiva.local'),
    accountManager: await login('account.manager@hiva.local'),
    designer: await login('designer@hiva.local'),
    finance: await login('finance@hiva.local'),
  };
  const org = await prisma.organization.findFirstOrThrow();
  const company = await prisma.company.findFirstOrThrow();
  const owner = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
  // A service contract of 500,000,000 with no progress yet — so anything earned here is media commission.
  projectId = (await prisma.project.create({
    data: { organizationId: org.id, code: await nextCode(prisma, 'project'), name: 'کمپین تلویزیونی نوروز', companyId: company.id, accountOwnerId: owner.id, state: 'ACTIVE', contractValue: 500_000_000, createdAt: day(-30) },
  })).id;
  vendorId = (await prisma.supplier.create({ data: { organizationId: org.id, name: 'شبکهٔ تلویزیونی نمونه', kind: 'SUPPLIER', departmentCode: 'ME' } })).id;
});
afterAll(async () => { await closeApp(); });

const order = (token: string, extra: Record<string, unknown> = {}) => post('/media-orders', token, {
  projectId, supplierId: vendorId, channel: 'TV', placement: 'تیزر ۳۰ ثانیه‌ای، پیش از اخبار ۲۱، ۲۰ نوبت',
  flightStart: day(-5).toISOString(), flightEnd: day(-1).toISOString(),
  pricingModel: 'COMMISSION', amount: 1_000_000_000, commissionPercent: 15, ...extra,
});

describe('The money in a media order', () => {
  it('prices commission against gross, and markup against net', () => {
    expect(priceMedia('COMMISSION', 1_000_000_000, 15)).toEqual({ client: expect.anything(), net: expect.anything() });
    const c = priceMedia('COMMISSION', 1_000_000_000, 15);
    expect([Number(c.client), Number(c.net)]).toEqual([1_000_000_000, 850_000_000]);
    const m = priceMedia('MARKUP', 1_000_000_000, 10);
    expect([Number(m.client), Number(m.net)]).toEqual([1_100_000_000, 1_000_000_000]);
  });

  it('is written by the media unit or Account, and booked only by them', async () => {
    expect((await order(T.designer)).status).toBe(403);           // a unit role, but not the media unit
    const o = expectOk(await order(T.media), 'order');
    expect(o.code).toMatch(/^MO-/);
    expect(o.state).toBe('DRAFT');
    expect([Number(o.clientAmount), Number(o.netAmount), Number(o.agencyRevenue)]).toEqual([1_000_000_000, 850_000_000, 150_000_000]);
    // A unit role outside the media unit does not even see the order (ADR-127).
    expect((await move('mediaOrder', o.id, 'book', T.designer)).status).toBe(404);
  });
});

describe('From booking to reconciliation', () => {
  let id: string;
  it('changes a draft, then books it — after which it is a commitment', async () => {
    id = expectOk(await order(T.media), 'order').id;
    const changed = expectOk(await patch(`/media-orders/${id}`, T.media, { amount: 1_200_000_000 }), 'change');
    expect(Number(changed.netAmount)).toBe(1_020_000_000);
    expectOk(await move('mediaOrder', id, 'book', T.media), 'book');
    expect((await patch(`/media-orders/${id}`, T.media, { amount: 1 })).body.error.code).toBe('MEDIA_ORDER_NOT_DRAFT');
  });

  it('bills the client on an intermediary invoice, pass-through and commission on separate lines', async () => {
    const draft = expectOk(await order(T.media), 'another');
    const bad = await post(`/projects/${projectId}/media-billing`, T.finance, { orderIds: [id, draft.id], number: 'M-1', issueDate: new Date().toISOString() });
    expect(bad.body.error.code).toBe('MEDIA_BILLING_INVALID');
    expect(bad.body.error.details.problems.join(' ')).toContain('هنوز رزرو نشده');
    const inv = expectOk(await post(`/projects/${projectId}/media-billing`, T.finance, { orderIds: [id], number: 'M-1', issueDate: new Date().toISOString() }), 'bill');
    expect(Number(inv.total)).toBe(1_200_000_000);
    expect(inv.lines).toEqual([
      expect.objectContaining({ unitPrice: 1_020_000_000, passThrough: true }),
      expect.objectContaining({ unitPrice: 180_000_000, passThrough: false }),
    ]);
    expect((await post(`/projects/${projectId}/media-billing`, T.finance, { orderIds: [id], number: 'M-2', issueDate: new Date().toISOString() })).body.error.details.problems[0]).toContain('پیش‌تر صورت‌حساب');
  });

  it('keeps its lines pass-through and commission when finance edits it — and no line may claim another invoice\'s order', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { number: 'M-1' } });
    const lines = inv.lines as { description: string; quantity: number; unitPrice: number; passThrough: boolean; mediaOrderId: string }[];
    // As the invoice dialog sends it: every line back, one description reworded.
    const edited = lines.map((l, i) => (i === 1 ? { ...l, description: `${l.description} — اصلاح‌شده` } : l));
    const after = expectOk(await patch(`/invoices/${inv.id}`, T.finance, { lines: edited }), 'edit');
    expect(after.lines).toEqual([
      expect.objectContaining({ passThrough: true, mediaOrderId: lines[0]!.mediaOrderId }),
      expect.objectContaining({ passThrough: false, description: expect.stringContaining('اصلاح‌شده') }),
    ]);
    expect(Number(after.total)).toBe(1_200_000_000);
    const other = expectOk(await order(T.media), 'another order');
    await prisma.mediaOrder.update({ where: { id: other.id }, data: { clientInvoiceId: (await prisma.invoice.findFirstOrThrow({ where: { NOT: { id: inv.id } } })).id } });
    const claim = await patch(`/invoices/${inv.id}`, T.finance, { lines: [{ ...edited[0]!, mediaOrderId: other.id }, edited[1]] });
    expect(claim.body.error.code).toBe('INVOICE_MEDIA_ORDER');
    await prisma.mediaOrder.update({ where: { id: other.id }, data: { clientInvoiceId: null } });
  });

  it('confirms delivery with its proof, and earns the commission then — not the pass-through', async () => {
    expect((await move('mediaOrder', id, 'confirm_delivery', T.media)).status).toBe(400);    // proof is required
    expectOk(await move('mediaOrder', id, 'confirm_delivery', T.media, 'گواهی پخش ۲۰ نوبت از رسانه دریافت شد'), 'aired');
    const o = await prisma.mediaOrder.findUniqueOrThrow({ where: { id } });
    expect(o.proofNote).toContain('گواهی پخش');

    const pos = positionAt(await loadRevenueData(prisma, o.organizationId, [projectId]), projectId, new Date());
    expect(pos.recognised).toBe(180_000_000);          // the commission; the 500,000,000 contract has no progress
    expect(pos.invoiced).toBe(180_000_000);            // 1,200,000,000 billed, of which 1,020,000,000 passed through
    expect(pos.wip).toBe(0);
  });

  it('reconciles only against the vendor’s invoice — or a written reason for the difference', async () => {
    expect((await move('mediaOrder', id, 'reconcile', T.finance)).body.error.message).toContain('هنوز ثبت نشده');
    const off = expectOk(await post(`/media-orders/${id}/vendor-invoice`, T.finance, { number: 'TV-8891', amount: 1_050_000_000, invoiceDate: new Date().toISOString() }), 'vendor invoice');
    expect(off).toMatchObject({ expected: 1_020_000_000, difference: 30_000_000, matches: false });
    const blocked = await move('mediaOrder', id, 'reconcile', T.finance);
    expect(blocked.body.error.details.difference).toBe(30_000_000);
    expectOk(await post(`/media-orders/${id}/vendor-invoice`, T.finance, { number: 'TV-8891', amount: 1_050_000_000, invoiceDate: new Date().toISOString(), discrepancyNote: 'دو نوبت پخش جبرانی اضافه با تأیید مشتری' }), 'explained');
    expectOk(await move('mediaOrder', id, 'reconcile', T.finance), 'reconcile');

    // Paying the vendor is a pass-through too: not the project's cost.
    expectOk(await post('/payments', T.finance, { direction: 'OUT', amount: 1_050_000_000, projectId, mediaOrderId: id, occurredAt: new Date().toISOString() }), 'pay vendor');
    const data = await loadRevenueData(prisma, (await prisma.organization.findFirstOrThrow()).id, [projectId]);
    expect(data.paymentsOut.get(projectId) ?? []).toHaveLength(0);
  });
});

describe('Media in another currency, and the media report', () => {
  it('books a dollar order at today’s rate and keeps the originals', async () => {
    const org = await prisma.organization.findFirstOrThrow();
    const creator = await prisma.user.findFirstOrThrow({ where: { email: 'finance@hiva.local' } });
    await prisma.exchangeRate.create({ data: { organizationId: org.id, currency: 'USD', rate: 1_000_000, effectiveDate: new Date(new Date().toISOString().slice(0, 10)), createdById: creator.id } });
    const o = expectOk(await order(T.accountManager, { channel: 'DIGITAL', placement: 'تبلیغات شبکه‌های اجتماعی', pricingModel: 'MARKUP', amount: 2_000, commissionPercent: 12, currency: 'USD' }), 'usd order');
    expect(o.currency).toBe('USD');
    expect([Number(o.originalNetAmount), Number(o.originalClientAmount)]).toEqual([2_000, 2_240]);
    expect([Number(o.netAmount), Number(o.clientAmount), Number(o.agencyRevenue)]).toEqual([2_000_000_000, 2_240_000_000, 240_000_000]);
  });

  it('shows billings, pass-through and the agency’s share — and where money is getting lost', async () => {
    const aired = expectOk(await order(T.media, { placement: 'بیلبورد بزرگراه، یک ماه', channel: 'OUTDOOR', commissionPercent: 20, amount: 300_000_000 }), 'outdoor');
    expectOk(await move('mediaOrder', aired.id, 'book', T.media), 'book');
    expectOk(await move('mediaOrder', aired.id, 'confirm_delivery', T.media, 'عکس نصب بیلبورد دریافت شد'), 'aired');
    const unproven = expectOk(await order(T.media, { placement: 'رادیو، ۱۰ نوبت', channel: 'RADIO', amount: 50_000_000 }), 'radio');
    expectOk(await move('mediaOrder', unproven.id, 'book', T.media), 'book radio');

    const r = expectOk(await get('/reports/media', T.finance), 'media report');
    expect(r.totals.billings).toBe(r.totals.passThrough + r.totals.revenue);
    expect(r.byChannel.find((c: any) => c.key === 'OUTDOOR')).toMatchObject({ billings: 300_000_000, passThrough: 240_000_000, revenue: 60_000_000, effectivePercent: 20 });
    expect(r.exceptions.unbilled.map((o: any) => o.id)).toContain(aired.id);               // ran, not billed
    expect(r.exceptions.awaitingVendorInvoice.map((o: any) => o.id)).toContain(aired.id);  // ran, vendor silent
    expect(r.exceptions.unproven.map((o: any) => o.id)).toContain(unproven.id);            // flight over, no proof
    expect(r.exceptions.discrepancies.length).toBeGreaterThanOrEqual(1);                   // the explained one stays visible
    expect((await get('/reports/media', T.designer)).status).toBe(200);                    // units read pricing
  });
});
