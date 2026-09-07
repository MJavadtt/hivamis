import type { FastifyPluginAsync } from 'fastify';
import { changePasswordSchema, loginSchema, permissionsForRoles, type RoleCode } from '@hiva/contracts';
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
  return {
    user,
    claims: {
      sub: user.id,
      organizationId: user.organizationId,
      departmentCode: user.department?.code ?? null,
      roles,
      permissions: permissionsForRoles(roles),
    },
  };
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
        locale: user.locale,
      },
    };
  });

  app.post('/auth/refresh', async (req) => {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };
    if (!refreshToken) throw badRequest('MISSING_TOKEN', 'توکن تازه‌سازی ارسال نشده است.');
    const session = await prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw unauthorized('نشست نامعتبر است. دوباره وارد شوید.');
    }
    const { claims } = await claimsFor(session.userId);
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
