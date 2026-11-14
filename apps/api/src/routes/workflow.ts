import type { FastifyPluginAsync } from 'fastify';
import {
  WORKFLOWS, WORKFLOW_READ_PERMISSION, decideStepBackSchema, isWorkflowEntity, stepBackSchema, transitionSchema,
} from '@hiva/contracts';
import { z } from 'zod';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { assertVisible } from '../bookings/access.js';
import { badRequest, notFound } from '../lib/errors.js';
import { allowedFor, delegate, forceState, transition, workflowFor, preflight } from '../workflow/engine.js';
import { decideStepBack, listStepBacks, stepBack, stepBackInfo, withdrawStepBack, type StepActor } from '../workflow/step-back.js';

const stepActor = (req: Parameters<typeof actorFrom>[0]): StepActor => {
  const a = actorFrom(req);
  return {
    id: a.id, organizationId: a.organizationId, departmentCode: a.departmentCode, permissions: a.permissions, roles: a.roles,
    delegatedRoles: a.delegatedRoles, ipAddress: a.ipAddress, userAgent: a.userAgent, requestId: a.requestId,
  };
};

/**
 * A booking is read by those it concerns (audit F-9, finding 3): to anyone else, its moves, history
 * and checklist are as absent as the booking itself. Other entities are gated by permission alone.
 */
async function assertRecordVisible(entity: string, id: string, req: Parameters<typeof actorFrom>[0]): Promise<void> {
  if (entity !== 'booking') return;
  const a = actorFrom(req);
  await assertVisible({ id: a.id, organizationId: a.organizationId, permissions: a.permissions, delegated: a.delegated }, id);
}

/**
 * The universal state-change endpoint. Every lifecycle move in the platform funnels through
 * here so permissions, mandatory reasons, Doc_H guards, audit and SLA all apply uniformly.
 */
const forceStateSchema = z.object({ toState: z.string().trim().min(1).max(40), reason: z.string().trim().max(2000).optional() });

const workflowRoutes: FastifyPluginAsync = async (app) => {
  /** Rejects an unknown `:entity` before it can reach the database client. */
  const requireEntity = (entity: string): void => {
    if (!isWorkflowEntity(entity)) {
      throw badRequest('UNKNOWN_ENTITY', `موجودیت «${entity}» فاقد ماشین حالت است.`);
    }
  };

  app.get('/workflow/definitions', { preHandler: [app.authenticate] }, async () =>
    Object.entries(WORKFLOWS).map(([entity, def]) => ({
      entity,
      labelFa: def.labelFa,
      initial: def.initial,
      states: def.states,
      terminal: def.terminal,
      transitions: def.transitions,
    })));

  app.get('/workflow/:entity/definition', { preHandler: [app.authenticate] }, async (req) => {
    const { entity } = req.params as { entity: string };
    const def = workflowFor(entity);
    if (!def) throw notFound('ماشین حالت');
    return def;
  });

  // Per-transition permission is enforced inside transition(); all 99 declared transitions
  // carry one, so there is no unrestricted move to guard against at the route level.
  // Audit F-7: a move queued offline is sent again until it is answered; the key makes it once.
  app.post('/workflow/:entity/:id/transitions', { preHandler: [app.authenticate, app.idempotent] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    requireEntity(entity);
    await assertRecordVisible(entity, id, req);
    const body = parse(transitionSchema, req.body);
    const actor = actorFrom(req);
    return transition({
      entity, id, action: body.action, reason: body.reason, payload: body.payload,
      actor: {
        id: actor.id, organizationId: actor.organizationId, permissions: actor.permissions,
        delegated: actor.delegated, roles: actor.roles, delegatedRoles: actor.delegatedRoles,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      },
    });
  });

  /**
   * Back one step to correct a mistake (the owner, 2026-11-14; ADR-128): a manager over the record takes
   * it back at once; anyone else asks their unit's manager. Read permission on the record is enough to
   * ask — whoever works on it may have got it wrong.
   */
  app.get('/workflow/:entity/:id/step-back', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    requireEntity(entity);
    await app.requirePermissions(WORKFLOW_READ_PERMISSION[entity]!)(req);
    return stepBackInfo(stepActor(req), entity, id);
  });

  app.post('/workflow/:entity/:id/step-back', { preHandler: [app.authenticate, app.idempotent] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    requireEntity(entity);
    await app.requirePermissions(WORKFLOW_READ_PERMISSION[entity]!)(req);
    const { reason } = parse(stepBackSchema, req.body);
    return stepBack(stepActor(req), entity, id, reason);
  });

  /** Requests waiting on the caller (`?which=awaiting`, the default) or their own (`?which=mine`). */
  app.get('/step-backs', { preHandler: [app.authenticate] }, async (req) => {
    const { which } = req.query as { which?: string };
    return listStepBacks(stepActor(req), which === 'mine' ? 'mine' : 'awaiting');
  });

  app.post('/step-backs/:requestId/decide', { preHandler: [app.authenticate] }, async (req) => {
    const { requestId } = req.params as { requestId: string };
    const { approve, note } = parse(decideStepBackSchema, req.body);
    return decideStepBack(stepActor(req), requestId, approve, note);
  });

  app.post('/step-backs/:requestId/withdraw', { preHandler: [app.authenticate] }, async (req) => {
    const { requestId } = req.params as { requestId: string };
    return withdrawStepBack(stepActor(req), requestId);
  });

  /** Any state, straight — the system administrator's alone (engine.ts, forceState). */
  app.post('/workflow/:entity/:id/force', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    requireEntity(entity);
    const body = parse(forceStateSchema, req.body);
    const actor = actorFrom(req);
    return forceState({
      entity, id, toState: body.toState, reason: body.reason,
      actor: {
        id: actor.id, organizationId: actor.organizationId, permissions: actor.permissions, delegated: actor.delegated,
        roles: actor.roles, delegatedRoles: actor.delegatedRoles, ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      },
    });
  });

  /**
   * State history is as sensitive as the record: every row carries the reason a transition was
   * taken. Gated by the entity's own read permission, and the denial is audited by
   * requirePermissions rather than checked by hand.
   */
  app.get('/workflow/:entity/:id/history', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    requireEntity(entity);
    await app.requirePermissions(WORKFLOW_READ_PERMISSION[entity]!)(req);
    await assertRecordVisible(entity, id, req);

    const actor = actorFrom(req);
    return prisma.stateTransition.findMany({
      where: { entityType: entity, entityId: id, organizationId: actor.organizationId },
      include: { actor: { select: { id: true, fullName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  /**
   * "Why can't I?" before the click: every transition out of the current state with every
   * guard's verdict, not just the first failure. Read permission on the entity is enough — the
   * response says which transitions the caller could perform, and which they could not.
   */
  app.get('/workflow/:entity/:id/preflight', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    requireEntity(entity);
    await app.requirePermissions(WORKFLOW_READ_PERMISSION[entity]!)(req);
    await assertRecordVisible(entity, id, req);
    return preflight(prisma, { entity, id, actor: actorFrom(req) });
  });

  app.get('/workflow/:entity/:id/preflight/:action', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id, action } = req.params as { entity: string; id: string; action: string };
    requireEntity(entity);
    await app.requirePermissions(WORKFLOW_READ_PERMISSION[entity]!)(req);
    await assertRecordVisible(entity, id, req);
    const result = await preflight(prisma, { entity, id, actor: actorFrom(req), action });
    return { state: result.state, ...result.transitions[0] };
  });

  app.get('/workflow/:entity/:id/available', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    requireEntity(entity);
    await app.requirePermissions(WORKFLOW_READ_PERMISSION[entity]!)(req);
    await assertRecordVisible(entity, id, req);

    const actor = actorFrom(req);
    const record = await delegate(prisma, entity).findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { state: true },
    });
    if (!record) throw notFound();
    return allowedFor(entity, record.state, actor.permissions);
  });
};

export default workflowRoutes;
