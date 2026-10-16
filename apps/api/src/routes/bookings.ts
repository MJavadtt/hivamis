import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  availabilityQuerySchema, bookableResourceSchema, bookingDraftSchema, bookingLocationSchema, cateringOptionSchema,
  paginationSchema, RESOURCE_TYPES,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { assertOwnReferences } from '../lib/scope.js';
import { assertVisible, seesAll, visibleAmong, visibleWhere, type BookingViewer } from '../bookings/access.js';
import { conflictsFor, freeRooms, suggestSlots } from '../bookings/availability.js';
import { approversFor, bookingView, LIST_SELECT, saveDraft } from '../bookings/service.js';

/**
 * Meeting bookings (audit F-9): the places and things that can be booked, whether a time works, and
 * the bookings themselves. Their states move through `POST /workflow/booking/:id/transitions`, like
 * every other workflow; this file reads and drafts.
 */

const listSchema = paginationSchema.extend({
  scope: z.enum(['mine', 'approve', 'all']).default('mine'),
  state: z.string().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const scheduleSchema = z.object({ from: z.coerce.date(), to: z.coerce.date() })
  .refine((q) => q.to > q.from && q.to.getTime() - q.from.getTime() <= 31 * 86_400_000, { message: 'بازه حداکثر یک ماه است.' });
const respondSchema = z.object({ response: z.enum(['ACCEPTED', 'DECLINED']) });
const resourceFilter = z.object({ type: z.enum(RESOURCE_TYPES).optional(), all: z.coerce.boolean().default(false) });

/** A car park with no spaces books nothing; the database refuses it too. */
const assertParkingHasSpaces = (r: { type?: string; capacity?: number }) => {
  if (r.type === 'PARKING' && r.capacity !== undefined && r.capacity < 1) throw badRequest('VALIDATION_ERROR', 'پارکینگ دست‌کم یک جای پارک دارد.', { field: 'capacity' });
};

const viewer = (a: ReturnType<typeof actorFrom>): BookingViewer => ({ id: a.id, organizationId: a.organizationId, permissions: a.permissions, delegated: a.delegated });

const bookingRoutes: FastifyPluginAsync = async (app) => {
  const book = { preHandler: [app.authenticate, app.requirePermissions('meeting.book')] };
  const manage = { preHandler: [app.authenticate, app.requirePermissions('resource.manage')] };

  /* ── places and things ───────────────────────────────────────────────── */

  app.get('/booking/locations', book, async (req) => {
    const actor = actorFrom(req);
    return prisma.bookingLocation.findMany({ where: { organizationId: actor.organizationId }, orderBy: { name: 'asc' }, take: 200 });
  });

  app.post('/booking/locations', manage, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(bookingLocationSchema, req.body);
    const made = await prisma.$transaction(async (tx) => {
      const row = await tx.bookingLocation.create({ data: { ...input, organizationId: actor.organizationId } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'bookingLocation', entityId: row.id, after: row, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return row;
    });
    return reply.code(201).send(made);
  });

  app.patch('/booking/locations/:id', manage, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(bookingLocationSchema.partial(), req.body);
    return prisma.$transaction(async (tx) => {
      const before = await tx.bookingLocation.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!before) throw notFound('مکان');
      const after = await tx.bookingLocation.update({ where: { id }, data: input });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'bookingLocation', entityId: id, before, after, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });

  /** What can be booked; the inactive too, for whoever manages them. */
  app.get('/booking/resources', book, async (req) => {
    const actor = actorFrom(req);
    const q = parse(resourceFilter, req.query);
    const all = q.all && actor.permissions.includes('resource.manage');
    return prisma.bookableResource.findMany({
      where: { organizationId: actor.organizationId, ...(q.type ? { type: q.type } : {}), ...(all ? {} : { isActive: true }) },
      include: { location: { select: { id: true, name: true } } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }], take: 500,
    });
  });

  app.post('/booking/resources', manage, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(bookableResourceSchema, req.body);
    assertParkingHasSpaces(input);
    await assertOwnReferences('bookableResource', input, actor.organizationId);
    const made = await prisma.$transaction(async (tx) => {
      const row = await tx.bookableResource.create({ data: { ...input, locationId: input.locationId ?? null, organizationId: actor.organizationId } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'bookableResource', entityId: row.id, after: row, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return row;
    });
    return reply.code(201).send(made);
  });

  app.patch('/booking/resources/:id', manage, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(bookableResourceSchema.partial(), req.body);
    await assertOwnReferences('bookableResource', input, actor.organizationId);
    return prisma.$transaction(async (tx) => {
      const before = await tx.bookableResource.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!before) throw notFound('منبع');
      assertParkingHasSpaces({ type: input.type ?? before.type, capacity: input.capacity ?? before.capacity });
      const after = await tx.bookableResource.update({ where: { id }, data: input });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'bookableResource', entityId: id, before, after, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });

  /** A resource's bookings over a span: the title only where the asker may read the booking. */
  app.get('/booking/resources/:id/schedule', book, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const q = parse(scheduleSchema, req.query);
    const resource = await prisma.bookableResource.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true, name: true, type: true, capacity: true } });
    if (!resource) throw notFound('منبع');
    const holds = await prisma.resourceHold.findMany({
      where: { organizationId: actor.organizationId, resourceId: id, startsAt: { lt: q.to }, endsAt: { gt: q.from } },
      select: { bookingId: true, startsAt: true, endsAt: true, spaces: true, booking: { select: { code: true, title: true } } },
      orderBy: { startsAt: 'asc' }, take: 500,
    });
    const named = await visibleAmong(viewer(actor), holds.map((h) => h.bookingId));
    return {
      resource,
      slots: holds.map((h) => ({
        startsAt: h.startsAt, endsAt: h.endsAt, spaces: h.spaces,
        ...(named.has(h.bookingId) ? { bookingId: h.bookingId, code: h.booking.code, title: h.booking.title } : {}),
      })),
    };
  });

  app.get('/booking/catering', book, async (req) => {
    const actor = actorFrom(req);
    const all = (req.query as { all?: string }).all === 'true' && actor.permissions.includes('resource.manage');
    return prisma.cateringOption.findMany({ where: { organizationId: actor.organizationId, ...(all ? {} : { isActive: true }) }, orderBy: { labelFa: 'asc' }, take: 200 });
  });

  app.post('/booking/catering', manage, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(cateringOptionSchema, req.body);
    const made = await prisma.$transaction(async (tx) => {
      const row = await tx.cateringOption.create({ data: { ...input, organizationId: actor.organizationId } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'cateringOption', entityId: row.id, after: row, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return row;
    });
    return reply.code(201).send(made);
  });

  app.patch('/booking/catering/:id', manage, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(cateringOptionSchema.partial(), req.body);
    return prisma.$transaction(async (tx) => {
      const before = await tx.cateringOption.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!before) throw notFound('گزینهٔ پذیرایی');
      const after = await tx.cateringOption.update({ where: { id }, data: input });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'cateringOption', entityId: id, before, after, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });

  /* ── whether a time works ────────────────────────────────────────────── */

  /** What is in the way of a time, which rooms are free then, and the next times that would work. */
  app.post('/bookings/availability', book, async (req) => {
    const actor = actorFrom(req);
    const q = parse(availabilityQuerySchema, req.body);
    if (q.excludeBookingId) await assertVisible(viewer(actor), q.excludeBookingId);
    const lot = q.parkingSpaces > 0
      ? await prisma.bookableResource.findFirst({ where: { organizationId: actor.organizationId, type: 'PARKING', isActive: true }, orderBy: { name: 'asc' }, select: { id: true } })
      : null;
    const slot = {
      startsAt: q.startsAt, endsAt: q.endsAt, roomId: q.roomId, resourceIds: q.resourceIds,
      personIds: [actor.id, ...q.participantIds], parkingId: lot?.id ?? null, parkingSpaces: q.parkingSpaces, excludeBookingId: q.excludeBookingId,
    };
    const [conflicts, rooms] = await Promise.all([
      conflictsFor(prisma, actor.organizationId, slot, viewer(actor)),
      freeRooms(prisma, actor.organizationId, { startsAt: q.startsAt, endsAt: q.endsAt, seats: q.seats, features: q.features, excludeBookingId: q.excludeBookingId }),
    ]);
    const suggestions = conflicts.length ? await suggestSlots(prisma, actor.organizationId, slot) : [];
    return { available: conflicts.length === 0, conflicts, freeRooms: rooms, suggestions };
  });

  app.get('/bookings/approvers', book, async (req) => {
    const actor = actorFrom(req);
    return approversFor(actor.organizationId, actor.id);
  });

  /* ── bookings ────────────────────────────────────────────────────────── */

  app.get('/bookings', book, async (req) => {
    const actor = actorFrom(req);
    const q = parse(listSchema, req.query);
    const v = viewer(actor);
    if (q.scope === 'all' && !seesAll(v)) throw new AppError(403, 'FORBIDDEN', 'برای دیدن همهٔ رزروها به دسترسی «مشاهدهٔ همهٔ رزروهای جلسه» نیاز دارید.');
    const standInFor = actor.delegated?.['meeting.approve'];
    const scope = q.scope === 'mine'
      ? { OR: [{ organizerId: actor.id }, { participants: { some: { userId: actor.id } } }] }
      : q.scope === 'approve'
        ? { approverId: { in: [actor.id, ...(standInFor ? [standInFor] : [])] }, state: 'PENDING_APPROVAL' }
        : {};
    const where = {
      AND: [visibleWhere(v), scope],
      ...(q.state ? { state: q.state } : {}),
      ...(q.from || q.to ? { startsAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' as const } }, { code: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.booking.findMany({ where, select: LIST_SELECT, orderBy: { startsAt: q.scope === 'mine' ? 'desc' : 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.booking.count({ where }),
    ]);
    return page(items, total, q);
  });

  app.get('/bookings/:id', book, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    await assertVisible(viewer(actor), id);
    return bookingView(id, viewer(actor));
  });

  app.post('/bookings', book, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(bookingDraftSchema, req.body);
    const made = await saveDraft(actor, input);
    return reply.code(201).send(await bookingView(made.id, viewer(actor)));
  });

  app.put('/bookings/:id', book, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(bookingDraftSchema, req.body);
    await saveDraft(actor, input, id);
    return bookingView(id, viewer(actor));
  });

  /** A participant says whether they will come. */
  app.post('/bookings/:id/respond', book, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { response } = parse(respondSchema, req.body);
    await assertVisible(viewer(actor), id);
    return prisma.$transaction(async (tx) => {
      const seat = await tx.bookingParticipant.findUnique({ where: { bookingId_userId: { bookingId: id, userId: actor.id } } });
      if (!seat) throw notFound('دعوت');
      const after = await tx.bookingParticipant.update({ where: { bookingId_userId: { bookingId: id, userId: actor.id } }, data: { response, respondedAt: new Date() } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'BOOKING_RESPONDED', entityType: 'booking', entityId: id, before: { response: seat.response }, after: { response }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });
};

export default bookingRoutes;
