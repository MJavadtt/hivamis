import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, expectOk, get, login, move, patch, post, put } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * The owner (2026-10-30): "make invoices and bookings editable too." An invoice is edited by its issuer
 * while it is a draft and by the system administrator in any state; a booking by its organiser while it
 * is a draft and by the system administrator at any stage. What the books and the calendar need holds
 * for everyone: totals from the lines, never below what was received, nothing the tax system is still
 * answering, nothing posted to accounting; a booking's room, things and people held again at its new
 * time or not at all, its replies, arrivals and meeting kept.
 */
describe('Editing an invoice (ADR-110)', () => {
  let T: Record<string, string>;
  let companyId: string;
  let admin: { id: string; organizationId: string };
  beforeAll(async () => {
    T = { finance: await login('finance@hiva.local'), admin: await login('admin@hiva.local') };
    admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' }, select: { id: true, organizationId: true } });
    companyId = (await prisma.company.findFirstOrThrow({ where: { organizationId: admin.organizationId, deletedAt: null }, select: { id: true } })).id;
  });
  afterAll(closeApp);

  let n = 0;
  const invoice = async (unitPrice = 1_000_000) => expectOk(await post('/invoices', T.finance, {
    kind: 'INVOICE', companyId, number: `ED-${Date.now()}-${++n}`, issueDate: '2026-10-01', taxPercent: 10,
    lines: [{ description: 'طراحی', quantity: 1, unitPrice }],
  }), 'invoice');
  const pay = async (invoiceId: string, amount: number) => expectOk(await post('/payments', T.finance, { invoiceId, direction: 'IN', amount, occurredAt: '2026-10-05', method: 'TRANSFER' }), 'payment');

  it('recomputes a draft’s totals from its new lines, and clears what it may lack', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { organizationId: admin.organizationId }, select: { id: true } });
    const inv = await invoice();
    expectOk(await patch(`/invoices/${inv.id}`, T.finance, { projectId: project.id }), 'project');
    const edited = expectOk(await patch(`/invoices/${inv.id}`, T.finance, {
      lines: [{ description: 'طراحی', quantity: 2, unitPrice: 500_000 }, { description: 'چاپ', quantity: 1, unitPrice: 200_000 }], projectId: null,
    }), 'edit');
    expect(Number(edited.subtotal)).toBe(1_200_000);
    expect(Number(edited.total)).toBe(1_320_000);
    expect(edited.projectId).toBeNull();
    // A total the client sends is never read.
    expect(Number(expectOk(await patch(`/invoices/${inv.id}`, T.finance, { total: 1 }), 'ignored').total)).toBe(1_320_000);
  });

  it('is its issuer’s while a draft, and the system administrator’s in any state', async () => {
    const inv = await invoice();
    expectOk(await move('invoice', inv.id, 'issue', T.finance), 'issue');
    expect((await patch(`/invoices/${inv.id}`, T.finance, { notes: 'دیرتر' })).body.error.code).toBe('INVOICE_NOT_DRAFT');
    const edited = expectOk(await patch(`/invoices/${inv.id}`, T.admin, { notes: 'تصحیح مدیر سیستم', number: `ED-ADMIN-${n}` }), 'admin');
    expect(edited).toMatchObject({ notes: 'تصحیح مدیر سیستم', state: 'ISSUED' });
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: inv.id, action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect(row.actorId).toBe(admin.id);
  });

  it('never goes below what was received, keeps its currency once paid, and its state follows the receipts', async () => {
    const inv = await invoice();
    expectOk(await move('invoice', inv.id, 'issue', T.finance), 'issue');
    expectOk(await move('invoice', inv.id, 'send', T.finance), 'send');
    await pay(inv.id, 600_000);
    expect((await patch(`/invoices/${inv.id}`, T.admin, { lines: [{ description: 'طراحی', quantity: 1, unitPrice: 500_000 }] })).body.error.code).toBe('INVOICE_BELOW_PAID');
    expect((await patch(`/invoices/${inv.id}`, T.admin, { currency: 'USD' })).body.error.code).toBe('INVOICE_CURRENCY_PAID');
    const settled = expectOk(await patch(`/invoices/${inv.id}`, T.admin, { taxPercent: 0, lines: [{ description: 'طراحی', quantity: 1, unitPrice: 600_000 }] }), 'down');
    expect(settled).toMatchObject({ state: 'PAID' });
    const reopened = expectOk(await patch(`/invoices/${inv.id}`, T.admin, { lines: [{ description: 'طراحی', quantity: 1, unitPrice: 900_000 }] }), 'up');
    expect(reopened).toMatchObject({ state: 'PARTIALLY_PAID' });
    expect(Number(reopened.paidAmount)).toBe(600_000);
  });

  it('leaves alone what the tax system is answering, and says when an accepted one needs its correction', async () => {
    const inv = await invoice();
    expectOk(await move('invoice', inv.id, 'issue', T.finance), 'issue');
    const sub = await prisma.taxSubmission.create({ data: { organizationId: admin.organizationId, invoiceId: inv.id, subject: 'ORIGINAL', serial: 1, taxId: `T${Date.now()}`.padEnd(22, '0'), payload: {}, createdById: admin.id, status: 'SENT' } });
    expect((await patch(`/invoices/${inv.id}`, T.admin, { lines: [{ description: 'طراحی', quantity: 1, unitPrice: 2_000_000 }] })).body.error.code).toBe('INVOICE_TAX_IN_FLIGHT');
    expect(expectOk(await patch(`/invoices/${inv.id}`, T.admin, { notes: 'یادداشت' }), 'notes').taxCorrectionDue).toBe(false);
    await prisma.taxSubmission.update({ where: { id: sub.id }, data: { status: 'ACCEPTED' } });
    expect(expectOk(await patch(`/invoices/${inv.id}`, T.admin, { lines: [{ description: 'طراحی', quantity: 1, unitPrice: 2_000_000 }] }), 'corrected').taxCorrectionDue).toBe(true);
  });

  it('keeps the amount, client and date of one posted to accounting', async () => {
    const inv = await invoice();
    const exp = await prisma.accountingExport.create({ data: { organizationId: admin.organizationId, number: 9000 + n, periodTo: new Date(), vouchers: 1, lines: 2, debitTotal: 0, creditTotal: 0, fileName: 'x.xlsx', content: '', createdById: admin.id } });
    await prisma.invoice.update({ where: { id: inv.id }, data: { accountingExportId: exp.id } });
    expect((await patch(`/invoices/${inv.id}`, T.admin, { taxPercent: 9 })).body.error.code).toBe('INVOICE_POSTED');
    expect((await patch(`/invoices/${inv.id}`, T.admin, { issueDate: '2026-09-01' })).body.error.code).toBe('INVOICE_POSTED');
    expectOk(await patch(`/invoices/${inv.id}`, T.admin, { dueDate: '2026-12-01', notes: 'پس از حسابداری' }), 'descriptive');
  });
});

const H = 3_600_000;
let slot = 0;
const nextSlot = () => {
  const start = new Date(Math.ceil(Date.now() / H) * H + (400 + slot * 3) * H);
  slot += 1;
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + H).toISOString() };
};

describe('Editing a booking (ADR-110)', () => {
  let T: Record<string, string>;
  let id: Record<string, string>;
  let room: string;
  beforeAll(async () => {
    T = { designer: await login('designer@hiva.local'), creative: await login('creative@hiva.local'), sales: await login('sales@hiva.local'), admin: await login('admin@hiva.local') };
    const users = await prisma.user.findMany({ where: { email: { in: ['sales@hiva.local'] } }, select: { id: true, email: true } });
    id = Object.fromEntries(users.map((u) => [u.email.split('@')[0]!, u.id]));
    room = (await prisma.bookableResource.findFirstOrThrow({ where: { name: 'اتاق جلسهٔ دماوند' }, select: { id: true } })).id;
  });
  afterAll(closeApp);

  const draft = (over: Record<string, unknown> = {}) => ({
    title: 'جلسهٔ ویرایش‌شدنی', roomId: room, participantIds: [id.sales], guests: [{ fullName: 'مهمان نمونه', company: 'شرکت نمونه' }], ...nextSlot(), ...over,
  });
  const step = (token: string, b: string, action: string) => post(`/workflow/booking/${b}/transitions`, token, { action });
  const confirmed = async (over: Record<string, unknown> = {}) => {
    const b = expectOk(await post('/bookings', T.designer, draft(over)), 'draft');
    expectOk(await step(T.designer, b.id, 'submit'), 'submit');
    expectOk(await step(T.creative, b.id, 'approve'), 'approve');
    expectOk(await step(T.designer, b.id, 'confirm'), 'confirm');
    return b;
  };

  it('is the system administrator’s at any stage: replies and arrivals kept, the room held at the new time, the meeting moved', async () => {
    const b = await confirmed();
    expectOk(await post(`/bookings/${b.id}/respond`, T.sales, { response: 'ACCEPTED' }), 'reply');
    const guest = await prisma.bookingGuest.findFirstOrThrow({ where: { bookingId: b.id } });
    await prisma.bookingGuest.update({ where: { id: guest.id }, data: { checkedInAt: new Date('2026-10-30T08:00:00Z') } });

    // Its organiser cannot change it once confirmed; the system administrator sees it editable.
    expect((await put(`/bookings/${b.id}`, T.designer, draft())).body.error.code).toBe('NOT_EDITABLE');
    expect(expectOk(await get(`/bookings/${b.id}`, T.admin), 'view').editable).toBe(true);

    const later = nextSlot();
    const edited = expectOk(await put(`/bookings/${b.id}`, T.admin, draft({ ...later, title: 'جلسهٔ جابه‌جاشده' })), 'edit');
    expect(edited).toMatchObject({ state: 'CONFIRMED', title: 'جلسهٔ جابه‌جاشده' });
    expect(edited.participants).toEqual([expect.objectContaining({ userId: id.sales, response: 'ACCEPTED' })]);
    expect((await prisma.bookingGuest.findUniqueOrThrow({ where: { id: guest.id } })).checkedInAt?.toISOString()).toBe('2026-10-30T08:00:00.000Z');
    const holds = await prisma.resourceHold.findMany({ where: { bookingId: b.id } });
    expect(holds.map((h) => h.startsAt.toISOString())).toEqual([later.startsAt]);
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: edited.meeting.id } });
    expect(meeting).toMatchObject({ subject: 'جلسهٔ جابه‌جاشده' });
    expect(meeting.heldAt.toISOString()).toBe(later.startsAt);
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: b.id, action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect((row.after as { asSystemAdministrator?: boolean }).asSystemAdministrator).toBe(true);
  });

  it('refuses a time its room is taken at, and changes nothing', async () => {
    const [a, other] = [await confirmed(), await confirmed()];
    const taken = expectOk(await get(`/bookings/${other.id}`, T.admin), 'other');
    const res = await put(`/bookings/${a.id}`, T.admin, draft({ startsAt: taken.startsAt, endsAt: taken.endsAt }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BOOKING_CONFLICT');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: a.id } })).startsAt.toISOString()).toBe(a.startsAt);
  });
});
