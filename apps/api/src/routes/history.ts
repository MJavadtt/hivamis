import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { currentUser, hasPermission } from '../auth/plugin.js';
import { PROPOSAL_SANCTIONED_STATES, redactionFor } from '../pdf/access.js';
import { delegate } from '../workflow/engine.js';
import {
  HISTORY_READ_PERMISSION, diff, reconstruct, redact, redactSnapshot, timeline, type AuditRow,
} from '../audit/history.js';

/**
 * A record's history as evidence: what it looked like at any instant, and who changed which
 * field from what to what. Built entirely from audit_events (roadmap #3).
 *
 * Read gate: the same permission that reads the record, or admin.audit. Financial fields are
 * withheld by the same rule the PDF layer uses, so a figure hidden on paper is hidden here.
 */
const historyRoutes: FastifyPluginAsync = async (app) => {
  async function load(req: Parameters<typeof actorFrom>[0], entityType: string, entityId: string) {
    const actor = actorFrom(req);
    const perm = HISTORY_READ_PERMISSION[entityType];
    if (!perm && !hasPermission(req, 'admin.audit')) {
      throw forbidden(`تاریخچهٔ «${entityType}» فقط برای حسابرسان قابل مشاهده است`);
    }
    if (perm && !hasPermission(req, perm) && !hasPermission(req, 'admin.audit')) {
      throw forbidden(`برای مشاهدهٔ تاریخچه به دسترسی «${perm}» نیاز دارید`);
    }

    const events = await prisma.auditEvent.findMany({
      where: { organizationId: actor.organizationId, entityType, entityId },
      orderBy: { createdAt: 'asc' },
      include: { actor: { select: { id: true, fullName: true } } },
    });
    if (events.length === 0) throw notFound('تاریخچه');

    // The sanctioned-price rule for proposals depends on the record's current state.
    let sanctioned = false;
    if (entityType === 'proposal') {
      const current = await delegate(prisma, 'proposal').findFirst({
        where: { id: entityId, organizationId: actor.organizationId }, select: { state: true },
      });
      sanctioned = current ? PROPOSAL_SANCTIONED_STATES.has(current.state) : false;
    }
    const redaction = redactionFor(currentUser(req), { proposalSanctioned: sanctioned });
    return { actor, events, redaction };
  }

  const actorName = (ev: { actor?: { fullName: string } | null; actorId: string | null }) =>
    ev.actor?.fullName ?? (ev.actorId ? null : 'سیستم');

  /** Every change to the record, oldest first, each with its field-level diff. */
  app.get('/history/:entityType/:entityId', { preHandler: [app.authenticate] }, async (req) => {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };
    const { events, redaction } = await load(req, entityType, entityId);
    return {
      entityType, entityId,
      withheld: redaction.withheld,
      events: timeline(events as AuditRow[]).map((ev) => ({
        id: ev.id, at: ev.createdAt, action: ev.action, reason: ev.reason, ipAddress: ev.ipAddress,
        actorId: ev.actorId, actorName: actorName(events.find((e) => e.id === ev.id)!),
        changes: redact(ev.changes, redaction),
        details: ev.details,
      })),
    };
  });

  /** The record as it stood at `ts`. */
  app.get('/history/:entityType/:entityId/at', { preHandler: [app.authenticate] }, async (req) => {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };
    const { ts } = req.query as { ts?: string };
    const at = ts ? new Date(ts) : null;
    if (!at || Number.isNaN(at.getTime())) throw badRequest('INVALID_TIMESTAMP', 'زمان مورد نظر معتبر نیست', { ts });

    const { events, redaction } = await load(req, entityType, entityId);
    const result = reconstruct(events as AuditRow[], at);
    if (!result) {
      return { entityType, entityId, at, known: false, snapshot: null, asOf: null,
        earliest: events[0]!.createdAt };
    }
    const { snapshot, withheld } = redactSnapshot(result.snapshot, redaction);
    return {
      entityType, entityId, at, known: true, snapshot, withheld,
      asOf: { id: result.asOf.id, at: result.asOf.createdAt, action: result.asOf.action },
    };
  });

  /** What changed between two instants, field by field. */
  app.get('/history/:entityType/:entityId/diff', { preHandler: [app.authenticate] }, async (req) => {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };
    const { from, to } = req.query as { from?: string; to?: string };
    const a = from ? new Date(from) : null;
    const b = to ? new Date(to) : new Date();
    if (!a || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
      throw badRequest('INVALID_TIMESTAMP', 'بازهٔ زمانی معتبر نیست', { from, to });
    }
    const { events, redaction } = await load(req, entityType, entityId);
    const before = reconstruct(events as AuditRow[], a);
    const after = reconstruct(events as AuditRow[], b);
    const changes = redact(diff(before?.snapshot ?? {}, after?.snapshot ?? {}), redaction);
    const between = events.filter((e) => e.createdAt > a && e.createdAt <= b);
    return {
      entityType, entityId, from: a, to: b, changes,
      events: between.length,
      actors: [...new Set(between.map((e) => actorName(e)).filter(Boolean))],
    };
  });
};

export default historyRoutes;
