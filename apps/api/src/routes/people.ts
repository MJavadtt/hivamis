import type { FastifyPluginAsync } from 'fastify';
import { phoneStartSchema, phoneVerifySchema, setPasswordSchema, unitColor } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { forgetStanding } from '../auth/standing.js';
import { setOAuthCookie } from '../auth/cookie.js';
import { hashPassword } from '../auth/password.js';
import { checkCode, issueCode } from '../auth/otp.js';
import { sendCode, smsAvailable } from '../auth/sms.js';
import { googleConfigured, startGoogle } from '../auth/google.js';
import { hasPassword } from './identity.js';

/**
 * A page for every person, and one's own page (Hivamis task 4).
 *
 * Anyone signed in sees who a colleague is — name, title, unit, roles, email — and, where their own
 * permissions allow, what that colleague is working on. A mobile number, the last sign-in and the
 * sign-in methods are for the person themselves and the administrators of users only.
 */

const DONE_TASK_STATES = ['APPROVED', 'CLOSED', 'CANCELLED'];

const unitOf = (d: { code: string; nameFa: string; nameEn: string; tagColor: string | null } | null) =>
  d ? { code: d.code, nameFa: d.nameFa, nameEn: d.nameEn, color: unitColor(d.code, d.tagColor) } : null;

/** At least one way in must remain: a password, a verified mobile, or a linked account. */
function waysIn(u: { passwordHash: string; phoneVerifiedAt: Date | null }, identities: number) {
  return (hasPassword(u.passwordHash) ? 1 : 0) + (u.phoneVerifiedAt ? 1 : 0) + identities;
}

const peopleRoutes: FastifyPluginAsync = async (app) => {
  app.get('/people', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { q } = req.query as { q?: string };
    const term = q?.trim();
    const people = await prisma.user.findMany({
      where: {
        organizationId: actor.organizationId, isActive: true, deletedAt: null,
        ...(term ? { OR: [{ fullName: { contains: term, mode: 'insensitive' } }, { jobTitle: { contains: term, mode: 'insensitive' } }, { email: { contains: term, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { fullName: 'asc' }, take: 500,
      select: { id: true, fullName: true, jobTitle: true, email: true, department: { select: { code: true, nameFa: true, nameEn: true, tagColor: true } } },
    });
    return people.map((p) => ({ ...p, department: unitOf(p.department) }));
  });

  app.get('/people/:id', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const person = await prisma.user.findFirst({
      where: { id, organizationId: actor.organizationId, deletedAt: null },
      include: { department: true, roles: { include: { role: true } } },
    });
    if (!person) throw notFound('شخص');
    const self = person.id === actor.id;
    const admin = actor.permissions.includes('admin.users');
    const now = new Date();

    const canTasks = actor.permissions.includes('task.read');
    const canProjects = actor.permissions.includes('project.read');
    const openWhere = { assigneeId: person.id, organizationId: actor.organizationId, state: { notIn: DONE_TASK_STATES } };
    const [openTasks, overdueTasks, tasks, allocations] = await Promise.all([
      canTasks ? prisma.task.count({ where: openWhere }) : null,
      canTasks ? prisma.task.count({ where: { ...openWhere, dueDate: { lt: now } } }) : null,
      canTasks ? prisma.task.findMany({ where: openWhere, orderBy: [{ dueDate: 'asc' }], take: 8, select: { id: true, code: true, title: true, state: true, dueDate: true } }) : [],
      canProjects ? prisma.allocation.findMany({
        where: { userId: person.id, toDate: { gte: now } }, orderBy: { fromDate: 'asc' },
        select: { project: { select: { id: true, code: true, name: true, state: true } } },
      }) : [],
    ]);

    return {
      id: person.id, fullName: person.fullName, jobTitle: person.jobTitle, email: person.email, isActive: person.isActive,
      joinedAt: person.createdAt, department: unitOf(person.department),
      roles: person.roles.map((r) => r.role.code),
      self,
      // For the person and for whoever manages users, not for every colleague.
      private: self || admin ? { phone: person.phone, phoneVerified: !!person.phoneVerifiedAt, lastLoginAt: person.lastLoginAt } : null,
      work: {
        openTasks, overdueTasks, tasks: canTasks ? tasks : null,
        projects: canProjects ? [...new Map(allocations.map((a) => [a.project.id, a.project])).values()] : null,
      },
    };
  });

  /** One's own sign-in methods and devices. */
  app.get('/me/profile', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const sid = req.user?.sid;
    // This device is its sign-in, whichever rotation of it the token was issued for (audit SEC-3).
    const family = sid ? (await prisma.session.findUnique({ where: { id: sid }, select: { familyId: true } }))?.familyId : undefined;
    const me = await prisma.user.findUniqueOrThrow({
      where: { id: actor.id },
      include: { identities: { orderBy: { createdAt: 'asc' } }, sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } } },
    });
    return {
      id: me.id, phone: me.phone, phoneVerified: !!me.phoneVerifiedAt, hasPassword: hasPassword(me.passwordHash),
      identities: me.identities.map((i) => ({ id: i.id, provider: i.provider, email: i.email, createdAt: i.createdAt, lastUsedAt: i.lastUsedAt })),
      sessions: me.sessions.map((s) => ({ id: s.id, userAgent: s.userAgent, ipAddress: s.ipAddress, createdAt: s.createdAt, current: s.familyId === family })),
      available: { phone: smsAvailable(), google: googleConfigured() },
    };
  });

  app.post('/me/phone/start', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { phone } = parse(phoneStartSchema, req.body);
    if (!smsAvailable()) throw new AppError(503, 'SMS_OFF', 'ارسال پیامک در این نصب خاموش است.');
    const owner = await prisma.user.findFirst({ where: { phone, phoneVerifiedAt: { not: null }, deletedAt: null } });
    if (owner && owner.id !== actor.id) throw conflict('PHONE_TAKEN', 'این شمارهٔ همراه به حساب دیگری وصل است.');
    const issued = await issueCode({ purpose: 'VERIFY_PHONE', phone, userId: actor.id, ipAddress: actor.ipAddress });
    if (!('code' in issued)) throw new AppError(429, 'CODE_TOO_SOON', `کد تازه تا ${issued.retryAfterSeconds} ثانیهٔ دیگر.`, { retryAfterSeconds: issued.retryAfterSeconds });
    await sendCode(phone, issued.code, 'VERIFY_PHONE');
    return reply.code(202).send({ sent: true });
  });

  app.post('/me/phone/verify', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { phone, code } = parse(phoneVerifySchema, req.body);
    const ok = await checkCode({ purpose: 'VERIFY_PHONE', phone, code });
    if (!ok || ok.userId !== actor.id) throw badRequest('BAD_CODE', 'کد درست نیست یا منقضی شده است.');
    const before = await prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { phone: true } });
    try {
      await prisma.user.update({ where: { id: actor.id }, data: { phone, phoneVerifiedAt: new Date() } });
    } catch {
      // The partial unique index: someone else verified it in between.
      throw conflict('PHONE_TAKEN', 'این شمارهٔ همراه به حساب دیگری وصل است.');
    }
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: actor.id, before: { phone: before.phone }, after: { phone, phoneVerified: true }, reason: 'mobile verified', ipAddress: actor.ipAddress });
    return { phone, phoneVerified: true };
  });

  app.delete('/me/phone', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const me = await prisma.user.findUniqueOrThrow({ where: { id: actor.id }, include: { _count: { select: { identities: true } } } });
    if (!me.phoneVerifiedAt) return { phone: me.phone, phoneVerified: false };
    if (waysIn(me, me._count.identities) <= 1) throw conflict('LAST_WAY_IN', 'این تنها راه ورود شماست؛ نخست رمز عبور بگذارید یا حساب دیگری وصل کنید.');
    await prisma.user.update({ where: { id: actor.id }, data: { phoneVerifiedAt: null } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: actor.id, before: { phoneVerified: true }, after: { phoneVerified: false }, reason: 'mobile sign-in removed', ipAddress: actor.ipAddress });
    return { phone: me.phone, phoneVerified: false };
  });

  app.post('/me/google/link', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const started = await startGoogle('LINK', actor.id);
    // Audit SEC-5: Google's answer is honoured only in the browser that asked.
    setOAuthCookie(reply, started.binding);
    return { url: started.url };
  });

  app.delete('/me/identities/:id', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const me = await prisma.user.findUniqueOrThrow({ where: { id: actor.id }, include: { identities: true } });
    const identity = me.identities.find((i) => i.id === id);
    if (!identity) throw notFound('حساب وصل‌شده');
    if (waysIn(me, me.identities.length) <= 1) throw conflict('LAST_WAY_IN', 'این تنها راه ورود شماست؛ نخست رمز عبور بگذارید یا شمارهٔ همراه را تأیید کنید.');
    await prisma.userIdentity.delete({ where: { id } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: 'userIdentity', entityId: id, before: { provider: identity.provider, email: identity.email }, reason: 'account unlinked', ipAddress: actor.ipAddress });
    return { id, removed: true };
  });

  /** A first password for someone who joined with a mobile or Google; changing one goes through change-password. */
  app.post('/me/password', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { newPassword } = parse(setPasswordSchema, req.body);
    const me = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (hasPassword(me.passwordHash)) throw conflict('HAS_PASSWORD', 'رمز عبور پیش‌تر گذاشته شده است؛ برای تغییر آن، رمز فعلی لازم است.');
    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
      // A first way in by password, not a changed one: nothing anyone holds loses its footing.
      await tx.user.update({ where: { id: actor.id }, data: { passwordHash, mustChangePassword: false } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: actor.id, reason: 'first password set', ipAddress: actor.ipAddress }, tx);
    });
    return reply.code(204).send();
  });

  app.delete('/me/sessions/:id', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const done = await prisma.session.updateMany({ where: { id, userId: actor.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'SIGNED_OUT' } });
    if (done.count !== 1) throw notFound('نشست');
    forgetStanding(actor.id);
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'LOGOUT', entityType: 'user', entityId: actor.id, reason: 'device signed out', after: { sessionId: id }, ipAddress: actor.ipAddress });
    return { id, revoked: true };
  });

  app.post('/me/sessions/revoke-others', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const sid = req.user?.sid;
    // Every sign-in but this device's — matched by family, since another tab may have rotated it since.
    const family = sid ? (await prisma.session.findUnique({ where: { id: sid }, select: { familyId: true } }))?.familyId : undefined;
    const done = await prisma.session.updateMany({ where: { userId: actor.id, revokedAt: null, ...(family ? { familyId: { not: family } } : {}) }, data: { revokedAt: new Date(), revokedReason: 'SIGNED_OUT' } });
    forgetStanding(actor.id);
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'LOGOUT', entityType: 'user', entityId: actor.id, reason: 'other devices signed out', after: { revoked: done.count }, ipAddress: actor.ipAddress });
    return { revoked: done.count };
  });
};

export default peopleRoutes;
