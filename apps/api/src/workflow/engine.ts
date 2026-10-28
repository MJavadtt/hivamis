import { availableTransitions, findTransition, stateLabelFa, WORKFLOWS, type Permission, type TransitionDef } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { AppError, GovernanceError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { pauseSla, resumeSla, startSla, stopSla } from '../sla/engine.js';
import { runGuards, runAllGuards, activeWaivers, type GuardCheck } from './guards.js';
import { rulesInForce } from './rules.js';
import './effects.js';
import { PROTECTED_FIELDS, effectsFor, guardsFor } from './registry.js';
import { applyNotifyRules, customGuards, customRulesFor } from './custom.js';

/** A move as people read it — «تحویل خروجی», not `submit` — for the refusals below. */
const moveLabel = (entity: string, action: string) =>
  WORKFLOWS[entity]?.transitions.find((t) => t.action === action)?.labelFa ?? action;

/** Prisma delegate for each workflow-managed entity. All of them expose a `state` column. */
/**
 * The only sanctioned way to reach a workflow entity's Prisma delegate. Exported so callers
 * never index the client with a path parameter — `(prisma as any)[entity]` turns a URL segment
 * into dynamic property access on the database client.
 */
export function delegate(tx: Tx, entity: string): any {
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
    mediaOrder: tx.mediaOrder,
    booking: tx.booking,
    siteProject: tx.siteProject,
  };
  const d = map[entity];
  if (!d) throw badRequest('UNKNOWN_ENTITY', `موجودیت «${entity}» فاقد ماشین حالت است.`);
  return d;
}

export interface TransitionActor {
  id: string;
  organizationId: string;
  permissions: string[];
  /** permission → delegator, for what the actor holds only through a delegation. */
  delegated?: Record<string, string>;
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
  let out: TransitionOutcome;
  try {
    out = await prisma.$transaction((tx) => transitionWithin(tx, input), { timeout: 20_000 });
  } catch (e) {
    // A guard saying no is a fact about the process — where people push against the rules —
    // and the rule lab (#5) needs it to say what a relaxed rule would have let through. The
    // transaction has rolled back, so this is written on its own.
    if (e instanceof GovernanceError) {
      await audit({
        organizationId: input.actor.organizationId, actorId: input.actor.id, action: 'TRANSITION_BLOCKED',
        entityType: input.entity, entityId: input.id,
        after: { action: input.action, rule: e.rule, guard: (e.details as { guard?: string } | undefined)?.guard ?? null, messageFa: e.message },
        ipAddress: input.actor.ipAddress, requestId: input.actor.requestId,
      }).catch(() => undefined);
    }
    throw e;
  }
  // Committed: whoever the move hands short-deadline work to hears about it (roadmap #49).
  // Imported late — the notifier reaches the job runner, which reaches back into the engine.
  await import('./notices.js').then((m) => m.noticesAfter(out, input.actor)).catch(() => undefined);
  return out;
}

/**
 * The engine body, for callers that must change state atomically with other writes — converting
 * a lead creates a Company and an Opportunity in the same breath, and a failed QC review raises
 * a revision alongside the deliverable's move.
 *
 * Prisma has no nested interactive transactions, so those callers join this rather than calling
 * `transition()` from inside their own. Same enforcement, same audit, same SLA effects: this is
 * an entry point, not an escape hatch.
 */
export async function transitionWithin(tx: Tx, input: TransitionInput): Promise<TransitionOutcome> {
  const { entity, id, action, actor } = input;
  const payload = input.payload ?? {};

  {
    const model = delegate(tx, entity);
    // Scoped to the actor's organisation: a record from another tenant must read as absent.
    const record = await model.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!record) throw notFound('رکورد');

    const fromState: string = record.state;
    const def: TransitionDef | undefined = findTransition(entity, fromState, action);

    if (!def) {
      const allowed = availableTransitions(entity, fromState).map((t) => t.action);
      throw new AppError(
        409,
        'ILLEGAL_TRANSITION',
        `انتقال «${moveLabel(entity, action)}» از وضعیت «${stateLabelFa(fromState)}» مجاز نیست.`,
        { fromState, requested: action, allowed },
      );
    }

    if (def.permission && !actor.permissions.includes(def.permission as Permission)) {
      throw forbidden(`برای انجام «${def.labelFa}» به دسترسی «${def.permission}» نیاز دارید.`);
    }
    // "A, as B's delegate" — recorded on the transition and its audit row, not just "A".
    const onBehalfOfId = (def.permission && actor.delegated?.[def.permission]) || null;

    const reason = input.reason?.trim();
    if (def.requiresReason && !reason) {
      throw badRequest(
        'REASON_REQUIRED',
        `ثبت دلیل برای «${def.labelFa}» الزامی است.`,
        { action },
      );
    }

    // Doc_H's guards, those an installed extension attached, then the organisation's own (#47).
    const custom = await customRulesFor(tx, actor.organizationId, entity, action);
    const own = customGuards(custom);
    const guardKeys = [...guardsFor(entity, action, def.guards), ...own.keys];
    const waivers = guardKeys.length ? await activeWaivers(tx, entity, id, action) : [];
    const guardResult = await runGuards(guardKeys, {
      tx, entity, id, record, payload, actorId: actor.id, resolve: own.resolve, labelOf: own.labelOf,
    }, waivers);
    if (!guardResult.ok) {
      throw new GovernanceError(
        guardResult.rule ?? 'unknown',
        guardResult.messageFa ?? 'این عملیات با قوانین حاکم بر فرآیند مغایرت دارد.',
        { ...(guardResult.details as object ?? {}), guard: guardResult.guard ?? null },
      );
    }
    // A waiver is spent by the transition it let through, in the same transaction, so it can
    // never let a second one through.
    for (const w of guardResult.usedWaivers) {
      await tx.waiver.update({ where: { id: w.id }, data: { usedAt: new Date(), usedById: actor.id, usedAction: action } });
    }
    const waived = guardResult.usedWaivers.map((w) => ({ id: w.id, guard: w.guard, grantedById: w.grantedById, reason: w.reason }));
    // Which rules said yes: the versions in force now, kept on the row for the auditor of later.
    const rules = await rulesInForce(tx);

    // The core effect, then what extensions add (#47). An extension adds to the update; it may
    // not write the state, identity, or anything the core effect already set.
    const patch: Record<string, unknown> = {};
    for (const effect of effectsFor(entity, action)) {
      const out = (await effect.run({ tx, id, record, payload, actorId: actor.id, organizationId: actor.organizationId, reason })) ?? {};
      if (effect.source !== 'core') {
        const refused = Object.keys(out).filter((k) => PROTECTED_FIELDS.has(k) || k in patch);
        if (refused.length) throw new AppError(500, 'EFFECT_REFUSED', `اثر «${effect.key}» از افزونهٔ «${effect.extension ?? '—'}» می‌خواهد «${refused.join('، ')}» را بنویسد؛ افزونه فقط می‌افزاید.`);
      }
      Object.assign(patch, out);
    }

    const updated = await model.update({
      where: { id },
      data: { state: def.to, ...patch },
    });
    const notified = await applyNotifyRules(tx, custom, { organizationId: actor.organizationId, entity, record: updated, actorId: actor.id, transitionFa: def.labelFa });
    const ownRules = custom.filter((r) => r.kind === 'GUARD').map((r) => `${r.code}@${r.version}`);

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
        onBehalfOfId,
        rulesVersionId: rules.workflows,
        permissionsVersionId: rules.permissions,
      },
    });

    await audit({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'STATE_TRANSITION',
      entityType: entity,
      entityId: id,
      onBehalfOfId,
      before: { state: fromState },
      after: {
        state: def.to, rules: { workflows: rules.workflows, permissions: rules.permissions },
        ...(waived.length ? { waived } : {}),
        // The organisation's rules this move met, by version (#47).
        ...(ownRules.length || notified.length ? { customRules: { guards: ownRules, notified } } : {}),
      },
      reason: reason ?? null,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    }, tx);

    if (def.stopsSla?.length) {
      await stopSla(tx, def.stopsSla, entity, id);
    }
    // Resume before pause: a transition may end one wait and begin another.
    if (def.resumesSla?.length) {
      await resumeSla(tx, entity, id, actor.id, def.resumesSla);
    }
    if (def.pausesSla?.length) {
      await pauseSla(tx, {
        entityType: entity, entityId: id, policyCodes: def.pausesSla,
        kind: 'TRANSITION', reason: `${def.labelFa} (${action})`, actorId: actor.id,
      });
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
  }
}

/**
 * A record that comes over from a previous system already in the middle of its life (roadmap #48):
 * a project that was running before this system existed. Its state is recorded, not moved — no
 * guard runs, since guards judge moves made here, and no effect or SLA clock starts — and the row
 * is marked `opening`, so process mining, the rule lab and webhooks leave it out. Only from the
 * workflow's first state, and only once, so it can never serve as a way round a guard.
 */
export async function recordOpeningState(
  tx: Tx,
  input: { entity: string; id: string; toState: string; reason: string; actor: Pick<TransitionActor, 'id' | 'organizationId' | 'ipAddress' | 'requestId'> },
): Promise<void> {
  const wf = WORKFLOWS[input.entity];
  if (!wf || !wf.states.includes(input.toState)) throw badRequest('UNKNOWN_STATE', `وضعیت «${input.toState}» در «${input.entity}» نیست.`);
  const model = delegate(tx, input.entity);
  const record = await model.findFirst({ where: { id: input.id, organizationId: input.actor.organizationId }, select: { id: true, state: true } });
  if (!record) throw notFound('رکورد');
  const moved = await tx.stateTransition.count({ where: { entityType: input.entity, entityId: input.id } });
  if (record.state !== wf.initial || moved > 0) {
    throw new AppError(409, 'OPENING_STATE', 'وضعیت آغازین فقط یک بار و برای رکوردی ثبت می‌شود که هنوز در این سامانه حرکتی نکرده است.');
  }
  if (input.toState === wf.initial) return;
  const rules = await rulesInForce(tx);
  await model.update({ where: { id: input.id }, data: { state: input.toState } });
  await tx.stateTransition.create({
    data: {
      organizationId: input.actor.organizationId, entityType: input.entity, entityId: input.id,
      fromState: wf.initial, toState: input.toState, action: 'opening', reason: input.reason, opening: true,
      actorId: input.actor.id, rulesVersionId: rules.workflows, permissionsVersionId: rules.permissions,
    },
  });
  await audit({
    organizationId: input.actor.organizationId, actorId: input.actor.id, action: 'STATE_TRANSITION',
    entityType: input.entity, entityId: input.id, before: { state: wf.initial }, after: { state: input.toState, opening: true },
    reason: input.reason, ipAddress: input.actor.ipAddress, requestId: input.actor.requestId,
  }, tx);
}

export interface CascadeInput {
  entity: string;
  id: string;
  toState: string;
  action: string;
  actorId: string;
  organizationId: string;
  reason?: string;
}

/**
 * A state change on a SECOND entity, caused by a transition on a first — approving a brief moves
 * its opportunity to BRIEF_COMPLETED, returning one moves it back to BRIEF_REQUESTED.
 *
 * Guards and permissions are deliberately not run: the cascade is a consequence of a move that
 * was already authorised and already passed its guards, and re-checking would demand that the
 * actor hold permissions on an entity they are not acting on directly. What a cascade must not
 * skip is traceability, so this writes the StateTransition row and the AuditEvent that an
 * inline `tx.<model>.update({ state })` silently omitted, leaving gaps in the entity's history.
 *
 * This is the only sanctioned way to cascade. Effects must call it rather than writing `state`.
 */
export async function cascadeState(tx: Tx, input: CascadeInput): Promise<void> {
  const { entity, id, toState, action, actorId, organizationId, reason } = input;
  const model = delegate(tx, entity);

  const record = await model.findFirst({
    where: { id, organizationId },
    select: { id: true, state: true },
  });
  // A cascade target that has gone missing must not abort the transition that caused it.
  if (!record || record.state === toState) return;

  await model.update({ where: { id }, data: { state: toState } });

  await tx.stateTransition.create({
    data: {
      organizationId,
      entityType: entity,
      entityId: id,
      fromState: record.state,
      toState,
      action,
      cascade: true,
      reason: reason ?? 'cascaded from a related transition',
      actorId,
    },
  });

  await audit({
    organizationId,
    actorId,
    action: 'STATE_TRANSITION',
    entityType: entity,
    entityId: id,
    before: { state: record.state },
    after: { state: toState },
    reason: reason ?? `cascade: ${action}`,
  }, tx);
}

/** Best-effort owner for SLA notifications, in order of how directly they own the clock. */
function resolveSlaOwner(record: Record<string, any>): string | null {
  return (
    record.assigneeId ??
    record.ownerId ??
    record.accountOwnerId ??
    record.reviewerId ??
    record.approverId ??
    record.createdById ??
    null
  );
}

export interface PreflightEntry {
  action: string;
  labelFa: string;
  labelEn: string;
  to: string;
  requiresReason: boolean;
  /** The caller holds the transition's permission. */
  permitted: boolean;
  permission: string | null;
  checks: GuardCheck[];
  /** Permitted and every guard holds — the click would succeed, as of now. */
  ready: boolean;
}

/**
 * What stands between the caller and each transition out of the current state, before they
 * click. Every guard is evaluated and every verdict reported, unlike enforcement, which stops
 * at the first. Guards are read-only, so this can run as often as a page wants.
 *
 * The payload is empty: a transition that carries one (a QC result, a decision) is judged
 * without it, and a guard that needs it will say so — which is still the right answer to
 * "what do I need".
 */
export async function preflight(
  tx: Tx,
  input: { entity: string; id: string; actor: Pick<TransitionActor, 'id' | 'organizationId' | 'permissions'>; action?: string },
): Promise<{ state: string; transitions: PreflightEntry[] }> {
  const { entity, id, actor } = input;
  const record = await delegate(tx, entity).findFirst({
    where: { id, organizationId: actor.organizationId },
  });
  if (!record) throw notFound('رکورد');

  const state: string = record.state;
  const candidates = availableTransitions(entity, state)
    .filter((t) => !input.action || t.action === input.action);
  if (input.action && candidates.length === 0) {
    throw new AppError(409, 'ILLEGAL_TRANSITION',
      `انتقال «${moveLabel(entity, input.action)}» از وضعیت «${stateLabelFa(state)}» مجاز نیست.`,
      { fromState: state, requested: input.action, allowed: availableTransitions(entity, state).map((t) => t.action) });
  }

  const transitions: PreflightEntry[] = [];
  const custom = await customRulesFor(tx, actor.organizationId, entity);
  for (const def of candidates) {
    const permitted = !def.permission || actor.permissions.includes(def.permission as Permission);
    const own = customGuards(custom.filter((r) => r.action === def.action));
    const guardKeys = [...guardsFor(entity, def.action, def.guards), ...own.keys];
    const waivers = guardKeys.length ? await activeWaivers(tx, entity, id, def.action) : [];
    const checks = await runAllGuards(guardKeys, { tx, entity, id, record, payload: {}, actorId: actor.id, resolve: own.resolve, labelOf: own.labelOf }, waivers);
    transitions.push({
      action: def.action, labelFa: def.labelFa, labelEn: def.labelEn, to: def.to,
      requiresReason: def.requiresReason ?? false,
      permitted, permission: def.permission ?? null,
      checks,
      ready: permitted && checks.every((c) => c.ok),
    });
  }
  return { state, transitions };
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
