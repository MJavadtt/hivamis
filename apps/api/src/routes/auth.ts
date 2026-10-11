import type { FastifyPluginAsync } from 'fastify';
import { changePasswordSchema, loginSchema, updateLocaleSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { parse, actorFrom } from '../lib/http.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { generateRefreshToken, hashToken, signAccessToken, ttlToMs } from '../auth/tokens.js';
import { audit } from '../lib/audit.js';
import { env } from '../env.js';
import { claimsFor } from '../auth/claims.js';
import { issueSession, countFailure, endSessions } from '../auth/session.js';
import { forgetStanding } from '../auth/standing.js';

/** Kept here for the messenger, which imported it from this module before it moved (Hivamis task 4). */
export { claimsFor };

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/login', {
    config: { rateLimit: { max: env.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  }, async (req) => {
    const { email, password } = parse(loginSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Uniform failure response — never reveal whether the address exists.
    const fail = async (reason: string) => {
      if (user) await countFailure(user.id, req, reason);
      throw unauthorized('ایمیل یا رمز عبور نادرست است');
    };

    if (!user || !user.isActive || user.deletedAt) return fail('inactive-or-missing');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw unauthorized('حساب کاربری موقتاً قفل شده است. چند دقیقه دیگر تلاش کنید.');
    }
    if (!(await verifyPassword(user.passwordHash, password))) return fail('bad-password');

    return issueSession(user.id, req, 'password');
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
    // Ended on purpose — signed out, a password or role change, a delegation's end: simply over.
    // Only a token rotated away (or one from before reasons were kept) means someone kept a copy.
    if (session.revokedAt && session.revokedReason && session.revokedReason !== 'ROTATED') {
      throw unauthorized('نشست نامعتبر است. دوباره وارد شوید.');
    }
    const reused = async () => {
      const { count } = await prisma.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'REUSE' },
      });
      forgetStanding(session.userId);
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
      return unauthorized('نشست نامعتبر است. دوباره وارد شوید.');
    };
    if (session.revokedAt) throw await reused();

    if (session.expiresAt < new Date()) {
      throw unauthorized('نشست نامعتبر است. دوباره وارد شوید.');
    }

    const { user: sessionUser, claims } = await claimsFor(session.userId);
    // Login rejects a deactivated or deleted user; refresh must agree, or a revoked employee
    // keeps minting access tokens until the refresh token expires days later.
    if (!sessionUser.isActive || sessionUser.deletedAt) {
      await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: 'DEACTIVATED' } });
      forgetStanding(session.userId);
      throw unauthorized('نشست نامعتبر است. دوباره وارد شوید.');
    }
    // Rotate: the presented refresh token is single-use — and only one request may spend it. Two
    // presenting it at once both read it as live; the rotation itself decides, so the second is the
    // replay it is, rather than a second session minted from the same token (Hivamis task 10).
    const next = generateRefreshToken();
    const rotated = await prisma.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'ROTATED' },
      });
      if (!count) return null;
      return tx.session.create({
        data: {
          userId: session.userId, familyId: session.familyId, refreshTokenHash: next.hash,
          userAgent: req.headers['user-agent'] ?? null, ipAddress: req.ip,
          expiresAt: new Date(Date.now() + ttlToMs(env.REFRESH_TOKEN_TTL)),
        },
      });
    });
    if (!rotated) throw await reused();
    return { accessToken: await signAccessToken({ ...claims, sid: rotated.id }), refreshToken: next.token };
  });

  app.post('/auth/logout', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };
    if (refreshToken) {
      await prisma.session.updateMany({
        // Only a live one: a token already rotated away keeps its reason, and with it reuse detection.
        where: { refreshTokenHash: hashToken(refreshToken), userId: actor.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'SIGNED_OUT' },
      });
    } else {
      await prisma.session.updateMany({
        where: { userId: actor.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'SIGNED_OUT' },
      });
    }
    forgetStanding(actor.id);
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
    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
      // Re-authentication everywhere, this device included: the tokens stop now, not in fifteen minutes.
      await endSessions(tx, user.id, 'PASSWORD_CHANGED');
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
        entityType: 'user', entityId: actor.id, reason: 'password changed', ipAddress: actor.ipAddress,
      }, tx);
    });
    return reply.code(204).send();
  });
};

export default authRoutes;
