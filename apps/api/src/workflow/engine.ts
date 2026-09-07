import { availableTransitions, findTransition, WORKFLOWS, type Permission, type TransitionDef } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { AppError, GovernanceError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { startSla, stopSla } from '../sla/engine.js';
import { runGuards } from './guards.js';
import { EFFECTS } from './effects.js';

/** Prisma delegate for each workflow-managed entity. All of them expose a `state` column. */
function delegate(tx: Tx, entity: string): any {
  const map: Record<string, any> = {
    lead: tx.lead,
    opportunity: tx.opportunity,
    brief: tx.brief,
    proposal: tx.proposal,
    project: tx.project,
    workOrder: tx.workOrder,
    task: tx.task,
    deliverable: tx.deliverable,
    revision: tx.revision,
    changeRequest: tx.changeRequest,
    contract: tx.contract,
    invoice: tx.invoice,
    outsourceRequest: tx.outsourceRequest,
  };
  const d = map[entity];
  if (!d) throw badRequest('UNKNOWN_ENTITY', `موجودیت «${entity}» فاقد ماشین حالت است.`);
  return d;
}

export interface TransitionActor {
  id: string;
  organizationId: string;
  permissions: string[];
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface TransitionInput {
  entity: string;
  id: string;
  action: string;
  reason?: string;
  payload?: Record<string, unknown>;
  actor: TransitionActor;
}

export interface TransitionOutcome {
  entity: string;
  id: string;
  fromState: string;
  toState: string;
  action: string;
  record: Record<string, any>;
  next: { action: string; labelFa: string; labelEn: string }[];
}

/**
 * The single write path for every state change in the platform.
 *
 * Enforcement order — permission → mandatory reason → Doc_H guards → atomic apply.
 * Because entity `state` is only ever written here, no caller can bypass a governance rule
 * with a plain UPDATE, which is what makes the Doc_H rules structurally enforced rather
 * than merely documented.
 */
export async function transition(input: TransitionInput): Promise<TransitionOutcome> {
  const { entity, id, action, actor } = input;
  const payload = input.payload ?? {};

  return prisma.$transaction(async (tx) => {
    const model = delegate(tx, entity);
    const record = await model.findUnique({ where: { id } });
    if (!record) throw notFound('رکورد');

    const fromState: string = record.state;
    const def: TransitionDef | undefined = findTransition(entity, fromState, action);

    if (!def) {
      const allowed = availableTransitions(entity, fromState).map((t) => t.action);
      throw new AppError(
        409,
        'ILLEGAL_TRANSITION',
        `انتقال «${action}» از وضعیت «${fromState}» مجاز نیست.`,
        { fromState, requested: action, allowed },
      );
    }

    if (def.permission && !actor.permissions.includes(def.permission as Permission)) {
      throw forbidden(`برای انجام «${def.labelFa}» به دسترسی «${def.permission}» نیاز دارید.`);
    }

    const reason = input.reason?.trim();
    if (def.requiresReason && !reason) {
      throw badRequest(
        'REASON_REQUIRED',
        `ثبت دلیل برای «${def.labelFa}» الزامی است.`,
        { action },
      );
    }

    const guardResult = await runGuards(def.guards, {
      tx, entity, id, record, payload, actorId: actor.id,
    });
    if (!guardResult.ok) {
      throw new GovernanceError(
        guardResult.rule ?? 'unknown',
        guardResult.messageFa ?? 'این عملیات با قوانین حاکم بر فرآیند مغایرت دارد.',
        guardResult.details,
      );
    }

    const effect = EFFECTS[`${entity}.${action}`];
    const patch = effect
      ? await effect({
          tx, id, record, payload,
          actorId: actor.id,
          organizationId: actor.organizationId,
          reason,
        })
      : {};

    const updated = await model.update({
      where: { id },
      data: { state: def.to, ...patch },
    });

    await tx.stateTransition.create({
      data: {
        organizationId: actor.organizationId,
        entityType: entity,
        entityId: id,
        fromState,
        toState: def.to,
        action,
        reason: reason ?? null,
        actorId: actor.id,
      },
    });

    await audit({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'STATE_TRANSITION',
      entityType: entity,
      entityId: id,
      before: { state: fromState },
      after: { state: def.to },
      reason: reason ?? null,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    }, tx);

    if (def.stopsSla?.length) {
      await stopSla(tx, def.stopsSla, entity, id);
    }
    if (def.startsSla) {
      await startSla(tx, {
        organizationId: actor.organizationId,
        policyCode: def.startsSla,
        entityType: entity,
        entityId: id,
        ownerId: resolveSlaOwner(updated),
      });
    }

    return {
      entity,
      id,
      fromState,
      toState: def.to,
      action,
      record: updated,
      next: availableTransitions(entity, def.to).map((t) => ({
        action: t.action,
        labelFa: t.labelFa,
        labelEn: t.labelEn,
      })),
    };
  }, { timeout: 20_000 });
}

/** Best-effort owner for SLA notifications, in order of how directly they own the clock. */
function resolveSlaOwner(record: Record<string, any>): string | null {
  return (
    record.assigneeId ??
    record.ownerId ??
    record.accountOwnerId ??
    record.reviewerId ??
    record.createdById ??
    null
  );
}

/** Transitions the caller may perform right now, given their permissions. */
export function allowedFor(entity: string, state: string, permissions: string[]) {
  return availableTransitions(entity, state)
    .filter((t) => !t.permission || permissions.includes(t.permission))
    .map((t) => ({
      action: t.action,
      labelFa: t.labelFa,
      labelEn: t.labelEn,
      requiresReason: t.requiresReason ?? false,
      to: t.to,
    }));
}

export function workflowFor(entity: string) {
  return WORKFLOWS[entity];
}
