import {
  DEPARTMENT_LABELS, ROLE_LABELS, evaluateRouting, buildStages, currentStage,
  type ApprovalStage, type DepartmentCode, type FieldDef, type ResolvedStage, type RoleCode, type RoutingRule,
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
  /** The device's own id for this submission; a repeat is the same form, not a second one. */
  clientKey?: string;
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

  /**
   * A form filled on set and queued (roadmap #19) may be sent more than once: the phone gets a
   * bar of signal, the request times out after the server already wrote it, the queue retries.
   * The key the device generated settles it — the first write wins and every retry gets that
   * same submission back, rather than the unit discovering three identical QC forms.
   */
  if (input.clientKey) {
    const already = await prisma.formSubmission.findFirst({
      where: { organizationId: actor.organizationId, clientKey: input.clientKey },
      include: { definition: { select: { code: true, nameFa: true, category: true, module: true, nextProcessFa: true } } },
    });
    if (already) {
      return {
        ...already,
        definition: already.definition,
        duplicateOf: already.code,
        requiredRoles: already.requiredRoles,
        routedBy: [],
        stages: (already.stages ?? []) as unknown,
      };
    }
  }

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

  /**
   * Who has to approve *these values* (roadmap #17). Doc_H's approverRoles are the floor; the
   * definition's rules add to it — Legal on a large contract, the CEO on a price below cost.
   * A draft is not routed: it has no final values to judge.
   */
  const routed = input.asDraft
    ? null
    : evaluateRouting(definition.approverRoles, definition.routing as unknown as RoutingRule[], clean);
  const requiredRoles = routed?.roles ?? [];
  /**
   * And in what order they speak (roadmap #18). A form with no declared chain gets one stage
   * over those roles — the behaviour every form had before chains existed.
   */
  const stages = input.asDraft
    ? []
    : buildStages(definition.approvalChain as unknown as ApprovalStage[], requiredRoles, clean);

  const result = await prisma.$transaction(async (tx) => {
    const submission = await tx.formSubmission.create({
      data: {
        organizationId: actor.organizationId,
        code: await nextCode(tx, 'formSubmission'),
        definitionId: definition.id,
        definitionVersion: definition.version,
        data: clean as object,
        state: input.asDraft ? 'DRAFT' : stages.length > 0 ? 'PENDING_APPROVAL' : 'SUBMITTED',
        requiredRoles,
        stages: stages.length ? (stages as unknown as object) : undefined,
        currentRoles: currentStage(stages)?.roles ?? [],
        routing: routed && routed.matched.length
          ? ({ matched: routed.matched, notifyRoles: routed.notifyRoles } as object)
          : undefined,
        submittedById: actor.id,
        assignedToId: input.assignedToId ?? null,
        projectId: input.projectId ?? (clean.projectId ? String(clean.projectId) : null),
        companyId: input.companyId ?? (clean.companyId ? String(clean.companyId) : null),
        opportunityId: input.opportunityId ?? (clean.opportunityId ? String(clean.opportunityId) : null),
        submittedAt: input.asDraft ? null : new Date(),
        clientKey: input.clientKey ?? null,
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
      after: {
        formCode: definition.code, state: submission.state, bound,
        ...(routed?.matched.length ? { routedBy: routed.matched.map((m) => m.id), requiredRoles } : {}),
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    }, tx);

    return { submission, bound };
  }, { timeout: 20_000 });

  // Only the stage that is actually waiting hears about it: telling every eventual approver at
  // once is how a chain becomes noise and people stop reading approval mail.
  const first = currentStage(stages);
  await notifyApprovers(
    {
      ...definition,
      approverRoles: first?.roles ?? [],
      notifyRoles: routed?.notifyRoles ?? [],
      matchedFa: routed?.matched.map((m) => m.whenFa) ?? [],
      stageFa: stages.length > 1 ? `مرحلهٔ ۱ از ${stages.length}: ${first?.labelFa ?? ''}` : null,
    },
    result.submission.id, actor,
  );

  return {
    ...result.submission,
    definition: {
      code: definition.code, nameFa: definition.nameFa, category: definition.category,
      module: definition.module, nextProcessFa: definition.nextProcessFa,
    },
    requiredRoles,
    routedBy: routed?.matched ?? [],
    stages,
    boundEntity: result.bound?.entity ?? null,
    boundEntityId: result.bound?.entityId ?? null,
  };
}

async function notifyApprovers(
  definition: { approverRoles: string[]; nameFa: string; receiverDepts: string[]; notifyRoles?: string[]; matchedFa?: string[]; stageFa?: string | null },
  submissionId: string,
  actor: FormActor,
): Promise<void> {
  // Roles told for information carry no veto, and are addressed separately below.
  const forInformation = (definition.notifyRoles ?? []).filter((r) => !definition.approverRoles.includes(r));
  if (forInformation.length) await notifyForInformation(forInformation, definition, submissionId, actor);
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
  // When a rule put an approver here, the notification says which rule — an approval request
  // that does not explain itself is the thing this feature exists to replace.
  const because = definition.matchedFa?.length ? ` — ${definition.matchedFa.join('؛ ')}` : '';
  const stagePrefix = definition.stageFa ? `${definition.stageFa} — ` : '';
  for (const a of approvers) {
    await notify({
      userId: a.id,
      kind: 'FORM_APPROVAL_REQUIRED',
      title: `فرم در انتظار تأیید: ${stagePrefix}${definition.nameFa}`,
      body: `برای بررسی و تصمیم‌گیری کلیک کنید.${because}`,
      entityType: 'formSubmission',
      entityId: submissionId,
      severity: 'INFO',
      mail,
    });
  }
}

/** Told, not asked: a role a rule wanted in the loop without giving it a veto. */
async function notifyForInformation(
  roles: string[],
  definition: { nameFa: string; matchedFa?: string[] },
  submissionId: string,
  actor: FormActor,
): Promise<void> {
  const people = await prisma.user.findMany({
    where: { organizationId: actor.organizationId, isActive: true, deletedAt: null, roles: { some: { role: { code: { in: roles } } } } },
    select: { id: true }, take: 50,
  });
  for (const p of people) {
    await notify({
      userId: p.id,
      kind: 'FORM_FOR_INFORMATION',
      title: `برای اطلاع: ${definition.nameFa}`,
      body: `این فرم ثبت شد و طبق قاعدهٔ مسیریابی به اطلاع شما می‌رسد${definition.matchedFa?.length ? ` — ${definition.matchedFa.join('؛ ')}` : ''}.`,
      entityType: 'formSubmission',
      entityId: submissionId,
      severity: 'INFO',
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

  // The roles this submission required when it was filled — not whatever the definition says
  // today, and not the form's floor alone. Older rows have none and fall back to the floor.
  const fallbackRoles = submission.requiredRoles.length ? submission.requiredRoles : submission.definition.approverRoles;
  // The stages this submission must pass (roadmap #18). A row written before chains existed has
  // none, and behaves as it always did: one approval from any required role finishes it.
  const stages = (Array.isArray(submission.stages) ? submission.stages : []) as unknown as ResolvedStage[];
  const stage = stages.length ? currentStage(stages) : null;
  if (stages.length && !stage) throw badRequest('FORM_NOT_PENDING', 'این فرم در وضعیت انتظار تأیید نیست.');
  const approverRoles = stage ? stage.roles : fallbackRoles;

  // A declared stage names whose sign-off is the point of it, so the executive bypass that
  // works on an ordinary form does not let someone stand in for the unit manager (roadmap #18).
  const bypass = input.actor.roles.some((r) => BYPASS_ROLES.has(r)) && !stage?.declared;
  const isApprover = bypass || input.actor.roles.some((r) => approverRoles.includes(r));
  // The role that qualifies the actor — if it is a borrowed one, the decision says whose.
  const qualifying = input.actor.roles.find((r) => approverRoles.includes(r));
  const onBehalfOfId = (!bypass && qualifying && input.actor.delegatedRoles?.[qualifying]) || null;
  if (!isApprover) {
    const roleNames = approverRoles
      .map((r) => ROLE_LABELS[r as RoleCode]?.fa ?? r)
      .join('، ');
    throw forbidden(stage && stages.length > 1
      ? `این فرم در «${stage.labelFa}» است و تصمیم آن با نقش‌های ${roleNames} است.`
      : `تأیید این فرم فقط توسط نقش‌های ${roleNames} مجاز است.`);
  }
  if (submission.submittedById === input.actor.id && !bypass) {
    // Separation of duties: a submitter cannot approve their own form.
    throw forbidden('تأیید فرم توسط ثبت‌کننده همان فرم مجاز نیست.');
  }
  // A quorum counts people, not clicks: the same approver cannot fill a stage twice, and a
  // bypassing executive standing in for a stage still only counts once.
  if (stage?.approvedBy.includes(input.actor.id)) {
    throw badRequest('ALREADY_APPROVED', 'شما پیش‌تر در همین مرحله تأیید کرده‌اید.');
  }

  /**
   * An approval clears the stage only when the stage has the distinct approvals it asks for;
   * a rejection or a return ends the whole form wherever it stands.
   */
  const nextStages = stages.map((s) => ({ ...s, approvedBy: [...s.approvedBy] }));
  let stageAdvanced = false;
  if (input.decision === 'APPROVE' && stage) {
    const live = nextStages.find((s) => s.id === stage.id && s.state === 'PENDING')!;
    live.approvedBy.push(input.actor.id);
    if (live.approvedBy.length >= live.quorum) { live.state = 'APPROVED'; stageAdvanced = true; }
  }
  const remaining = currentStage(nextStages);
  const chainComplete = !stages.length || !remaining;
  const nextState =
    input.decision !== 'APPROVE'
      ? (input.decision === 'REJECT' ? 'REJECTED' : 'RETURNED')
      : chainComplete ? 'APPROVED' : 'PENDING_APPROVAL';

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.formSubmission.update({
      where: { id: submission.id },
      data: {
        state: nextState,
        // A form still climbing its chain has not been decided yet.
        decidedAt: nextState === 'PENDING_APPROVAL' ? null : new Date(),
        returnReason: input.decision === 'APPROVE' ? null : input.comment ?? null,
        ...(stages.length ? { stages: nextStages as unknown as object, currentStage: nextStages.filter((s) => s.state === 'APPROVED').length } : {}),
        currentRoles: nextState === 'PENDING_APPROVAL' ? remaining?.roles ?? [] : [],
      },
    });

    await tx.formApproval.create({
      data: {
        submissionId: submission.id,
        approverId: input.actor.id,
        stage: stage?.id ?? null,
        decision: input.decision,
        comment: input.comment ?? null,
      },
    });

    // The form's clock runs until the form is actually decided, not until the first signature.
    if (submission.definition.slaCode && nextState !== 'PENDING_APPROVAL') {
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
      after: {
        state: nextState,
        ...(stage ? { stage: stage.id, stageFa: stage.labelFa, quorum: stage.quorum, cleared: stageAdvanced } : {}),
      },
      reason: input.comment ?? null,
      ipAddress: input.actor.ipAddress,
      userAgent: input.actor.userAgent,
      requestId: input.actor.requestId,
    }, tx);

    const index = nextStages.findIndex((s) => s.state === 'PENDING');
    const progressFa = stages.length > 1 && stage
      ? ` (${stage.labelFa}${stage.quorum > 1 ? ` — ${nextStages.find((s) => s.id === stage.id)!.approvedBy.length} از ${stage.quorum} تأیید` : ''})`
      : '';
    await tx.notification.create({
      data: {
        userId: submission.submittedById,
        kind: `FORM_${nextState === 'PENDING_APPROVAL' ? 'STAGE_APPROVED' : nextState}`,
        title: nextState === 'PENDING_APPROVAL'
          ? `فرم «${submission.definition.nameFa}» یک مرحله جلو رفت${progressFa}`
          : `فرم «${submission.definition.nameFa}» ${nextState === 'APPROVED' ? 'تأیید شد' : nextState === 'REJECTED' ? 'رد شد' : 'بازگشت داده شد'}`,
        body: input.comment ?? null,
        entityType: 'formSubmission',
        entityId: submission.id,
        severity: nextState === 'REJECTED' || nextState === 'RETURNED' ? 'WARNING' : 'INFO',
      },
    });

    return { ...updated, stages: nextStages, stageCleared: stageAdvanced, nextStageFa: remaining?.labelFa ?? null, stageIndex: index };
  });

  // A stage that has just cleared hands the form to the next one, and only then are its
  // approvers told — the chain is a queue of decisions, not a broadcast.
  if (result.state === 'PENDING_APPROVAL' && stageAdvanced && remaining) {
    await notifyApprovers(
      {
        ...submission.definition,
        approverRoles: remaining.roles,
        stageFa: `مرحلهٔ ${result.stageIndex + 1} از ${nextStages.length}: ${remaining.labelFa}`,
      },
      submission.id, input.actor,
    );
  }
  return result;
}

/**
 * Prisma filter for "forms awaiting a decision from one of these roles". A submission routed by
 * a rule (roadmap #17) carries its own required roles; one written before routing existed falls
 * back to its definition's. Both cases have to match, or an approver loses their inbox.
 */
export const pendingForRoles = (roles: string[]) => ({
  OR: [
    // The stage actually waiting (roadmap #18) — a later stage's approver is not asked yet.
    { currentRoles: { hasSome: roles } },
    { AND: [{ currentRoles: { isEmpty: true } }, { requiredRoles: { hasSome: roles } }] },
    { AND: [{ currentRoles: { isEmpty: true } }, { requiredRoles: { isEmpty: true } }, { definition: { approverRoles: { hasSome: roles } } }] },
  ],
});
