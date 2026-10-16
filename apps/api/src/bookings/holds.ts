import { Prisma } from '@prisma/client';
import type { Tx } from '../db.js';
import { AppError } from '../lib/errors.js';
import { conflictsFor } from './availability.js';

/**
 * Taking what a confirmed booking needs, all of it or none (audit F-9). The meeting platform's
 * three layers, in order of authority:
 *
 *   1. The exclusion constraints on `resource_holds` and `person_holds`: the database cannot store
 *      two overlapping holds of one room, one piece of equipment, one vehicle or one person.
 *   2. A transaction-scoped advisory lock on each thing and person touched, taken in one order so two
 *      confirmations cannot deadlock. It is what makes parking — shared up to a capacity, which no
 *      exclusion constraint expresses — safe to count.
 *   3. The availability check again, under the locks, so a lost race is said by name.
 *
 * Runs inside the workflow's transaction; any refusal rolls the whole move back.
 */

export interface HoldRequest {
  id: string;
  organizationId: string;
  startsAt: Date;
  endsAt: Date;
  roomId: string | null;
  resourceIds: readonly string[];
  parkingId: string | null;
  parkingSpaces: number;
  /** Everyone the meeting holds, the organiser included. */
  personIds: readonly string[];
}

const EXCLUSION_VIOLATION = '23P01';

export class BookingConflictError extends AppError {
  constructor(conflicts: unknown[], message = 'این زمان دیگر آزاد نیست؛ زمان دیگری برگزینید.') {
    super(409, 'BOOKING_CONFLICT', message, { conflicts });
  }
}

export async function release(tx: Tx, bookingId: string): Promise<void> {
  await tx.resourceHold.deleteMany({ where: { bookingId } });
  await tx.personHold.deleteMany({ where: { bookingId } });
}

export async function hold(tx: Tx, b: HoldRequest): Promise<void> {
  const persons = [...new Set(b.personIds)];
  const exclusive = [...new Set([...(b.roomId ? [b.roomId] : []), ...b.resourceIds])];
  const parking = b.parkingSpaces > 0 && b.parkingId ? b.parkingId : null;
  const keys = [
    ...persons.map((id) => `booking:person:${id}`),
    ...[...exclusive, ...(parking ? [parking] : [])].map((id) => `booking:resource:${id}`),
  ].sort();
  for (const key of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;

  await release(tx, b.id);
  const conflicts = await conflictsFor(tx, b.organizationId, {
    startsAt: b.startsAt, endsAt: b.endsAt, roomId: b.roomId, resourceIds: b.resourceIds,
    personIds: persons, parkingId: b.parkingId, parkingSpaces: b.parkingSpaces, excludeBookingId: b.id,
  });
  if (conflicts.length) throw new BookingConflictError(conflicts);

  const at = { organizationId: b.organizationId, bookingId: b.id, startsAt: b.startsAt, endsAt: b.endsAt };
  try {
    if (exclusive.length) await tx.resourceHold.createMany({ data: exclusive.map((resourceId) => ({ ...at, resourceId, spaces: 1, exclusive: true })) });
    if (parking) await tx.resourceHold.create({ data: { ...at, resourceId: parking, spaces: b.parkingSpaces, exclusive: false } });
    if (persons.length) await tx.personHold.createMany({ data: persons.map((userId) => ({ ...at, userId })) });
  } catch (e) {
    // Lost a race despite the locks (another installation process, a hand-run script): the database
    // said no, and that is the answer.
    const raw = e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError ? e.message : '';
    if (raw.includes(EXCLUSION_VIOLATION) || raw.includes('exclusion constraint')) throw new BookingConflictError([]);
    throw e;
  }
}
