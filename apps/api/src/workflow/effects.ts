import type { Tx } from '../db.js';

export interface EffectContext {
  tx: Tx;
  id: string;
  record: Record<string, any>;
  payload: Record<string, unknown>;
  actorId: string;
  organizationId: string;
  reason?: string;
}

/**
 * Side effects applied atomically with a state change, keyed `<entity>.<action>`.
 * The returned object is merged into the entity's UPDATE, so timestamps and denormalised
 * fields can never drift from the state they describe.
 */
export const EFFECTS: Record<string, (c: EffectContext) => Promise<Record<string, unknown>>> = {
  'lead.disqualify': async ({ reason }) => ({ disqualifyReason: reason ?? null }),

  'lead.convert': async () => ({}),

  'opportunity.win': async () => ({ wonAt: new Date() }),
  'opportunity.lose': async ({ reason }) => ({ lostReason: reason ?? null }),

  'brief.return_incomplete': async ({ tx, id, record, reason }) => {
    // Doc_H cycle 1 — the brief goes back to Sales; the return count feeds the "Brief Completeness" KPI.
    await tx.opportunity.update({
      where: { id: record.opportunityId },
      data: { state: 'BRIEF_REQUESTED' },
    }).catch(() => undefined);
    return { returnReason: reason ?? null, returnCount: { increment: 1 } };
  },

  'brief.approve': async ({ tx, record }) => {
    await tx.opportunity.update({
      where: { id: record.opportunityId },
      data: { state: 'BRIEF_COMPLETED' },
    }).catch(() => undefined);
    return { approvedAt: new Date() };
  },

  'brief.start_review': async ({ actorId }) => ({ reviewedById: actorId }),
  'brief.submit': async ({ actorId }) => ({ submittedById: actorId }),

  'proposal.final_qc_reject': async () => ({ revisionCount: { increment: 1 } }),
  'proposal.client_request_revision': async ({ reason }) => ({
    clientDecision: 'REVISION',
    clientFeedback: reason ?? null,
    revisionCount: { increment: 1 },
  }),
  'proposal.client_approve': async () => ({ clientDecision: 'APPROVED' }),
  'proposal.client_reject': async ({ reason }) => ({
    clientDecision: 'REJECTED',
    clientFeedback: reason ?? null,
  }),
  'proposal.rework': async ({ tx, id, record, actorId }) => {
    // Snapshot the superseded version before the rework overwrites it.
    await tx.proposalVersion.create({
      data: {
        proposalId: id,
        version: record.version ?? 1,
        snapshot: JSON.parse(JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
        changeNote: 'نسخه پیش از اصلاح بازخورد مشتری',
        createdById: actorId,
      },
    }).catch(() => undefined);
    return { version: { increment: 1 } };
  },

  'project.authorize': async () => ({}),
  'project.activate': async () => ({ actualStart: new Date() }),
  'project.hold': async ({ reason }) => ({ holdReason: reason ?? null }),
  'project.resume': async () => ({ holdReason: null }),
  'project.complete': async () => ({ actualEnd: new Date() }),
  'project.cancel': async ({ reason }) => ({ cancelReason: reason ?? null }),
  'project.start_closure': async ({ tx, id, actorId }) => {
    await tx.closureChecklist.upsert({
      where: { projectId: id },
      create: { projectId: id, updatedById: actorId },
      update: {},
    });
    return {};
  },
  'project.close': async ({ tx, id, actorId }) => {
    await tx.closureChecklist.update({
      where: { projectId: id },
      data: { closedInSystem: true, updatedById: actorId },
    }).catch(() => undefined);
    return { closedAt: new Date() };
  },

  'workOrder.accept': async ({ actorId, payload }) => ({
    acceptedAt: new Date(),
    acceptedById: actorId,
    committedDate: payload.committedDate ? new Date(payload.committedDate as string) : undefined,
  }),
  'workOrder.request_clarification': async ({ reason }) => ({ clarificationNote: reason ?? null }),
  'workOrder.clarify': async () => ({ clarificationNote: null }),
  'workOrder.submit': async () => ({ submittedAt: new Date() }),
  'workOrder.cancel': async ({ reason }) => ({ cancelReason: reason ?? null }),

  'task.accept': async () => ({ acceptedAt: new Date() }),
  'task.block': async ({ reason }) => ({ blockReason: reason ?? null }),
  'task.start': async () => ({ blockReason: null }),
  'task.submit': async () => ({ submittedAt: new Date() }),
  'task.close': async () => ({ closedAt: new Date() }),

  'deliverable.submit': async () => ({ submittedAt: new Date() }),
  'deliverable.deliver': async () => ({ deliveredAt: new Date() }),
  'deliverable.client_accept': async () => ({ acceptedAt: new Date() }),
  'deliverable.client_reject': async ({ reason }) => ({ rejectReason: reason ?? null }),

  'revision.approve': async () => ({ resolvedAt: new Date() }),
  'revision.reject': async ({ reason }) => ({ rejectNote: reason ?? null, round: { increment: 1 } }),

  'changeRequest.customer_approve': async () => ({
    customerDecision: 'APPROVED',
    customerDecidedAt: new Date(),
  }),
  'changeRequest.approve_in_scope': async () => ({
    customerDecision: 'NOT_REQUIRED',
    customerDecidedAt: new Date(),
  }),
  'changeRequest.reject': async ({ reason }) => ({
    customerDecision: 'REJECTED',
    rejectReason: reason ?? null,
    customerDecidedAt: new Date(),
  }),
  'changeRequest.close': async () => ({ closedAt: new Date() }),

  'contract.sign': async ({ payload }) => ({
    signedDate: payload.signedDate ? new Date(payload.signedDate as string) : new Date(),
  }),
  'contract.register': async ({ tx, record, payload }) => {
    // The registered contract value becomes the project's revenue baseline, so project
    // profitability reports against a real, signed figure rather than an estimate.
    if (record.projectId) {
      await tx.project.update({
        where: { id: record.projectId },
        data: { contractValue: record.contractValue, plannedEnd: record.endDate },
      }).catch(() => undefined);
    }
    return {
      registeredAt: new Date(),
      contractNumber: (payload.contractNumber as string) ?? undefined,
    };
  },
  'contract.request_revision': async ({ reason }) => ({ revisionNote: reason ?? null }),
  'contract.terminate': async ({ reason }) => ({ terminateReason: reason ?? null }),

  'invoice.cancel': async ({ reason }) => ({ cancelReason: reason ?? null }),
  'invoice.settle': async ({ record }) => ({ paidAmount: record.total }),

  'outsourceRequest.approve': async ({ actorId }) => ({
    approvedById: actorId,
    approvedAt: new Date(),
  }),
  'outsourceRequest.reject': async ({ reason }) => ({ rejectReason: reason ?? null }),
};
