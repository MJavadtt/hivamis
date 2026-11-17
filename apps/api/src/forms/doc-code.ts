import { UNIT_SHORT_CODES, documentCode, type DepartmentCode } from '@hiva/contracts';
import { prisma } from '../db.js';

/**
 * A form's document code by the owner's coding instruction QA-WI-001/00 (ADR-133): the two letters
 * of the unit that owns it — the first unit that sends it; management's when any unit may — then
 * FR, its serial among that unit's forms, and its revision: `SA-FR-001/00`. The serial follows the
 * catalogue's order, so a form keeps its number; the revision is how many times it was redesigned.
 */
export async function formDocCodes(organizationId: string): Promise<Map<string, string>> {
  const [units, forms] = await Promise.all([
    prisma.department.findMany({ where: { organizationId }, select: { code: true, shortCode: true } }),
    prisma.formDefinition.findMany({ where: { organizationId }, select: { id: true, senderDepts: true, version: true }, orderBy: [{ no: 'asc' }, { createdAt: 'asc' }], take: 2000 }),
  ]);
  const short = new Map(units.map((u) => [u.code, u.shortCode ?? UNIT_SHORT_CODES[u.code as DepartmentCode] ?? u.code.slice(0, 2)]));
  const serial = new Map<string, number>();
  const out = new Map<string, string>();
  for (const f of forms) {
    const owner = short.get(f.senderDepts[0] ?? 'M') ?? 'MA';
    const n = (serial.get(owner) ?? 0) + 1;
    serial.set(owner, n);
    out.set(f.id, documentCode(owner, 'FR', n, f.version - 1));
  }
  return out;
}
