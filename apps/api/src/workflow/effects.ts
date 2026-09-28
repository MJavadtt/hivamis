import type { Tx } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { logTime } from '../reports/time.js';
import { stageZero } from '../quality/stage-zero.js';
import { cascadeState } from './engine.js';
import { registerEffect } from './registry.js';

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

  // The converting route supplies the company it created or was given; the lead points at it.
  'lead.convert': async ({ payload }) => (
    payload.companyId ? { companyId: payload.companyId as string } : {}
  ),

  'opportunity.win': async () => ({ wonAt: new Date() }),
  'opportunity.lose': async ({ reason }) => ({ lostReason: reason ?? null }),

  'brief.return_incomplete': async ({ tx, record, reason, actorId, organizationId }) => {
    // Doc_H cycle 1 — the brief goes back to Sales; the return count feeds the "Brief Completeness" KPI.
    await cascadeState(tx, {
      entity: 'opportunity', id: record.opportunityId, toState: 'BRIEF_REQUESTED',
      action: 'brief_returned', actorId, organizationId,
      reason: reason ? `بریف ناقص بازگردانده شد: ${reason}` : 'بریف ناقص بازگردانده شد',
    });
    return { returnReason: reason ?? null, returnCount: { increment: 1 } };
  },

  'brief.approve': async ({ tx, record, actorId, organizationId }) => {
    await cascadeState(tx, {
      entity: 'opportunity', id: record.opportunityId, toState: 'BRIEF_COMPLETED',
      action: 'brief_approved', actorId, organizationId, reason: 'بریف تأیید شد',
    });
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

  // Doc_H RACI #7/#8 — dispatch names a person, because the 4-hour acceptance clock this
  // transition starts belongs to somebody. Whose capacity it lands on is advisory (#12), and
  // is shown when the assignment is made; who it lands on is not optional.
  'task.assign': async ({ tx, payload, record, organizationId }) => {
    const assigneeId = (payload.assigneeId as string | undefined) ?? record.assigneeId ?? null;
    if (!assigneeId) throw badRequest('ASSIGNEE_REQUIRED', 'تخصیص بدون نام مسئول ممکن نیست');
    const user = await tx.user.findFirst({ where: { id: assigneeId, organizationId, isActive: true, deletedAt: null }, select: { id: true } });
    if (!user) throw badRequest('ASSIGNEE_INVALID', 'کاربر انتخاب‌شده فعال نیست یا در این سازمان نیست', { assigneeId });
    return { assigneeId };
  },
  'task.accept': async () => ({ acceptedAt: new Date() }),
  'task.block': async ({ reason }) => ({ blockReason: reason ?? null }),
  'task.start': async () => ({ blockReason: null }),
  // The least a person can be asked and still close the cost loop (roadmap #14): one number
  // with the submission. Logged as a time entry like any other, so it is never "the" figure.
  'task.submit': async ({ tx, id, payload, actorId, organizationId }) => {
    if (payload.hours != null && payload.hours !== '') {
      await logTime(tx, { organizationId, taskId: id, userId: actorId, hours: Number(payload.hours), note: 'ثبت هنگام تحویل' });
    }
    return { submittedAt: new Date() };
  },
  'task.close': async () => ({ closedAt: new Date() }),

  // The handover happened, so its stage-zero result is kept with it: Account sees what the
  // machine already checked — and what it could not — before opening a single file (#22).
  'deliverable.submit': async ({ tx, id, organizationId }) => {
    const result = await stageZero(tx, organizationId, id);
    return {
      submittedAt: new Date(),
      stageZeroVerdict: result.verdict, stageZeroAt: new Date(), stageZeroFindings: result as unknown as object,
    };
  },
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
        // …with the currency it was written in (roadmap #28), so the project knows it is a dollar job.
        data: { contractValue: record.contractValue, contractCurrency: record.currency, originalContractValue: record.originalValue, plannedEnd: record.endDate },
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

  // Roadmap #31. Delivery is confirmed with its proof — the reason field carries it — because
  // the commission is earned when the media runs, and "it ran" is a claim that needs evidence.
  'mediaOrder.book': async () => ({ bookedAt: new Date() }),
  'mediaOrder.confirm_delivery': async ({ reason }) => ({ airedAt: new Date(), proofNote: reason ?? null }),
  'mediaOrder.reconcile': async () => ({ reconciledAt: new Date() }),
  'mediaOrder.cancel': async ({ reason }) => ({ cancelReason: reason ?? null }),
};

// The core's effects enter the registry the way an extension's do (roadmap #47): first on their
// transition, so whatever an extension adds runs after them.
for (const [key, run] of Object.entries(EFFECTS)) {
  const [entity, action] = key.split('.') as [string, string];
  registerEffect({ key, entity, action, labelFa: key, source: 'core', run });
}
