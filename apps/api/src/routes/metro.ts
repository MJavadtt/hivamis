import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  METRO_BOOKING_LABELS, METRO_BOOKING_MOVES, METRO_HOLDING_STATES, METRO_SPACE_KINDS, METRO_SPACE_LABELS,
  metroBookingMoveSchema, metroBookingSchema, metroBookingUpdateSchema, metroDays, metroLineSchema, metroLineUpdateSchema,
  metroPaymentSchema, metroSettingsSchema, metroSpaceSchema, metroSpaceUpdateSchema, metroStationSchema, metroStationUpdateSchema,
  metroSuggestedAmount, metroTrainSchema, metroTrainUpdateSchema, metroWagonSchema, metroWagonUpdateSchema,
  type MetroBookingState, type MetroSpaceKind,
} from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { nextCode } from '../lib/codes.js';
import { notify } from '../mail/notify.js';
import { holdersOf } from '../sites/people.js';
import { ensureMetroCatalogue, wagonSpaces } from '../metro/catalogue.js';
import { assertFree, day, takenOf } from '../metro/bookings.js';

/**
 * Metro advertising (the owner, 2026-11-17; ADR-135): «مشابه ماژول مکان‌ها و اجاره‌داری، یک ماژول برای
 * مترو». Lines and their stations, trains of wagons and the spaces they carry — all added, edited and
 * deleted here; bookings of those spaces over dates for an amount, with payments; reminders; reports.
 * Notes, photos and files on every part go through the files panel (records.ts, ADR-134).
 */
type Actor = ReturnType<typeof actorFrom>;
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const num = (v: unknown) => Number(v ?? 0);
const kindFa = (k: string) => METRO_SPACE_LABELS[k as MetroSpaceKind]?.fa ?? k;

const listQuery = z.object({
  state: z.string().optional(), lineId: z.string().uuid().optional(), q: z.string().trim().max(100).optional(),
  from: z.string().optional(), to: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const periodQuery = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), lineId: z.string().uuid().optional(), kind: z.enum(METRO_SPACE_KINDS).optional() });

const metroRoutes: FastifyPluginAsync = async (app) => {
  const read = { preHandler: [app.authenticate, app.requirePermissions('metro.read')] };
  const write = { preHandler: [app.authenticate, app.requirePermissions('metro.write')] };
  const book = { preHandler: [app.authenticate, app.requirePermissions('metro.book')] };

  const log = (actor: Actor, action: string, entityType: string, entityId: string, extra: { before?: unknown; after?: unknown; reason?: string | null } = {}, tx?: Tx) =>
    audit({ organizationId: actor.organizationId, actorId: actor.id, action, entityType, entityId, before: extra.before as object, after: extra.after as object, reason: extra.reason ?? null, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);

  /** One of the organisation's rows, or not found — the same answer for another organisation's. */
  async function own<T>(model: string, id: string, organizationId: string): Promise<T> {
    const row = await (prisma as unknown as Record<string, { findFirst(a: unknown): Promise<unknown> }>)[model]!.findFirst({ where: { id, organizationId } });
    if (!row) throw notFound();
    return row as T;
  }

  /* ── the overview ─────────────────────────────────────────────────────── */

  app.get('/metro/overview', read, async (req) => {
    const actor = actorFrom(req);
    await ensureMetroCatalogue(actor.organizationId);
    const org = actor.organizationId;
    const today = day(new Date().toISOString().slice(0, 10));
    const settings = await prisma.metroSettings.findUnique({ where: { organizationId: org } });
    const soon = new Date(today.getTime() + (settings?.endingSoonDays ?? 7) * 86_400_000);
    const [lines, stations, trains, wagons, spaces, byState, ending, payments, booked] = await Promise.all([
      prisma.metroLine.findMany({ where: { organizationId: org }, orderBy: { number: 'asc' }, include: { _count: { select: { stations: true, trains: true } } } }),
      prisma.metroStation.count({ where: { organizationId: org } }),
      prisma.metroTrain.count({ where: { organizationId: org } }),
      prisma.metroWagon.count({ where: { organizationId: org } }),
      prisma.metroAdSpace.groupBy({ by: ['kind'], where: { organizationId: org, isActive: true }, _sum: { quantity: true } }),
      prisma.metroBooking.groupBy({ by: ['state'], where: { organizationId: org }, _count: true, _sum: { amount: true } }),
      prisma.metroBooking.findMany({ where: { organizationId: org, state: { in: ['CONFIRMED', 'ACTIVE'] }, endDate: { gte: today, lte: soon } }, orderBy: { endDate: 'asc' }, take: 20, include: { company: { select: { legalName: true } } } }),
      prisma.metroPayment.aggregate({ where: { booking: { organizationId: org, state: { not: 'CANCELLED' } } }, _sum: { amount: true } }),
      prisma.metroBookingItem.groupBy({ by: ['spaceId'], where: { booking: { organizationId: org, state: { in: [...METRO_HOLDING_STATES] }, startDate: { lte: today }, endDate: { gte: today } } }, _sum: { quantity: true } }),
    ]);
    const bookedIds = booked.map((b) => b.spaceId);
    const bookedKinds = bookedIds.length ? await prisma.metroAdSpace.findMany({ where: { id: { in: bookedIds } }, select: { id: true, kind: true } }) : [];
    const kindOf = new Map(bookedKinds.map((s) => [s.id, s.kind]));
    const takenToday: Record<string, number> = {};
    for (const b of booked) { const k = kindOf.get(b.spaceId)!; takenToday[k] = (takenToday[k] ?? 0) + (b._sum.quantity ?? 0); }
    const billed = byState.filter((s) => s.state !== 'CANCELLED').reduce((sum, s) => sum + num(s._sum.amount), 0);
    return {
      lines: lines.map(({ _count, ...l }) => ({ ...l, stations: _count.stations, trains: _count.trains })),
      counts: { lines: lines.length, stations, trains, wagons },
      capacity: METRO_SPACE_KINDS.map((kind) => ({ kind, units: spaces.find((s) => s.kind === kind)?._sum.quantity ?? 0, takenToday: takenToday[kind] ?? 0 })),
      bookings: Object.fromEntries(byState.map((s) => [s.state, { count: s._count, amount: num(s._sum.amount) }])),
      money: { billed, paid: num(payments._sum.amount), outstanding: billed - num(payments._sum.amount) },
      endingSoon: ending.map((b) => ({ id: b.id, code: b.code, title: b.title, client: b.company?.legalName ?? b.clientName, endDate: iso(b.endDate), state: b.state })),
      settings: { endingSoonDays: settings?.endingSoonDays ?? 7, holdDays: settings?.holdDays ?? 3 },
    };
  });

  app.patch('/metro/settings', write, async (req) => {
    const actor = actorFrom(req);
    await ensureMetroCatalogue(actor.organizationId);
    const input = parse(metroSettingsSchema, req.body ?? {});
    return prisma.metroSettings.update({ where: { organizationId: actor.organizationId }, data: input });
  });

  /* ── lines and stations ───────────────────────────────────────────────── */

  app.get('/metro/lines', read, async (req) => {
    const actor = actorFrom(req);
    await ensureMetroCatalogue(actor.organizationId);
    const lines = await prisma.metroLine.findMany({ where: { organizationId: actor.organizationId }, orderBy: { number: 'asc' }, include: { _count: { select: { stations: true, trains: true } } } });
    return lines.map(({ _count, ...l }) => ({ ...l, stations: _count.stations, trains: _count.trains }));
  });

  app.get('/metro/lines/:id', read, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const line = await prisma.metroLine.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: {
        stations: { orderBy: [{ branch: { sort: 'asc', nulls: 'first' } }, { order: 'asc' }] },
        trains: { orderBy: { code: 'asc' }, include: { wagons: { orderBy: { number: 'asc' }, include: { spaces: { orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] } } } } },
      },
    });
    if (!line) throw notFound('خط');
    // What each space has taken today, so the page shows what is free now.
    const today = day(new Date().toISOString().slice(0, 10));
    const ids = line.trains.flatMap((t) => t.wagons.flatMap((w) => w.spaces.map((s) => s.id)));
    const taken = await takenOf(prisma, actor.organizationId, ids, today, today);
    return {
      ...line,
      trains: line.trains.map((t) => ({ ...t, wagons: t.wagons.map((w) => ({ ...w, spaces: w.spaces.map((s) => ({ ...s, monthlyPrice: num(s.monthlyPrice), takenToday: taken.get(s.id) ?? 0 })) })) })),
    };
  });

  app.post('/metro/lines', write, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(metroLineSchema, req.body);
    if (await prisma.metroLine.count({ where: { organizationId: actor.organizationId, number: input.number } })) throw conflict('LINE_EXISTS', `خط ${input.number} پیش‌تر ثبت شده است.`);
    const line = await prisma.metroLine.create({ data: { ...input, organizationId: actor.organizationId } });
    await log(actor, 'CREATE', 'metroLine', line.id, { after: input });
    return reply.code(201).send(line);
  });

  app.patch('/metro/lines/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await own<{ number: number }>('metroLine', id, actor.organizationId);
    const input = parse(metroLineUpdateSchema, req.body ?? {});
    if (input.number && input.number !== before.number && await prisma.metroLine.count({ where: { organizationId: actor.organizationId, number: input.number } })) {
      throw conflict('LINE_EXISTS', `خط ${input.number} پیش‌تر ثبت شده است.`);
    }
    const line = await prisma.metroLine.update({ where: { id }, data: input });
    await log(actor, 'UPDATE', 'metroLine', id, { before, after: input });
    return line;
  });

  /** What a deletion takes along — refused while a booking still holds any of it. */
  async function assertNoLiveBooking(where: object, what: string) {
    const live = await prisma.metroBookingItem.findFirst({ where: { space: where, booking: { state: { in: [...METRO_HOLDING_STATES] } } }, select: { booking: { select: { code: true } } } });
    if (live) throw conflict('METRO_BOOKED', `${what} در رزرو ${live.booking.code} است؛ نخست آن رزرو را لغو کنید یا فضا را از آن بردارید.`);
  }

  app.delete('/metro/lines/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await own<object>('metroLine', id, actor.organizationId);
    await assertNoLiveBooking({ wagon: { train: { lineId: id } } }, 'فضایی از این خط');
    await prisma.$transaction(async (tx) => { await tx.metroLine.delete({ where: { id } }); await log(actor, 'DELETE', 'metroLine', id, { before }, tx); });
    return { id };
  });

  app.post('/metro/lines/:id/stations', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    await own('metroLine', id, actor.organizationId);
    const input = parse(metroStationSchema, req.body);
    const last = await prisma.metroStation.aggregate({ where: { lineId: id }, _max: { order: true } });
    const station = await prisma.metroStation.create({ data: { ...input, order: input.order ?? (last._max.order ?? 0) + 1, lineId: id, organizationId: actor.organizationId } });
    await log(actor, 'CREATE', 'metroStation', station.id, { after: input });
    return reply.code(201).send(station);
  });

  app.patch('/metro/stations/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await own<object>('metroStation', id, actor.organizationId);
    const input = parse(metroStationUpdateSchema, req.body ?? {});
    const station = await prisma.metroStation.update({ where: { id }, data: input });
    await log(actor, 'UPDATE', 'metroStation', id, { before, after: input });
    return station;
  });

  app.delete('/metro/stations/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await own<object>('metroStation', id, actor.organizationId);
    await prisma.metroStation.delete({ where: { id } });
    await log(actor, 'DELETE', 'metroStation', id, { before });
    return { id };
  });

  /* ── trains, wagons and their spaces ──────────────────────────────────── */

  app.post('/metro/lines/:id/trains', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    await own('metroLine', id, actor.organizationId);
    const input = parse(metroTrainSchema, req.body);
    if (await prisma.metroTrain.count({ where: { lineId: id, code: input.code } })) throw conflict('TRAIN_EXISTS', `قطار ${input.code} در این خط هست.`);
    const train = await prisma.$transaction(async (tx) => {
      const t = await tx.metroTrain.create({ data: { organizationId: actor.organizationId, lineId: id, code: input.code, notes: input.notes ?? null, isActive: input.isActive } });
      for (let n = 1; n <= input.wagons; n++) {
        const w = await tx.metroWagon.create({ data: { organizationId: actor.organizationId, trainId: t.id, number: n } });
        await tx.metroAdSpace.createMany({ data: wagonSpaces(actor.organizationId, w.id, input.template, input.prices) });
      }
      await log(actor, 'CREATE', 'metroTrain', t.id, { after: { code: input.code, wagons: input.wagons, template: input.template } }, tx);
      return t;
    });
    return reply.code(201).send(train);
  });

  app.patch('/metro/trains/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await own<{ code: string; lineId: string }>('metroTrain', id, actor.organizationId);
    const input = parse(metroTrainUpdateSchema, req.body ?? {});
    if (input.code && input.code !== before.code && await prisma.metroTrain.count({ where: { lineId: before.lineId, code: input.code } })) throw conflict('TRAIN_EXISTS', `قطار ${input.code} در این خط هست.`);
    const train = await prisma.metroTrain.update({ where: { id }, data: input });
    await log(actor, 'UPDATE', 'metroTrain', id, { before, after: input });
    return train;
  });

  app.delete('/metro/trains/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await own<object>('metroTrain', id, actor.organizationId);
    await assertNoLiveBooking({ wagon: { trainId: id } }, 'فضایی از این قطار');
    await prisma.$transaction(async (tx) => { await tx.metroTrain.delete({ where: { id } }); await log(actor, 'DELETE', 'metroTrain', id, { before }, tx); });
    return { id };
  });

  app.post('/metro/trains/:id/wagons', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    await own('metroTrain', id, actor.organizationId);
    const input = parse(metroWagonSchema, req.body ?? {});
    const last = await prisma.metroWagon.aggregate({ where: { trainId: id }, _max: { number: true } });
    const made = await prisma.$transaction(async (tx) => {
      const out = [];
      for (let i = 1; i <= input.count; i++) {
        const w = await tx.metroWagon.create({ data: { organizationId: actor.organizationId, trainId: id, number: (last._max.number ?? 0) + i, notes: input.notes ?? null } });
        await tx.metroAdSpace.createMany({ data: wagonSpaces(actor.organizationId, w.id, input.template, input.prices) });
        await log(actor, 'CREATE', 'metroWagon', w.id, { after: { trainId: id, number: w.number } }, tx);
        out.push(w);
      }
      return out;
    });
    return reply.code(201).send(made);
  });

  app.patch('/metro/wagons/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await own<{ trainId: string; number: number }>('metroWagon', id, actor.organizationId);
    const input = parse(metroWagonUpdateSchema, req.body ?? {});
    if (input.number && input.number !== before.number && await prisma.metroWagon.count({ where: { trainId: before.trainId, number: input.number } })) throw conflict('WAGON_EXISTS', `واگن ${input.number} در این قطار هست.`);
    const wagon = await prisma.metroWagon.update({ where: { id }, data: input });
    await log(actor, 'UPDATE', 'metroWagon', id, { before, after: input });
    return wagon;
  });

  app.delete('/metro/wagons/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await own<object>('metroWagon', id, actor.organizationId);
    await assertNoLiveBooking({ wagonId: id }, 'فضایی از این واگن');
    await prisma.$transaction(async (tx) => { await tx.metroWagon.delete({ where: { id } }); await log(actor, 'DELETE', 'metroWagon', id, { before }, tx); });
    return { id };
  });

  app.post('/metro/wagons/:id/spaces', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    await own('metroWagon', id, actor.organizationId);
    const input = parse(metroSpaceSchema, req.body);
    const space = await prisma.metroAdSpace.create({ data: { ...input, organizationId: actor.organizationId, wagonId: id } });
    await log(actor, 'CREATE', 'metroSpace', space.id, { after: input });
    return reply.code(201).send(space);
  });

  app.patch('/metro/spaces/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await own<{ quantity: number }>('metroAdSpace', id, actor.organizationId);
    const input = parse(metroSpaceUpdateSchema, req.body ?? {});
    // Fewer units than bookings already hold of it, on any day still to come, is refused.
    if (input.quantity !== undefined && input.quantity < before.quantity) {
      const today = day(new Date().toISOString().slice(0, 10));
      const items = await prisma.metroBookingItem.findMany({ where: { spaceId: id, booking: { state: { in: [...METRO_HOLDING_STATES] }, endDate: { gte: today } } }, select: { quantity: true }, take: 5000 });
      const most = items.reduce((s, i) => s + i.quantity, 0);
      if (input.quantity < most) throw conflict('SPACE_TAKEN', `رزروهای پیش رو ${most} واحد از این فضا را گرفته‌اند.`);
    }
    const space = await prisma.metroAdSpace.update({ where: { id }, data: input });
    await log(actor, 'UPDATE', 'metroSpace', id, { before, after: input });
    return space;
  });

  app.delete('/metro/spaces/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await own<object>('metroAdSpace', id, actor.organizationId);
    await assertNoLiveBooking({ id }, 'این فضا');
    await prisma.$transaction(async (tx) => { await tx.metroAdSpace.delete({ where: { id } }); await log(actor, 'DELETE', 'metroSpace', id, { before }, tx); });
    return { id };
  });

  /* ── availability ─────────────────────────────────────────────────────── */

  /** Every space of a line (or all lines) with what is free of it over the days asked. */
  app.get('/metro/availability', read, async (req) => {
    const actor = actorFrom(req);
    const q = parse(periodQuery, req.query);
    if (q.to < q.from) throw badRequest('BAD_PERIOD', 'پایان بازه پیش از آغاز آن است.');
    const spaces = await prisma.metroAdSpace.findMany({
      where: { organizationId: actor.organizationId, isActive: true, ...(q.kind ? { kind: q.kind } : {}), ...(q.lineId ? { wagon: { train: { lineId: q.lineId } } } : {}) },
      orderBy: [{ wagon: { train: { line: { number: 'asc' } } } }, { wagon: { train: { code: 'asc' } } }, { wagon: { number: 'asc' } }, { kind: 'asc' }],
      take: 5000,
      select: { id: true, kind: true, label: true, quantity: true, monthlyPrice: true, wagon: { select: { id: true, number: true, train: { select: { id: true, code: true, line: { select: { id: true, number: true, nameFa: true, color: true } } } } } } },
    });
    const taken = await takenOf(prisma, actor.organizationId, spaces.map((s) => s.id), day(q.from), day(q.to));
    return spaces.map((s) => ({ ...s, monthlyPrice: num(s.monthlyPrice), taken: taken.get(s.id) ?? 0, free: Math.max(0, s.quantity - (taken.get(s.id) ?? 0)) }));
  });

  /* ── bookings ─────────────────────────────────────────────────────────── */

  const bookingInclude = {
    company: { select: { id: true, legalName: true } }, project: { select: { id: true, code: true, name: true } },
    items: { include: { space: { select: { id: true, kind: true, label: true, quantity: true, wagon: { select: { number: true, train: { select: { code: true, line: { select: { id: true, number: true, nameFa: true, color: true } } } } } } } } } },
    payments: { orderBy: { paidAt: 'asc' as const } },
  };
  type BookingRow = Awaited<ReturnType<typeof loadBooking>>;
  async function loadBooking(id: string, organizationId: string) {
    const b = await prisma.metroBooking.findFirst({ where: { id, organizationId }, include: bookingInclude });
    if (!b) throw notFound('رزرو');
    return b;
  }
  async function shape(b: BookingRow) {
    const people = await prisma.user.findMany({ where: { id: { in: [b.ownerId, b.createdById].filter((x): x is string => !!x) } }, select: { id: true, fullName: true } });
    const name = (id: string | null) => people.find((p) => p.id === id) ?? null;
    const paid = b.payments.reduce((s, p) => s + num(p.amount), 0);
    return {
      ...b, startDate: iso(b.startDate), endDate: iso(b.endDate), amount: num(b.amount), days: metroDays(iso(b.startDate)!, iso(b.endDate)!),
      client: b.company?.legalName ?? b.clientName, owner: name(b.ownerId), createdBy: name(b.createdById),
      items: b.items.map((i) => ({ ...i, monthlyPrice: num(i.monthlyPrice) })),
      payments: b.payments.map((p) => ({ ...p, amount: num(p.amount), paidAt: iso(p.paidAt) })),
      paid, balance: num(b.amount) - paid, moves: METRO_BOOKING_MOVES[b.state as MetroBookingState] ?? [],
    };
  }

  app.get('/metro/bookings', read, async (req) => {
    const actor = actorFrom(req);
    const q = parse(listQuery, req.query);
    const where = {
      organizationId: actor.organizationId,
      ...(q.state ? { state: q.state } : {}),
      ...(q.lineId ? { items: { some: { space: { wagon: { train: { lineId: q.lineId } } } } } } : {}),
      ...(q.from ? { endDate: { gte: day(q.from) } } : {}), ...(q.to ? { startDate: { lte: day(q.to) } } : {}),
      ...(q.q ? { OR: [{ code: { contains: q.q, mode: 'insensitive' as const } }, { title: { contains: q.q, mode: 'insensitive' as const } }, { clientName: { contains: q.q, mode: 'insensitive' as const } }, { company: { legalName: { contains: q.q, mode: 'insensitive' as const } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.metroBooking.findMany({
        where, orderBy: { startDate: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { company: { select: { legalName: true } }, payments: { select: { amount: true } }, items: { select: { quantity: true, space: { select: { kind: true, wagon: { select: { train: { select: { line: { select: { number: true, color: true } } } } } } } } } } },
      }),
      prisma.metroBooking.count({ where }),
    ]);
    return {
      total, page: q.page, pageSize: q.pageSize,
      items: rows.map((b) => {
        const paid = b.payments.reduce((s, p) => s + num(p.amount), 0);
        const units: Record<string, number> = {};
        for (const i of b.items) units[i.space.kind] = (units[i.space.kind] ?? 0) + i.quantity;
        const lines = [...new Map(b.items.map((i) => [i.space.wagon.train.line.number, i.space.wagon.train.line])).values()];
        return { id: b.id, code: b.code, title: b.title, client: b.company?.legalName ?? b.clientName, state: b.state, startDate: iso(b.startDate), endDate: iso(b.endDate), amount: num(b.amount), paid, balance: num(b.amount) - paid, units, lines };
      }),
    };
  });

  app.get('/metro/bookings/:id', read, async (req) => {
    const actor = actorFrom(req);
    return shape(await loadBooking((req.params as { id: string }).id, actor.organizationId));
  });

  async function assertRefs(actor: Actor, input: { companyId?: string | null; projectId?: string | null; ownerId?: string | null }) {
    if (input.companyId && !(await prisma.company.count({ where: { id: input.companyId, organizationId: actor.organizationId } }))) throw new AppError(422, 'UNKNOWN_REFERENCE', 'مشتری پیدا نشد.');
    if (input.projectId && !(await prisma.project.count({ where: { id: input.projectId, organizationId: actor.organizationId } }))) throw new AppError(422, 'UNKNOWN_REFERENCE', 'پروژه پیدا نشد.');
    if (input.ownerId && !(await prisma.user.count({ where: { id: input.ownerId, organizationId: actor.organizationId, deletedAt: null } }))) throw new AppError(422, 'UNKNOWN_REFERENCE', 'مسئول رزرو پیدا نشد.');
  }

  /** Those who should hear of a booking: its owner, and whoever books metro spaces. */
  async function tell(actor: Actor, b: { id: string; code: string; ownerId: string | null }, title: string) {
    const to = new Set([...(await holdersOf(actor.organizationId, 'metro.book', { inOwnRight: true })), ...(b.ownerId ? [b.ownerId] : [])]);
    to.delete(actor.id);
    await Promise.all([...to].map((userId) => notify({ userId, kind: 'METRO_BOOKING', title, entityType: 'metroBooking', entityId: b.id }).catch(() => undefined)));
  }

  app.post('/metro/bookings', book, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(metroBookingSchema, req.body);
    await assertRefs(actor, input);
    const start = day(input.startDate), end = day(input.endDate);
    const booking = await prisma.$transaction(async (tx) => {
      // Two bookings of one space, made at the same moment, wait for each other here.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('metro:${actor.organizationId}'))`);
      const spaces = await assertFree(tx, actor.organizationId, input.items, start, end);
      const price = new Map(spaces.map((s) => [s.id, num(s.monthlyPrice)]));
      const suggested = metroSuggestedAmount(input.items.map((i) => ({ quantity: i.quantity, monthlyPrice: price.get(i.spaceId)! })), input.startDate, input.endDate);
      const b = await tx.metroBooking.create({
        data: {
          organizationId: actor.organizationId, code: await nextCode(tx, 'metroBooking'), title: input.title ?? null,
          companyId: input.companyId ?? null, clientName: input.clientName ?? null, projectId: input.projectId ?? null,
          startDate: start, endDate: end, state: input.state, amount: input.amount ?? suggested, ownerId: input.ownerId ?? actor.id,
          createdById: actor.id, notes: input.notes ?? null,
          items: { create: input.items.map((i) => ({ spaceId: i.spaceId, quantity: i.quantity, monthlyPrice: price.get(i.spaceId)! })) },
        },
      });
      await log(actor, 'CREATE', 'metroBooking', b.id, { after: { code: b.code, items: input.items.length, amount: num(b.amount), state: b.state } }, tx);
      return b;
    });
    await tell(actor, booking, `رزرو تازهٔ مترو ${booking.code} (${METRO_BOOKING_LABELS[booking.state as MetroBookingState].fa})`);
    return reply.code(201).send(await shape(await loadBooking(booking.id, actor.organizationId)));
  });

  app.patch('/metro/bookings/:id', book, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await loadBooking(id, actor.organizationId);
    const input = parse(metroBookingUpdateSchema, req.body ?? {});
    await assertRefs(actor, input);
    const startS = input.startDate ?? iso(before.startDate)!, endS = input.endDate ?? iso(before.endDate)!;
    if (endS < startS) throw badRequest('BAD_PERIOD', 'پایان رزرو پیش از آغاز آن است.');
    const items = input.items ?? before.items.map((i) => ({ spaceId: i.spaceId, quantity: i.quantity }));
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('metro:${actor.organizationId}'))`);
      const holding = METRO_HOLDING_STATES.includes(before.state as MetroBookingState);
      const spaces = holding ? await assertFree(tx, actor.organizationId, items, day(startS), day(endS), id) : null;
      if (input.items) {
        const price = new Map((spaces ?? await tx.metroAdSpace.findMany({ where: { id: { in: items.map((i) => i.spaceId) }, organizationId: actor.organizationId }, select: { id: true, monthlyPrice: true } })).map((s) => [s.id, num(s.monthlyPrice)]));
        if (price.size !== new Set(items.map((i) => i.spaceId)).size) throw new AppError(422, 'UNKNOWN_SPACE', 'یکی از فضاهای برگزیده پیدا نشد.');
        await tx.metroBookingItem.deleteMany({ where: { bookingId: id } });
        await tx.metroBookingItem.createMany({ data: items.map((i) => ({ bookingId: id, spaceId: i.spaceId, quantity: i.quantity, monthlyPrice: price.get(i.spaceId)! })) });
      }
      const { items: _items, startDate, endDate, amount, ...rest } = input;
      await tx.metroBooking.update({
        where: { id },
        data: {
          ...rest, ...(amount != null ? { amount } : {}),
          ...(startDate ? { startDate: day(startDate) } : {}), ...(endDate ? { endDate: day(endDate), endingNotifiedAt: null } : {}),
        },
      });
      await log(actor, 'UPDATE', 'metroBooking', id, { before: { startDate: iso(before.startDate), endDate: iso(before.endDate), amount: num(before.amount) }, after: { ...rest, startDate, endDate, items: input.items?.length } }, tx);
    });
    return shape(await loadBooking(id, actor.organizationId));
  });

  app.post('/metro/bookings/:id/state', book, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const b = await loadBooking(id, actor.organizationId);
    const { to, reason } = parse(metroBookingMoveSchema, req.body);
    const from = b.state as MetroBookingState;
    if (!METRO_BOOKING_MOVES[from].includes(to)) throw conflict('BAD_MOVE', `رزرو «${METRO_BOOKING_LABELS[from].fa}» به «${METRO_BOOKING_LABELS[to].fa}» نمی‌رود.`);
    if (to === 'CANCELLED' && !reason?.trim()) throw badRequest('REASON_REQUIRED', 'دلیل لغو را بنویسید.');
    await prisma.$transaction(async (tx) => {
      // Coming back to holding the spaces, they must still be free.
      if (!METRO_HOLDING_STATES.includes(from) && METRO_HOLDING_STATES.includes(to)) {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('metro:${actor.organizationId}'))`);
        await assertFree(tx, actor.organizationId, b.items.map((i) => ({ spaceId: i.spaceId, quantity: i.quantity })), b.startDate, b.endDate, id);
      }
      await tx.metroBooking.update({ where: { id }, data: { state: to } });
      await log(actor, 'STATE_TRANSITION', 'metroBooking', id, { before: { state: from }, after: { state: to }, reason }, tx);
    });
    await tell(actor, b, `رزرو مترو ${b.code}: ${METRO_BOOKING_LABELS[to].fa}`);
    return shape(await loadBooking(id, actor.organizationId));
  });

  app.delete('/metro/bookings/:id', book, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const b = await loadBooking(id, actor.organizationId);
    await prisma.$transaction(async (tx) => {
      await tx.comment.deleteMany({ where: { entityType: 'metroBooking', entityId: id } });
      await tx.metroBooking.delete({ where: { id } });
      await log(actor, 'DELETE', 'metroBooking', id, { before: { code: b.code, client: b.company?.legalName ?? b.clientName, amount: num(b.amount), state: b.state } }, tx);
    });
    return { id };
  });

  app.post('/metro/bookings/:id/payments', book, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    await loadBooking(id, actor.organizationId);
    const input = parse(metroPaymentSchema, req.body);
    const p = await prisma.metroPayment.create({ data: { bookingId: id, amount: input.amount, paidAt: day(input.paidAt), method: input.method ?? null, reference: input.reference ?? null, note: input.note ?? null, recordedById: actor.id } });
    await log(actor, 'CREATE', 'metroPayment', p.id, { after: { bookingId: id, amount: input.amount, paidAt: input.paidAt } });
    return reply.code(201).send({ ...p, amount: num(p.amount), paidAt: iso(p.paidAt) });
  });

  app.delete('/metro/payments/:id', book, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const p = await prisma.metroPayment.findFirst({ where: { id, booking: { organizationId: actor.organizationId } } });
    if (!p) throw notFound('پرداخت');
    await prisma.metroPayment.delete({ where: { id } });
    await log(actor, 'DELETE', 'metroPayment', id, { before: { bookingId: p.bookingId, amount: num(p.amount) } });
    return { id };
  });

  /* ── reports ──────────────────────────────────────────────────────────── */

  async function report(req: FastifyRequest) {
    const actor = actorFrom(req);
    const q = parse(periodQuery, req.query);
    if (q.to < q.from) throw badRequest('BAD_PERIOD', 'پایان بازه پیش از آغاز آن است.');
    const from = day(q.from), to = day(q.to);
    const span = metroDays(q.from, q.to);
    const [spaces, items, bookings, payments] = await Promise.all([
      prisma.metroAdSpace.findMany({ where: { organizationId: actor.organizationId, isActive: true, ...(q.lineId ? { wagon: { train: { lineId: q.lineId } } } : {}) }, select: { id: true, kind: true, quantity: true, wagon: { select: { train: { select: { lineId: true } } } } }, take: 20_000 }),
      prisma.metroBookingItem.findMany({
        where: { booking: { organizationId: actor.organizationId, state: { in: ['CONFIRMED', 'ACTIVE', 'ENDED'] }, startDate: { lte: to }, endDate: { gte: from } }, ...(q.lineId ? { space: { wagon: { train: { lineId: q.lineId } } } } : {}) },
        select: { quantity: true, spaceId: true, booking: { select: { startDate: true, endDate: true } }, space: { select: { kind: true, wagon: { select: { train: { select: { lineId: true } } } } } } }, take: 50_000,
      }),
      prisma.metroBooking.findMany({
        where: { organizationId: actor.organizationId, startDate: { lte: to }, endDate: { gte: from }, ...(q.lineId ? { items: { some: { space: { wagon: { train: { lineId: q.lineId } } } } } } : {}) },
        select: { id: true, code: true, title: true, state: true, amount: true, startDate: true, endDate: true, clientName: true, company: { select: { legalName: true } }, payments: { select: { amount: true } } }, orderBy: { startDate: 'asc' }, take: 5000,
      }),
      prisma.metroPayment.findMany({ where: { booking: { organizationId: actor.organizationId }, paidAt: { gte: from, lte: to } }, select: { amount: true }, take: 50_000 }),
    ]);
    const lines = await prisma.metroLine.findMany({ where: { organizationId: actor.organizationId, ...(q.lineId ? { id: q.lineId } : {}) }, orderBy: { number: 'asc' }, select: { id: true, number: true, nameFa: true, color: true } });
    // Occupancy: unit-days sold against unit-days there were, by line and kind.
    const overlap = (s: Date, e: Date) => Math.max(0, Math.round((Math.min(e.getTime(), to.getTime()) - Math.max(s.getTime(), from.getTime())) / 86_400_000) + 1);
    const occupancy = lines.map((l) => ({
      line: l,
      kinds: METRO_SPACE_KINDS.map((kind) => {
        const capacity = spaces.filter((s) => s.kind === kind && s.wagon.train.lineId === l.id).reduce((t, s) => t + s.quantity, 0) * span;
        const sold = items.filter((i) => i.space.kind === kind && i.space.wagon.train.lineId === l.id).reduce((t, i) => t + i.quantity * overlap(i.booking.startDate, i.booking.endDate), 0);
        return { kind, capacity, sold, rate: capacity ? sold / capacity : 0 };
      }),
    }));
    const live = bookings.filter((b) => b.state !== 'CANCELLED');
    const clients = new Map<string, { client: string; bookings: number; amount: number }>();
    for (const b of live) {
      const c = b.company?.legalName ?? b.clientName ?? '—';
      const row = clients.get(c) ?? { client: c, bookings: 0, amount: 0 };
      row.bookings++; row.amount += num(b.amount); clients.set(c, row);
    }
    return {
      period: { from: q.from, to: q.to, days: span },
      occupancy,
      totals: {
        bookings: live.length, billed: live.reduce((s, b) => s + num(b.amount), 0),
        paidInPeriod: payments.reduce((s, p) => s + num(p.amount), 0),
        outstanding: live.reduce((s, b) => s + num(b.amount) - b.payments.reduce((t, p) => t + num(p.amount), 0), 0),
        byState: Object.fromEntries(Object.keys(METRO_BOOKING_LABELS).map((st) => [st, bookings.filter((b) => b.state === st).length])),
      },
      clients: [...clients.values()].sort((a, b) => b.amount - a.amount).slice(0, 20),
      bookings: bookings.map((b) => ({ id: b.id, code: b.code, title: b.title, client: b.company?.legalName ?? b.clientName, state: b.state, startDate: iso(b.startDate), endDate: iso(b.endDate), amount: num(b.amount), paid: b.payments.reduce((t, p) => t + num(p.amount), 0) })),
    };
  }

  app.get('/metro/reports', read, report);

  /** The period's bookings as a CSV that Excel opens in Persian. */
  app.get('/metro/reports.csv', read, async (req, reply) => {
    const r = await report(req);
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['کد', 'عنوان', 'مشتری', 'وضعیت', 'آغاز', 'پایان', 'مبلغ', 'پرداخت‌شده', 'مانده'];
    const rows = r.bookings.map((b) => [b.code, b.title, b.client, METRO_BOOKING_LABELS[b.state as MetroBookingState]?.fa ?? b.state, b.startDate, b.endDate, b.amount, b.paid, b.amount - b.paid]);
    const body = '﻿' + [head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="metro-${r.period.from}-${r.period.to}.csv"; filename*=UTF-8''${encodeURIComponent(`گزارش مترو ${r.period.from} تا ${r.period.to}.csv`)}`);
    return body;
  });

  /** Kinds and their names, for every screen that shows them. */
  app.get('/metro/kinds', read, async () => METRO_SPACE_KINDS.map((k) => ({ kind: k, fa: kindFa(k), en: METRO_SPACE_LABELS[k].en })));
};

export default metroRoutes;
