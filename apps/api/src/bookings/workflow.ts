import { BOOKING_MAX_HOURS, permissionsForRoles } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { grantsOf } from '../auth/grants.js';
import { applyOverrides, overridesOf } from '../auth/overrides.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';
import { claimsFor } from '../auth/claims.js';
import type { GuardContext, GuardResult } from '../workflow/guards.js';
import type { EffectContext } from '../workflow/effects.js';
import { conflictsFor } from './availability.js';
import { hold, release } from './holds.js';

/**
 * The booking workflow's rules and effects (audit F-9). The meeting platform checked its rules in
 * route handlers, and its bot skipped them (finding 1). Here they are named guards the engine runs on
 * every way in — page, Mini App, bot button — answering 422 with the rule.
 */

const pass: GuardResult = { ok: true };
const RULE = 'رزرو جلسه';
const refuse = (messageFa: string, details?: unknown): GuardResult => ({ ok: false, rule: RULE, messageFa, ...(details ? { details } : {}) });

/** What a booking asks for besides its own row. */
export async function needsOf(tx: Tx, bookingId: string) {
  const [people, resources] = await Promise.all([
    tx.bookingParticipant.findMany({ where: { bookingId }, select: { userId: true } }),
    tx.bookingResource.findMany({ where: { bookingId }, select: { resourceId: true } }),
  ]);
  return { participantIds: people.map((p) => p.userId), resourceIds: resources.map((r) => r.resourceId) };
}

/**
 * Who may be named to decide bookings: active people whose own roles grant meeting.approve, as the
 * organisation granted them. A stand-in by delegation decides for the approver; they are not named.
 */
export async function approverIds(organizationId: string, among?: readonly string[]): Promise<Set<string>> {
  const { map } = await grantsOf(organizationId);
  const users = await prisma.user.findMany({
    where: { organizationId, isActive: true, deletedAt: null, ...(among ? { id: { in: [...among] } } : {}) },
    select: { id: true, roles: { select: { role: { select: { code: true } } } } }, take: 5000,
  });
  const own = await overridesOf(users.map((u) => u.id));
  return new Set(users.filter((u) => applyOverrides(permissionsForRoles(u.roles.map((r) => r.role.code), map), own.get(u.id)).includes('meeting.approve')).map((u) => u.id));
}

export const mayApprove = async (userId: string, organizationId: string) => (await approverIds(organizationId, [userId])).has(userId);

/** A new time sent with a reschedule, if it is one: two instants, in order, in the future, not too long. */
function newTime(payload: Record<string, unknown>): { startsAt: Date; endsAt: Date } | null {
  const s = new Date(String(payload.startsAt ?? '')), e = new Date(String(payload.endsAt ?? ''));
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return null;
  if (e.getTime() - s.getTime() > BOOKING_MAX_HOURS * 3_600_000 || s.getTime() <= Date.now()) return null;
  return { startsAt: s, endsAt: e };
}

export const BOOKING_GUARDS: Record<string, (c: GuardContext) => Promise<GuardResult>> = {
  'booking.organizerOnly': async ({ record, actorId }) =>
    record.organizerId === actorId ? pass : refuse('این کار با برگزارکنندهٔ جلسه است.'),

  /** Cancelling is the organiser's, or the office's: whoever holds meeting.view_all. */
  'booking.organizerOrOverseer': async ({ record, actorId }) => {
    if (record.organizerId === actorId) return pass;
    const { claims } = await claimsFor(actorId);
    return claims.permissions.includes('meeting.view_all') ? pass : refuse('رزرو را برگزارکننده یا مسئول رزروهای سازمان لغو می‌کند.');
  },

  'booking.inFuture': async ({ record }) =>
    new Date(record.startsAt) > new Date() ? pass : refuse('زمان جلسه گذشته است؛ زمان تازه‌ای بگذارید.'),

  'booking.approverAssigned': async ({ record }) => {
    if (!record.approverId || record.approverId === record.organizerId) return refuse('برای این رزرو تأییدکننده‌ای جز خود برگزارکننده تعیین نشده است.');
    return (await mayApprove(record.approverId, record.organizationId))
      ? pass
      : refuse('تأییدکنندهٔ این رزرو دیگر دسترسی «تأیید رزرو جلسه» را ندارد؛ تأییدکنندهٔ دیگری برگزینید.');
  },

  /** The approver named on the booking decides it, or whoever stands in for them by a delegation. */
  'booking.assignedApprover': async ({ tx, record, actorId }) => {
    if (record.approverId === actorId) return pass;
    const now = new Date();
    const standIn = record.approverId && await tx.delegation.count({
      where: { fromUserId: record.approverId, toUserId: actorId, permissions: { has: 'meeting.approve' }, revokedAt: null, startsAt: { lte: now }, endsAt: { gte: now } },
    });
    return standIn ? pass : refuse('این رزرو را تأییدکنندهٔ تعیین‌شده یا جانشین او تصمیم می‌گیرد.');
  },

  'booking.newTimeGiven': async ({ payload, record }) => {
    const t = newTime(payload);
    if (!t) return refuse('زمان تازه را بدهید: آغاز و پایان، در آینده، و نه بیش از ۱۲ ساعت.');
    return t.startsAt.getTime() === new Date(record.startsAt).getTime() && t.endsAt.getTime() === new Date(record.endsAt).getTime()
      ? refuse('زمان تازه همان زمان پیشین است.')
      : pass;
  },

  /** Nothing the booking needs is taken in its time — said by name, the database's word to come. */
  'booking.noConflict': async ({ tx, id, record, payload, actorId }) => {
    const t = newTime(payload) ?? { startsAt: new Date(record.startsAt), endsAt: new Date(record.endsAt) };
    const needs = await needsOf(tx, id);
    const conflicts = await conflictsFor(tx, record.organizationId, {
      ...t, roomId: record.roomId, resourceIds: needs.resourceIds, personIds: [record.organizerId, ...needs.participantIds],
      parkingId: record.parkingId, parkingSpaces: record.parkingSpaces, excludeBookingId: id,
    }, { id: actorId, organizationId: record.organizationId, permissions: [] });
    return conflicts.length ? refuse(conflicts.map((c) => c.messageFa).join(' '), { conflicts }) : pass;
  },

  'booking.hasEnded': async ({ record }) =>
    new Date(record.endsAt) <= new Date() ? pass : refuse('جلسه هنوز تمام نشده است.'),
};

export const BOOKING_GUARD_LABELS: Record<string, string> = {
  'booking.organizerOnly': 'کار با برگزارکنندهٔ جلسه باشد',
  'booking.organizerOrOverseer': 'لغو با برگزارکننده یا مسئول رزروهای سازمان باشد',
  'booking.inFuture': 'زمان جلسه نگذشته باشد',
  'booking.approverAssigned': 'تأییدکننده‌ای با دسترسی تأیید، جز خود برگزارکننده، تعیین شده باشد',
  'booking.assignedApprover': 'تصمیم با تأییدکنندهٔ تعیین‌شده یا جانشین او باشد',
  'booking.newTimeGiven': 'زمان تازه‌ای در آینده داده شده باشد',
  'booking.noConflict': 'اتاق، تجهیزات، پارکینگ و افراد در این زمان آزاد باشند',
  'booking.hasEnded': 'زمان جلسه به پایان رسیده باشد',
};

/** The meeting a confirmed booking is, made once and kept in step with it. */
async function meetingFor(tx: Tx, record: Record<string, any>, participantIds: string[], actorId: string): Promise<string> {
  const [people, guests] = await Promise.all([
    tx.user.findMany({ where: { id: { in: [record.organizerId, ...participantIds] }, organizationId: record.organizationId }, select: { fullName: true } }),
    tx.bookingGuest.findMany({ where: { bookingId: record.id }, select: { fullName: true, company: true } }),
  ]);
  const attendees = [...people.map((p) => p.fullName), ...guests.map((g) => (g.company ? `${g.fullName} (${g.company})` : g.fullName))].join('، ').slice(0, 2000);
  const fields = {
    subject: record.title, heldAt: record.startsAt, attendees: attendees || '—', agenda: record.description ?? null,
    projectId: record.projectId ?? null, companyId: record.companyId ?? null, kind: record.kind === 'EXTERNAL' ? 'CLIENT' : 'INTERNAL',
  };
  if (record.meetingId) {
    const before = await tx.meeting.findUnique({ where: { id: record.meetingId } });
    if (before) {
      const after = await tx.meeting.update({ where: { id: before.id }, data: fields });
      await audit({ organizationId: record.organizationId, actorId, action: 'UPDATE', entityType: 'meeting', entityId: after.id, before, after, reason: `رزرو ${record.code} دوباره قطعی شد` }, tx);
      return after.id;
    }
  }
  const made = await tx.meeting.create({
    data: { organizationId: record.organizationId, code: await nextCode(tx, 'meeting'), ...fields, actions: [], createdById: record.organizerId },
  });
  await audit({ organizationId: record.organizationId, actorId, action: 'CREATE', entityType: 'meeting', entityId: made.id, after: made, reason: `از رزرو ${record.code}` }, tx);
  return made.id;
}

export const BOOKING_EFFECTS: Record<string, (c: EffectContext) => Promise<Record<string, unknown>>> = {
  'booking.submit': async () => ({ submittedAt: new Date(), decidedAt: null, decisionNote: null }),
  'booking.approve': async () => ({ decidedAt: new Date() }),
  'booking.request_changes': async ({ reason }) => ({ decidedAt: new Date(), decisionNote: reason ?? null }),
  'booking.reject': async ({ reason }) => ({ decidedAt: new Date(), decisionNote: reason ?? null }),

  /** Holds the room, the things and the people — or nothing — and makes the Hivamis meeting. */
  'booking.confirm': async ({ tx, id, record, actorId }) => {
    const needs = await needsOf(tx, id);
    await hold(tx, {
      id, organizationId: record.organizationId, startsAt: new Date(record.startsAt), endsAt: new Date(record.endsAt),
      roomId: record.roomId, resourceIds: needs.resourceIds, parkingId: record.parkingId, parkingSpaces: record.parkingSpaces,
      personIds: [record.organizerId, ...needs.participantIds],
    });
    return { confirmedAt: new Date(), meetingId: await meetingFor(tx, record, needs.participantIds, actorId) };
  },

  /** A new time goes back for approval, and lets go of what the old one held. */
  'booking.reschedule': async ({ tx, id, payload }) => {
    await release(tx, id);
    const t = newTime(payload)!;
    return { ...t, submittedAt: new Date(), decidedAt: null, decisionNote: null, confirmedAt: null };
  },

  'booking.complete': async () => ({ completedAt: new Date() }),

  /** Lets go of everything; a meeting made for it and never minuted was never held, and goes too. */
  'booking.cancel': async ({ tx, id, record, reason, actorId }) => {
    await release(tx, id);
    let meetingId = record.meetingId as string | null;
    if (meetingId) {
      const m = await tx.meeting.findUnique({ where: { id: meetingId } });
      if (m && !m.minutesRecordedAt && !m.decisions) {
        await tx.meeting.delete({ where: { id: m.id } });
        await audit({ organizationId: record.organizationId, actorId, action: 'DELETE', entityType: 'meeting', entityId: m.id, before: m, reason: `رزرو ${record.code} لغو شد` }, tx);
        meetingId = null;
      }
    }
    return { cancelledAt: new Date(), cancelReason: reason ?? null, meetingId };
  },
};
