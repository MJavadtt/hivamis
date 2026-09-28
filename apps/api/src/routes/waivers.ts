import type { FastifyPluginAsync } from 'fastify';
import { WORKFLOWS, isWorkflowEntity } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { guardLabel, guardsFor, hasGuard } from '../workflow/registry.js';
import { CUSTOM_PREFIX, isCustomKey } from '../workflow/custom.js';
import { delegate } from '../workflow/engine.js';

export const DEFAULT_WAIVER_DAYS = 7;
export const MAX_WAIVER_DAYS = 30;

/**
 * Governed exceptions (roadmap #7). A blocked guard is otherwise a dead end, and a dead end
 * moves the work outside the system, losing both the rule and the trace. The CEO or deputy can
 * say "this once, without X; on my authority" — and the system makes that possible, costly,
 * visible and temporary: one guard on one record, a reason, an expiry of days, spent by the
 * first transition it lets through, listed in a register the dashboard and the data-quality
 * report can see.
 */
const waiverRoutes: FastifyPluginAsync = async (app) => {
  app.post('/waivers', {
    preHandler: [app.authenticate, app.requirePermissions('governance.waive')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const body = (req.body ?? {}) as { entityType?: string; entityId?: string; guard?: string; action?: string; reason?: string; expiresAt?: string };
    if (!body.entityType || !isWorkflowEntity(body.entityType)) throw badRequest('UNKNOWN_ENTITY', 'موجودیت باید ماشین حالت داشته باشد');
    // Any guard may be waived — Doc_H's, an extension's, or the organisation's own (#47).
    const own = body.guard && isCustomKey(body.guard)
      ? await prisma.customRule.findFirst({ where: { organizationId: actor.organizationId, code: body.guard.slice(CUSTOM_PREFIX.length), kind: 'GUARD', retiredAt: null } })
      : null;
    if (!body.guard || !(hasGuard(body.guard) || own)) throw badRequest('UNKNOWN_GUARD', `قانون کنترلی «${body.guard ?? ''}» وجود ندارد`);
    if (!body.reason?.trim() || body.reason.trim().length < 10) {
      throw badRequest('REASON_REQUIRED', 'دلیل استثنا الزامی است و باید دست‌کم ده حرف باشد — این متن در دفتر استثناها می‌ماند');
    }
    // The guard must actually stand on some transition of this entity; otherwise the waiver is noise.
    const wf = WORKFLOWS[body.entityType]!;
    const guarded = own
      ? wf.transitions.filter((t) => own.entity === body.entityType && t.action === own.action)
      : wf.transitions.filter((t) => guardsFor(body.entityType!, t.action, t.guards).includes(body.guard!));
    if (guarded.length === 0) throw badRequest('GUARD_NOT_ON_ENTITY', `قانون «${body.guard}» روی هیچ انتقالی از «${body.entityType}» نیست`);
    if (body.action && !guarded.some((t) => t.action === body.action)) {
      throw badRequest('ACTION_NOT_GUARDED', `انتقال «${body.action}» با قانون «${body.guard}» کنترل نمی‌شود`, { guarded: guarded.map((t) => t.action) });
    }
    const record = await delegate(prisma, body.entityType).findFirst({ where: { id: body.entityId ?? '', organizationId: actor.organizationId }, select: { id: true } });
    if (!record) throw notFound('رکورد');

    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : new Date(Date.now() + DEFAULT_WAIVER_DAYS * 86_400_000);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) throw badRequest('INVALID_EXPIRY', 'انقضا باید در آینده باشد');
    if ((expiresAt.getTime() - Date.now()) / 86_400_000 > MAX_WAIVER_DAYS) {
      throw badRequest('TOO_LONG', `استثنا نمی‌تواند بیش از ${MAX_WAIVER_DAYS} روز اعتبار داشته باشد — استثنای دائمی یعنی تغییر قانون`, { maxDays: MAX_WAIVER_DAYS });
    }
    // One live waiver per guard per record: a second one would only muddy the register.
    const duplicate = await prisma.waiver.findFirst({
      where: { entityType: body.entityType, entityId: record.id, guard: body.guard, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (duplicate) throw badRequest('WAIVER_EXISTS', 'برای این قانون روی این رکورد استثنای فعالی وجود دارد', { id: duplicate.id });

    const waiver = await prisma.waiver.create({
      data: {
        organizationId: actor.organizationId, entityType: body.entityType, entityId: record.id, guard: body.guard,
        action: body.action ?? null, reason: body.reason.trim(), grantedById: actor.id, expiresAt,
      },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'WAIVER_GRANTED',
      entityType: body.entityType, entityId: record.id,
      after: { waiverId: waiver.id, guard: waiver.guard, action: waiver.action, expiresAt, reason: waiver.reason },
      reason: waiver.reason, ipAddress: actor.ipAddress,
    });
    return reply.code(201).send({ ...waiver, guardLabelFa: own?.labelFa ?? guardLabel(waiver.guard) });
  });

  /** The register: every exception, with its state. Open to whoever reads governance. */
  app.get('/waivers', {
    preHandler: [app.authenticate, app.requirePermissions('governance.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { entityType, entityId, status } = req.query as Record<string, string | undefined>;
    const now = new Date();
    const rows = await prisma.waiver.findMany({
      where: { organizationId: actor.organizationId, ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) },
      orderBy: { grantedAt: 'desc' }, take: 300,
    });
    const ids = [...new Set(rows.flatMap((r) => [r.grantedById, r.usedById, r.revokedById]).filter((x): x is string => !!x))];
    const names = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const ownCodes = rows.filter((r) => isCustomKey(r.guard)).map((r) => r.guard.slice(CUSTOM_PREFIX.length));
    const ownLabels = new Map((ownCodes.length
      ? await prisma.customRule.findMany({ where: { organizationId: actor.organizationId, code: { in: ownCodes } }, orderBy: { version: 'desc' }, select: { code: true, labelFa: true } })
      : []).reverse().map((r) => [`${CUSTOM_PREFIX}${r.code}`, r.labelFa]));
    const withStatus = rows.map((r) => ({
      ...r,
      guardLabelFa: ownLabels.get(r.guard) ?? guardLabel(r.guard),
      grantedByName: names.get(r.grantedById) ?? '—',
      usedByName: r.usedById ? names.get(r.usedById) ?? '—' : null,
      status: r.revokedAt ? 'REVOKED' : r.usedAt ? 'USED' : r.expiresAt <= now ? 'EXPIRED' : 'OPEN',
    }));
    return status ? withStatus.filter((w) => w.status === status) : withStatus;
  });

  app.post('/waivers/:id/revoke', {
    preHandler: [app.authenticate, app.requirePermissions('governance.waive')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const w = await prisma.waiver.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!w) throw notFound('استثنا');
    if (w.usedAt) throw badRequest('ALREADY_USED', 'این استثنا مصرف شده و دیگر قابل لغو نیست');
    if (w.revokedAt) return w;
    const revoked = await prisma.waiver.update({ where: { id }, data: { revokedAt: new Date(), revokedById: actor.id } });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'WAIVER_REVOKED',
      entityType: w.entityType, entityId: w.entityId, before: { waiverId: id, guard: w.guard }, ipAddress: actor.ipAddress,
    });
    return revoked;
  });

};

export default waiverRoutes;
