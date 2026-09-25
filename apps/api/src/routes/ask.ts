import type { FastifyPluginAsync } from 'fastify';
import { askReportSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { ask, catalogFor } from '../ask/answer.js';
import { PERIOD_PRESETS } from '../ask/periods.js';
import { modelPlanner } from '../ask/model.js';

/** Natural-language reporting (roadmap #27): questions answered from the semantic layer. */
const askRoutes: FastifyPluginAsync = async (app) => {
  app.get('/reports/ask/catalog', {
    preHandler: [app.authenticate, app.requirePermissions('report.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    return {
      metrics: catalogFor(actor),
      periods: Object.entries(PERIOD_PRESETS).map(([key, p]) => ({ key, labelFa: p.labelFa })),
      modelFallback: modelPlanner() !== null,
    };
  });

  app.post('/reports/ask', {
    preHandler: [app.authenticate, app.requirePermissions('report.read')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req) => {
    const actor = actorFrom(req);
    const input = parse(askReportSchema, req.body);
    return ask(prisma, {
      id: actor.id, organizationId: actor.organizationId, departmentCode: actor.departmentCode,
      permissions: actor.permissions, ipAddress: actor.ipAddress, requestId: actor.requestId,
    }, { question: input.question ?? null, plan: input.plan ?? null }, { planner: modelPlanner() });
  });
};

export default askRoutes;
