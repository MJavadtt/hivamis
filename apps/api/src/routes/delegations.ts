import type { FastifyPluginAsync } from 'fastify';
import { ALL_PERMISSIONS, ROLE_CODES, type RoleCode } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom } from '../lib/http.js';
import { hasPermission } from '../auth/plugin.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { permissionsFor } from '../auth/grants.js';

/** A delegation may not run longer than this; a longer absence is a role change, not a delegation. */
export const MAX_DELEGATION_DAYS = 90;

/**
 * Time-boxed delegation of authority (roadmap #6).
 *
 * The model names one approver per step — the deputy for pricing, the account manager for a
 * brief — and when that person is away the chain stops. In practice organisations route around
 * that by sharing a password, which turns every audit row into a guess. This gives them the
 * formal alternative: a delegation says who, to whom, which permissions and roles, from when to
 * when, and why; it can be revoked; and everything done under it is recorded as done on the
 * delegator's behalf.
 *
 * It takes effect on the delegate's next token — within the access-token lifetime — and a
 * revocation ends their sessions at once, so it cannot linger.
 */
const delegationRoutes: FastifyPluginAsync = async (app) => {
  /** Everything a user may delegate: what their own roles grant them, right now. */
  async function grantsOf(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId }, select: { organizationId: true, isActive: true, roles: { select: { role: { select: { code: true } } } } },
    });
    const roles = (user?.roles ?? []).map((r) => r.role.code as RoleCode);
    return { active: user?.isActive ?? false, roles, permissions: new Set<string>(user ? await permissionsFor(user.organizationId, roles) : []) };
  }

  app.post('/delegations', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const body = (req.body ?? {}) as {
      fromUserId?: string; toUserId?: string; permissions?: string[]; roles?: string[];
      startsAt?: string; endsAt?: string; reason?: string;
    };
    // You delegate your own authority. Delegating someone else's takes admin.users.
    const fromUserId = body.fromUserId ?? actor.id;
    if (fromUserId !== actor.id && !hasPermission(req, 'admin.users')) {
      throw forbidden('فقط می‌توانید اختیارات خودتان را تفویض کنید');
    }
    if (!body.toUserId) throw badRequest('DELEGATE_REQUIRED', 'گیرندهٔ تفویض مشخص نشده است');
    if (body.toUserId === fromUserId) throw badRequest('SELF_DELEGATION', 'تفویض به خود معنایی ندارد');
    if (!body.reason?.trim()) throw badRequest('REASON_REQUIRED', 'دلیل تفویض الزامی است');

    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
    const endsAt = body.endsAt ? new Date(body.endsAt) : null;
    if (Number.isNaN(startsAt.getTime()) || !endsAt || Number.isNaN(endsAt.getTime())) {
      throw badRequest('INVALID_RANGE', 'بازهٔ تفویض معتبر نیست');
    }
    if (endsAt <= startsAt) throw badRequest('INVALID_RANGE', 'پایان تفویض باید بعد از شروع آن باشد');
    if ((endsAt.getTime() - startsAt.getTime()) / 86_400_000 > MAX_DELEGATION_DAYS) {
      throw badRequest('TOO_LONG', `تفویض نمی‌تواند بیش از ${MAX_DELEGATION_DAYS} روز باشد — غیبت طولانی‌تر یعنی تغییر نقش`, { maxDays: MAX_DELEGATION_DAYS });
    }

    const permissions = [...new Set(body.permissions ?? [])];
    const roles = [...new Set(body.roles ?? [])];
    if (permissions.length === 0 && roles.length === 0) throw badRequest('SCOPE_REQUIRED', 'دست‌کم یک دسترسی یا نقش باید تفویض شود');
    const unknownPerm = permissions.find((p) => !(ALL_PERMISSIONS as readonly string[]).includes(p));
    if (unknownPerm) throw badRequest('UNKNOWN_PERMISSION', `دسترسی «${unknownPerm}» وجود ندارد`);
    const unknownRole = roles.find((r) => !(ROLE_CODES as readonly string[]).includes(r));
    if (unknownRole) throw badRequest('UNKNOWN_ROLE', `نقش «${unknownRole}» وجود ندارد`);

    const from = await grantsOf(fromUserId);
    const notHeld = permissions.filter((p) => !from.permissions.has(p));
    if (notHeld.length) throw badRequest('NOT_HELD', 'نمی‌توان دسترسی‌ای را تفویض کرد که خود ندارید', { permissions: notHeld });
    const roleNotHeld = roles.filter((r) => !from.roles.includes(r as RoleCode));
    if (roleNotHeld.length) throw badRequest('NOT_HELD', 'نمی‌توان نقشی را تفویض کرد که خود ندارید', { roles: roleNotHeld });

    const to = await prisma.user.findFirst({ where: { id: body.toUserId, organizationId: actor.organizationId, isActive: true } });
    if (!to) throw notFound('گیرندهٔ تفویض');

    const delegation = await prisma.delegation.create({
      data: {
        organizationId: actor.organizationId, fromUserId, toUserId: to.id, permissions, roles,
        startsAt, endsAt, reason: body.reason.trim(), createdById: actor.id,
      },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'DELEGATION_GRANTED',
      entityType: 'delegation', entityId: delegation.id,
      after: { fromUserId, toUserId: to.id, permissions, roles, startsAt, endsAt, reason: delegation.reason },
      ipAddress: actor.ipAddress,
    });
    return reply.code(201).send(delegation);
  });

  /** Mine — given and received — or, with admin.users, everyone's. */
  app.get('/delegations', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { scope, active } = req.query as { scope?: string; active?: string };
    const all = scope === 'all' && hasPermission(req, 'admin.users');
    const now = new Date();
    const rows = await prisma.delegation.findMany({
      where: {
        organizationId: actor.organizationId,
        ...(all ? {} : { OR: [{ fromUserId: actor.id }, { toUserId: actor.id }] }),
        ...(active === 'true' ? { revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } } : {}),
      },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
    const ids = [...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId]))];
    const names = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      ...r,
      fromName: names.get(r.fromUserId) ?? '—', toName: names.get(r.toUserId) ?? '—',
      status: r.revokedAt ? 'REVOKED' : r.endsAt <= now ? 'EXPIRED' : r.startsAt > now ? 'SCHEDULED' : 'ACTIVE',
    }));
  });

  /** The delegator, the delegate, or admin.users may end it early. The delegate's sessions end with it. */
  app.post('/delegations/:id/revoke', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const d = await prisma.delegation.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!d) throw notFound('تفویض');
    if (d.fromUserId !== actor.id && d.toUserId !== actor.id && !hasPermission(req, 'admin.users')) throw forbidden();
    if (d.revokedAt) return d;
    const revoked = await prisma.$transaction(async (tx) => {
      const row = await tx.delegation.update({ where: { id }, data: { revokedAt: new Date(), revokedById: actor.id } });
      // The borrowed permissions live in the delegate's token until it expires; end the
      // sessions so the revocation is immediate — the precedent set by role changes.
      await tx.session.updateMany({ where: { userId: d.toUserId, revokedAt: null }, data: { revokedAt: new Date() } });
      return row;
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'DELEGATION_REVOKED',
      entityType: 'delegation', entityId: id, before: { toUserId: d.toUserId, endsAt: d.endsAt },
      ipAddress: actor.ipAddress,
    });
    return revoked;
  });
};

export default delegationRoutes;
