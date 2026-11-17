import { prisma } from '../db.js';
import { isFileRecord, mayReadFile, recordInOrganization } from '../documents/records.js';
import { badRequest, notFound } from '../lib/errors.js';
import { organizationWhere } from '../lib/scope.js';

/**
 * What a note — or a file — is written on (ADR-134): the same targets the files panel uses (ADR-121),
 * a record's own column (`projectId`…) or `recordType` and `recordId`. One gate for both: whoever may
 * read a record's files may read and write its notes.
 */
const COLUMNS = {
  projectId: 'project', companyId: 'company', contractId: 'contract', deliverableId: 'deliverable',
  proposalId: 'proposal', submissionId: 'formSubmission', venueId: 'venue', siteProjectId: 'siteProject',
} as const;
type Column = keyof typeof COLUMNS;

export interface NoteTarget { entityType: string; entityId: string; column: Column | null }

export function targetOf(input: Record<string, unknown>): NoteTarget {
  const str = (k: string) => (typeof input[k] === 'string' && input[k] ? String(input[k]) : null);
  for (const column of Object.keys(COLUMNS) as Column[]) {
    const id = str(column);
    if (id) return { entityType: COLUMNS[column], entityId: id, column };
  }
  const type = str('recordType'), id = str('recordId');
  if (type && id && isFileRecord(type)) return { entityType: type, entityId: id, column: null };
  throw badRequest('NO_TARGET', 'روشن نیست یادداشت روی کدام رکورد است.');
}

interface Reader { id: string; organizationId: string; permissions: readonly string[]; roles: readonly string[]; departmentCode?: string | null }

/** The record exists in the reader's organisation and is theirs to read — or it is not found. */
export async function assertMayNote(actor: Reader, t: NoteTarget): Promise<void> {
  const exists = t.column
    ? (await (prisma as unknown as Record<string, { count(a: unknown): Promise<number> }>)[t.entityType]!.count({ where: { id: t.entityId, ...organizationWhere(t.entityType[0]!.toUpperCase() + t.entityType.slice(1), actor.organizationId) } })) > 0
    : await recordInOrganization(t.entityType as never, t.entityId, actor.organizationId);
  const links = {
    venueId: null, siteProjectId: null, siteRecordType: null, recordType: t.column ? null : t.entityType, recordId: t.column ? null : t.entityId,
    ...(t.column ? { [t.column]: t.entityId } : {}),
  };
  if (!exists || !(await mayReadFile(actor as never, links as never))) throw notFound('رکورد');
}
