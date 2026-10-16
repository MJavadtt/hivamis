import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { notFound } from '../lib/errors.js';

/**
 * Who may read a booking (audit F-9). The meeting platform's bot answered `/start meeting_<id>` with
 * any meeting's summary to anyone registered (finding 3). Here a booking is read by those it
 * concerns — its organiser, its approver or the approver's stand-in, a participant — or by whoever
 * holds `meeting.view_all`. To anyone else it does not exist: 404, never 403.
 */

export interface BookingViewer {
  id: string;
  organizationId: string;
  permissions: readonly string[];
  /** permission → who delegated it; an approver's stand-in sees what the approver would. */
  delegated?: Record<string, string>;
}

export const seesAll = (v: Pick<BookingViewer, 'permissions'>) => v.permissions.includes('meeting.view_all');

export function visibleWhere(v: BookingViewer): Prisma.BookingWhereInput {
  if (seesAll(v)) return { organizationId: v.organizationId };
  const standInFor = v.delegated?.['meeting.approve'];
  return {
    organizationId: v.organizationId,
    OR: [
      { organizerId: v.id },
      { approverId: v.id },
      ...(standInFor ? [{ approverId: standInFor }] : []),
      { participants: { some: { userId: v.id } } },
    ],
  };
}

/** The booking, if the viewer may read it; otherwise as absent as one that never was. */
export async function assertVisible(v: BookingViewer, id: string, db: Tx | typeof prisma = prisma): Promise<void> {
  const found = await db.booking.count({ where: { id, ...visibleWhere(v) } });
  if (!found) throw notFound('رزرو');
}

/** Which of these bookings the viewer may read — to name one in a conflict, or keep it nameless. */
export async function visibleAmong(v: BookingViewer, ids: string[], db: Tx | typeof prisma = prisma): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.booking.findMany({ where: { id: { in: ids }, ...visibleWhere(v) }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}
