import { METRO_HOLDING_STATES, METRO_SPACE_LABELS, type MetroSpaceKind } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { AppError } from '../lib/errors.js';

/**
 * A space holds as many units as it has (ADR-135): forty handles may go to five clients, a body to one.
 * Over any days two bookings share, what holds, confirmed and running bookings take of a space may not
 * pass its quantity.
 */
export const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** What is taken of each space over these days, by bookings other than `except`. */
export async function takenOf(db: Tx | typeof prisma, organizationId: string, spaceIds: string[], start: Date, end: Date, except?: string): Promise<Map<string, number>> {
  if (!spaceIds.length) return new Map();
  const rows = await db.metroBookingItem.findMany({
    where: {
      spaceId: { in: spaceIds },
      booking: { organizationId, state: { in: [...METRO_HOLDING_STATES] }, startDate: { lte: end }, endDate: { gte: start }, ...(except ? { id: { not: except } } : {}) },
    },
    select: { spaceId: true, quantity: true },
    take: 20_000,
  });
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.spaceId, (out.get(r.spaceId) ?? 0) + r.quantity);
  return out;
}

/** Refuses what would put more on a space than it has, naming the space and what is free. */
export async function assertFree(db: Tx, organizationId: string, items: { spaceId: string; quantity: number }[], start: Date, end: Date, except?: string) {
  const want = new Map<string, number>();
  for (const i of items) want.set(i.spaceId, (want.get(i.spaceId) ?? 0) + i.quantity);
  const spaces = await db.metroAdSpace.findMany({
    where: { id: { in: [...want.keys()] }, organizationId },
    select: { id: true, kind: true, label: true, quantity: true, isActive: true, monthlyPrice: true, wagon: { select: { number: true, train: { select: { code: true, line: { select: { nameFa: true } } } } } } },
  });
  if (spaces.length !== want.size) throw new AppError(422, 'UNKNOWN_SPACE', 'یکی از فضاهای برگزیده پیدا نشد.');
  const taken = await takenOf(db, organizationId, [...want.keys()], start, end, except);
  for (const s of spaces) {
    const free = s.quantity - (taken.get(s.id) ?? 0);
    if (!s.isActive) throw new AppError(409, 'SPACE_INACTIVE', `فضای ${s.label ?? METRO_SPACE_LABELS[s.kind as MetroSpaceKind]?.fa ?? s.kind} واگن ${s.wagon.number} قطار ${s.wagon.train.code} غیرفعال است.`);
    if (want.get(s.id)! > free) {
      throw new AppError(409, 'SPACE_TAKEN', `در این تاریخ‌ها از فضای ${s.label ?? METRO_SPACE_LABELS[s.kind as MetroSpaceKind]?.fa ?? s.kind} واگن ${s.wagon.number} قطار ${s.wagon.train.code} (${s.wagon.train.line.nameFa}) ${free} واحد آزاد است.`, { spaceId: s.id, free });
    }
  }
  return spaces;
}
