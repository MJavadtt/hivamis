import type { BookingDraft } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { AppError, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';
import { assertOwnReferences } from '../lib/scope.js';
import { allowedFor } from '../workflow/engine.js';
import { seesAll, type BookingViewer } from './access.js';
import { approverIds, mayApprove } from './workflow.js';

/**
 * A booking as its organiser writes it (audit F-9): saved whole, as a draft, until it is sent. Every
 * id it names — room, parking, equipment, people, approver, project, client, catering — must be the
 * organisation's own, and of the right kind; anything else answers as though it did not exist.
 */

export const EDITABLE = ['DRAFT', 'CHANGES_REQUESTED'];

interface Actor { id: string; organizationId: string; ipAddress?: string | null; requestId?: string | null }

const unknown = (field: string) => new AppError(422, 'UNKNOWN_REFERENCE', `ارجاع «${field}» نامعتبر است.`, { field });

/** People who may approve this organiser's bookings, and their unit's manager when they may. */
export async function approversFor(organizationId: string, organizerId: string) {
  const [me, eligible] = await Promise.all([
    prisma.user.findUnique({ where: { id: organizerId }, select: { department: { select: { managerId: true } } } }),
    approverIds(organizationId),
  ]);
  eligible.delete(organizerId);
  const approvers = await prisma.user.findMany({
    where: { id: { in: [...eligible] }, organizationId }, select: { id: true, fullName: true, jobTitle: true }, orderBy: { fullName: 'asc' }, take: 500,
  });
  const manager = me?.department?.managerId;
  return { approvers, suggested: manager && eligible.has(manager) ? manager : null };
}

async function checkNames(tx: Tx, organizationId: string, organizerId: string, input: BookingDraft) {
  await assertOwnReferences('booking', { projectId: input.projectId, companyId: input.companyId }, organizationId, tx);
  const ids = [input.roomId, ...input.resourceIds].filter(Boolean) as string[];
  const things = ids.length ? await tx.bookableResource.findMany({ where: { id: { in: ids }, organizationId, isActive: true }, select: { id: true, type: true } }) : [];
  const kind = new Map(things.map((t) => [t.id, t.type]));
  if (input.roomId && kind.get(input.roomId) !== 'ROOM') throw unknown('roomId');
  if (input.resourceIds.some((id) => !['EQUIPMENT', 'VEHICLE', 'OTHER'].includes(kind.get(id) ?? ''))) throw unknown('resourceIds');
  const people = [...new Set(input.participantIds)].filter((id) => id !== organizerId);
  if (people.length && await tx.user.count({ where: { id: { in: people }, organizationId, isActive: true, deletedAt: null } }) !== people.length) throw unknown('participantIds');
  const options = [...new Set(input.catering.map((c) => c.optionId))];
  if (options.length && await tx.cateringOption.count({ where: { id: { in: options }, organizationId, isActive: true } }) !== options.length) throw unknown('catering');
  if (input.approverId && (input.approverId === organizerId || !(await mayApprove(input.approverId, organizationId)))) {
    throw new AppError(422, 'NOT_AN_APPROVER', 'تأییدکنندهٔ برگزیده دسترسی «تأیید رزرو جلسه» را ندارد، یا خود برگزارکننده است.', { field: 'approverId' });
  }
  // Parking: the car park asked for, or the first one there is.
  let parkingId: string | null = null;
  if (input.parkingSpaces > 0) {
    const lot = await tx.bookableResource.findFirst({ where: { organizationId, type: 'PARKING', isActive: true }, orderBy: { name: 'asc' }, select: { id: true } });
    parkingId = lot?.id ?? null;
  }
  const approverId = input.approverId ?? (await approversFor(organizationId, organizerId)).suggested;
  return { people, parkingId, approverId };
}

/** Creates a draft, or replaces one the organiser may still change. */
export async function saveDraft(actor: Actor, input: BookingDraft, existingId?: string) {
  return prisma.$transaction(async (tx) => {
    const before = existingId
      ? await tx.booking.findFirst({ where: { id: existingId, organizationId: actor.organizationId }, include: { participants: true, resources: true, guests: true, catering: true } })
      : null;
    if (existingId && !before) throw notFound('رزرو');
    if (before && before.organizerId !== actor.id) throw notFound('رزرو');
    if (before && !EDITABLE.includes(before.state)) {
      throw new AppError(409, 'NOT_EDITABLE', 'این رزرو دیگر پیش‌نویس نیست؛ برای زمان تازه «تغییر زمان» را بزنید.', { state: before.state });
    }
    const { people, parkingId, approverId } = await checkNames(tx, actor.organizationId, actor.id, input);
    const row = {
      title: input.title, description: input.description ?? null, kind: input.kind,
      startsAt: input.startsAt, endsAt: input.endsAt, roomId: input.roomId ?? null, placeNote: input.placeNote ?? null,
      parkingId, parkingSpaces: input.parkingSpaces, approverId,
      projectId: input.projectId ?? null, companyId: input.companyId ?? null,
    };
    const booking = before
      ? await tx.booking.update({ where: { id: before.id }, data: row })
      : await tx.booking.create({ data: { ...row, organizationId: actor.organizationId, code: await nextCode(tx, 'booking'), organizerId: actor.id } });
    const of = { bookingId: booking.id, organizationId: actor.organizationId };
    if (before) {
      await tx.bookingParticipant.deleteMany({ where: { bookingId: booking.id } });
      await tx.bookingResource.deleteMany({ where: { bookingId: booking.id } });
      await tx.bookingGuest.deleteMany({ where: { bookingId: booking.id } });
      await tx.bookingCatering.deleteMany({ where: { bookingId: booking.id } });
    }
    if (people.length) await tx.bookingParticipant.createMany({ data: people.map((userId) => ({ ...of, userId })) });
    if (input.resourceIds.length) await tx.bookingResource.createMany({ data: [...new Set(input.resourceIds)].map((resourceId) => ({ ...of, resourceId })) });
    if (input.guests.length) await tx.bookingGuest.createMany({ data: input.guests.map((g) => ({ ...of, ...g, company: g.company ?? null, email: g.email ?? null, phone: g.phone ?? null })) });
    if (input.catering.length) await tx.bookingCatering.createMany({ data: input.catering.map((c) => ({ ...of, optionId: c.optionId, quantity: c.quantity })) });
    const after = { ...booking, participantIds: people, resourceIds: input.resourceIds, guests: input.guests, catering: input.catering };
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: before ? 'UPDATE' : 'CREATE', entityType: 'booking', entityId: booking.id,
      before: before ?? undefined, after, ipAddress: actor.ipAddress, requestId: actor.requestId,
    }, tx);
    return booking;
  });
}

const DETAIL = {
  organizer: { select: { id: true, fullName: true } },
  approver: { select: { id: true, fullName: true } },
  room: { select: { id: true, name: true, capacity: true, floor: true, features: true, location: { select: { name: true } } } },
  parking: { select: { id: true, name: true } },
  project: { select: { id: true, code: true, name: true } },
  company: { select: { id: true, legalName: true } },
  meeting: { select: { id: true, code: true } },
  participants: { select: { userId: true, response: true, user: { select: { fullName: true } } } },
  resources: { select: { resource: { select: { id: true, name: true, type: true } } } },
  guests: { select: { id: true, fullName: true, company: true, email: true, phone: true, isVip: true, checkedInAt: true, checkedOutAt: true } },
  catering: { select: { quantity: true, option: { select: { id: true, labelFa: true, labelEn: true } } } },
} as const;

/** What the viewer may do from here: the moves their part in the booking gives them. */
function movesFor(b: { state: string; organizerId: string; approverId: string | null }, v: BookingViewer) {
  const organizer = b.organizerId === v.id;
  const approver = !!b.approverId && (b.approverId === v.id || v.delegated?.['meeting.approve'] === b.approverId);
  return allowedFor('booking', b.state, [...v.permissions]).filter((t) =>
    ['approve', 'reject', 'request_changes'].includes(t.action) ? approver
      : t.action === 'cancel' ? organizer || seesAll(v)
        : organizer);
}

export async function bookingView(id: string, v: BookingViewer, db: Tx | typeof prisma = prisma) {
  const b = await db.booking.findFirst({ where: { id, organizationId: v.organizationId }, include: DETAIL });
  if (!b) throw notFound('رزرو');
  return {
    ...b,
    participants: b.participants.map((p) => ({ userId: p.userId, fullName: p.user.fullName, response: p.response })),
    resources: b.resources.map((r) => r.resource),
    catering: b.catering.map((c) => ({ optionId: c.option.id, labelFa: c.option.labelFa, labelEn: c.option.labelEn, quantity: c.quantity })),
    editable: EDITABLE.includes(b.state) && b.organizerId === v.id,
    availableTransitions: movesFor(b, v),
  };
}

export const LIST_SELECT = {
  id: true, code: true, state: true, title: true, kind: true, startsAt: true, endsAt: true, placeNote: true, organizerId: true, approverId: true,
  organizer: { select: { id: true, fullName: true } },
  room: { select: { id: true, name: true } },
  meeting: { select: { id: true, code: true } },
  _count: { select: { participants: true, guests: true } },
} as const;
