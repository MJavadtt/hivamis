import type { FastifyPluginAsync } from 'fastify';
import { transitionSchema, WORKFLOWS } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { allowedFor, transition, workflowFor } from '../workflow/engine.js';

/**
 * The universal state-change endpoint. Every lifecycle move in the platform funnels through
 * here so permissions, mandatory reasons, Doc_H guards, audit and SLA all apply uniformly.
 */
const workflowRoutes: FastifyPluginAsync = async (app) => {
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

  app.post('/workflow/:entity/:id/transitions', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    const body = parse(transitionSchema, req.body);
    const actor = actorFrom(req);
    return transition({
      entity, id, action: body.action, reason: body.reason, payload: body.payload,
      actor: {
        id: actor.id, organizationId: actor.organizationId, permissions: actor.permissions,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      },
    });
  });

  app.get('/workflow/:entity/:id/history', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    return prisma.stateTransition.findMany({
      where: { entityType: entity, entityId: id },
      include: { actor: { select: { id: true, fullName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.get('/workflow/:entity/:id/available', { preHandler: [app.authenticate] }, async (req) => {
    const { entity, id } = req.params as { entity: string; id: string };
    const actor = actorFrom(req);
    const record = await (prisma as any)[entity]?.findUnique?.({ where: { id }, select: { state: true } });
    if (!record) throw notFound();
    return allowedFor(entity, record.state, actor.permissions);
  });
};

export default workflowRoutes;
