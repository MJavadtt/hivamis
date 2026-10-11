import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma as defaultPrisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { createActivation, PENDING_PREFIX, sendActivation } from '../onboarding/activation.js';
import { syncReference, type OrganizationSync } from './reference.js';
import { APP_VERSION } from '../version.js';
import { tenancy } from '../lib/tenant.js';
import { env } from '../env.js';
import { isDemoEmail } from '../lib/demo-accounts.js';
import { forgetStanding } from '../auth/standing.js';

/**
 * Organisations on one installation (roadmap #50). Provisioning one is the whole of it: the
 * organisation, its reference data through the same sync an upgrade runs, and its first system
 * administrator — with no password; they set their own from a one-time link, as people brought in by
 * the onboarding import do (#48). Everything after that is the organisation's own: its users, units,
 * rules and forms, through the application.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ProvisionInput {
  name: string;
  slug: string;
  legalName?: string;
  hosts?: string[];
  currency?: string;
  timezone?: string;
  admin: { email: string; fullName: string };
}

function cleanHosts(hosts: string[] | undefined): string[] {
  const out = [...new Set((hosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean))];
  for (const h of out) if (!HOST.test(h)) throw badRequest('BAD_HOST', `نشانی «${h}» نام میزبان درستی نیست.`);
  return out;
}

async function assertHostsFree(db: PrismaClient, hosts: string[], exceptId?: string) {
  for (const h of hosts) {
    const taken = await db.organization.findFirst({ where: { hosts: { has: h }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { slug: true } });
    if (taken) throw conflict('HOST_TAKEN', `نشانی «${h}» از آنِ سازمان دیگری است.`);
  }
}

/** The activation link at the organisation's own address, when it has one. */
function atHost(url: string, hosts: string[]): string {
  if (!hosts[0]) return url;
  const u = new URL(url);
  // The organisation's own name, on the standard port: the installation's port (a development
  // server's, say) is not the organisation's.
  u.hostname = hosts[0];
  u.port = '';
  return u.toString();
}

export async function provisionOrganization(input: ProvisionInput, db: PrismaClient = defaultPrisma) {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const email = input.admin.email.trim().toLowerCase();
  const fullName = input.admin.fullName.trim();
  if (!name) throw badRequest('NAME_REQUIRED', 'نام سازمان لازم است.');
  if (!SLUG.test(slug)) throw badRequest('BAD_SLUG', 'نام کوتاه سازمان فقط حروف کوچک لاتین، رقم و خط تیره است (۲ تا ۴۰ نویسه).');
  if (!EMAIL.test(email)) throw badRequest('BAD_EMAIL', 'ایمیل مدیر سیستم درست نیست.');
  // Audit SEC-8: in production the demo domain is the seed's; an administrator there would stop the next start.
  if (env.NODE_ENV === 'production' && isDemoEmail(email)) throw badRequest('DEMO_EMAIL', 'دامنهٔ hiva.local مخصوص حساب‌های نمایشی است؛ ایمیل واقعی مدیر را بدهید.');
  if (!fullName) throw badRequest('NAME_REQUIRED', 'نام مدیر سیستم لازم است.');
  const hosts = cleanHosts(input.hosts);
  // Everything is checked before anything is written: a half-made organisation helps nobody.
  if (await db.organization.findUnique({ where: { slug }, select: { id: true } })) throw conflict('SLUG_TAKEN', `نام کوتاه «${slug}» از آنِ سازمان دیگری است.`);
  // An email is unique within an organisation, and this one is new (audit LOG-4): the same person may run two.
  await assertHostsFree(db, hosts);
  // One organisation per installation unless the operator said otherwise: a second one by mistake
  // would quietly receive the first one's sign-ups.
  if (tenancy.mode === 'single' && (await db.organization.count()) > 0) {
    throw conflict('SINGLE_TENANT', 'این نصب یک‌سازمانی است و سازمانش ساخته شده؛ برای سازمان دوم TENANT_MODE=multi را تنظیم کنید.');
  }

  const organization = await db.organization.create({
    data: {
      name, slug, hosts, legalName: input.legalName?.trim() || null,
      ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    },
  });
  const sync = await syncReference(db, { trigger: 'provision', appVersion: APP_VERSION, only: [organization.id] });

  const { admin, activation } = await db.$transaction(async (tx) => {
    const unit = await tx.department.findUniqueOrThrow({ where: { organizationId_code: { organizationId: organization.id, code: 'M' } } });
    const role = await tx.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
    const made = await tx.user.create({
      data: {
        organizationId: organization.id, departmentId: unit.id, email, fullName, jobTitle: 'مدیر سیستم',
        // No password exists until its owner sets one from the link.
        passwordHash: `${PENDING_PREFIX}${randomBytes(12).toString('hex')}`, mustChangePassword: false,
        roles: { create: [{ roleId: role.id }] },
      },
      select: { id: true, email: true, fullName: true },
    });
    const link = await createActivation(tx, made.id, made.id);
    await audit({
      organizationId: organization.id, actorId: made.id, action: 'ORG_PROVISION', entityType: 'organization', entityId: organization.id,
      after: { name, slug, hosts, admin: email }, reason: 'provisioned',
    }, tx);
    return { admin: made, activation: { ...link, url: atHost(link.url, hosts) } };
  });
  await sendActivation(activation);
  return {
    organization: { id: organization.id, name, slug, hosts },
    admin,
    activation: { url: activation.url, expiresAt: activation.expiresAt, emailed: activation.emailed },
    sync: sync.organizations[0] as OrganizationSync,
  };
}

export async function updateOrganization(slug: string, change: {
  name?: string; addHosts?: string[]; removeHosts?: string[]; active?: boolean;
  /** Audit LOG-5: megabytes of files the organisation may keep; null, no limit. The operator's to set. */
  storageQuotaMb?: number | null;
}, db: PrismaClient = defaultPrisma) {
  const org = await db.organization.findUnique({ where: { slug: slug.toLowerCase() } });
  if (!org) throw notFound('سازمان');
  const add = cleanHosts(change.addHosts);
  await assertHostsFree(db, add, org.id);
  const remove = new Set(cleanHosts(change.removeHosts));
  const hosts = [...new Set([...org.hosts, ...add])].filter((h) => !remove.has(h));
  const updated = await db.organization.update({
    where: { id: org.id },
    data: {
      hosts,
      ...(change.name?.trim() ? { name: change.name.trim() } : {}),
      ...(change.active !== undefined ? { isActive: change.active } : {}),
      ...(change.storageQuotaMb !== undefined ? { storageQuotaMb: change.storageQuotaMb } : {}),
    },
    select: { id: true, name: true, slug: true, hosts: true, isActive: true, storageQuotaMb: true },
  });
  // A suspended organisation's sessions end now, not at their next refresh.
  if (change.active === false) {
    await db.session.updateMany({ where: { revokedAt: null, user: { organizationId: org.id } }, data: { revokedAt: new Date(), revokedReason: 'SUSPENDED' } });
    forgetStanding();
  }
  return updated;
}

export async function listOrganizations(db: PrismaClient = defaultPrisma) {
  const orgs = await db.organization.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true, slug: true, hosts: true, isActive: true, createdAt: true } });
  return Promise.all(orgs.map(async (o) => ({ ...o, users: await db.user.count({ where: { organizationId: o.id, deletedAt: null } }) })));
}

/** What an operator wants to know first: the version, the schema, the last upgrade, the organisations. */
export async function systemStatus(db: PrismaClient = defaultPrisma) {
  // A database made some other way than `migrate deploy` (a test schema, a restored dump) may carry
  // no migration history; the status says so rather than failing.
  const [history] = await db.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('_prisma_migrations') IS NOT NULL AS present`;
  const [migrations] = history?.present
    ? await db.$queryRaw<{ applied: bigint; latest: string | null }[]>`
        SELECT count(*) AS applied, max(migration_name) AS latest FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
    : [{ applied: 0n, latest: null }];
  const last = await db.systemUpgrade.findFirst({ orderBy: { startedAt: 'desc' }, select: { appVersion: true, trigger: true, startedAt: true, finishedAt: true } });
  return {
    version: APP_VERSION,
    migrations: { applied: Number(migrations?.applied ?? 0), latest: migrations?.latest ?? null },
    lastReferenceSync: last,
    organizations: await listOrganizations(db),
  };
}
