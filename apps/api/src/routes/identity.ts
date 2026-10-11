import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  approveSignupSchema, permissionsForRoles, phoneStartSchema, phoneVerifySchema, rejectSignupSchema, signupSchema,
  signupSettingsSchema, type RoleCode,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { env, mailEnabled } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { organizationForHost, organizationForRequest, requestHost, tenancy } from '../lib/tenant.js';
import { appUrl, notify } from '../mail/notify.js';
import { enqueueMail } from '../jobs/runner.js';
import { grantsOf } from '../auth/grants.js';
import { issueSession, countFailure } from '../auth/session.js';
import { checkCode, issueCode } from '../auth/otp.js';
import { sendCode, smsAvailable } from '../auth/sms.js';
import { createTicket, finishGoogle, google, googleConfigured, redeemTicket, startGoogle } from '../auth/google.js';

/**
 * Signing in with a mobile number or a Google account, and asking to join (Hivamis task 4).
 *
 * Signing in proves who someone is; it never decides what they may do. A person who asks to join is
 * a request until the system administrator approves it, choosing the unit and roles themselves
 * (Hivamis task 6) — so nobody gets in by signing up.
 */

/**
 * A mobile number is not unique across organisations; at one organisation's address, signing in by
 * code looks only among its people (roadmap #50).
 */
async function hereOnly(req: FastifyRequest): Promise<{ organizationId?: string }> {
  if (tenancy.mode !== 'multi') return {};
  const here = await organizationForHost(requestHost(req));
  return here ? { organizationId: here.id } : {};
}

/** What a sign-up-created account's password hash starts as: it can never verify. */
export const NO_PASSWORD_PREFIX = '!no-password:';
export const hasPassword = (hash: string) => !hash.startsWith('!');

/** Joining is open unless the administrator closed it; there must also be a way to prove oneself. */
async function signupState(req: FastifyRequest, organizationId?: string | null) {
  // The organisation of the address the person came to (roadmap #50); after Google, the one the
  // sign-in began in — Google returns to the installation's one address.
  const org = organizationId
    ? await prisma.organization.findFirst({ where: { id: organizationId, isActive: true }, select: { id: true, name: true, slug: true, settings: true } })
    : await organizationForRequest(req);
  if (!org) throw notFound('سازمان');
  const settings = (org.settings ?? {}) as { signup?: { enabled?: boolean } };
  const open = settings.signup?.enabled !== false;
  return { org, open, phone: open && smsAvailable(), google: open && googleConfigured() };
}

async function notifyAdmins(organizationId: string, title: string, body: string, entityId: string) {
  const grants = await grantsOf(organizationId);
  const people = await prisma.user.findMany({
    where: { organizationId, isActive: true, deletedAt: null },
    select: { id: true, roles: { select: { role: { select: { code: true } } } } },
  });
  for (const p of people) {
    const perms = permissionsForRoles(p.roles.map((r) => r.role.code as RoleCode), grants.map);
    if (perms.includes('admin.users')) await notify({ userId: p.id, kind: 'SIGNUP_REQUESTED', title, body, entityType: 'signupRequest', entityId });
  }
}

const RATE = { rateLimit: { max: env.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } };
const SENT_FOR = 60;

const identityRoutes: FastifyPluginAsync = async (app) => {
  /** Which ways in this installation offers — the sign-in and sign-up pages ask before drawing. */
  app.get('/auth/methods', async (req) => {
    const s = await signupState(req);
    return {
      organization: s.org.name, password: true, phone: smsAvailable(), google: googleConfigured(),
      signup: { open: s.open && (s.phone || s.google), phone: s.phone, google: s.google },
    };
  });

  /* ── by mobile ───────────────────────────────────────────────────────── */

  /**
   * Sends a code if the number belongs to an active person. The answer is the same either way, so
   * the page cannot be used to find out who has an account.
   */
  app.post('/auth/phone/start', { config: RATE }, async (req, reply) => {
    const { phone } = parse(phoneStartSchema, req.body);
    if (!smsAvailable()) throw new AppError(503, 'SMS_OFF', 'ورود با شمارهٔ همراه در این نصب فعال نیست.');
    const user = await prisma.user.findFirst({ where: { phone, phoneVerifiedAt: { not: null }, isActive: true, deletedAt: null, ...(await hereOnly(req)) } });
    if (user && !(user.lockedUntil && user.lockedUntil > new Date())) {
      const issued = await issueCode({ purpose: 'LOGIN', phone, userId: user.id, ipAddress: req.ip });
      // Sent in the background: waiting on the provider would make an existing number slower to answer.
      if ('code' in issued) void sendCode(phone, issued.code, 'LOGIN').catch((e) => req.log.warn({ err: e }, 'sms not sent'));
    }
    return reply.code(202).send({ sent: true, resendAfterSeconds: SENT_FOR });
  });

  app.post('/auth/phone/verify', { config: RATE }, async (req, reply) => {
    const { phone, code } = parse(phoneVerifySchema, req.body);
    const user = await prisma.user.findFirst({ where: { phone, phoneVerifiedAt: { not: null }, isActive: true, deletedAt: null, ...(await hereOnly(req)) } });
    if (!user) throw unauthorized('کد درست نیست یا منقضی شده است.');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw unauthorized('حساب کاربری موقتاً قفل شده است. چند دقیقه دیگر تلاش کنید.');
    const ok = await checkCode({ purpose: 'LOGIN', phone, code });
    if (!ok || ok.userId !== user.id) {
      await countFailure(user.id, req, 'phone-code');
      throw unauthorized('کد درست نیست یا منقضی شده است.');
    }
    return issueSession(user.id, req, reply, 'phone');
  });

  /* ── by Google ───────────────────────────────────────────────────────── */

  app.get('/auth/google/start', { config: RATE }, async (req) => {
    const { mode } = req.query as { mode?: string };
    if (mode === 'signup') {
      const s = await signupState(req);
      if (!s.google) throw new AppError(403, 'SIGNUP_CLOSED', 'درخواست عضویت با گوگل در این سازمان باز نیست.');
      return { url: await startGoogle('SIGNUP', null, s.org.id) };
    }
    return { url: await startGoogle('LOGIN') };
  });

  /** Where Google sends the browser back. It answers with a page address, never with a token. */
  app.get('/auth/google/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const back = (path: string, fragment: Record<string, string>) =>
      reply.redirect(`${appUrl(path)}#${new URLSearchParams(fragment).toString()}`);
    if (q.error || !q.code || !q.state) return back('/auth/google', { error: 'CANCELLED' });
    try {
      const { mode, userId, organizationId, profile } = await finishGoogle(q.code, q.state);
      return await googleOutcome(req, mode, userId, organizationId, profile, back);
    } catch (e) {
      return back('/auth/google', { error: e instanceof AppError ? e.code : 'GOOGLE_FAILED' });
    }
  });

  async function googleOutcome(
    req: FastifyRequest, mode: 'LOGIN' | 'SIGNUP' | 'LINK', linkUserId: string | null, organizationId: string | null,
    profile: { sub: string; email: string; name: string; domain: string },
    back: (path: string, fragment: Record<string, string>) => FastifyReply,
  ) {
    const ip = req.ip;
    const identity = await prisma.userIdentity.findUnique({ where: { provider_subject: { provider: 'google', subject: profile.sub } }, include: { user: true } });

    if (mode === 'LINK') {
      if (identity && identity.userId !== linkUserId) return back('/me', { error: 'LINKED_ELSEWHERE' });
      const me = await prisma.user.findUniqueOrThrow({ where: { id: linkUserId! } });
      if (!identity) {
        const made = await prisma.userIdentity.create({ data: { userId: me.id, provider: 'google', subject: profile.sub, email: profile.email } });
        await audit({ organizationId: me.organizationId, actorId: me.id, action: 'CREATE', entityType: 'userIdentity', entityId: made.id, after: { provider: 'google', email: profile.email }, reason: 'google linked', ipAddress: ip });
      }
      return back('/me', { linked: 'google' });
    }

    if (mode === 'LOGIN') {
      let user = identity?.user ?? null;
      if (!user) {
        // A verified Google address that is someone's work address: that someone, linked from now on.
        const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
        if (byEmail && byEmail.isActive && !byEmail.deletedAt) {
          const made = await prisma.userIdentity.create({ data: { userId: byEmail.id, provider: 'google', subject: profile.sub, email: profile.email } });
          await audit({ organizationId: byEmail.organizationId, actorId: byEmail.id, action: 'CREATE', entityType: 'userIdentity', entityId: made.id, after: { provider: 'google', email: profile.email }, reason: 'google linked at sign-in', ipAddress: ip });
          user = byEmail;
        }
      }
      if (!user || !user.isActive || user.deletedAt) return back('/auth/google', { error: 'NO_ACCOUNT' });
      if (user.lockedUntil && user.lockedUntil > new Date()) return back('/auth/google', { error: 'LOCKED' });
      await prisma.userIdentity.updateMany({ where: { provider: 'google', subject: profile.sub }, data: { lastUsedAt: new Date() } });
      return back('/auth/google', { ticket: await createTicket(user.id) });
    }

    // SIGNUP
    const s = await signupState(req, organizationId);
    if (!s.google) return back('/signup', { error: 'SIGNUP_CLOSED' });
    if (google.allowedDomains.length && !google.allowedDomains.includes(profile.domain)) return back('/signup', { error: 'DOMAIN' });
    if (identity || await prisma.user.findUnique({ where: { email: profile.email } })) return back('/signup', { error: 'HAS_ACCOUNT' });
    const pending = await prisma.signupRequest.findFirst({ where: { organizationId: s.org.id, email: profile.email, status: 'PENDING' } });
    if (pending) return back('/signup', { done: 'pending' });
    const request = await prisma.signupRequest.create({
      data: { organizationId: s.org.id, method: 'GOOGLE', fullName: profile.name.slice(0, 120), email: profile.email, googleSubject: profile.sub, ipAddress: ip },
    });
    await audit({ organizationId: s.org.id, actorId: null, action: 'CREATE', entityType: 'signupRequest', entityId: request.id, after: { method: 'GOOGLE', email: profile.email }, ipAddress: ip });
    await notifyAdmins(s.org.id, `درخواست عضویت: ${request.fullName}`, `${request.email} — با حساب گوگل`, request.id);
    return back('/signup', { done: 'sent' });
  }

  app.post('/auth/ticket', { config: RATE }, async (req, reply) => {
    const { ticket } = (req.body ?? {}) as { ticket?: string };
    const userId = typeof ticket === 'string' && ticket.length <= 100 ? await redeemTicket(ticket) : null;
    if (!userId) throw unauthorized('این پیوند ورود منقضی شده است؛ دوباره با گوگل وارد شوید.');
    return issueSession(userId, req, reply, 'google');
  });

  /* ── asking to join ──────────────────────────────────────────────────── */

  app.get('/auth/signup/options', async (req) => {
    const s = await signupState(req);
    const units = s.open
      ? await prisma.department.findMany({ where: { organizationId: s.org.id }, orderBy: { sortOrder: 'asc' }, select: { code: true, nameFa: true, nameEn: true } })
      : [];
    return { organization: s.org.name, open: s.open && (s.phone || s.google), phone: s.phone, google: s.google, units };
  });

  app.post('/auth/signup/phone/start', { config: RATE }, async (req, reply) => {
    const { phone } = parse(phoneStartSchema, req.body);
    if (!(await signupState(req)).phone) throw new AppError(403, 'SIGNUP_CLOSED', 'درخواست عضویت با شمارهٔ همراه در این سازمان باز نیست.');
    const issued = await issueCode({ purpose: 'SIGNUP', phone, ipAddress: req.ip });
    if (!('code' in issued)) throw new AppError(429, 'CODE_TOO_SOON', `کد تازه تا ${issued.retryAfterSeconds} ثانیهٔ دیگر.`, { retryAfterSeconds: issued.retryAfterSeconds });
    await sendCode(phone, issued.code, 'SIGNUP');
    return reply.code(202).send({ sent: true, resendAfterSeconds: SENT_FOR });
  });

  app.post('/auth/signup', { config: RATE }, async (req, reply) => {
    const input = parse(signupSchema, req.body);
    const s = await signupState(req);
    if (!s.phone) throw new AppError(403, 'SIGNUP_CLOSED', 'درخواست عضویت با شمارهٔ همراه در این سازمان باز نیست.');
    if (!(await checkCode({ purpose: 'SIGNUP', phone: input.phone, code: input.code }))) throw badRequest('BAD_CODE', 'کد درست نیست یا منقضی شده است.');
    // The number is proved now; only then say what stands in the way.
    if (await prisma.user.findUnique({ where: { email: input.email } })) throw conflict('EMAIL_TAKEN', 'با این ایمیل پیش‌تر حسابی ساخته شده است؛ وارد شوید.');
    if (await prisma.user.findFirst({ where: { phone: input.phone, phoneVerifiedAt: { not: null }, deletedAt: null } })) throw conflict('PHONE_TAKEN', 'این شمارهٔ همراه به حساب دیگری وصل است؛ با آن وارد شوید.');
    if (await prisma.signupRequest.findFirst({ where: { organizationId: s.org.id, email: input.email, status: 'PENDING' } })) throw conflict('ALREADY_PENDING', 'درخواست شما پیش‌تر ثبت شده و در انتظار تأیید مدیر سیستم است.');
    const request = await prisma.signupRequest.create({
      data: {
        organizationId: s.org.id, method: 'PHONE', fullName: input.fullName, email: input.email, phone: input.phone,
        departmentCode: input.departmentCode ?? null, note: input.note ?? null, ipAddress: req.ip,
      },
    });
    await audit({ organizationId: s.org.id, actorId: null, action: 'CREATE', entityType: 'signupRequest', entityId: request.id, after: { method: 'PHONE', email: input.email }, ipAddress: req.ip });
    await notifyAdmins(s.org.id, `درخواست عضویت: ${request.fullName}`, `${request.email} — ${request.phone}`, request.id);
    return reply.code(201).send({ status: 'PENDING' });
  });

  /* ── the administrator's queue ───────────────────────────────────────── */

  app.get('/signup-requests', { preHandler: [app.authenticate, app.requirePermissions('admin.users')] }, async (req) => {
    const actor = actorFrom(req);
    const { status } = req.query as { status?: string };
    return prisma.signupRequest.findMany({
      where: { organizationId: actor.organizationId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' }, take: 200,
      select: {
        id: true, method: true, fullName: true, email: true, phone: true, departmentCode: true, note: true, status: true,
        decidedAt: true, decisionNote: true, createdAt: true, decidedBy: { select: { fullName: true } }, userId: true,
      },
    });
  });

  app.post('/signup-requests/:id/approve', { preHandler: [app.authenticate, app.requirePermissions('admin.users')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(approveSignupSchema, req.body);
    const request = await prisma.signupRequest.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!request) throw notFound('درخواست عضویت');
    if (request.status !== 'PENDING') throw conflict('ALREADY_DECIDED', 'این درخواست پیش‌تر بررسی شده است.');
    if (await prisma.user.findUnique({ where: { email: request.email } })) throw conflict('EMAIL_TAKEN', 'با این ایمیل پیش‌تر حسابی ساخته شده است.');
    const department = await prisma.department.findFirst({ where: { organizationId: actor.organizationId, code: input.departmentCode } });
    if (!department) throw badRequest('UNKNOWN_DEPARTMENT', 'واحد سازمانی نامعتبر است.');
    const roles = await prisma.role.findMany({ where: { code: { in: input.roles } } });
    if (roles.length !== new Set(input.roles).size) throw badRequest('UNKNOWN_ROLE', 'نقش نامعتبر است.');

    const user = await prisma.$transaction(async (tx) => {
      if (request.phone && await tx.user.findFirst({ where: { phone: request.phone, phoneVerifiedAt: { not: null }, deletedAt: null } })) {
        throw conflict('PHONE_TAKEN', 'این شمارهٔ همراه در این فاصله به حساب دیگری وصل شده است.');
      }
      const made = await tx.user.create({
        data: {
          organizationId: actor.organizationId, departmentId: department.id, email: request.email, fullName: request.fullName,
          jobTitle: input.jobTitle ?? null, passwordHash: `${NO_PASSWORD_PREFIX}${randomBytes(16).toString('hex')}`,
          ...(request.phone ? { phone: request.phone, phoneVerifiedAt: new Date() } : {}),
          roles: { create: roles.map((r) => ({ roleId: r.id })) },
        },
      });
      if (request.googleSubject) await tx.userIdentity.create({ data: { userId: made.id, provider: 'google', subject: request.googleSubject, email: request.email } });
      // Decided once: a second approval racing this one finds it no longer pending, and its account rolls back.
      const taken = await tx.signupRequest.updateMany({
        where: { id, status: 'PENDING' }, data: { status: 'APPROVED', decidedAt: new Date(), decidedById: actor.id, userId: made.id },
      });
      if (taken.count !== 1) throw conflict('ALREADY_DECIDED', 'این درخواست پیش‌تر بررسی شده است.');
      return made;
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'APPROVE', entityType: 'signupRequest', entityId: id,
      after: { userId: user.id, departmentCode: input.departmentCode, roles: input.roles }, ipAddress: actor.ipAddress,
    });
    if (mailEnabled) {
      const how = request.method === 'PHONE' ? 'با همین شمارهٔ همراه' : 'با همان حساب گوگل';
      await enqueueMail({
        to: user.email, subject: 'حساب شما در هیوامیس آماده است',
        text: `${user.fullName} عزیز،\n\nدرخواست عضویت شما تأیید شد. ${how} وارد شوید:\n${appUrl('/')}`,
        html: `<div dir="rtl" style="font-family:Tahoma,sans-serif"><p>${user.fullName} عزیز،</p><p>درخواست عضویت شما تأیید شد. ${how} وارد شوید: <a href="${appUrl('/')}">${appUrl('/')}</a></p></div>`,
      }).catch(() => undefined);
    }
    return { id, status: 'APPROVED', userId: user.id };
  });

  app.post('/signup-requests/:id/reject', { preHandler: [app.authenticate, app.requirePermissions('admin.users')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { note } = parse(rejectSignupSchema, req.body);
    const taken = await prisma.signupRequest.updateMany({
      where: { id, organizationId: actor.organizationId, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: new Date(), decidedById: actor.id, decisionNote: note },
    });
    if (taken.count !== 1) {
      if (!(await prisma.signupRequest.findFirst({ where: { id, organizationId: actor.organizationId } }))) throw notFound('درخواست عضویت');
      throw conflict('ALREADY_DECIDED', 'این درخواست پیش‌تر بررسی شده است.');
    }
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'REJECT', entityType: 'signupRequest', entityId: id, reason: note, ipAddress: actor.ipAddress });
    return { id, status: 'REJECTED' };
  });

  app.get('/settings/signup', { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] }, async (req) => {
    // The administrator's own organisation, whatever address they came to.
    const s = await signupState(req, actorFrom(req).organizationId);
    return { enabled: s.open, phone: smsAvailable(), google: googleConfigured() };
  });

  app.patch('/settings/signup', { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] }, async (req) => {
    const actor = actorFrom(req);
    const { enabled } = parse(signupSettingsSchema, req.body);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
    const settings = { ...((org.settings ?? {}) as Record<string, unknown>), signup: { enabled } };
    await prisma.organization.update({ where: { id: org.id }, data: { settings } });
    await audit({ organizationId: org.id, actorId: actor.id, action: 'UPDATE', entityType: 'organization', entityId: org.id, after: { signup: { enabled } }, reason: 'sign-up', ipAddress: actor.ipAddress });
    return { enabled };
  });

  /** The SMS sandbox's messages, for whoever runs the installation, while no provider is set. */
  app.get('/admin/sms-outbox', { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] }, async () => {
    const messages = await prisma.smsMessage.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return { mode: env.SMS_MODE ?? (env.NODE_ENV === 'production' ? 'off' : 'sandbox'), messages };
  });
};

export default identityRoutes;
