import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorFrom, parse } from '../lib/http.js';
import { deleteRecord, deletionPlan } from '../lib/purge.js';

/**
 * Deleting a record for good (ADR-132): first what it would take with it, then — confirmed — the
 * deletion. `record.delete` is a manager's by default, and reaches only the records they see.
 */
const body = z.object({ reason: z.string().trim().max(2000).optional() });

const recordsRoutes: FastifyPluginAsync = async (app) => {
  const guard = { preHandler: [app.authenticate, app.requirePermissions('record.delete')] };

  app.get('/records/:kind/:id/deletion', guard, async (req) => {
    const { kind, id } = req.params as { kind: string; id: string };
    return deletionPlan(actorFrom(req), kind, id);
  });

  app.delete('/records/:kind/:id', guard, async (req) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const { reason } = parse(body, req.body ?? {});
    return deleteRecord(actorFrom(req), kind, id, reason);
  });
};

export default recordsRoutes;
