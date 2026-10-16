import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { AppError } from './errors.js';

/**
 * A team someone may be put in (list 3, item 6): an open team of the organisation, in the person's
 * own unit. Anything else answers as a team that does not exist there. The database refuses the
 * same (`hiva_team_in_unit`).
 */
export async function teamInUnit(db: Tx | typeof prisma, organizationId: string, teamId: string, departmentId: string): Promise<string> {
  const team = await db.team.findFirst({ where: { id: teamId, organizationId, departmentId, archivedAt: null }, select: { id: true } });
  if (!team) throw new AppError(422, 'TEAM_NOT_IN_UNIT', 'این تیم در واحد این شخص نیست.', { field: 'teamId' });
  return team.id;
}

/** The short form every screen shows: which team, in what colour. */
export const teamOf = (t: { id: string; nameFa: string; nameEn: string; color: string | null } | null | undefined) =>
  t ? { id: t.id, nameFa: t.nameFa, nameEn: t.nameEn, color: t.color } : null;
