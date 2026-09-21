import type { FastifyPluginAsync } from 'fastify';
import {
  changePasswordSchema, loginSchema, permissionsForRoles, updateLocaleSchema, type RoleCode,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { parse, actorFrom } from '../lib/http.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { generateRefreshToken, hashToken, signAccessToken, ttlToMs } from '../auth/tokens.js';
import { audit } from '../lib/audit.js';
import { env } from '../env.js';

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;

async function claimsFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { department: true, roles: { include: { role: true } } },
  });
  if (!user) throw unauthorized();
  const roles = user.roles.map((r) => r.role.code as RoleCode);
  const native = permissionsForRoles(roles);
  const { permissions, delegated, delegatedRoles, roles: allRoles } = await withDelegations(user.id, roles, native);
  return {
    user,
    claims: {
      sub: user.id,
      organizationId: user.organizationId,
      departmentCode: user.department?.code ?? null,
      roles: allRoles,
      permissions,
      ...(Object.keys(delegated).length ? { delegated } : {}),
      ...(Object.keys(delegatedRoles).length ? { delegatedRoles } : {}),
    },
  };
}

/**
 * Fold the user's active delegations into their grants (roadmap #6). A delegated permission is
 * only granted if the delegator still holds it themselves at this moment — a delegation must
 * not outlive a demotion — and never overrides what the delegate already has natively, so the
 * attribution map names only what came from someone else.
 */
async function withDelegations(userId: string, roles: RoleCode[], native: readonly string[]) {
  const now = new Date();
  const active = await prisma.delegation.findMany({
    where: { toUserId: userId, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { createdAt: 'asc' },
  });
  const permissions = new Set<string>(native);
  const allRoles = new Set<string>(roles);
  const delegated: Record<string, string> = {};
  const delegatedRoles: Record<string, string> = {};
  for (const d of active) {
    const from = await prisma.user.findUnique({
      where: { id: d.fromUserId }, select: { isActive: true, roles: { select: { role: { select: { code: true } } } } },
    });
    if (!from?.isActive) continue;
    const fromRoles = from.roles.map((r) => r.role.code as RoleCode);
    const fromPerms = new Set<string>(permissionsForRoles(fromRoles));
    for (const p of d.permissions) {
      if (!fromPerms.has(p) || permissions.has(p)) continue;
      permissions.add(p); delegated[p] = d.fromUserId;
    }
    for (const r of d.roles) {
      if (!fromRoles.includes(r as RoleCode) || allRoles.has(r)) continue;
      allRoles.add(r); delegatedRoles[r] = d.fromUserId;
    }
  }
  return { permissions: [...permissions], roles: [...allRoles], delegated, delegatedRoles };
}

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/login', {
    config: { rateLimit: { max: env.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  }, async (req) => {
    const { email, password } = parse(loginSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Uniform failure response — never reveal whether the address exists.
    const fail = async (reason: string) => {
      if (user) {
        const failed = user.failedLoginCount + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: failed,
            lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : user.lockedUntil,
          },
        });
        await audit({
          organizationId: user.organizationId, actorId: user.id, action: 'LOGIN_FAILED',
          entityType: 'user', entityId: user.id, reason,
          ipAddress: req.ip, userAgent: req.headers['user-agent'] ?? null,
        }).catch(() => undefined);
      }
      throw unauthorized('ایمیل یا رمز عبور نادرست است');
    };

    if (!user || !user.isActive || user.deletedAt) return fail('inactive-or-missing');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw unauthorized('حساب کاربری موقتاً قفل شده است. چند دقیقه دیگر تلاش کنید.');
    }
    if (!(await verifyPassword(user.passwordHash, password))) return fail('bad-password');

    const { claims } = await claimsFor(user.id);
    const accessToken = await signAccessToken(claims);
    const refresh = generateRefreshToken();

    await prisma.$transaction([
      prisma.session.create({
        data: {
          userId: user.id,
          refreshTokenHash: refresh.hash,
          userAgent: req.headers['user-agent'] ?? null,
          ipAddress: req.ip,
          expiresAt: new Date(Date.now() + ttlToMs(env.REFRESH_TOKEN_TTL)),
        },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      }),
    ]);

    await audit({
      organizationId: user.organizationId, actorId: user.id, action: 'LOGIN',
      entityType: 'user', entityId: user.id,
      ipAddress: req.ip, userAgent: req.headers['user-agent'] ?? null,
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      mustChangePassword: user.mustChangePassword,
      user: {
        id: user.id, email: user.email, fullName: user.fullName, jobTitle: user.jobTitle,
        departmentCode: claims.departmentCode, roles: claims.roles, permissions: claims.permissions,
        delegated: claims.delegated ?? {}, delegatedRoles: claims.delegatedRoles ?? {},
        locale: user.locale,
      },
    };
  });

  /** A display preference, so it needs only an authenticated caller — no admin permission. */
  app.patch('/auth/me/locale', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { locale } = parse(updateLocaleSchema, req.body);
    const user = await prisma.user.update({
      where: { id: actor.id },
      data: { locale },
      select: { id: true, locale: true },
    });
    return user;
  });

  app.post('/auth/refresh', {
    // Rotation makes this endpoint a credential-guessing surface of its own; it is limited
    // on the same budget as login rather than left on the 300/min global allowance.
    config: { rateLimit: { max: env.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  }, async (req) => {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };
    if (!refreshToken) throw badRequest('MISSING_TOKEN', 'توکن تازه‌سازی ارسال نشده است.');
    const session = await prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
    });
    if (!session) throw unauthorized('نشست نامعتبر است. دوباره وارد شوید.');

    /**
     * Reuse detection (OAuth 2.1 BCP). Rotation makes each refresh token single-use, so a
     * second presentation means the token was captured: either the attacker is replaying what
     * the victim already spent, or the victim is replaying what the attacker spent. Which of
     * the two cannot be told apart, so the whole family goes.
     *
     * Revocation is user-wide rather than per-device-chain. That needs no schema change, and
     * at this scale — tens of staff, a few devices each — forcing everyone on the account to
     * sign in again is the correct response to a stolen credential, not collateral damage.
     */
    if (session.revokedAt) {
      const { count } = await prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const owner = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { organizationId: true },
      });
      await audit({
        organizationId: owner?.organizationId ?? '',
        actorId: session.userId,
        action: 'REFRESH_TOKEN_REUSE',
        entityType: 'user',
        entityId: session.userId,
        after: { revokedSessions: count, reusedSessionId: session.id },
        reason: 'a revoked refresh token was presented — every session for this user was revoked',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        requestId: req.id,
      }).catch(() => undefined);
      throw unauthorized('نشست نامعتبر است. دوباره وارد شوید.');
    }

    if (session.expiresAt < new Date()) {
      throw unauthorized('نشست نامعتبر است. دوباره وارد شوید.');
    }

    const { user: sessionUser, claims } = await claimsFor(session.userId);
    // Login rejects a deactivated or deleted user; refresh must agree, or a revoked employee
    // keeps minting access tokens until the refresh token expires days later.
    if (!sessionUser.isActive || sessionUser.deletedAt) {
      await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      throw unauthorized('نشست نامعتبر است. دوباره وارد شوید.');
    }
    // Rotate: the presented refresh token is single-use.
    const next = generateRefreshToken();
    await prisma.$transaction([
      prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }),
      prisma.session.create({
        data: {
          userId: session.userId, refreshTokenHash: next.hash,
          userAgent: req.headers['user-agent'] ?? null, ipAddress: req.ip,
          expiresAt: new Date(Date.now() + ttlToMs(env.REFRESH_TOKEN_TTL)),
        },
      }),
    ]);
    return { accessToken: await signAccessToken(claims), refreshToken: next.token };
  });

  app.post('/auth/logout', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };
    if (refreshToken) {
      await prisma.session.updateMany({
        where: { refreshTokenHash: hashToken(refreshToken), userId: actor.id },
        data: { revokedAt: new Date() },
      });
    } else {
      await prisma.session.updateMany({
        where: { userId: actor.id, revokedAt: null }, data: { revokedAt: new Date() },
      });
    }
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'LOGOUT',
      entityType: 'user', entityId: actor.id, ipAddress: actor.ipAddress,
    });
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const user = await prisma.user.findUnique({
      where: { id: actor.id },
      include: { department: true, roles: { include: { role: true } }, organization: true },
    });
    if (!user) throw unauthorized();
    return {
      id: user.id, email: user.email, fullName: user.fullName, jobTitle: user.jobTitle,
      locale: user.locale, mustChangePassword: user.mustChangePassword,
      department: user.department ? { code: user.department.code, nameFa: user.department.nameFa } : null,
      organization: { id: user.organization.id, name: user.organization.name, currency: user.organization.currency },
      roles: actor.roles, permissions: actor.permissions,
      delegated: actor.delegated, delegatedRoles: actor.delegatedRoles,
    };
  });

  app.post('/auth/change-password', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
    const user = await prisma.user.findUnique({ where: { id: actor.id } });
    if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw badRequest('BAD_CREDENTIALS', 'رمز عبور فعلی نادرست است.');
    }
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
      }),
      // Force re-authentication everywhere after a password change.
      prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
      entityType: 'user', entityId: actor.id, reason: 'password changed',
    });
    return reply.code(204).send();
  });
};

export default authRoutes;
