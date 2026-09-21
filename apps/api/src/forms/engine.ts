import {
  DEPARTMENT_LABELS, ROLE_LABELS,
  type DepartmentCode, type FieldDef, type RoleCode,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { nextCode } from '../lib/codes.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { startSla, stopSla } from '../sla/engine.js';
import { validateFormData } from './validator.js';
import { FORM_HANDLERS } from './handlers.js';
import { appUrl, formApprovalMail, notify } from '../mail/notify.js';

export interface FormActor {
  id: string;
  organizationId: string;
  departmentCode: string | null;
  roles: string[];
  permissions: string[];
  /** role → delegator, for approver roles held only through a delegation. */
  delegatedRoles?: Record<string, string>;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface SubmitFormInput {
  formCode: string;
  data: Record<string, unknown>;
  projectId?: string;
  companyId?: string;
  opportunityId?: string;
  assignedToId?: string;
  asDraft?: boolean;
  actor: FormActor;
}

const BYPASS_ROLES = new Set(['SUPER_ADMIN', 'CEO', 'DEPUTY']);

/**
 * Submit one of the 130 Doc_H forms.
 *
 * The engine realises the Doc_H contract for every form:
 *   Sender → Receiver → Trigger → Input → Process → Output → Approver → SLA → Next Process
 * Sender is checked against the definition, the receiver determines routing, an approval task is
 * created for the approver roles, and the declared SLA clock starts on submission.
 */
export async function submitForm(input: SubmitFormInput) {
  const { actor } = input;

  const definition = await prisma.formDefinition.findUnique({ where: { code: input.formCode } });
  if (!definition) throw notFound('تعریف فرم');
  if (!definition.isActive) throw badRequest('FORM_INACTIVE', 'این فرم غیرفعال است.');

  // Doc_H assigns every form an owning department; only that department may originate it.
  const senders = definition.senderDepts;
  const bypass = actor.roles.some((r) => BYPASS_ROLES.has(r));
  if (senders.length > 0 && !bypass && (!actor.departmentCode || !senders.includes(actor.departmentCode))) {
    // Name the units in Persian — the operator should not have to decode «S» or «CR».
    const names = senders
      .map((code) => DEPARTMENT_LABELS[code as DepartmentCode]?.fa ?? code)
      .join('، ');
    throw forbidden(`ثبت فرم «${definition.nameFa}» فقط توسط واحد ${names} مجاز است.`);
  }

  const fields = definition.schema as unknown as FieldDef[];
  const clean = validateFormData(fields, input.data, { partial: input.asDraft === true });

  const result = await prisma.$transaction(async (tx) => {
    const submission = await tx.formSubmission.create({
      data: {
        organizationId: actor.organizationId,
        code: await nextCode(tx, 'formSubmission'),
        definitionId: definition.id,
        definitionVersion: definition.version,
        data: clean as object,
        state: input.asDraft ? 'DRAFT' : definition.approverRoles.length > 0 ? 'PENDING_APPROVAL' : 'SUBMITTED',
        submittedById: actor.id,
        assignedToId: input.assignedToId ?? null,
        projectId: input.projectId ?? (clean.projectId ? String(clean.projectId) : null),
        companyId: input.companyId ?? (clean.companyId ? String(clean.companyId) : null),
        opportunityId: input.opportunityId ?? (clean.opportunityId ? String(clean.opportunityId) : null),
        submittedAt: input.asDraft ? null : new Date(),
      },
    });

    // A draft is not yet a business event: no binding runs and no SLA starts.
    if (input.asDraft) return { submission, bound: null as null | { entity: string; entityId: string } };

    let bound: { entity: string; entityId: string } | null = null;
    const handler = definition.binding ? FORM_HANDLERS[definition.binding] : undefined;
    if (handler) {
      bound = await handler({
        tx,
        data: clean,
        actorId: actor.id,
        organizationId: actor.organizationId,
        departmentCode: actor.departmentCode,
        projectId: submission.projectId,
        companyId: submission.companyId,
        opportunityId: submission.opportunityId,
      });
      await tx.formSubmission.update({
        where: { id: submission.id },
        data: { boundEntity: bound.entity, boundEntityId: bound.entityId },
      });
    }

    if (definition.slaCode) {
      await startSla(tx, {
        organizationId: actor.organizationId,
        policyCode: definition.slaCode,
        entityType: 'formSubmission',
        entityId: submission.id,
        ownerId: input.assignedToId ?? actor.id,
      });
    }

    await audit({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'CREATE',
      entityType: 'formSubmission',
      entityId: submission.id,
      after: { formCode: definition.code, state: submission.state, bound },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    }, tx);

    return { submission, bound };
  }, { timeout: 20_000 });

  await notifyApprovers(definition, result.submission.id, actor);

  return {
    ...result.submission,
    definition: {
      code: definition.code, nameFa: definition.nameFa, category: definition.category,
      module: definition.module, nextProcessFa: definition.nextProcessFa,
    },
    boundEntity: result.bound?.entity ?? null,
    boundEntityId: result.bound?.entityId ?? null,
  };
}

async function notifyApprovers(
  definition: { approverRoles: string[]; nameFa: string; receiverDepts: string[] },
  submissionId: string,
  actor: FormActor,
): Promise<void> {
  if (definition.approverRoles.length === 0) return;
  const approvers = await prisma.user.findMany({
    where: {
      organizationId: actor.organizationId,
      isActive: true,
      deletedAt: null,
      roles: { some: { role: { code: { in: definition.approverRoles } } } },
    },
    select: { id: true },
    take: 50,
  });
  if (approvers.length === 0) return;

  // Through the shared notifier, so an approver who is not in the app still hears about it.
  // Sequential rather than createMany: each recipient is addressed individually, and the
  // count here is already capped at 50.
  // FormActor carries no display name; look it up rather than widening the interface.
  const sender = await prisma.user
    .findUnique({ where: { id: actor.id }, select: { fullName: true } })
    .catch(() => null);
  const mail = formApprovalMail({
    formFa: definition.nameFa,
    code: submissionId.slice(0, 8),
    senderFa: sender?.fullName ?? 'کاربر سامانه',
    url: appUrl(`/forms?submission=${submissionId}`),
  });
  for (const a of approvers) {
    await notify({
      userId: a.id,
      kind: 'FORM_APPROVAL_REQUIRED',
      title: `فرم در انتظار تأیید: ${definition.nameFa}`,
      body: 'برای بررسی و تصمیم‌گیری کلیک کنید.',
      entityType: 'formSubmission',
      entityId: submissionId,
      severity: 'INFO',
      mail,
    });
  }
}

export interface DecideFormInput {
  submissionId: string;
  decision: 'APPROVE' | 'REJECT' | 'RETURN';
  comment?: string;
  actor: FormActor;
}

/** Approve, reject or return a submitted form; stops the form's SLA clock either way. */
export async function decideForm(input: DecideFormInput) {
  const submission = await prisma.formSubmission.findUnique({
    where: { id: input.submissionId },
    include: { definition: true },
  });
  if (!submission) throw notFound('فرم');
  if (!['SUBMITTED', 'PENDING_APPROVAL'].includes(submission.state)) {
    throw badRequest('FORM_NOT_PENDING', 'این فرم در وضعیت انتظار تأیید نیست.');
  }

  const approverRoles = submission.definition.approverRoles;
  const bypass = input.actor.roles.some((r) => BYPASS_ROLES.has(r));
  const isApprover = bypass || input.actor.roles.some((r) => approverRoles.includes(r));
  // The role that qualifies the actor — if it is a borrowed one, the decision says whose.
  const qualifying = input.actor.roles.find((r) => approverRoles.includes(r));
  const onBehalfOfId = (!bypass && qualifying && input.actor.delegatedRoles?.[qualifying]) || null;
  if (!isApprover) {
    const roleNames = approverRoles
      .map((r) => ROLE_LABELS[r as RoleCode]?.fa ?? r)
      .join('، ');
    throw forbidden(`تأیید این فرم فقط توسط نقش‌های ${roleNames} مجاز است.`);
  }
  if (submission.submittedById === input.actor.id && !bypass) {
    // Separation of duties: a submitter cannot approve their own form.
    throw forbidden('تأیید فرم توسط ثبت‌کننده همان فرم مجاز نیست.');
  }

  const nextState =
    input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'RETURNED';

  return prisma.$transaction(async (tx) => {
    const updated = await tx.formSubmission.update({
      where: { id: submission.id },
      data: {
        state: nextState,
        decidedAt: new Date(),
        returnReason: input.decision === 'APPROVE' ? null : input.comment ?? null,
      },
    });

    await tx.formApproval.create({
      data: {
        submissionId: submission.id,
        approverId: input.actor.id,
        decision: input.decision,
        comment: input.comment ?? null,
      },
    });

    if (submission.definition.slaCode) {
      await stopSla(tx, [submission.definition.slaCode], 'formSubmission', submission.id);
    }

    await audit({
      organizationId: input.actor.organizationId,
      actorId: input.actor.id,
      onBehalfOfId,
      action: input.decision === 'APPROVE' ? 'APPROVE' : 'REJECT',
      entityType: 'formSubmission',
      entityId: submission.id,
      before: { state: submission.state },
      after: { state: nextState },
      reason: input.comment ?? null,
      ipAddress: input.actor.ipAddress,
      userAgent: input.actor.userAgent,
      requestId: input.actor.requestId,
    }, tx);

    await tx.notification.create({
      data: {
        userId: submission.submittedById,
        kind: `FORM_${nextState}`,
        title: `فرم «${submission.definition.nameFa}» ${nextState === 'APPROVED' ? 'تأیید شد' : nextState === 'REJECTED' ? 'رد شد' : 'بازگشت داده شد'}`,
        body: input.comment ?? null,
        entityType: 'formSubmission',
        entityId: submission.id,
        severity: nextState === 'APPROVED' ? 'INFO' : 'WARNING',
      },
    });

    return updated;
  });
}
