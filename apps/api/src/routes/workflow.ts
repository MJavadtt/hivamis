import type { FastifyPluginAsync } from 'fastify';
import {
  WORKFLOWS, WORKFLOW_READ_PERMISSION, isWorkflowEntity, transitionSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { allowedFor, delegate, transition, workflowFor, preflight } from '../workflow/engine.js';

/**
 * The universal state-change endpoint. Every lifecycle move in the platform funnels through
 * here so permissions, mandatory reasons, Doc_H guards, audit and SLA all apply uniformly.
 */
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
  app.post('/workflow/:entity/:id/transitions', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    requireEntity(entity);
    const body = parse(transitionSchema, req.body);
    const actor = actorFrom(req);
    return transition({
      entity, id, action: body.action, reason: body.reason, payload: body.payload,
      actor: {
        id: actor.id, organizationId: actor.organizationId, permissions: actor.permissions,
        delegated: actor.delegated,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
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
    return preflight(prisma, { entity, id, actor: actorFrom(req) });
  });

  app.get('/workflow/:entity/:id/preflight/:action', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id, action } = req.params as { entity: string; id: string; action: string };
    requireEntity(entity);
    await app.requirePermissions(WORKFLOW_READ_PERMISSION[entity]!)(req);
    const result = await preflight(prisma, { entity, id, actor: actorFrom(req), action });
    return { state: result.state, ...result.transitions[0] };
  });

  app.get('/workflow/:entity/:id/available', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    requireEntity(entity);
    await app.requirePermissions(WORKFLOW_READ_PERMISSION[entity]!)(req);

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
