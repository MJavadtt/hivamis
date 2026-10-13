import type { Tx } from '../db.js';

/**
 * Every job title the organisation's people carry becomes a position of its own, in the unit most
 * of its holders are in, and they are given it (audit F-3). What the migration did for the data that
 * was there, done for people made afterwards by the seed or an import. Titles already a position are
 * left as they are; the text stays on each person as the fallback.
 */
export async function positionsFromTitles(tx: Tx, organizationId: string): Promise<number> {
  const people = await tx.user.findMany({
    where: { organizationId, deletedAt: null, positionId: null, jobTitle: { not: null } },
    select: { id: true, jobTitle: true, departmentId: true },
  });
  const byTitle = new Map<string, typeof people>();
  for (const p of people) {
    const title = p.jobTitle!.trim();
    if (title) byTitle.set(title, [...(byTitle.get(title) ?? []), p]);
  }
  let made = 0;
  for (const [title, holders] of byTitle) {
    const units = new Map<string, number>();
    for (const h of holders) if (h.departmentId) units.set(h.departmentId, (units.get(h.departmentId) ?? 0) + 1);
    const unit = [...units].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const existing = await tx.position.findUnique({ where: { organizationId_nameFa: { organizationId, nameFa: title } } });
    const position = existing ?? await tx.position.create({ data: { organizationId, nameFa: title, departmentId: unit } });
    if (!existing) made++;
    await tx.user.updateMany({ where: { id: { in: holders.map((h) => h.id) } }, data: { positionId: position.id } });
  }
  return made;
}
