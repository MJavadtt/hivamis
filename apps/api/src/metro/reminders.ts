import { METRO_BOOKING_LABELS } from '@hiva/contracts';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { notify } from '../mail/notify.js';
import { holdersOf } from '../sites/people.js';

/**
 * Metro bookings' daily round (ADR-135), as the venues module's reminders are: a confirmed booking
 * whose first day has come starts running; a running one whose last day has passed ends; one ending
 * within the organisation's days is told to its owner and to whoever books, once; a hold left longer
 * than its days is told to its owner, once.
 */
export async function runMetroReminders(now = new Date()) {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const out = { started: 0, ended: 0, ending: 0, holds: 0 };
  const settings = await prisma.metroSettings.findMany({ take: 1000 });
  for (const s of settings) {
    const org = s.organizationId;
    const started = await prisma.metroBooking.findMany({ where: { organizationId: org, state: 'CONFIRMED', startDate: { lte: today }, endDate: { gte: today } }, select: { id: true }, take: 1000 });
    const ended = await prisma.metroBooking.findMany({ where: { organizationId: org, state: { in: ['CONFIRMED', 'ACTIVE'] }, endDate: { lt: today } }, select: { id: true }, take: 1000 });
    for (const [rows, to] of [[started, 'ACTIVE'], [ended, 'ENDED']] as const) {
      for (const b of rows) {
        await prisma.metroBooking.update({ where: { id: b.id }, data: { state: to } });
        await audit({ organizationId: org, action: 'STATE_TRANSITION', entityType: 'metroBooking', entityId: b.id, after: { state: to }, reason: 'the booking’s dates, by the daily round' });
      }
    }
    out.started += started.length; out.ended += ended.length;

    const bookers = await holdersOf(org, 'metro.book', { inOwnRight: true });
    const soon = new Date(today.getTime() + s.endingSoonDays * 86_400_000);
    const ending = await prisma.metroBooking.findMany({ where: { organizationId: org, state: { in: ['CONFIRMED', 'ACTIVE'] }, endDate: { gte: today, lte: soon }, endingNotifiedAt: null }, take: 500 });
    for (const b of ending) {
      const days = Math.round((b.endDate.getTime() - today.getTime()) / 86_400_000);
      for (const userId of new Set([b.ownerId, ...bookers].filter((x): x is string => !!x))) {
        await notify({ userId, kind: 'METRO_ENDING', title: `رزرو مترو ${b.code} ${days === 0 ? 'امروز' : `${days} روز دیگر`} به پایان می‌رسد`, entityType: 'metroBooking', entityId: b.id, severity: 'WARNING' });
      }
      await prisma.metroBooking.update({ where: { id: b.id }, data: { endingNotifiedAt: now } });
      out.ending++;
    }
    const stale = new Date(today.getTime() - s.holdDays * 86_400_000);
    const holds = await prisma.metroBooking.findMany({ where: { organizationId: org, state: 'HOLD', createdAt: { lt: stale }, holdNotifiedAt: null }, take: 500 });
    for (const b of holds) {
      await notify({ userId: b.ownerId ?? b.createdById, kind: 'METRO_HOLD', title: `رزرو موقت مترو ${b.code} هنوز قطعی نشده است (${METRO_BOOKING_LABELS.HOLD.fa})`, entityType: 'metroBooking', entityId: b.id, severity: 'WARNING' });
      await prisma.metroBooking.update({ where: { id: b.id }, data: { holdNotifiedAt: now } });
      out.holds++;
    }
  }
  return out;
}
