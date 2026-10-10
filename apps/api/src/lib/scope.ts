import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { AppError } from './errors.js';

/**
 * How a row reaches its organisation, read from Prisma's own model description (audit SEC-1, SEC-12).
 *
 * A model with an `organizationId` scopes on it. A child without one (a milestone, a comment) reaches
 * one through the shortest chain of required relations — a milestone through its project. A model
 * that reaches no organisation at all (a role, a permission) is shared by the installation, and
 * nothing here constrains it.
 */

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];
type DmmfField = DmmfModel['fields'][number];

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name.toLowerCase(), m]));

export const modelNamed = (name: string): DmmfModel => {
  const m = MODELS.get(name.toLowerCase());
  if (!m) throw new Error(`unknown Prisma model "${name}"`);
  return m;
};
const accessor = (m: DmmfModel) => m.name[0]!.toLowerCase() + m.name.slice(1);
const relationsOf = (m: DmmfModel): DmmfField[] =>
  m.fields.filter((f) => f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0);

export const hasOrganizationColumn = (model: string): boolean =>
  modelNamed(model).fields.some((f) => f.name === 'organizationId' && f.kind === 'scalar');

const paths = new Map<string, string[] | null>();

/** The chain of relation fields from `model` to a model with an `organizationId`; null when shared. */
function pathToOrganization(model: string): string[] | null {
  const key = model.toLowerCase();
  if (paths.has(key)) return paths.get(key)!;
  const start = modelNamed(model);
  let found: string[] | null = null;
  if (start.name === 'Organization') found = [];
  else if (hasOrganizationColumn(start.name)) found = [];
  else {
    // Breadth first over required relations: the shortest chain is the one a query should walk.
    const queue: { m: DmmfModel; path: string[] }[] = [{ m: start, path: [] }];
    const seen = new Set([start.name]);
    while (queue.length && !found) {
      const { m, path } = queue.shift()!;
      for (const r of relationsOf(m)) {
        if (!r.isRequired || seen.has(r.type)) continue;
        seen.add(r.type);
        const next = [...path, r.name];
        if (hasOrganizationColumn(r.type)) { found = next; break; }
        queue.push({ m: modelNamed(r.type), path: next });
      }
    }
  }
  paths.set(key, found);
  return found;
}

/**
 * The Prisma `where` that keeps `model` to one organisation: `{ organizationId }`, or nested through
 * its parent — `{ project: { organizationId } }`. Null for a model the installation shares.
 */
export function organizationWhere(model: string, organizationId: string): Record<string, unknown> | null {
  if (modelNamed(model).name === 'Organization') return { id: organizationId };
  const path = pathToOrganization(model);
  if (!path) return null;
  return path.reduceRight<Record<string, unknown>>((inner, rel) => ({ [rel]: inner }), { organizationId });
}

/**
 * Refuses a write whose foreign keys name a record of another organisation (audit SEC-12).
 *
 * Every relation of `model` held by one column is checked when `data` sets it: the record it points
 * at must exist in `organizationId`. A record elsewhere answers exactly as a record that does not
 * exist — `422 UNKNOWN_REFERENCE` — so the answer says nothing about another organisation's ids.
 */
export async function assertOwnReferences(
  model: string,
  data: Record<string, unknown>,
  organizationId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  for (const rel of relationsOf(modelNamed(model))) {
    const from = rel.relationFromFields!;
    // `organizationId` is the server's to set, and a composite key's other half is checked with it.
    const field = from.find((f) => f !== 'organizationId');
    if (!field || from.length - (from.includes('organizationId') ? 1 : 0) !== 1) continue;
    const value = data[field];
    if (typeof value !== 'string' || !value) continue;
    const scope = organizationWhere(rel.type, organizationId);
    if (!scope) continue;
    const target = modelNamed(rel.type);
    const key = rel.relationToFields?.[from.indexOf(field)] ?? 'id';
    const found = await (db as any)[accessor(target)].count({ where: { [key]: value, ...scope } });
    if (!found) throw new AppError(422, 'UNKNOWN_REFERENCE', `ارجاع «${field}» نامعتبر است.`, { field });
  }
}
