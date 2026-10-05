import type { FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { generateRefreshToken, signAccessToken, ttlToMs } from './tokens.js';
import { claimsFor } from './claims.js';
import { assertSignInHere } from '../lib/tenant.js';

/** How a person proved who they are; recorded with every sign-in. */
export type SignInMethod = 'password' | 'phone' | 'google';

/**
 * A session for someone who has just proved who they are — by password, a code sent to their mobile,
 * or Google (Hivamis task 4). Every way in ends here, so each gets the same session, the same reset
 * of failed attempts and the same audit record, naming the method.
 */
export async function issueSession(userId: string, req: FastifyRequest, method: SignInMethod) {
  const { user, claims } = await claimsFor(userId);
  await assertSignInHere(req, user.organizationId);
  const refresh = generateRefreshToken();
  const [session] = await prisma.$transaction([
    prisma.session.create({
      data: {
        userId: user.id, refreshTokenHash: refresh.hash,
        userAgent: req.headers['user-agent'] ?? null, ipAddress: req.ip,
        expiresAt: new Date(Date.now() + ttlToMs(env.REFRESH_TOKEN_TTL)),
      },
    }),
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null } }),
  ]);
  await audit({
    organizationId: user.organizationId, actorId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id,
    reason: method === 'password' ? null : method, ipAddress: req.ip, userAgent: req.headers['user-agent'] ?? null,
  });
  return {
    accessToken: await signAccessToken({ ...claims, sid: session.id }),
    refreshToken: refresh.token,
    mustChangePassword: user.mustChangePassword,
    user: {
      id: user.id, email: user.email, fullName: user.fullName, jobTitle: user.jobTitle,
      departmentCode: claims.departmentCode, roles: claims.roles, permissions: claims.permissions,
      delegated: claims.delegated ?? {}, delegatedRoles: claims.delegatedRoles ?? {},
      locale: user.locale,
    },
  };
}

/** A failed proof counts against the account as a wrong password does; five lock it for a while. */
export async function countFailure(userId: string, req: FastifyRequest, reason: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true, failedLoginCount: true, lockedUntil: true } });
  if (!user) return;
  const failed = user.failedLoginCount + 1;
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : user.lockedUntil },
  });
  await audit({
    organizationId: user.organizationId, actorId: userId, action: 'LOGIN_FAILED', entityType: 'user', entityId: userId,
    reason, ipAddress: req.ip, userAgent: req.headers['user-agent'] ?? null,
  }).catch(() => undefined);
}

export const MAX_FAILED = 5;
export const LOCK_MS = 15 * 60_000;
