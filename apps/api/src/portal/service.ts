/**
 * The client portal (roadmap #34): a client contact signs in and sees their company's projects —
 * progress, milestones, deliverables as they read from outside, the approvals waiting on them
 * (#35), the weekly reports in their client version (#37), the files Account chose to share, their
 * invoices, and a conversation with Account on each project.
 *
 * Every read here is scoped to the signed-in account's company in its organisation; nothing takes
 * an organisation or a company from the request. What reaches the client is chosen field by field
 * — no cost, margin, internal notes, unit codes or staff workload.
 */
import { stateLabelFa } from '@hiva/contracts';
import { prisma } from '../db.js';
import { AppError, conflict, notFound, unauthorized } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { hashToken } from '../auth/tokens.js';
import { audit } from '../lib/audit.js';
import { clientMail } from '../mail/client.js';
import { esc } from '../pdf/fmt.js';
import { formatJalali } from '../lib/jalali.js';
import { env } from '../env.js';
import { invitationToken, signPortalToken } from './auth.js';

const DAY = 86_400_000;
const INVITE_DAYS = 7;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;
/** A project the client knows about: authorised onward, and not withdrawn. */
export const PORTAL_PROJECT_STATES = ['AUTHORIZED', 'PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'PENDING_CLOSURE', 'CLOSED'];

const appUrl = () => (env.PUBLIC_APP_URL || env.CORS_ORIGIN.split(',')[0]!.trim()).replace(/\/+$/, '');
export const inviteLink = (token: string) => `${appUrl()}/portal/invite/${token}`;

export interface StaffActor { id: string; organizationId: string; ipAddress?: string | null; requestId?: string | null }
type PortalAccount = Awaited<ReturnType<typeof import('./auth.js').portalUser>>;

/* ── staff: who may use the portal ─────────────────────────────────────────── */

async function sendInvite(u: { email: string }, contactName: string, org: string, token: string) {
  await clientMail.deliver({
    to: u.email, subject: `دعوت به پورتال مشتری ${org}`,
    html: `<div dir="rtl"><p>${esc(contactName)} گرامی،</p><p>${esc(org)} برای شما حسابی در پورتال مشتری ساخته است: پیشرفت پروژه‌ها، خروجی‌هایی که منتظر نظر شما هستند، گزارش‌ها و فایل‌ها در یک جا.</p>
<p><a href="${esc(inviteLink(token))}">تعیین رمز عبور و ورود</a> — این پیوند ${INVITE_DAYS} روز معتبر است.</p></div>`,
    text: `${contactName} گرامی،\n${org} برای شما حسابی در پورتال مشتری ساخته است.\n${inviteLink(token)}`,
  });
}

/** Invite a contact — or invite them again, which also serves as a password reset. */
export async function invite(actor: StaffActor, contactId: string) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, deletedAt: null, company: { organizationId: actor.organizationId, deletedAt: null } },
    include: { company: { select: { id: true } }, portalUser: true },
  });
  if (!contact) throw notFound('مخاطب');
  if (!contact.email) throw new AppError(422, 'PORTAL_CONTACT_EMAIL', `برای «${contact.fullName}» ایمیلی ثبت نشده است؛ نام کاربری پورتال همان ایمیل است.`);
  const email = contact.email.trim().toLowerCase();
  const clash = await prisma.portalUser.findUnique({ where: { email } });
  if (clash && clash.contactId !== contact.id) throw conflict('PORTAL_EMAIL_TAKEN', `نشانی ${email} پیش‌تر برای مخاطب دیگری در پورتال ثبت شده است.`);
  const { token, hash } = invitationToken();
  const data = {
    email, status: 'INVITED', passwordHash: null, inviteTokenHash: hash, inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * DAY),
    invitedById: actor.id, failedLogins: 0, lockedUntil: null,
  };
  const user = contact.portalUser
    ? await prisma.portalUser.update({ where: { id: contact.portalUser.id }, data: { ...data, tokenVersion: { increment: 1 } } })
    : await prisma.portalUser.create({ data: { ...data, organizationId: actor.organizationId, companyId: contact.company.id, contactId: contact.id } });
  await audit({
    organizationId: actor.organizationId, actorId: actor.id, action: contact.portalUser ? 'PORTAL_REINVITED' : 'PORTAL_INVITED',
    entityType: 'portalUser', entityId: user.id, after: { email, contactId }, ipAddress: actor.ipAddress, requestId: actor.requestId,
  });
  const mailed = clientMail.enabled();
  if (mailed) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { name: true } });
    await sendInvite(user, contact.fullName, org.name, token);
  }
  // With mail off the link is handed over once, as with approval links (#35).
  return { user: publicUser(user), link: mailed ? null : inviteLink(token) };
}

export async function disable(actor: StaffActor, id: string) {
  const u = await prisma.portalUser.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!u) throw notFound('حساب پورتال');
  const updated = await prisma.portalUser.update({ where: { id }, data: { status: 'DISABLED', inviteTokenHash: null, inviteExpiresAt: null, tokenVersion: { increment: 1 } } });
  await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'PORTAL_DISABLED', entityType: 'portalUser', entityId: id, ipAddress: actor.ipAddress, requestId: actor.requestId });
  return publicUser(updated);
}

export const publicUser = <T extends { passwordHash: string | null; inviteTokenHash: string | null }>(u: T) => {
  const { passwordHash: _p, inviteTokenHash: _i, ...rest } = u;
  return rest;
};

/* ── the client: accept, sign in ───────────────────────────────────────────── */

export async function accept(token: string, password: string, ip: string | null) {
  const u = await prisma.portalUser.findUnique({ where: { inviteTokenHash: hashToken(token) } });
  if (!u || u.status === 'DISABLED' || !u.inviteExpiresAt || u.inviteExpiresAt <= new Date()) {
    throw new AppError(410, 'PORTAL_INVITE_INVALID', 'این دعوت‌نامه معتبر نیست یا مهلتش گذشته است؛ از مدیر اکانت خود دعوت تازه بخواهید.');
  }
  const updated = await prisma.portalUser.update({
    where: { id: u.id },
    data: { passwordHash: await hashPassword(password), status: 'ACTIVE', inviteTokenHash: null, inviteExpiresAt: null, tokenVersion: { increment: 1 }, lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null },
  });
  await audit({ organizationId: u.organizationId, actorId: null, action: 'PORTAL_ACTIVATED', entityType: 'portalUser', entityId: u.id, ipAddress: ip });
  return { token: await signPortalToken({ sub: updated.id, organizationId: updated.organizationId, companyId: updated.companyId, v: updated.tokenVersion }) };
}

export async function login(email: string, password: string, ip: string | null, userAgent: string | null) {
  const u = await prisma.portalUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  // One answer for every failure: whether an address has an account is not the caller's business.
  const fail = async (reason: string) => {
    if (u) {
      const failed = u.failedLogins + 1;
      await prisma.portalUser.update({ where: { id: u.id }, data: { failedLogins: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS) : u.lockedUntil } });
      await audit({ organizationId: u.organizationId, actorId: null, action: 'PORTAL_LOGIN_FAILED', entityType: 'portalUser', entityId: u.id, reason, ipAddress: ip, userAgent }).catch(() => undefined);
    }
    throw unauthorized('ایمیل یا رمز عبور نادرست است');
  };
  if (!u || u.status !== 'ACTIVE' || !u.passwordHash) return fail('inactive-or-missing');
  if (u.lockedUntil && u.lockedUntil > new Date()) throw unauthorized('حساب موقتاً قفل شده است. چند دقیقه دیگر تلاش کنید.');
  if (!(await verifyPassword(u.passwordHash, password))) return fail('bad-password');
  await prisma.portalUser.update({ where: { id: u.id }, data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null } });
  await audit({ organizationId: u.organizationId, actorId: null, action: 'PORTAL_LOGIN', entityType: 'portalUser', entityId: u.id, ipAddress: ip, userAgent });
  return { token: await signPortalToken({ sub: u.id, organizationId: u.organizationId, companyId: u.companyId, v: u.tokenVersion }) };
}

/* ── the client's views ────────────────────────────────────────────────────── */

const projectScope = (p: PortalAccount) => ({ organizationId: p.organizationId, companyId: p.companyId, deletedAt: null, state: { in: PORTAL_PROJECT_STATES } });

export async function visibleProject(p: PortalAccount, id: string) {
  const project = await prisma.project.findFirst({ where: { id, ...projectScope(p) } });
  if (!project) throw notFound('پروژه');
  return project;
}

const pendingFor = (p: PortalAccount) => ({ companyId: p.companyId, status: 'PENDING', expiresAt: { gt: new Date() } });

export async function home(p: PortalAccount) {
  const projects = await prisma.project.findMany({
    where: projectScope(p), orderBy: { createdAt: 'desc' },
    select: { id: true, code: true, name: true, state: true, plannedStart: true, plannedEnd: true, milestones: { select: { completedAt: true } } },
  });
  const approvals = await prisma.clientApproval.findMany({ where: pendingFor(p), orderBy: { createdAt: 'asc' }, select: { id: true, code: true, subjectType: true, manifest: true, contactId: true, expiresAt: true } });
  const invoices = await prisma.invoice.findMany({
    where: { organizationId: p.organizationId, companyId: p.companyId, kind: 'INVOICE', state: { notIn: ['DRAFT', 'CANCELLED'] } },
    orderBy: { issueDate: 'desc' }, take: 50,
    select: { id: true, number: true, issueDate: true, dueDate: true, total: true, paidAmount: true, state: true, currency: true, originalTotal: true },
  });
  return {
    me: { name: p.contact.fullName, email: p.email, company: p.company.brandName ?? p.company.legalName },
    projects: projects.map((x) => ({
      id: x.id, code: x.code, name: x.name, state: x.state, stateFa: stateLabelFa(x.state), plannedStart: x.plannedStart, plannedEnd: x.plannedEnd,
      milestones: { done: x.milestones.filter((m) => m.completedAt).length, total: x.milestones.length },
    })),
    approvals: approvals.map((a) => ({
      id: a.id, code: a.code, subjectType: a.subjectType, title: (a.manifest as { subject: { title: string } }).subject.title,
      expiresAt: a.expiresAt, forMe: a.contactId === p.contactId,
    })),
    invoices,
  };
}

export async function project(p: PortalAccount, id: string) {
  const pr = await visibleProject(p, id);
  const [milestones, deliverables, reports, messages] = await Promise.all([
    prisma.milestone.findMany({ where: { projectId: id }, orderBy: [{ sortOrder: 'asc' }, { dueDate: 'asc' }], select: { id: true, name: true, description: true, dueDate: true, completedAt: true } }),
    prisma.deliverable.findMany({
      where: { projectId: id }, orderBy: { createdAt: 'asc' },
      select: { id: true, code: true, name: true, version: true, state: true, dueDate: true, deliveredAt: true, acceptedAt: true },
    }),
    prisma.statusReport.findMany({ where: { projectId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, code: true, period: true, createdAt: true } }),
    prisma.portalMessage.findMany({
      where: { projectId: id }, orderBy: { createdAt: 'asc' },
      select: { id: true, body: true, createdAt: true, portalUser: { select: { contact: { select: { fullName: true } } } }, user: { select: { fullName: true } } },
    }),
  ]);
  const deliverableIds = deliverables.map((d) => d.id);
  const [documents, approvals] = await Promise.all([
    prisma.document.findMany({
      where: { organizationId: p.organizationId, deletedAt: null, clientVisible: true, OR: [{ projectId: id }, { deliverableId: { in: deliverableIds } }] },
      orderBy: { createdAt: 'desc' }, select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true, deliverableId: true },
    }),
    prisma.clientApproval.findMany({
      where: { companyId: p.companyId, subjectType: 'DELIVERABLE', subjectId: { in: deliverableIds } }, orderBy: { createdAt: 'desc' },
      select: { id: true, code: true, subjectId: true, status: true, contactId: true, contactName: true, decision: true, decidedAt: true, expiresAt: true },
    }),
  ]);
  return {
    project: { id: pr.id, code: pr.code, name: pr.name, objective: pr.objective, state: pr.state, stateFa: stateLabelFa(pr.state), plannedStart: pr.plannedStart, plannedEnd: pr.plannedEnd },
    milestones,
    // Everything before delivery is one step to the client: «در حال تهیه».
    deliverables: deliverables.map((d) => ({ ...d, clientState: ['DELIVERED', 'ACCEPTED'].includes(d.state) || (d.state === 'REVISION_REQUIRED' && d.deliveredAt) ? d.state : 'IN_PROGRESS' })),
    reports, documents,
    approvals: approvals.map((a) => ({ ...a, status: a.status === 'PENDING' && a.expiresAt <= new Date() ? 'EXPIRED' : a.status, forMe: a.contactId === p.contactId })),
    messages: messages.map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt, fromClient: !!m.portalUser, author: m.portalUser?.contact.fullName ?? m.user?.fullName ?? '' })),
  };
}

/** A shared file of one of the company's visible projects. */
export async function sharedDocument(p: PortalAccount, id: string) {
  const d = await prisma.document.findFirst({
    where: { id, organizationId: p.organizationId, deletedAt: null, clientVisible: true },
    include: { project: { select: { id: true } }, deliverable: { select: { projectId: true } } },
  });
  const projectId = d?.project?.id ?? d?.deliverable?.projectId;
  if (!d || !projectId) throw notFound('فایل');
  await visibleProject(p, projectId);
  return d;
}

export async function postMessage(p: PortalAccount, projectId: string, body: string) {
  const pr = await visibleProject(p, projectId);
  const m = await prisma.portalMessage.create({ data: { organizationId: p.organizationId, projectId, portalUserId: p.id, body } });
  return { message: m, accountOwnerId: pr.accountOwnerId, projectName: pr.name };
}

/** Account's reply, and a note to the client's address when mail is on. */
export async function reply(actor: StaffActor, projectId: string, body: string) {
  const pr = await prisma.project.findFirst({ where: { id: projectId, organizationId: actor.organizationId, deletedAt: null } });
  if (!pr) throw notFound('پروژه');
  const m = await prisma.portalMessage.create({ data: { organizationId: actor.organizationId, projectId, userId: actor.id, body } });
  if (clientMail.enabled()) {
    const readers = await prisma.portalUser.findMany({ where: { companyId: pr.companyId, status: 'ACTIVE' }, select: { email: true } });
    for (const r of readers) {
      await clientMail.deliver({
        to: r.email, subject: `پیام تازه دربارهٔ ${pr.name}`,
        html: `<div dir="rtl"><p>پیام تازه‌ای دربارهٔ پروژهٔ «${esc(pr.name)}» در پورتال مشتری دارید (${esc(formatJalali(m.createdAt))}).</p><p><a href="${esc(appUrl())}/portal/projects/${pr.id}">مشاهده در پورتال</a></p></div>`,
        text: `پیام تازه‌ای دربارهٔ پروژهٔ «${pr.name}» در پورتال مشتری دارید.`,
      }).catch(() => undefined);
    }
  }
  return m;
}
