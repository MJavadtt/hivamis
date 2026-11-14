import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { OVERSIGHT_GRANTOR_ROLE } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { organizationWhere } from '../lib/scope.js';
import { hashPassword } from '../auth/password.js';
import { endSessions } from '../auth/session.js';
import { removeUser } from '../auth/remove-user.js';
import { forgetStanding } from '../auth/standing.js';

/**
 * A clean start for an organisation (owner's report, 2026-10-23): every person and every record goes,
 * but for one system administrator — and the history stays (the owner's answer).
 *
 * What stays is what the organisation is, not what it did: its settings, units, roles and their
 * grants, positions and teams, forms and their routing, rules, SLA policies, calendars and holidays,
 * tax and accounting settings, the rooms and resources one books, the installation's own guide
 * videos and keys. And the history: the audit trail, the workflow's transitions, security alerts, and
 * the numbering counters, so a new record never takes a code the history already gives another.
 *
 * Everything else the organisation holds is deleted, children before parents. The other people are
 * removed as the administrator removes one: a person the history names keeps their name in it and
 * can no longer sign in; one it does not name is deleted outright. The administrator kept may be
 * given a new password here; every session ends either way.
 */

export const KEEP = new Set([
  // What the organisation is.
  'Organization', 'Holiday', 'RuleSetVersion', 'Department', 'Role', 'Position', 'Permission', 'RolePermission', 'RoleGrant',
  'FormDefinition', 'FormDefinitionVersion', 'SlaPolicy', 'CustomRule', 'ExchangeRate', 'TaxProfile', 'AccountingSettings',
  'BookingLocation', 'BookableResource', 'CateringOption', 'Team', 'GuideVideo', 'ServerKey', 'SystemUpgrade', 'MessengerPollState',
  // ADR-103: the venues module's lists and how its rentals run.
  'SiteOption', 'SiteSettings',
  // The history.
  'AuditEvent', 'StateTransition', 'SecurityAlert', 'Counter',
  // People: removed one by one below, never wholesale; the kept administrator's roles and sign-ins stay.
  'User', 'UserRole', 'UserPermissionOverride', 'UserIdentity',
]);

/** Every model the organisation's records live in, that a clean start empties. */
export const WIPED: readonly string[] = Prisma.dmmf.datamodel.models.map((m) => m.name).filter((m) => !KEEP.has(m));

const delegate = (tx: Tx, model: string) =>
  (tx as unknown as Record<string, { deleteMany(args: unknown): Promise<{ count: number }>; count(args: unknown): Promise<number> }>)[model[0]!.toLowerCase() + model.slice(1)]!;

export interface ResetPlan {
  organization: { id: string; name: string; slug: string | null };
  admin: { id: string; email: string; fullName: string };
  /** Rows each model loses. */
  records: Record<string, number>;
  people: number;
}

async function adminOf(organizationId: string, email: string) {
  const admin = await prisma.user.findFirst({
    where: { organizationId, email: email.trim().toLowerCase(), deletedAt: null },
    select: { id: true, email: true, fullName: true, roles: { select: { role: { select: { code: true } } } } },
  });
  if (!admin || !admin.roles.some((r) => r.role.code === OVERSIGHT_GRANTOR_ROLE)) {
    const admins = await prisma.user.findMany({
      where: { organizationId, deletedAt: null, roles: { some: { role: { code: OVERSIGHT_GRANTOR_ROLE } } } }, select: { email: true },
    });
    throw new AppError(400, 'NOT_A_SYSTEM_ADMIN', `${email} مدیر سیستم این سازمان نیست. مدیران سیستم: ${admins.map((a) => a.email).join('، ') || '—'}`);
  }
  return admin;
}

export async function planReset(organizationId: string, keepAdminEmail: string): Promise<ResetPlan> {
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { id: true, name: true, slug: true } });
  const admin = await adminOf(organizationId, keepAdminEmail);
  const records: Record<string, number> = {};
  for (const m of WIPED) {
    const where = organizationWhere(m, organizationId);
    if (!where) continue;
    const n = await delegate(prisma, m).count({ where });
    if (n) records[m] = n;
  }
  const people = await prisma.user.count({ where: { organizationId, deletedAt: null, id: { not: admin.id } } });
  return { organization, admin: { id: admin.id, email: admin.email, fullName: admin.fullName }, records, people };
}

export async function resetOrganization(organizationId: string, keepAdminEmail: string, password?: string) {
  if (password !== undefined && password.length < 12) throw new AppError(400, 'WEAK_PASSWORD', 'رمز عبور دست‌کم ۱۲ نویسه باشد.');
  const plan = await planReset(organizationId, keepAdminEmail);
  const files = await prisma.document.findMany({ where: { organizationId }, select: { storedName: true } });
  const passwordHash = password ? await hashPassword(password) : undefined;
  const deleted: Record<string, number> = {};
  let removed = 0, gone = 0;

  await prisma.$transaction(async (tx) => {
    // Children before parents, found by trying: a model whose rows something still points at waits
    // for the next pass. Each try is its own savepoint, so a refusal costs nothing but the try.
    let left = WIPED.filter((m) => organizationWhere(m, organizationId));
    for (let pass = 0; left.length; pass++) {
      const waiting: string[] = [];
      const why: string[] = [];
      for (const m of left) {
        await tx.$executeRawUnsafe('SAVEPOINT hiva_reset');
        try {
          const { count } = await delegate(tx, m).deleteMany({ where: organizationWhere(m, organizationId) });
          if (count) deleted[m] = (deleted[m] ?? 0) + count;
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT hiva_reset');
        } catch (e) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT hiva_reset');
          waiting.push(m);
          why.push(`${m}: ${(e as Error).message.split('\n').filter(Boolean).pop()}`);
        }
      }
      if (waiting.length === left.length || pass > 40) throw new Error(`a clean start could not empty: ${why.join(' | ')}`);
      left = waiting;
    }

    // The people, as the administrator removes one.
    const others = await tx.user.findMany({ where: { organizationId, deletedAt: null, id: { not: plan.admin.id } }, select: { id: true } });
    for (const u of others) (await removeUser(tx, u)) === 'deleted' ? gone++ : removed++;

    // The administrator kept: a new password if one was given, and every sign-in ends.
    if (passwordHash) await tx.user.update({ where: { id: plan.admin.id }, data: { passwordHash, mustChangePassword: false, lockedUntil: null, isActive: true } });
    await endSessions(tx, plan.admin.id, passwordHash ? 'PASSWORD_SET_BY_ADMIN' : 'SIGNED_OUT');

    await audit({
      organizationId, actorId: plan.admin.id, action: 'ORGANIZATION_RESET', entityType: 'organization', entityId: organizationId,
      after: { kept: plan.admin.email, records: deleted, peopleRemoved: removed, peopleDeleted: gone, passwordSet: !!passwordHash },
      reason: 'a clean start from the command line: every person and record but the system administrator; the history kept',
    }, tx);
  }, { timeout: 15 * 60_000, maxWait: 60_000 });

  forgetStanding();
  // The files go after the commit: a failure above leaves every file where it was.
  const root = path.resolve(env.STORAGE_DIR);
  let filesRemoved = 0;
  for (const f of files) {
    const target = path.join(root, f.storedName);
    if (target.startsWith(root + path.sep) && await unlink(target).then(() => true, () => false)) filesRemoved++;
  }
  return { organization: plan.organization.slug, kept: plan.admin.email, deleted, peopleRemoved: removed, peopleDeleted: gone, filesRemoved, passwordSet: !!passwordHash };
}

/**
 * A fresh start that keeps the colleagues (the owner, 2026-11-14; ADR-130): «کاربران (همکاران) را
 * نگه‌دار، تمام اطلاعات مربوط به مشتریان و پروژه‌ها را پاک کن، باید همه چیز را کاربران از اول خودشان
 * وارد کنند».
 *
 * Every person stays as they are — their roles, unit, position, team, photo, sign-ins and sessions,
 * leave and delegations — and so does what the organisation is (KEEP) and its history. Besides, the
 * lists the owner chose to keep: suppliers and their evaluations, marketers and referring companies,
 * and the two companies invoices are issued in. Everything the work made is deleted: clients and
 * their people, leads, deals, briefs, proposals, projects, tasks, contracts, invoices, payments,
 * files, the venues database, chats, notifications and the assistant's conversations.
 */
export const KEEP_PEOPLE = new Set([
  ...KEEP,
  // The colleagues and what is theirs rather than the work's.
  'Session', 'UserLeave', 'Delegation', 'MessengerLink', 'PushSubscription', 'AccountActivation', 'SignupRequest', 'SignInFailure', 'SiteSavedView',
  // Integrations, set up once for the installation.
  'ApiKey', 'WebhookSubscription',
  // The owner's choice (2026-11-14).
  'Supplier', 'SupplierEvaluation', 'LeadReferrer', 'InvoiceSeller',
]);

/** Every model a fresh start that keeps the colleagues empties. */
export const WIPED_KEEPING_PEOPLE: readonly string[] = Prisma.dmmf.datamodel.models.map((m) => m.name).filter((m) => !KEEP_PEOPLE.has(m));

/** Each model's rows to delete: a person's photo is a file too, and stays with them. */
async function freshWhere(organizationId: string) {
  const avatars = (await prisma.user.findMany({ where: { organizationId, avatarDocumentId: { not: null } }, select: { avatarDocumentId: true } }))
    .map((u) => u.avatarDocumentId!);
  return (m: string): Record<string, unknown> | null => {
    const where = organizationWhere(m, organizationId);
    if (!where || m !== 'Document' || !avatars.length) return where;
    return { AND: [where, { id: { notIn: avatars } }] };
  };
}

export interface FreshStartPlan {
  organization: { id: string; name: string; slug: string | null };
  by: { id: string; email: string; fullName: string };
  /** Rows each model loses. */
  records: Record<string, number>;
  /** The people who stay — all of them. */
  people: number;
  kept: Record<string, number>;
}

export async function planFreshStart(organizationId: string, byEmail: string): Promise<FreshStartPlan> {
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { id: true, name: true, slug: true } });
  const by = await adminOf(organizationId, byEmail);
  const whereOf = await freshWhere(organizationId);
  const records: Record<string, number> = {};
  for (const m of WIPED_KEEPING_PEOPLE) {
    const where = whereOf(m);
    if (!where) continue;
    const n = await delegate(prisma, m).count({ where });
    if (n) records[m] = n;
  }
  const kept: Record<string, number> = {};
  for (const m of ['Supplier', 'LeadReferrer', 'InvoiceSeller', 'Department', 'AuditEvent']) kept[m] = await delegate(prisma, m).count({ where: organizationWhere(m, organizationId) });
  const people = await prisma.user.count({ where: { organizationId, deletedAt: null } });
  return { organization, by: { id: by.id, email: by.email, fullName: by.fullName }, records, people, kept };
}

export async function freshStartKeepingPeople(organizationId: string, byEmail: string) {
  const plan = await planFreshStart(organizationId, byEmail);
  const whereOf = await freshWhere(organizationId);
  const files = await prisma.document.findMany({ where: whereOf('Document') as Prisma.DocumentWhereInput, select: { storedName: true } });
  const deleted: Record<string, number> = {};

  await prisma.$transaction(async (tx) => {
    // As the clean start does: children before parents, found by trying, each try its own savepoint.
    let left = WIPED_KEEPING_PEOPLE.filter((m) => whereOf(m));
    for (let pass = 0; left.length; pass++) {
      const waiting: string[] = [];
      const why: string[] = [];
      for (const m of left) {
        await tx.$executeRawUnsafe('SAVEPOINT hiva_fresh');
        try {
          const { count } = await delegate(tx, m).deleteMany({ where: whereOf(m) });
          if (count) deleted[m] = (deleted[m] ?? 0) + count;
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT hiva_fresh');
        } catch (e) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT hiva_fresh');
          waiting.push(m);
          why.push(`${m}: ${(e as Error).message.split('\n').filter(Boolean).pop()}`);
        }
      }
      if (waiting.length === left.length || pass > 40) throw new Error(`a fresh start could not empty: ${why.join(' | ')}`);
      left = waiting;
    }
    await audit({
      organizationId, actorId: plan.by.id, action: 'ORGANIZATION_FRESH_START', entityType: 'organization', entityId: organizationId,
      after: { by: plan.by.email, records: deleted, peopleKept: plan.people, kept: plan.kept },
      reason: 'a fresh start from the command line: every client and project record deleted, the colleagues and the history kept (the owner, 2026-11-14)',
    }, tx);
  }, { timeout: 15 * 60_000, maxWait: 60_000 });

  forgetStanding();
  const root = path.resolve(env.STORAGE_DIR);
  let filesRemoved = 0;
  for (const f of files) {
    const target = path.join(root, f.storedName);
    if (target.startsWith(root + path.sep) && await unlink(target).then(() => true, () => false)) filesRemoved++;
  }
  return { organization: plan.organization.slug, by: plan.by.email, deleted, peopleKept: plan.people, kept: plan.kept, filesRemoved };
}
