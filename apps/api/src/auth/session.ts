import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma, type Tx } from '../db.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { generateRefreshToken, signAccessToken, ttlToMs } from './tokens.js';
import { claimsFor } from './claims.js';
import { assertSignInHere } from '../lib/tenant.js';
import { forgetStanding } from './standing.js';
import { setRefreshCookie } from './cookie.js';
import { recordFailure } from './throttle.js';

/** How a person proved who they are; recorded with every sign-in. */
export type SignInMethod = 'password' | 'phone' | 'google' | 'telegram';

/**
 * A session for someone who has just proved who they are — by password, a code sent to their mobile,
 * Google (Hivamis task 4), or the Telegram Mini App (audit F-9). Every way in ends here, so each gets the same session, the same reset
 * of failed attempts and the same audit record, naming the method.
 */
export async function issueSession(userId: string, req: FastifyRequest, reply: FastifyReply, method: SignInMethod) {
  const { user, claims } = await claimsFor(userId);
  await assertSignInHere(req, user.organizationId);
  const refresh = generateRefreshToken();
  // A sign-in starts a family; every rotation of it carries the same id (audit SEC-3).
  const id = randomUUID();
  const [session] = await prisma.$transaction([
    prisma.session.create({
      data: {
        id, familyId: id, userId: user.id, refreshTokenHash: refresh.hash,
        userAgent: req.headers['user-agent'] ?? null, ipAddress: req.ip,
        expiresAt: new Date(Date.now() + ttlToMs(env.REFRESH_TOKEN_TTL)),
      },
    }),
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
  ]);
  await audit({
    organizationId: user.organizationId, actorId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id,
    reason: method === 'password' ? null : method, ipAddress: req.ip, userAgent: req.headers['user-agent'] ?? null,
  });
  // The refresh token goes to a cookie the page cannot read, never into the body (audit SEC-4).
  setRefreshCookie(reply, refresh.token);
  return {
    accessToken: await signAccessToken({ ...claims, sid: session.id }),
    mustChangePassword: user.mustChangePassword,
    user: {
      id: user.id, email: user.email, fullName: user.fullName, jobTitle: user.jobTitle,
      departmentCode: claims.departmentCode, roles: claims.roles, permissions: claims.permissions,
      delegated: claims.delegated ?? {}, delegatedRoles: claims.delegatedRoles ?? {},
      locale: user.locale,
    },
  };
}

/**
 * A wrong password or code. Its network slows down for what was typed (audit SEC-10) — the account is
 * not locked — and when it was someone's account, the audit trail says so, for the detectors that
 * raise an alert on an account tried from everywhere.
 */
export async function countFailure(identifier: string, req: FastifyRequest, user: { id: string; organizationId: string } | null, reason: string): Promise<void> {
  await recordFailure(identifier, req.ip);
  if (!user) return;
  await audit({
    organizationId: user.organizationId, actorId: user.id, action: 'LOGIN_FAILED', entityType: 'user', entityId: user.id,
    reason, ipAddress: req.ip, userAgent: req.headers['user-agent'] ?? null,
  }).catch(() => undefined);
}

/**
 * Deactivates one account and ends its sessions, with the audit row in the same transaction. The
 * admin route and `demo:deactivate` both come here, so the two cannot drift apart.
 */
export async function deactivateUser(
  tx: Tx,
  user: { id: string; organizationId: string },
  actor: { id: string | null; ipAddress?: string | null; requestId?: string | null },
  reason: string,
): Promise<void> {
  await tx.user.update({ where: { id: user.id }, data: { isActive: false } });
  await endSessions(tx, user.id, 'DEACTIVATED');
  await audit({
    organizationId: user.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: user.id,
    before: { isActive: true }, after: { isActive: false }, reason, ipAddress: actor.ipAddress, requestId: actor.requestId,
  }, tx);
}

/**
 * Audit SEC-3: everything this person holds stops now — their sessions end, and every access token they
 * carry is dated by a new `authVersion`. A role change, a deactivation, a password change and a
 * delegation's end all come here.
 */
export async function endSessions(tx: Tx, userId: string, reason: string): Promise<number> {
  await tx.user.update({ where: { id: userId }, data: { authVersion: { increment: 1 } } });
  const { count } = await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  forgetStanding(userId);
  return count;
}
