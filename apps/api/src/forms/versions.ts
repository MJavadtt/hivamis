/**
 * Form definition versioning (roadmap #16).
 *
 * A definition's schema is data, and data changes. Before this, a change rewrote history: every
 * submission — and every archived PDF built from one — rendered under whatever the schema said
 * today, with fields that no longer existed and answers to questions that had been reworded.
 *
 * Now every schema change is a new version row, submissions pin the version they were filled
 * under, and readers ask `schemaForSubmission` rather than the definition. The definition's own
 * `schema` column stays the *current* version for new submissions.
 */
import type { FieldDef, FormDef, RoutingRule } from '@hiva/contracts';
import type { Tx } from '../db.js';

/**
 * Structural equality. JSONB hands back keys in its own order, so the schema that went in and
 * the schema that comes out of the database can differ as strings while being the same shape —
 * and a string comparison would mint a new version on every seed.
 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const sameSchema = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export interface PublishInput {
  organizationId: string;
  form: FormDef;
  /** Why the schema changed — recorded on the version row. */
  note?: string;
  createdById?: string | null;
}

/**
 * Create or update a definition from its declaration. Metadata (routing, SLA, names) is always
 * refreshed; the schema is compared, and only a real change produces a new version. Idempotent:
 * re-running the seed against an unchanged catalogue writes nothing new.
 */
export async function publishDefinition(tx: Tx, input: PublishInput): Promise<{ version: number; changed: boolean }> {
  const { form } = input;
  const metadata = {
    nameFa: form.nameFa,
    nameEn: form.nameEn,
    category: form.category,
    module: form.module,
    senderDepts: [...form.senderDepts],
    receiverDepts: [...form.receiverDepts],
    approverRoles: [...form.approverRoles],
    slaCode: form.slaCode ?? null,
    binding: form.binding ?? null,
    nextProcessFa: form.nextProcessFa ?? null,
  };
  const schema = form.fields as unknown as object;
  // Routing decides who must approve, so it is versioned with the schema rather than refreshed
  // silently: a submission is judged under the rules it was filled under (roadmap #16, #17).
  const routing = (form.routing ?? []) as unknown as object;
  const approvalChain = (form.approvalChain ?? []) as unknown as object;

  const existing = await tx.formDefinition.findUnique({ where: { code: form.code } });
  if (!existing) {
    const created = await tx.formDefinition.create({
      data: { organizationId: input.organizationId, no: form.no, code: form.code, ...metadata, schema, routing, approvalChain, version: 1 },
    });
    await tx.formDefinitionVersion.create({
      data: { definitionId: created.id, version: 1, schema, routing, approvalChain, nameFa: form.nameFa, note: input.note ?? null, createdById: input.createdById ?? null },
    });
    return { version: 1, changed: true };
  }

  if (sameSchema(existing.schema, schema) && sameSchema(existing.routing, routing) && sameSchema(existing.approvalChain, approvalChain)) {
    await tx.formDefinition.update({ where: { id: existing.id }, data: metadata });
    // A definition that predates versioning may have no row for its current version yet.
    await tx.formDefinitionVersion.upsert({
      where: { definitionId_version: { definitionId: existing.id, version: existing.version } },
      create: { definitionId: existing.id, version: existing.version, schema: existing.schema as object, routing: existing.routing as object, approvalChain: existing.approvalChain as object, nameFa: existing.nameFa },
      update: {},
    });
    return { version: existing.version, changed: false };
  }

  const version = existing.version + 1;
  await tx.formDefinition.update({ where: { id: existing.id }, data: { ...metadata, schema, routing, approvalChain, version } });
  await tx.formDefinitionVersion.create({
    data: { definitionId: existing.id, version, schema, routing, approvalChain, nameFa: form.nameFa, note: input.note ?? null, createdById: input.createdById ?? null },
  });
  return { version, changed: true };
}

/**
 * The fields a submission was filled under. Falls back to the definition's current schema only
 * for a submission whose version row is missing, which the migration's backfill should make
 * impossible — the fallback is there so a reader never sees an empty form.
 */
export async function schemaForSubmission(
  tx: Tx,
  submission: { definitionId: string; definitionVersion: number; definition?: { schema: unknown } | null },
): Promise<FieldDef[]> {
  const row = await tx.formDefinitionVersion.findUnique({
    where: { definitionId_version: { definitionId: submission.definitionId, version: submission.definitionVersion } },
    select: { schema: true },
  });
  const schema = row?.schema ?? submission.definition?.schema;
  return (Array.isArray(schema) ? schema : []) as FieldDef[];
}

/** The routing rules a submission was filled under — the ones that decided its approvers. */
export async function routingForSubmission(
  tx: Tx,
  submission: { definitionId: string; definitionVersion: number; definition?: { routing?: unknown } | null },
): Promise<RoutingRule[]> {
  const row = await tx.formDefinitionVersion.findUnique({
    where: { definitionId_version: { definitionId: submission.definitionId, version: submission.definitionVersion } },
    select: { routing: true },
  });
  const rules = row?.routing ?? submission.definition?.routing;
  return (Array.isArray(rules) ? rules : []) as RoutingRule[];
}
