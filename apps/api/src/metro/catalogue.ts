import { METRO_CATALOGUE, METRO_WAGON_TEMPLATE, metroInterchanges, type MetroSpaceKind } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';

/**
 * The metro an organisation starts with (ADR-135): Tehran's seven lines and their stations from the
 * operator's map, laid down once. After that the lines are the organisation's — what it deletes stays
 * deleted, as the settings row says it was seeded. Trains and wagons are its own to enter.
 */
export async function ensureMetroCatalogue(organizationId: string, db: Tx | typeof prisma = prisma): Promise<boolean> {
  const done = await db.metroSettings.findUnique({ where: { organizationId } });
  if (done) return false;
  const crossing = metroInterchanges();
  for (const l of METRO_CATALOGUE) {
    const line = await db.metroLine.upsert({
      where: { organizationId_number: { organizationId, number: l.number } },
      update: {},
      create: { organizationId, number: l.number, nameFa: l.fa, nameEn: l.en, city: l.city, color: l.color },
    });
    if (await db.metroStation.count({ where: { lineId: line.id } })) continue;
    await db.metroStation.createMany({
      data: l.stations.map((s, i) => {
        const [nameFa, branch] = Array.isArray(s) ? s : [s, null];
        return { organizationId, lineId: line.id, nameFa, branch, order: i + 1, isInterchange: crossing.has(nameFa) };
      }),
    });
  }
  await db.metroSettings.create({ data: { organizationId } });
  return true;
}

/** The spaces a new wagon carries: the template's, as asked, at the prices given. */
export function wagonSpaces(organizationId: string, wagonId: string, template: Partial<Record<MetroSpaceKind, number>>, prices: Partial<Record<MetroSpaceKind, number>>) {
  return (Object.keys(METRO_WAGON_TEMPLATE) as MetroSpaceKind[])
    .map((kind) => ({ kind, quantity: template[kind] ?? METRO_WAGON_TEMPLATE[kind] }))
    .filter((s) => s.quantity > 0)
    .map((s) => ({ organizationId, wagonId, kind: s.kind, quantity: s.quantity, monthlyPrice: prices[s.kind] ?? 0 }));
}
