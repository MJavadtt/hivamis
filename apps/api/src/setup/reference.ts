import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ALL_FORMS, ALL_PERMISSIONS, PERMISSIONS, ROLE_CODES, ROLE_LABELS, ROLE_PERMISSIONS,
  DEPARTMENT_LABELS, DEPARTMENT_CODES, EXECUTION_DEPARTMENTS, SLA_POLICIES,
} from '@hiva/contracts';
import { publishDefinition } from '../forms/versions.js';
import { syncInvoiceSellers } from '../invoices/sellers.js';

/**
 * The reference data, brought up to the code (roadmap #50): permissions and roles for the whole
 * installation; for each organisation its units, its SLA policies and the form catalogue. The seed
 * used to be the only way in, so an installation that upgraded its code kept last version's forms —
 * the lead form went on asking for «تلفن» without the lead sources of task 2. Now the same sync runs
 * on every start, when an organisation is provisioned, and by hand.
 *
 * It never takes back what an organisation made its own: a form edited in the designer keeps its
 * fields (roadmap #15), SLA hours an administrator set keep their hours, a unit keeps its colour.
 * It only adds what is missing and refreshes what the catalogue still speaks for.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface OrganizationSync {
  organizationId: string;
  departmentsAdded: number;
  slaAdded: number;
  slaUpdated: number;
  slaKept: number;
  formsChanged: number;
  formsKept: number;
  /** ADR-125: the companies its invoices are issued in, made once. */
  sellersAdded: number;
}

export interface ReferenceSync {
  permissions: number;
  roles: number;
  organizations: OrganizationSync[];
}

/** Permissions and roles: one set for the installation; an organisation grants them its own way (task 6). */
export async function syncPlatform(db: Db): Promise<{ permissions: number; roles: number }> {
  const permIds = new Map<string, string>();
  for (const code of ALL_PERMISSIONS) {
    const p = await db.permission.upsert({
      where: { code },
      create: { code, nameFa: PERMISSIONS[code] },
      update: { nameFa: PERMISSIONS[code] },
    });
    permIds.set(code, p.id);
  }
  for (const code of ROLE_CODES) {
    const role = await db.role.upsert({
      where: { code },
      create: { code, nameFa: ROLE_LABELS[code].fa, nameEn: ROLE_LABELS[code].en },
      update: { nameFa: ROLE_LABELS[code].fa, nameEn: ROLE_LABELS[code].en },
    });
    // The defaults a role starts from. What an organisation's administrator grants lives in
    // role_grants and is not touched here.
    const want = new Set([...new Set(ROLE_PERMISSIONS[code])].map((p) => permIds.get(p)).filter((id): id is string => !!id));
    const have = await db.rolePermission.findMany({ where: { roleId: role.id }, select: { permissionId: true } });
    const stale = have.filter((h) => !want.has(h.permissionId)).map((h) => h.permissionId);
    if (stale.length) await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { in: stale } } });
    const missing = [...want].filter((id) => !have.some((h) => h.permissionId === id));
    if (missing.length) await db.rolePermission.createMany({ data: missing.map((permissionId) => ({ roleId: role.id, permissionId })), skipDuplicates: true });
  }
  return { permissions: ALL_PERMISSIONS.length, roles: ROLE_CODES.length };
}

/** One organisation's units, SLA policies and forms. */
export async function syncOrganization(db: Db, organizationId: string): Promise<OrganizationSync> {
  const out: OrganizationSync = { organizationId, departmentsAdded: 0, slaAdded: 0, slaUpdated: 0, slaKept: 0, formsChanged: 0, formsKept: 0, sellersAdded: 0 };

  let order = 0;
  for (const code of DEPARTMENT_CODES) {
    const existing = await db.department.findUnique({ where: { organizationId_code: { organizationId, code } }, select: { id: true, namesOwned: true } });
    if (existing) {
      // A unit the organisation renamed keeps its names (list 3, item 6); the others follow the code.
      if (!existing.namesOwned) await db.department.update({ where: { id: existing.id }, data: { nameFa: DEPARTMENT_LABELS[code].fa, nameEn: DEPARTMENT_LABELS[code].en } });
    } else {
      await db.department.create({
        data: {
          organizationId, code, nameFa: DEPARTMENT_LABELS[code].fa, nameEn: DEPARTMENT_LABELS[code].en,
          isExecutionalUnit: EXECUTION_DEPARTMENTS.includes(code), sortOrder: order,
        },
      });
      out.departmentsAdded++;
    }
    order++;
  }

  for (const policy of SLA_POLICIES) {
    const existing = await db.slaPolicy.findUnique({ where: { organizationId_code: { organizationId, code: policy.code } } });
    if (!existing) {
      await db.slaPolicy.create({
        data: { organizationId, code: policy.code, labelFa: policy.labelFa, labelEn: policy.labelEn, hours: policy.hours, warnAt: policy.warnAt, docRef: policy.docRef },
      });
      out.slaAdded++;
      continue;
    }
    // Hours the organisation set are its own; the names and the rule cited follow the catalogue.
    const ownHours = !!existing.customizedAt;
    const next = {
      labelFa: policy.labelFa, labelEn: policy.labelEn, docRef: policy.docRef ?? null,
      ...(ownHours ? {} : { hours: policy.hours, warnAt: policy.warnAt }),
    };
    const same = existing.labelFa === next.labelFa && existing.labelEn === next.labelEn && (existing.docRef ?? null) === next.docRef
      && (ownHours || (Number(existing.hours) === policy.hours && Number(existing.warnAt) === policy.warnAt));
    if (!same) { await db.slaPolicy.update({ where: { id: existing.id }, data: next }); out.slaUpdated++; }
    if (ownHours) out.slaKept++;
  }

  for (const form of ALL_FORMS) {
    const { changed, skippedCustomised } = await publishDefinition(db, { organizationId, form, note: 'reference sync' });
    if (changed) out.formsChanged++;
    if (skippedCustomised) out.formsKept++;
  }

  out.sellersAdded = await syncInvoiceSellers(db, organizationId);
  return out;
}

/** Record codes run on from the highest one in use, so an imported or restored row never collides. */
export async function syncCounters(db: Db): Promise<void> {
  const tables: [scope: string, table: string][] = [
    ['lead', 'leads'], ['opportunity', 'opportunities'], ['brief', 'briefs'],
    ['proposal', 'proposals'], ['project', 'projects'], ['workOrder', 'work_orders'],
    ['task', 'tasks'], ['deliverable', 'deliverables'], ['qcReview', 'qc_reviews'],
    ['revision', 'revisions'], ['changeRequest', 'change_requests'], ['contract', 'contracts'],
    ['invoice', 'invoices'], ['risk', 'risks'], ['issue', 'issues'], ['decision', 'decisions'],
    ['meeting', 'meetings'], ['statusReport', 'status_reports'],
    ['outsourceRequest', 'outsource_requests'], ['formSubmission', 'form_submissions'],
    ['handoff', 'handoffs'],
  ];
  for (const [scope, table] of tables) {
    const rows = await db.$queryRawUnsafe<{ max: number | null }[]>(
      `SELECT MAX(NULLIF(regexp_replace(code, '^.*-', ''), '')::int) AS max
         FROM ${table} WHERE code ~ '^[A-Z]+-[0-9]+$'`,
    );
    const max = rows[0]?.max ?? 0;
    if (max > 0) {
      await db.$executeRawUnsafe(
        `INSERT INTO counters (id, scope, value) VALUES (gen_random_uuid(), $1, $2)
         ON CONFLICT (scope) DO UPDATE SET value = GREATEST(counters.value, $2)`,
        scope, max,
      );
    }
  }
}

/** Arbitrary, fixed: the key under which only one process at a time brings the reference data up. */
const LOCK_KEY = 4_850_050;

/**
 * The whole sync, for every organisation in service, as one transaction behind an advisory lock:
 * two replicas starting together take turns, and the second finds nothing left to do. A failure
 * changes nothing. A run is written to system_upgrades with what it changed — every run asked for by
 * hand or by provisioning, and a start-up run when it changed something or the version is new (a
 * development server restarts on every save, and would otherwise fill the table with nothing).
 */
export async function syncReference(prisma: PrismaClient, opts: {
  trigger: 'startup' | 'manual' | 'provision' | 'seed'; appVersion: string; only?: string[];
}): Promise<ReferenceSync & { recorded: boolean }> {
  const startedAt = new Date();
  const summary = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    const platform = await syncPlatform(tx);
    const orgs = await tx.organization.findMany({
      where: { isActive: true, ...(opts.only ? { id: { in: opts.only } } : {}) },
      select: { id: true }, orderBy: { createdAt: 'asc' },
    });
    const organizations: OrganizationSync[] = [];
    for (const o of orgs) organizations.push(await syncOrganization(tx, o.id));
    await syncCounters(tx);
    return { ...platform, organizations };
  }, { timeout: 300_000, maxWait: 300_000 });

  const changed = summary.organizations.some((o) => o.departmentsAdded || o.slaAdded || o.slaUpdated || o.formsChanged);
  const last = await prisma.systemUpgrade.findFirst({ where: { finishedAt: { not: null } }, orderBy: { startedAt: 'desc' }, select: { appVersion: true } });
  const recorded = opts.trigger !== 'startup' || changed || last?.appVersion !== opts.appVersion;
  if (recorded) {
    await prisma.systemUpgrade.create({
      data: { appVersion: opts.appVersion, trigger: opts.trigger, startedAt, finishedAt: new Date(), summary: summary as unknown as Prisma.InputJsonValue },
    });
  }
  return { ...summary, recorded };
}
