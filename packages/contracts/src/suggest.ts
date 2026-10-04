import type { Permission } from './permissions.js';

/**
 * Which forms a record's page offers (Hivamis task 4b).
 *
 * A form is related to a kind of record when one of its fields points at that kind (54 forms point at
 * a project, 16 at a proposal…). Which of them a page puts first depends on where the record stands:
 * a project being authorised calls for contract and finance forms, one in delivery for orders, unit
 * work, QC and reporting, one closing for the closure forms. These are the Doc_H categories A–N each
 * stage calls for; a form outside them is still offered, after them.
 */

export interface RecordKind {
  /** What reading such a record takes. */
  readonly permission: Permission;
  /** The categories every stage calls for, unless the stage names its own. */
  readonly categories: readonly string[];
  readonly byState?: Readonly<Record<string, readonly string[]>>;
}

export const RECORD_KINDS: Readonly<Record<string, RecordKind>> = {
  company: { permission: 'crm.company.read', categories: ['A', 'L', 'N'] },
  opportunity: {
    permission: 'crm.opportunity.read', categories: ['A', 'G'],
    byState: { BRIEF_REQUESTED: ['A', 'G', 'B'], BRIEF_COMPLETED: ['B', 'G'], PROPOSAL: ['F', 'G'], NEGOTIATION: ['G', 'H'], WON: ['H', 'B'], LOST: ['N'] },
  },
  brief: {
    permission: 'brief.read', categories: ['A', 'B', 'G'],
    byState: { SUBMITTED: ['B', 'G'], UNDER_REVIEW: ['B'], RETURNED_INCOMPLETE: ['A', 'G'], APPROVED: ['B', 'C', 'F'] },
  },
  proposal: { permission: 'proposal.read', categories: ['F', 'G'] },
  project: {
    permission: 'project.read', categories: ['B', 'J'],
    byState: {
      DRAFT: ['B', 'H'], PENDING_AUTHORIZATION: ['H', 'I', 'B'], AUTHORIZED: ['B', 'J', 'C'], PLANNING: ['J', 'C', 'B'],
      ACTIVE: ['C', 'D', 'E', 'J', 'K', 'L', 'I'], ON_HOLD: ['J', 'K', 'L'], COMPLETED: ['M', 'E', 'L', 'I'],
      PENDING_CLOSURE: ['M', 'I'], CLOSED: ['M', 'N'], CANCELLED: ['M'],
    },
  },
  contract: { permission: 'contract.read', categories: ['H'], byState: { SIGNED: ['H', 'I'], REGISTERED: ['I', 'H'] } },
  workOrder: {
    permission: 'workorder.read', categories: ['C', 'D', 'E'],
    byState: { DRAFT: ['C'], CLARIFICATION_REQUESTED: ['D', 'C'], IN_PROGRESS: ['D', 'E'], SUBMITTED: ['E'], COMPLETED: ['E', 'K'] },
  },
  deliverable: {
    permission: 'deliverable.read', categories: ['E', 'D'],
    byState: { REVISION_REQUIRED: ['E', 'D'], DELIVERED: ['L', 'M'], ACCEPTED: ['L', 'M'] },
  },
  task: { permission: 'task.read', categories: ['D', 'J'] },
  changeRequest: { permission: 'change.read', categories: ['J', 'H', 'L'] },
  invoice: { permission: 'finance.read', categories: ['I'] },
};

/** The categories this record's stage calls for, most fitting first. */
export function stageCategories(kind: string, state: string | null | undefined): readonly string[] {
  const k = RECORD_KINDS[kind];
  if (!k) return [];
  return (state && k.byState?.[state]) || k.categories;
}

/** Roles a form's sending units do not bind (as in the form engine). */
export const FORM_SENDER_BYPASS_ROLES: readonly string[] = ['SUPER_ADMIN', 'CEO', 'DEPUTY'];

/** May someone in this unit, with these roles, submit a form sent by these units? */
export function maySubmitForm(senderDepts: readonly string[], departmentCode: string | null | undefined, roles: readonly string[]): boolean {
  return senderDepts.length === 0
    || (!!departmentCode && senderDepts.includes(departmentCode))
    || roles.some((r) => FORM_SENDER_BYPASS_ROLES.includes(r));
}
