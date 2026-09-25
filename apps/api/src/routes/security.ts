import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { alertKindFa, scanOrganization } from '../security/scan.js';

/**
 * Security alerts (roadmap #26) — read, reviewed and dismissed by those who read the audit
 * trail itself. A dismissal needs a reason: "this was fine" is the decision most worth being
 * able to check later.
 */
const securityRoutes: FastifyPluginAsync = async (app) => {
  app.get('/security/alerts', {
    preHandler: [app.authenticate, app.requirePermissions('admin.audit')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { status, limit } = req.query as Record<string, string | undefined>;
    const rows = await prisma.securityAlert.findMany({
      where: { organizationId: actor.organizationId, ...(status && status !== 'ALL' ? { status } : status === 'ALL' ? {} : { status: 'OPEN' }) },
      orderBy: [{ createdAt: 'desc' }],
      take: Math.min(Number(limit ?? 100) || 100, 500),
    });
    const people = await prisma.user.findMany({
      where: { id: { in: [...new Set(rows.flatMap((r) => [r.actorId, r.reviewedById]).filter((x): x is string => !!x))] } },
      select: { id: true, fullName: true, email: true, department: { select: { code: true } } },
    });
    const who = new Map(people.map((p) => [p.id, p]));
    const counts = await prisma.securityAlert.groupBy({
      by: ['status', 'severity'], where: { organizationId: actor.organizationId }, _count: { _all: true },
    });
    return {
      alerts: rows.map((r) => ({
        ...r, kindFa: alertKindFa(r.kind),
        actor: r.actorId ? who.get(r.actorId) ?? null : null,
        reviewedBy: r.reviewedById ? who.get(r.reviewedById)?.fullName ?? null : null,
      })),
      counts: counts.map((c) => ({ status: c.status, severity: c.severity, count: c._count._all })),
    };
  });

  app.post('/security/alerts/:id/review', {
    preHandler: [app.authenticate, app.requirePermissions('admin.audit')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { status, note } = (req.body ?? {}) as { status?: string; note?: string };
    if (!status || !['ACKNOWLEDGED', 'DISMISSED', 'OPEN'].includes(status)) {
      throw badRequest('INVALID_STATUS', 'وضعیت باید «بررسی‌شده»، «رد شده» یا «باز» باشد');
    }
    if (status === 'DISMISSED' && (note?.trim().length ?? 0) < 5) {
      throw badRequest('REASON_REQUIRED', 'برای رد یک هشدار نوشتن دلیل لازم است');
    }
    const alert = await prisma.securityAlert.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!alert) throw notFound('هشدار');
    if (alert.actorId === actor.id) {
      // Nobody closes the case about themselves.
      throw badRequest('SELF_REVIEW', 'هشداری که دربارهٔ خود شماست را دیگری باید بررسی کند');
    }
    const updated = await prisma.securityAlert.update({
      where: { id },
      data: { status, reviewNote: note?.trim() || null, reviewedById: actor.id, reviewedAt: new Date() },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'SECURITY_ALERT_REVIEWED',
      entityType: 'securityAlert', entityId: id,
      before: { status: alert.status }, after: { status, kind: alert.kind },
      reason: note?.trim() || null,
      ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
    });
    return updated;
  });

  /** Scan now, rather than waiting for the next quarter-hour. */
  app.post('/security/scan', {
    preHandler: [app.authenticate, app.requirePermissions('admin.audit')],
  }, async (req) => {
    const actor = actorFrom(req);
    return scanOrganization(actor.organizationId);
  });
};

export default securityRoutes;
