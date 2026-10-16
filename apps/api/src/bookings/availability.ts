import type { BookingConflict } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { visibleAmong, type BookingViewer } from './access.js';

/**
 * Whether a time works, said in advance and by name (audit F-9). Holds of confirmed bookings are the
 * truth; the database refuses an overlapping one when a booking is confirmed. This reads the same
 * holds so a person learns which room, which colleague or how much parking is in the way before they
 * send anything — and never the title of a booking they may not read.
 */

type Db = Tx | typeof prisma;

export interface SlotQuery {
  startsAt: Date;
  endsAt: Date;
  roomId?: string | null;
  resourceIds?: readonly string[];
  /** Everyone the meeting holds, the organiser included. */
  personIds?: readonly string[];
  parkingId?: string | null;
  parkingSpaces?: number;
  /** The booking being checked, whose own holds are not in its way. */
  excludeBookingId?: string;
}

const overlapping = (q: { startsAt: Date; endsAt: Date }) => ({ startsAt: { lt: q.endsAt }, endsAt: { gt: q.startsAt } });
const iso = (d: Date) => d.toISOString();

/** The most spaces in use at any instant of the window, from the holds that touch it. */
export function peakUse(holds: readonly { startsAt: Date; endsAt: Date; spaces: number }[], window: { startsAt: Date; endsAt: Date }): number {
  const edges: [number, number][] = [];
  for (const h of holds) {
    const from = Math.max(h.startsAt.getTime(), window.startsAt.getTime());
    const to = Math.min(h.endsAt.getTime(), window.endsAt.getTime());
    if (from < to) edges.push([from, h.spaces], [to, -h.spaces]);
  }
  // At one instant, a hold ending frees its spaces before the next one takes them (half-open).
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0, peak = 0;
  for (const [, d] of edges) { now += d; peak = Math.max(peak, now); }
  return peak;
}

export async function conflictsFor(db: Db, organizationId: string, q: SlotQuery, viewer?: BookingViewer): Promise<BookingConflict[]> {
  const out: BookingConflict[] = [];
  const exclusiveIds = [...new Set([...(q.roomId ? [q.roomId] : []), ...(q.resourceIds ?? [])])];
  const wantParking = (q.parkingSpaces ?? 0) > 0;
  const resourceIds = [...exclusiveIds, ...(wantParking && q.parkingId ? [q.parkingId] : [])];
  const notThis = q.excludeBookingId ? { bookingId: { not: q.excludeBookingId } } : {};

  const resources = resourceIds.length
    ? await db.bookableResource.findMany({ where: { id: { in: resourceIds }, organizationId }, select: { id: true, name: true, isActive: true, capacity: true, type: true } })
    : [];
  const byId = new Map(resources.map((r) => [r.id, r]));
  for (const id of resourceIds) {
    const r = byId.get(id);
    if (!r || !r.isActive) out.push({ kind: 'INACTIVE', subjectId: id, nameFa: r?.name ?? '—', messageFa: `«${r?.name ?? 'این مورد'}» برای رزرو در دسترس نیست.` });
  }

  const [held, people] = await Promise.all([
    exclusiveIds.length
      ? db.resourceHold.findMany({
          where: { organizationId, resourceId: { in: exclusiveIds }, exclusive: true, ...overlapping(q), ...notThis },
          select: { resourceId: true, bookingId: true, startsAt: true, endsAt: true, booking: { select: { code: true } } },
          orderBy: { startsAt: 'asc' }, take: 50,
        })
      : [],
    q.personIds?.length
      ? db.personHold.findMany({
          where: { organizationId, userId: { in: [...new Set(q.personIds)] }, ...overlapping(q), ...notThis },
          select: { userId: true, bookingId: true, startsAt: true, endsAt: true, booking: { select: { code: true } }, user: { select: { fullName: true } } },
          orderBy: { startsAt: 'asc' }, take: 50,
        })
      : [],
  ]);
  const named = viewer ? await visibleAmong(viewer, [...held, ...people].map((h) => h.bookingId)) : new Set<string>();
  const code = (h: { bookingId: string; booking: { code: string } }) => (named.has(h.bookingId) ? h.booking.code : undefined);

  for (const h of held) {
    const r = byId.get(h.resourceId);
    out.push({
      kind: r?.type === 'ROOM' ? 'ROOM' : 'RESOURCE', subjectId: h.resourceId, nameFa: r?.name ?? '—', bookingCode: code(h),
      from: iso(h.startsAt), to: iso(h.endsAt),
      messageFa: `«${r?.name ?? '—'}» در این زمان رزرو شده است.`,
    });
  }
  for (const h of people) {
    out.push({
      kind: 'PERSON', subjectId: h.userId, nameFa: h.user.fullName, bookingCode: code(h),
      from: iso(h.startsAt), to: iso(h.endsAt),
      messageFa: `${h.user.fullName} در این زمان در جلسهٔ دیگری است.`,
    });
  }

  if (wantParking) {
    const lot = q.parkingId ? byId.get(q.parkingId) : undefined;
    if (!q.parkingId) {
      out.push({ kind: 'PARKING', subjectId: '', nameFa: 'پارکینگ', messageFa: 'برای جای پارک، پارکینگ را برگزینید.' });
    } else if (lot?.isActive) {
      const holds = await db.resourceHold.findMany({
        where: { organizationId, resourceId: lot.id, ...overlapping(q), ...notThis },
        select: { startsAt: true, endsAt: true, spaces: true }, take: 1000,
      });
      const free = lot.capacity - peakUse(holds, q);
      if (free < q.parkingSpaces!) {
        out.push({ kind: 'PARKING', subjectId: lot.id, nameFa: lot.name, messageFa: `در «${lot.name}» در این زمان ${Math.max(free, 0)} جای خالی هست و ${q.parkingSpaces} جا خواسته شده.` });
      }
    }
  }
  return out;
}

/** Rooms free for the whole window, with the seats and features asked for, smallest first. */
export async function freeRooms(db: Db, organizationId: string, q: { startsAt: Date; endsAt: Date; seats?: number; features?: readonly string[]; excludeBookingId?: string }) {
  const rooms = await db.bookableResource.findMany({
    where: {
      organizationId, type: 'ROOM', isActive: true,
      capacity: { gte: q.seats ?? 0 },
      ...(q.features?.length ? { features: { hasEvery: [...q.features] } } : {}),
    },
    select: { id: true, name: true, capacity: true, floor: true, features: true, location: { select: { id: true, name: true } } },
    orderBy: [{ capacity: 'asc' }, { name: 'asc' }], take: 200,
  });
  if (!rooms.length) return [];
  const busy = await db.resourceHold.findMany({
    where: { organizationId, resourceId: { in: rooms.map((r) => r.id) }, exclusive: true, ...overlapping(q), ...(q.excludeBookingId ? { bookingId: { not: q.excludeBookingId } } : {}) },
    select: { resourceId: true }, take: 1000,
  });
  const taken = new Set(busy.map((b) => b.resourceId));
  return rooms.filter((r) => !taken.has(r.id));
}

/** The day, weekday and minute of an instant on the organisation's clock. */
function local(d: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

const STEP_MS = 30 * 60_000;

/**
 * The next times, of the same length, when the room and every person are free — on working days,
 * within working hours, on the organisation's clock. At most `limit`, within a week.
 */
export async function suggestSlots(db: Db, organizationId: string, q: SlotQuery & { limit?: number }) {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true, workingDays: true, workStartHour: true, workEndHour: true } });
  const length = q.endsAt.getTime() - q.startsAt.getTime();
  const from = new Date(Math.ceil(Math.max(q.startsAt.getTime(), Date.now()) / STEP_MS) * STEP_MS);
  const until = new Date(from.getTime() + 7 * 86_400_000);
  const holidays = new Set((await db.holiday.findMany({ where: { organizationId, date: { gte: new Date(from.getTime() - 86_400_000), lte: until } }, select: { date: true } }))
    .map((h) => h.date.toISOString().slice(0, 10)));
  const exclusiveIds = [...new Set([...(q.roomId ? [q.roomId] : []), ...(q.resourceIds ?? [])])];
  const window = { startsAt: from, endsAt: new Date(until.getTime() + length) };
  const notThis = q.excludeBookingId ? { bookingId: { not: q.excludeBookingId } } : {};
  const [held, people] = await Promise.all([
    exclusiveIds.length ? db.resourceHold.findMany({ where: { organizationId, resourceId: { in: exclusiveIds }, exclusive: true, ...overlapping(window), ...notThis }, select: { startsAt: true, endsAt: true }, take: 2000 }) : [],
    q.personIds?.length ? db.personHold.findMany({ where: { organizationId, userId: { in: [...new Set(q.personIds)] }, ...overlapping(window), ...notThis }, select: { startsAt: true, endsAt: true }, take: 5000 }) : [],
  ]);
  const busy = [...held, ...people];
  const out: { startsAt: string; endsAt: string }[] = [];
  for (let t = from.getTime(); t < until.getTime() && out.length < (q.limit ?? 5); t += STEP_MS) {
    const s = new Date(t), e = new Date(t + length);
    const a = local(s, org.timezone), b = local(new Date(e.getTime() - 1), org.timezone);
    if (a.day !== b.day || !org.workingDays.includes(a.weekday) || holidays.has(a.day)) continue;
    if (a.minute < org.workStartHour * 60 || b.minute + 1 > org.workEndHour * 60) continue;
    if (busy.some((h) => h.startsAt < e && h.endsAt > s)) continue;
    out.push({ startsAt: iso(s), endsAt: iso(e) });
  }
  return out;
}
