import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { OVERSIGHT_GRANTOR_ROLE } from '@hiva/contracts';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { notify } from '../mail/notify.js';
import { claimsFor } from './claims.js';
import { forgetStanding } from './standing.js';
import { generateRefreshToken, signAccessToken, type AccessTokenClaims } from './tokens.js';

/**
 * The system administrator working in someone's account (owner's report, 2026-10-23): seeing what
 * they see and doing what they would — a task, an approval, a form — when they cannot.
 *
 * Openly, never covertly. The administrator gives a reason; the person is told; the session lasts
 * half an hour and is never refreshed; the screen says whose account it is the whole time; and every
 * audit row written under it names the administrator as who was at the keyboard. What only the person
 * may do — their password, sign-ins, signature, private conversations — stays theirs (auth plugin).
 */

export const ACTING_MINUTES = 30;

export async function startActing(req: FastifyRequest, admin: AccessTokenClaims, targetId: string, reason: string) {
  // In their own right: a system administrator's role lent by delegation does not reach this.
  if (!admin.roles.includes(OVERSIGHT_GRANTOR_ROLE) || admin.delegatedRoles?.[OVERSIGHT_GRANTOR_ROLE] || admin.apiKeyId) {
    throw forbidden('کار در حساب دیگران فقط با مدیر سیستم است.');
  }
  if (admin.imp) throw badRequest('ALREADY_ACTING', 'اکنون در حساب کس دیگری هستید؛ نخست به حساب خودتان برگردید.');
  if (targetId === admin.sub) throw badRequest('SELF', 'این حساب خودتان است.');
  const target = await prisma.user.findFirst({
    where: { id: targetId, organizationId: admin.organizationId, deletedAt: null },
    select: { id: true, fullName: true, isActive: true, roles: { select: { role: { select: { code: true } } } } },
  });
  if (!target) throw notFound('کاربر');
  if (!target.isActive) throw badRequest('INACTIVE', 'این حساب غیرفعال است.');
  // One administrator's work is not done in another's account: each answers in their own name.
  if (target.roles.some((r) => r.role.code === OVERSIGHT_GRANTOR_ROLE)) {
    throw new AppError(403, 'NOT_ANOTHER_ADMIN', 'در حساب مدیر سیستم دیگری نمی‌توان کار کرد.');
  }

  const { claims } = await claimsFor(target.id);
  const id = randomUUID();
  // A refresh token nobody holds: the session ends when its access token does.
  const session = await prisma.session.create({
    data: {
      id, familyId: id, userId: target.id, impersonatorId: admin.sub, refreshTokenHash: generateRefreshToken().hash,
      userAgent: req.headers['user-agent'] ?? null, ipAddress: req.ip,
      expiresAt: new Date(Date.now() + ACTING_MINUTES * 60_000),
    },
  });
  await audit({
    organizationId: admin.organizationId, actorId: admin.sub, action: 'ACT_AS_STARTED', entityType: 'user', entityId: target.id,
    reason, ipAddress: req.ip, userAgent: req.headers['user-agent'] ?? null, requestId: req.id,
    after: { sessionId: session.id, until: session.expiresAt },
  });
  const by = await prisma.user.findUnique({ where: { id: admin.sub }, select: { fullName: true } });
  await notify({
    userId: target.id, kind: 'ACCOUNT_ACTED_IN', severity: 'WARNING', entityType: 'user', entityId: target.id,
    title: `مدیر سیستم، ${by?.fullName ?? ''}، در حساب شما کار می‌کند`,
    body: `دلیل: ${reason}. هر کاری که در این مدت انجام شود با نام ایشان در سابقه ثبت می‌شود.`,
  });
  return {
    accessToken: await signAccessToken({ ...claims, sid: session.id, imp: admin.sub }, `${ACTING_MINUTES}m`),
    until: session.expiresAt,
    user: { id: target.id, fullName: target.fullName },
  };
}

export async function endActing(req: FastifyRequest, claims: AccessTokenClaims): Promise<void> {
  if (!claims.imp || !claims.sid) throw badRequest('NOT_ACTING', 'اکنون در حساب کس دیگری نیستید.');
  await prisma.session.updateMany({ where: { id: claims.sid, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'ACT_AS_ENDED' } });
  forgetStanding(claims.sub);
  await audit({
    organizationId: claims.organizationId, actorId: claims.imp, action: 'ACT_AS_ENDED', entityType: 'user', entityId: claims.sub,
    ipAddress: req.ip, userAgent: req.headers['user-agent'] ?? null, requestId: req.id,
  });
}

/** For the screen: whose keyboard it is, and until when — or null in one's own account. */
export async function actingFor(claims: AccessTokenClaims | undefined) {
  if (!claims?.imp || !claims.sid) return null;
  const [admin, session] = await Promise.all([
    prisma.user.findUnique({ where: { id: claims.imp }, select: { id: true, fullName: true } }),
    prisma.session.findUnique({ where: { id: claims.sid }, select: { expiresAt: true } }),
  ]);
  return admin && session ? { by: admin, until: session.expiresAt } : null;
}
