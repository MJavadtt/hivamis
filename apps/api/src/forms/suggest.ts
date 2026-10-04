import { RECORD_KINDS, maySubmitForm, stageCategories, type FieldDef } from '@hiva/contracts';
import { prisma } from '../db.js';

/**
 * The forms a page offers, ready to fill (Hivamis task 4b).
 *
 * On a record's page: every active form with a field that points at that kind of record and that the
 * reader's unit may send — with that field, and every other field pointing at a record this one
 * belongs to (its project, client, contract…), already filled. They come in the order the record's
 * stage calls for them, then by how often the reader's unit has used them lately. Without a record:
 * the forms the reader uses most, so the next one is a click away.
 */

export interface Suggestion {
  code: string; nameFa: string; nameEn: string; category: string;
  /** Field key → the id it is filled with. */
  prefill: Record<string, string>;
  /** The record's stage calls for this form's category. */
  fitsStage: boolean;
  /** How often the reader's unit sent it in the last six months. */
  unitUses: number;
  /** When it was last sent for this very record, if ever. */
  lastForRecord: string | null;
}

export interface SuggestActor { id: string; organizationId: string; departmentCode: string | null; roles: string[]; permissions: string[] }

interface Context { state: string | null; refs: Record<string, string> }

const compact = (o: Record<string, string | null | undefined>) =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === 'string'));

/** The record, its stage, and the records it belongs to — what a form about it can be filled with. */
export async function recordContext(entity: string, id: string, organizationId: string): Promise<Context | null> {
  const org = { id, organizationId };
  switch (entity) {
    case 'company': {
      const r = await prisma.company.findFirst({ where: org, select: { id: true } });
      return r && { state: null, refs: { company: r.id } };
    }
    case 'opportunity': {
      const r = await prisma.opportunity.findFirst({ where: org, select: { state: true, companyId: true } });
      return r && { state: r.state, refs: compact({ opportunity: id, company: r.companyId }) };
    }
    case 'brief': {
      const r = await prisma.brief.findFirst({ where: org, select: { state: true, opportunityId: true, opportunity: { select: { companyId: true } } } });
      return r && { state: r.state, refs: compact({ brief: id, opportunity: r.opportunityId, company: r.opportunity.companyId }) };
    }
    case 'proposal': {
      const r = await prisma.proposal.findFirst({ where: org, select: { state: true, briefId: true, brief: { select: { opportunityId: true, opportunity: { select: { companyId: true } } } } } });
      return r && { state: r.state, refs: compact({ proposal: id, brief: r.briefId, opportunity: r.brief.opportunityId, company: r.brief.opportunity.companyId }) };
    }
    case 'project': {
      const r = await prisma.project.findFirst({ where: org, select: { state: true, companyId: true, briefId: true, proposalId: true, opportunityId: true } });
      if (!r) return null;
      const contract = await prisma.contract.findFirst({ where: { projectId: id, organizationId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      return { state: r.state, refs: compact({ project: id, company: r.companyId, brief: r.briefId, proposal: r.proposalId, opportunity: r.opportunityId, contract: contract?.id }) };
    }
    case 'contract': {
      const r = await prisma.contract.findFirst({ where: org, select: { state: true, companyId: true, proposalId: true, projectId: true } });
      return r && { state: r.state, refs: compact({ contract: id, company: r.companyId, proposal: r.proposalId, project: r.projectId }) };
    }
    case 'workOrder': {
      const r = await prisma.workOrder.findFirst({ where: org, select: { state: true, projectId: true, proposalId: true, project: { select: { companyId: true } } } });
      return r && { state: r.state, refs: compact({ workOrder: id, project: r.projectId, proposal: r.proposalId, company: r.project.companyId }) };
    }
    case 'deliverable': {
      const r = await prisma.deliverable.findFirst({ where: org, select: { state: true, projectId: true, proposalId: true, workOrderId: true, project: { select: { companyId: true } } } });
      return r && { state: r.state, refs: compact({ deliverable: id, project: r.projectId, proposal: r.proposalId, workOrder: r.workOrderId, company: r.project.companyId }) };
    }
    case 'task': {
      const r = await prisma.task.findFirst({ where: org, select: { state: true, projectId: true, workOrderId: true, deliverableId: true } });
      return r && { state: r.state, refs: compact({ task: id, project: r.projectId, workOrder: r.workOrderId, deliverable: r.deliverableId }) };
    }
    case 'changeRequest': {
      const r = await prisma.changeRequest.findFirst({ where: org, select: { state: true, projectId: true, project: { select: { companyId: true } } } });
      return r && { state: r.state, refs: compact({ changeRequest: id, project: r.projectId, company: r.project.companyId }) };
    }
    case 'invoice': {
      const r = await prisma.invoice.findFirst({ where: org, select: { state: true, companyId: true, projectId: true, contractId: true } });
      return r && { state: r.state, refs: compact({ invoice: id, company: r.companyId, project: r.projectId, contract: r.contractId }) };
    }
    default:
      return null;
  }
}

const refFields = (schema: unknown): FieldDef[] =>
  (Array.isArray(schema) ? (schema as FieldDef[]) : []).filter((f) => f.type === 'entityRef' && typeof f.entity === 'string');

async function unitUsage(actor: SuggestActor, since: Date): Promise<Map<string, number>> {
  if (!actor.departmentCode) return new Map();
  const rows = await prisma.formSubmission.groupBy({
    by: ['definitionId'], _count: { _all: true },
    where: { createdAt: { gt: since }, submittedBy: { organizationId: actor.organizationId, department: { code: actor.departmentCode } } },
  });
  return new Map(rows.map((r) => [r.definitionId, r._count._all]));
}

const SIX_MONTHS = 183 * 86_400_000;

export async function suggestForRecord(actor: SuggestActor, entity: string, id: string, limit: number): Promise<{ state: string | null; total: number; forms: Suggestion[] } | null> {
  const context = await recordContext(entity, id, actor.organizationId);
  if (!context) return null;
  const stage = stageCategories(entity, context.state);
  const definitions = await prisma.formDefinition.findMany({ where: { organizationId: actor.organizationId, isActive: true }, orderBy: { no: 'asc' } });
  const candidates = definitions.filter((d) =>
    refFields(d.schema).some((f) => f.entity === entity) && maySubmitForm(d.senderDepts, actor.departmentCode, actor.roles));
  if (!candidates.length) return { state: context.state, total: 0, forms: [] };

  const usage = await unitUsage(actor, new Date(Date.now() - SIX_MONTHS));
  // When each was last sent about this record: by its project link, or by the field naming it.
  const keys = [...new Set(candidates.flatMap((d) => refFields(d.schema).filter((f) => f.entity === entity).map((f) => f.key)))];
  const previous = await prisma.formSubmission.findMany({
    where: {
      definitionId: { in: candidates.map((d) => d.id) },
      OR: [...(entity === 'project' ? [{ projectId: id }] : []), ...keys.map((key) => ({ data: { path: [key], equals: id } }))],
    },
    orderBy: { createdAt: 'desc' }, select: { definitionId: true, createdAt: true },
  });
  const last = new Map<string, Date>();
  for (const p of previous) if (!last.has(p.definitionId)) last.set(p.definitionId, p.createdAt);

  const ranked = candidates.map((d) => {
    const rank = stage.indexOf(d.category);
    return {
      d, rank: rank === -1 ? stage.length : rank,
      suggestion: {
        code: d.code, nameFa: d.nameFa, nameEn: d.nameEn, category: d.category,
        prefill: Object.fromEntries(refFields(d.schema).filter((f) => context.refs[f.entity!]).map((f) => [f.key, context.refs[f.entity!]!])),
        fitsStage: rank !== -1, unitUses: usage.get(d.id) ?? 0, lastForRecord: last.get(d.id)?.toISOString() ?? null,
      } satisfies Suggestion,
    };
  }).sort((a, b) => a.rank - b.rank || b.suggestion.unitUses - a.suggestion.unitUses || a.d.no - b.d.no);

  return { state: context.state, total: ranked.length, forms: ranked.slice(0, limit).map((r) => r.suggestion) };
}

/** The forms this person — then their unit — sends most; the ones that create records after that. */
export async function frequentForms(actor: SuggestActor, limit: number): Promise<Suggestion[]> {
  const since = new Date(Date.now() - SIX_MONTHS);
  const definitions = await prisma.formDefinition.findMany({ where: { organizationId: actor.organizationId, isActive: true }, orderBy: { no: 'asc' } });
  const mine = definitions.filter((d) => maySubmitForm(d.senderDepts, actor.departmentCode, actor.roles));
  const own = await prisma.formSubmission.groupBy({ by: ['definitionId'], _count: { _all: true }, where: { submittedById: actor.id, createdAt: { gt: since } } });
  const ownUses = new Map(own.map((r) => [r.definitionId, r._count._all]));
  const unit = await unitUsage(actor, since);
  const score = (id: string) => (ownUses.get(id) ?? 0) * 1000 + (unit.get(id) ?? 0);
  return mine
    .map((d) => ({ d, s: score(d.id) }))
    // Nothing used yet: the forms that start something — a lead, a brief, a project — come first.
    .sort((a, b) => b.s - a.s || Number(!!b.d.binding) - Number(!!a.d.binding) || a.d.no - b.d.no)
    .slice(0, limit)
    .map(({ d }) => ({
      code: d.code, nameFa: d.nameFa, nameEn: d.nameEn, category: d.category, prefill: {},
      fitsStage: false, unitUses: unit.get(d.id) ?? 0, lastForRecord: null,
    }));
}

export const suggestableKinds = Object.keys(RECORD_KINDS);
