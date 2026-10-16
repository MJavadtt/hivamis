import { prisma } from '../db.js';

/**
 * How the rooms are used (audit F-9, step 4), for whoever runs them: bookings by how they ended, each
 * room's booked hours against its working hours, the hours of the day meetings start in, and catering
 * ordered. Counted from holds — what was actually held — not from requests.
 */

/** Working days and hours between two instants, on the organisation's clock. */
function workingHours(from: Date, to: Date, org: { timezone: string; workingDays: number[]; workStartHour: number; workEndHour: number }, holidays: Set<string>) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const days = new Set<string>();
  let n = 0;
  for (let t = from.getTime(); t < to.getTime(); t += 3_600_000) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (days.has(day)) continue;
    days.add(day);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
    if (org.workingDays.includes(weekday) && !holidays.has(day)) n += 1;
  }
  return n * Math.max(org.workEndHour - org.workStartHour, 0);
}

export async function bookingAnalytics(organizationId: string, from: Date, to: Date) {
  const span = { startsAt: { lt: to }, endsAt: { gt: from } };
  const [org, holidays, states, rooms, holds, catering] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true, workingDays: true, workStartHour: true, workEndHour: true } }),
    prisma.holiday.findMany({ where: { organizationId, date: { gte: new Date(from.getTime() - 86_400_000), lte: to } }, select: { date: true }, take: 400 }),
    prisma.booking.groupBy({ by: ['state'], where: { organizationId, ...span }, _count: { _all: true } }),
    prisma.bookableResource.findMany({ where: { organizationId, type: 'ROOM' }, select: { id: true, name: true, capacity: true, isActive: true }, orderBy: { name: 'asc' }, take: 200 }),
    prisma.resourceHold.findMany({ where: { organizationId, exclusive: true, resource: { type: 'ROOM' }, ...span }, select: { resourceId: true, startsAt: true, endsAt: true }, take: 20_000 }),
    prisma.bookingCatering.findMany({
      where: { organizationId, booking: { state: { in: ['CONFIRMED', 'COMPLETED'] }, ...span } },
      select: { quantity: true, option: { select: { id: true, labelFa: true, labelEn: true, unitPrice: true } } }, take: 20_000,
    }),
  ]);
  const available = workingHours(from, to, org, new Set(holidays.map((h) => h.date.toISOString().slice(0, 10))));
  const hoursOf = (h: { startsAt: Date; endsAt: Date }) => (Math.min(h.endsAt.getTime(), to.getTime()) - Math.max(h.startsAt.getTime(), from.getTime())) / 3_600_000;
  const booked = new Map<string, { hours: number; meetings: number }>();
  const byHour = Array.from({ length: 24 }, () => 0);
  const hourOf = new Intl.DateTimeFormat('en-GB', { timeZone: org.timezone, hour: '2-digit', hourCycle: 'h23' });
  for (const h of holds) {
    const b = booked.get(h.resourceId) ?? { hours: 0, meetings: 0 };
    b.hours += Math.max(hoursOf(h), 0);
    b.meetings += 1;
    booked.set(h.resourceId, b);
    byHour[Number(hourOf.format(h.startsAt)) % 24]! += 1;
  }
  const food = new Map<string, { labelFa: string; labelEn: string; quantity: number; cost: number }>();
  for (const c of catering) {
    const f = food.get(c.option.id) ?? { labelFa: c.option.labelFa, labelEn: c.option.labelEn, quantity: 0, cost: 0 };
    f.quantity += c.quantity;
    f.cost += c.quantity * Number(c.option.unitPrice);
    food.set(c.option.id, f);
  }
  const count = Object.fromEntries(states.map((s) => [s.state, s._count._all]));
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    from, to, workingHoursPerRoom: available,
    bookings: { total: Object.values(count).reduce((a, b) => a + b, 0), byState: count },
    rooms: rooms.map((r) => {
      const b = booked.get(r.id) ?? { hours: 0, meetings: 0 };
      return { ...r, meetings: b.meetings, hours: round(b.hours), utilization: available ? round((b.hours / available) * 100) : 0 };
    }),
    startsByHour: byHour,
    catering: [...food.values()].sort((a, b) => b.quantity - a.quantity),
  };
}
