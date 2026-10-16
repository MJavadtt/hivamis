import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, expectOk, get, login, post, put } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { handleUpdate, sandboxChat } from '../src/messenger/service.js';
import { sandboxProvider } from '../src/messenger/provider.js';
import { peakUse } from '../src/bookings/availability.js';

/**
 * Audit F-9, step 2: meeting bookings in Hivamis. The organiser drafts; the approver named on the
 * booking decides; the organiser confirms, and only then are the room, the things and the people held —
 * by the database, which refuses an overlap whatever the application does. A confirmed booking is a
 * Hivamis meeting. A booking is read by those it concerns (finding 3), and the bot's buttons move it
 * through the same workflow, with its guards (finding 1).
 */

const H = 3_600_000;
/** A time well in the future, distinct per test, on the hour. */
let slot = 0;
const nextSlot = (hours = 1) => {
  const start = new Date(Math.ceil(Date.now() / H) * H + (72 + slot * 3) * H);
  slot += 1;
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + hours * H).toISOString() };
};

describe('Meeting bookings', () => {
  let T: Record<string, string>;
  let id: Record<string, string>;
  let rooms: Record<string, string>;
  const original = env.MESSENGER_MODE;

  beforeAll(async () => {
    env.MESSENGER_MODE = 'sandbox';
    T = {
      designer: await login('designer@hiva.local'), creative: await login('creative@hiva.local'), sales: await login('sales@hiva.local'),
      salesManager: await login('sales.manager@hiva.local'), ceo: await login('ceo@hiva.local'), admin: await login('admin@hiva.local'),
      strategy: await login('strategy@hiva.local'),
    };
    const users = await prisma.user.findMany({ where: { email: { in: ['designer@hiva.local', 'creative@hiva.local', 'sales@hiva.local', 'strategy@hiva.local', 'media@hiva.local'] } }, select: { id: true, email: true } });
    id = Object.fromEntries(users.map((u) => [u.email.split('@')[0]!, u.id]));
    const things = await prisma.bookableResource.findMany({ select: { id: true, name: true } });
    rooms = Object.fromEntries(things.map((t) => [t.name, t.id]));
  });
  afterAll(async () => { env.MESSENGER_MODE = original; await closeApp(); });

  const draft = (over: Record<string, unknown> = {}) => ({
    title: 'بازبینی کمپین پاییز', roomId: rooms['اتاق جلسهٔ دماوند'], participantIds: [id.sales], ...nextSlot(), ...over,
  });
  const move = (token: string, bookingId: string, action: string, extra: Record<string, unknown> = {}) =>
    post(`/workflow/booking/${bookingId}/transitions`, token, { action, ...extra });
  /** Drafted by the designer, sent, approved by their unit's manager. */
  async function approved(over: Record<string, unknown> = {}, who = 'designer') {
    const b = expectOk(await post('/bookings', T[who]!, draft(over)), 'draft');
    expectOk(await move(T[who]!, b.id, 'submit'), 'submit');
    expectOk(await move(T.creative!, b.id, 'approve'), 'approve');
    return b;
  }

  it('drafts with the unit manager as approver, and refuses names that are not the organisation’s or not of their kind', async () => {
    const b = expectOk(await post('/bookings', T.designer, draft({ guests: [{ fullName: 'مهسا نوری', company: 'پگاه سبز' }] })), 'draft');
    expect(b).toMatchObject({ state: 'DRAFT', approver: { id: id.creative }, editable: true });
    expect(b.code).toMatch(/^BKG-\d{6}$/);
    expect(b.availableTransitions.map((t: { action: string }) => t.action)).toEqual(['submit', 'cancel']);

    // Equipment is not a room; the organiser cannot approve their own; an unknown person is unknown.
    expect((await post('/bookings', T.designer, draft({ roomId: rooms['ویدئوپروژکتور سیار'] }))).body.error.code).toBe('UNKNOWN_REFERENCE');
    expect((await post('/bookings', T.creative, draft({ approverId: id.creative }))).body.error.code).toBe('NOT_AN_APPROVER');
    expect((await post('/bookings', T.designer, draft({ approverId: id.sales }))).body.error.code).toBe('NOT_AN_APPROVER');
    expect((await post('/bookings', T.designer, draft({ participantIds: ['00000000-0000-4000-8000-00000000dead'] }))).body.error.code).toBe('UNKNOWN_REFERENCE');
    const backwards = await post('/bookings', T.designer, { ...draft(), endsAt: new Date(Date.now() + 70 * H).toISOString(), startsAt: new Date(Date.now() + 71 * H).toISOString() });
    expect(backwards.status).toBe(400);

    // Only its organiser changes a draft.
    expect((await put(`/bookings/${b.id}`, T.sales, draft())).status).toBe(404);
    const edited = expectOk(await put(`/bookings/${b.id}`, T.designer, draft({ title: 'بازبینی کمپین پاییز — دور دوم' })), 'edit');
    expect(edited.title).toContain('دور دوم');
    expect(edited.guests).toHaveLength(0);
  });

  it('is decided by its approver alone, and holds nothing until its organiser confirms it', async () => {
    const b = expectOk(await post('/bookings', T.designer, draft({ parkingSpaces: 2 })), 'draft');
    expectOk(await move(T.designer, b.id, 'submit'), 'submit');
    expect(await prisma.slaClock.count({ where: { entityType: 'booking', entityId: b.id, state: { in: ['RUNNING', 'AT_RISK'] } } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: id.creative, kind: 'BOOKING_APPROVAL_REQUIRED', entityId: b.id } })).toBe(1);

    // Another manager holds meeting.approve, but this booking is not theirs to decide.
    const other = await move(T.salesManager, b.id, 'approve');
    expect(other.status).toBe(404); // and they cannot even see it
    const strategy = await move(T.strategy, b.id, 'approve');
    expect(strategy.status).toBe(404);
    // The organiser holds no meeting.approve.
    expect((await move(T.designer, b.id, 'approve')).status).toBe(403);

    expectOk(await move(T.creative, b.id, 'approve'), 'approve');
    expect(await prisma.resourceHold.count({ where: { bookingId: b.id } })).toBe(0);
    // The approver cannot confirm it for the organiser.
    const byApprover = await move(T.creative, b.id, 'confirm');
    expect(byApprover.status).toBe(422);
    expect(byApprover.body.error.details.rule).toBe('رزرو جلسه');

    const done = expectOk(await move(T.designer, b.id, 'confirm'), 'confirm');
    expect(done.toState).toBe('CONFIRMED');
    const holds = await prisma.resourceHold.findMany({ where: { bookingId: b.id }, select: { exclusive: true, spaces: true } });
    expect(holds).toEqual(expect.arrayContaining([{ exclusive: true, spaces: 1 }, { exclusive: false, spaces: 2 }]));
    expect(await prisma.personHold.count({ where: { bookingId: b.id } })).toBe(2);

    // The booking is a Hivamis meeting now, where its minutes will be kept.
    const view = expectOk(await get(`/bookings/${b.id}`, T.designer), 'view');
    expect(view.meeting.code).toMatch(/^MTG-/);
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: view.meeting.id } });
    expect(meeting.attendees).toContain('بهراد');
    expect(await prisma.auditEvent.count({ where: { entityType: 'meeting', entityId: meeting.id, action: 'CREATE' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: id.sales, kind: 'BOOKING_INVITED', entityId: b.id } })).toBe(1);
  });

  it('refuses a time already taken, says by what, and offers the next times that work', async () => {
    const first = await approved();
    expectOk(await move(T.designer, first.id, 'confirm'), 'confirm');
    const taken = await prisma.booking.findUniqueOrThrow({ where: { id: first.id } });
    const same = { startsAt: taken.startsAt.toISOString(), endsAt: taken.endsAt.toISOString() };

    // Someone else, the same room, half an hour into the first meeting.
    const half = { startsAt: new Date(taken.startsAt.getTime() + H / 2).toISOString(), endsAt: new Date(taken.endsAt.getTime() + H / 2).toISOString() };
    const b = expectOk(await post('/bookings', T.salesManager, { title: 'جلسهٔ فروش', roomId: rooms['اتاق جلسهٔ دماوند'], participantIds: [], ...half, approverId: id.creative }), 'draft');
    const refused = await move(T.salesManager, b.id, 'submit');
    expect(refused.status).toBe(422);
    const conflicts = refused.body.error.details.conflicts as { kind: string; nameFa: string; bookingCode?: string }[];
    expect(conflicts).toEqual([expect.objectContaining({ kind: 'ROOM', nameFa: 'اتاق جلسهٔ دماوند' })]);
    // Not theirs to read, so not named.
    expect(conflicts[0]!.bookingCode).toBeUndefined();

    // A meeting ending as the other starts does not collide.
    const after = { startsAt: taken.endsAt.toISOString(), endsAt: new Date(taken.endsAt.getTime() + H).toISOString() };
    const check = expectOk(await post('/bookings/availability', T.salesManager, { ...after, roomId: rooms['اتاق جلسهٔ دماوند'] }), 'availability');
    expect(check.available).toBe(true);

    // A participant held elsewhere is named; the organiser of both sees the other booking's code.
    const mine = expectOk(await post('/bookings/availability', T.designer, { ...same, roomId: rooms['اتاق جلسهٔ البرز'], participantIds: [id.sales] }), 'availability');
    expect(mine.available).toBe(false);
    expect(mine.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PERSON', nameFa: 'الهام کریمی', bookingCode: first.code }),
    ]));
    expect(mine.freeRooms.map((r: { name: string }) => r.name)).not.toContain('اتاق جلسهٔ دماوند');
    expect(mine.suggestions.length).toBeGreaterThan(0);
  });

  it('cannot hold one room twice, even when two confirmations race', async () => {
    const t = nextSlot();
    const a = await approved({ ...t, roomId: rooms['اتاق گفت‌وگوی کوچک'], participantIds: [] });
    const b = await approved({ ...t, roomId: rooms['اتاق گفت‌وگوی کوچک'], participantIds: [], approverId: id.creative }, 'sales');
    const [ra, rb] = await Promise.all([move(T.designer, a.id, 'confirm'), move(T.sales, b.id, 'confirm')]);
    // One wins; the other is refused — by the check under the lock (409) or by the guard after (422).
    const statuses = [ra.status, rb.status];
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.find((s) => s !== 200)).toBeOneOf([409, 422]);
    expect(await prisma.resourceHold.count({ where: { resourceId: rooms['اتاق گفت‌وگوی کوچک']!, bookingId: { in: [a.id, b.id] } } })).toBe(1);

    // And the database itself refuses a second overlapping hold, whatever wrote it.
    const winner = ra.status === 200 ? a : b;
    const held = await prisma.resourceHold.findFirstOrThrow({ where: { bookingId: winner.id } });
    await expect(prisma.resourceHold.create({
      data: { organizationId: held.organizationId, resourceId: held.resourceId, bookingId: (ra.status === 200 ? b : a).id, startsAt: held.startsAt, endsAt: held.endsAt },
    })).rejects.toThrow(/exclusion|23P01/);
  });

  it('shares parking up to its capacity, at the busiest moment', async () => {
    expect(peakUse([
      { startsAt: new Date(0), endsAt: new Date(2 * H), spaces: 3 },
      { startsAt: new Date(2 * H), endsAt: new Date(4 * H), spaces: 3 },
    ], { startsAt: new Date(0), endsAt: new Date(4 * H) })).toBe(3);
    const t = nextSlot(2);
    const a = await approved({ ...t, roomId: null, placeNote: 'لابی', participantIds: [], parkingSpaces: 4 });
    expectOk(await move(T.designer, a.id, 'confirm'), 'confirm');
    const tooMany = expectOk(await post('/bookings/availability', T.sales, { ...t, parkingSpaces: 3 }), 'availability');
    expect(tooMany.conflicts).toEqual([expect.objectContaining({ kind: 'PARKING' })]);
    const fits = expectOk(await post('/bookings/availability', T.sales, { ...t, parkingSpaces: 2 }), 'availability');
    expect(fits.available).toBe(true);
  });

  it('is read only by those it concerns (finding 3)', async () => {
    const b = expectOk(await post('/bookings', T.designer, draft({ title: 'جلسهٔ محرمانهٔ بودجه' })), 'draft');
    for (const path of [`/bookings/${b.id}`, `/workflow/booking/${b.id}/history`, `/workflow/booking/${b.id}/preflight`, `/workflow/booking/${b.id}/available`]) {
      expect((await get(path, T.salesManager)).status, path).toBe(404);
    }
    expect((await get(`/bookings/${b.id}`, T.sales)).status).toBe(200); // a participant
    expect((await get(`/bookings/${b.id}`, T.ceo)).status).toBe(200); // meeting.view_all
    expect((await get('/bookings', T.salesManager, { scope: 'all' })).status).toBe(403);
    const all = expectOk(await get('/bookings', T.ceo, { scope: 'all', pageSize: '200' }), 'all');
    expect(all.items.map((x: { id: string }) => x.id)).toContain(b.id);
    const theirs = expectOk(await get('/bookings', T.salesManager, { scope: 'mine', pageSize: '200' }), 'mine');
    expect(theirs.items.map((x: { id: string }) => x.id)).not.toContain(b.id);
  });

  it('goes back for approval at a new time, lets go of what it held, and keeps its meeting in step', async () => {
    const b = await approved();
    expectOk(await move(T.designer, b.id, 'confirm'), 'confirm');
    const meetingId = (await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).meetingId!;
    const t = nextSlot();
    expect((await move(T.designer, b.id, 'reschedule', { reason: 'مشتری دیرتر می‌رسد' })).status).toBe(422);
    expectOk(await move(T.designer, b.id, 'reschedule', { reason: 'مشتری دیرتر می‌رسد', payload: t }), 'reschedule');
    expect(await prisma.resourceHold.count({ where: { bookingId: b.id } })).toBe(0);
    expectOk(await move(T.creative, b.id, 'approve'), 'approve');
    expectOk(await move(T.designer, b.id, 'confirm'), 'confirm');
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting.heldAt.toISOString()).toBe(t.startsAt);
  });

  it('when cancelled, lets go of everything and takes back a meeting never held', async () => {
    const b = await approved();
    expectOk(await move(T.designer, b.id, 'confirm'), 'confirm');
    const meetingId = (await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).meetingId!;
    expect((await move(T.sales, b.id, 'cancel', { reason: 'نمی‌آیم' })).status).toBe(422);
    expectOk(await move(T.designer, b.id, 'cancel', { reason: 'کمپین عقب افتاد' }), 'cancel');
    expect(await prisma.resourceHold.count({ where: { bookingId: b.id } })).toBe(0);
    expect(await prisma.personHold.count({ where: { bookingId: b.id } })).toBe(0);
    expect(await prisma.meeting.findUnique({ where: { id: meetingId } })).toBeNull();
    expect(await prisma.auditEvent.count({ where: { entityType: 'meeting', entityId: meetingId, action: 'DELETE' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: id.sales, kind: 'BOOKING_CANCELLED', entityId: b.id } })).toBe(1);
  });

  it('is decided from the chat by single-use buttons that go through the same workflow (finding 1)', async () => {
    // The approver links the sandbox chat.
    const { code } = expectOk(await post('/messenger/link', T.creative), 'link');
    expectOk(await post('/messenger/sandbox/send', T.creative, { text: code }), 'linked');

    const b = expectOk(await post('/bookings', T.designer, draft()), 'draft');
    expectOk(await move(T.designer, b.id, 'submit'), 'submit');
    const sent = await prisma.messengerMessage.findFirstOrThrow({ where: { userId: id.creative, notificationKind: 'BOOKING_APPROVAL_REQUIRED', direction: 'OUT' }, orderBy: { createdAt: 'desc' } });
    const [approve] = (sent.buttons as { action?: string }[][])[0]!;
    // Someone else's chat pressing the approver's button: refused.
    const press = (chat: string, action: string) => handleUpdate(sandboxProvider, { callback_query: { id: 'cb', data: `a:${action}`, message: { chat: { id: chat } } } });
    expect((await press(sandboxChat(id.designer!), approve!.action!)).answer).toBe('این دکمه برای شما نیست.');
    const answer = (await press(sandboxChat(id.creative!), approve!.action!)).answer!;
    expect(answer).toContain('رزرو تأیید شد');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).state).toBe('APPROVED');
    const row = await prisma.stateTransition.findFirstOrThrow({ where: { entityType: 'booking', entityId: b.id, action: 'approve' } });
    expect(row.actorId).toBe(id.creative);
    // Once.
    expect((await press(sandboxChat(id.creative!), approve!.action!)).answer).toBe('این دکمه پیش‌تر به کار رفته است.');
  });

  it('keeps places and things to whoever manages them, with an audit row', async () => {
    expect((await post('/booking/resources', T.designer, { type: 'ROOM', name: 'اتاق تازه', capacity: 4 })).status).toBe(403);
    const made = await post('/booking/resources', T.admin, { type: 'ROOM', name: 'اتاق تازه', capacity: 4, features: ['DISPLAY'] });
    expect(made.status).toBe(201);
    expect(await prisma.auditEvent.count({ where: { entityType: 'bookableResource', entityId: made.body.id, action: 'CREATE' } })).toBe(1);
    expect((await post('/booking/resources', T.admin, { type: 'PARKING', name: 'پارکینگ صفر', capacity: 0 })).status).toBe(400);
    const schedule = expectOk(await get(`/booking/resources/${rooms['اتاق جلسهٔ دماوند']}/schedule`, T.salesManager, { from: new Date().toISOString(), to: new Date(Date.now() + 20 * 86_400_000).toISOString() }), 'schedule');
    // Held slots are shown; whose, only to those it concerns.
    expect(schedule.slots.length).toBeGreaterThan(0);
    expect(schedule.slots.every((s: { title?: string }) => s.title === undefined)).toBe(true);
  });
});
