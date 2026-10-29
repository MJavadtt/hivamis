/**
 * Moving in from another system (the owner's request, 2026-10-28: "bring everything from Mizito into
 * this project — analyse it first, then import it with care").
 *
 * A source's adapter (mizito.ts) turns its export into the shape below; this file writes that shape,
 * whatever the source. People, clients and their contacts, sales opportunities, projects, tasks and their
 * comments, in that order, each record in its own transaction with an `import_links` row naming where it came from — so a
 * run that stops half-way is run again, and nothing is made twice. Without `commit` it writes nothing
 * and says what it would do.
 *
 * Nothing here bypasses the record: every person, client, contact, project and task made is an audit
 * row under the administrator who ran the move, and a state a project or a task arrives in is an
 * opening transition with its reason ("from Mizito"), never a silent column.
 */
import { randomBytes } from 'node:crypto';
import type { DepartmentCode, OpportunityState, RoleCode } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';
import { recordOpeningState } from '../workflow/engine.js';
import { rolesOf } from '../auth/roles.js';
import { PENDING_PREFIX } from './activation.js';
import { nameKey } from './units.js';

export type MigrationSource = 'mizito' | 'sheet';

export interface MigPerson {
  ref: string; fullName: string; email: string | null; phone: string | null; jobTitle: string | null;
  unit: DepartmentCode; roles: RoleCode[];
  /** A person the source lists as removed: kept as a name on the history, never able to sign in. */
  removed: boolean;
}
export interface MigContact { fullName: string; jobTitle: string | null; phone: string | null; email: string | null }
export interface MigClient {
  ref: string; code: string | null; legalName: string; brandName: string | null; industry: string | null;
  nationalId: string | null; economicCode: string | null; postalCode: string | null; phone: string | null;
  email: string | null; website: string | null; address: string | null; notes: string | null;
  accountOwnerRef: string | null; contacts: MigContact[]; createdAt: Date | null;
}
/** A sale the source tracked — won, lost or still open — with its value in the organisation's currency. */
export interface MigOpportunity {
  ref: string; title: string; clientRef: string; value: number; state: OpportunityState; ownerRef: string | null;
  description: string | null; lostReason: string | null; wonAt: Date | null; expectedCloseDate: Date | null; createdAt: Date | null;
}
export type MigProjectState = 'DRAFT' | 'ACTIVE' | 'ON_HOLD' | 'CLOSED' | 'CANCELLED';
export interface MigProject {
  ref: string; legacyRef: string | null; name: string; clientRef: string; accountOwnerRef: string | null;
  state: MigProjectState; plannedStart: Date | null; plannedEnd: Date | null; createdAt: Date | null; closedAt: Date | null;
  /** The sale it came from or still waits on. */
  opportunityRef: string | null;
  /** Why it is on hold or cancelled, as the source said. */
  stateReason: string | null;
}
export interface MigTask {
  ref: string; projectRef: string; title: string; description: string | null; assigneeRef: string | null;
  createdByRef: string | null; createdAt: Date | null; dueDate: Date | null; done: boolean; doneAt: Date | null; progress: number;
  /** The unit the source filed it under, when it said; else its doer's. */
  unit: DepartmentCode | null;
}
export interface MigComment {
  ref: string; projectRef: string; taskRef: string | null; authorRef: string | null; body: string; createdAt: Date | null;
}
export interface Migration {
  source: MigrationSource;
  people: MigPerson[]; clients: MigClient[]; opportunities: MigOpportunity[]; projects: MigProject[]; tasks: MigTask[]; comments: MigComment[];
  /** What the adapter noticed and decided, in Persian, for the person running the move. */
  notes: string[];
}

export interface MigrationReport {
  dryRun: boolean;
  counts: Record<'people' | 'clients' | 'contacts' | 'opportunities' | 'projects' | 'tasks' | 'comments', { create: number; link: number; skip: number; failed: number }>;
  /** People made without an address of their own: their email is a stand-in until set. */
  standInEmails: string[];
  /** Running projects with no start authorization on record (Doc_H rule 13): each needs its contract or order. */
  withoutAuthorization: number;
  people: { name: string; unit: string; roles: string[]; email: string; status: 'create' | 'link' | 'skip' }[];
  failures: { kind: string; ref: string; messageFa: string }[];
  notes: string[];
}

export interface MigrationActor { id: string; organizationId: string }

const KINDS = ['people', 'clients', 'contacts', 'opportunities', 'projects', 'tasks', 'comments'] as const;
/** An address that can receive nothing (RFC 2606): a person the source knew without one gets this until it is set. */
export const standInEmail = (ref: string) => `${ref.replace(/[^a-zA-Z0-9]/g, '').slice(-12).toLowerCase()}@import.invalid`;
const OPEN_TASK = { CREATED: 'CREATED', ASSIGNED: 'ASSIGNED', IN_PROGRESS: 'IN_PROGRESS', CLOSED: 'CLOSED' } as const;
const REASON = { mizito: 'ورود از میزیتو', sheet: 'ورود از فایل مشتریان و پروژه‌ها' } as const;

/** The records already made from this source, by their source id. */
async function linksOf(organizationId: string, source: MigrationSource) {
  const rows = await prisma.importLink.findMany({ where: { organizationId, source }, select: { externalId: true, entityId: true } });
  return new Map(rows.map((r) => [r.externalId, r.entityId]));
}

export async function runMigration(actor: MigrationActor, m: Migration, opts: { commit: boolean }): Promise<MigrationReport> {
  const { organizationId } = actor;
  const source = m.source;
  const report: MigrationReport = {
    dryRun: !opts.commit,
    counts: Object.fromEntries(KINDS.map((k) => [k, { create: 0, link: 0, skip: 0, failed: 0 }])) as MigrationReport['counts'],
    standInEmails: [], withoutAuthorization: 0, people: [], failures: [], notes: [...m.notes],
  };
  const links = await linksOf(organizationId, source);
  /** Each source ref's record here — known before the run, or made by it. A dry run invents ids for what it would make. */
  const ids = new Map<string, string>(links);
  const made = (kind: (typeof KINDS)[number]) => report.counts[kind];
  const write = async (kind: (typeof KINDS)[number], ref: string, entityType: string, fn: (t: Tx) => Promise<string>) => {
    if (!opts.commit) { ids.set(ref, `dry:${ref}`); made(kind).create++; return; }
    try {
      const id = await prisma.$transaction(async (t) => {
        const entityId = await fn(t);
        await t.importLink.create({ data: { organizationId, source, externalId: ref, entityType, entityId } });
        return entityId;
      }, { timeout: 30_000 });
      ids.set(ref, id);
      made(kind).create++;
    } catch (e) {
      made(kind).failed++;
      report.failures.push({ kind, ref, messageFa: (e as { message?: string }).message?.slice(0, 300) ?? 'نوشته نشد' });
    }
  };
  const link = async (kind: (typeof KINDS)[number], ref: string, entityType: string, entityId: string) => {
    ids.set(ref, entityId);
    made(kind).link++;
    if (opts.commit) await prisma.importLink.create({ data: { organizationId, source, externalId: ref, entityType, entityId } });
  };
  const idOf = (ref: string | null) => (ref ? ids.get(ref) ?? null : null);
  const real = (id: string | null) => (id && !id.startsWith('dry:') ? id : null);
  const at = (d: Date | null) => (d && !Number.isNaN(d.getTime()) ? d : undefined);

  /* ── people ── */
  const [departments, roles, existingUsers] = await Promise.all([
    prisma.department.findMany({ where: { organizationId }, select: { id: true, code: true } }),
    prisma.role.findMany({ where: rolesOf(organizationId), select: { id: true, code: true } }),
    prisma.user.findMany({ where: { organizationId, deletedAt: null }, select: { id: true, email: true, fullName: true, department: { select: { code: true } } } }),
  ]);
  const unitOfUser = new Map(existingUsers.map((u) => [u.id, u.department?.code ?? null]));
  const unitOfRef = new Map<string, string>();
  const takenEmails = new Set(existingUsers.map((u) => u.email));
  for (const p of m.people) {
    unitOfRef.set(p.ref, p.unit);
    const email = p.email?.toLowerCase() || standInEmail(p.ref);
    if (ids.has(p.ref)) { made('people').skip++; report.people.push({ name: p.fullName, unit: p.unit, roles: p.roles, email, status: 'skip' }); continue; }
    // The same person already here — the administrator who runs the move, most often: linked, never doubled.
    const same = existingUsers.find((u) => (p.email && u.email === p.email.toLowerCase()) || nameKey(u.fullName) === nameKey(p.fullName));
    if (same) {
      await link('people', p.ref, 'user', same.id);
      report.people.push({ name: p.fullName, unit: same.department?.code ?? p.unit, roles: p.roles, email: same.email, status: 'link' });
      continue;
    }
    if (takenEmails.has(email)) { made('people').failed++; report.failures.push({ kind: 'people', ref: p.ref, messageFa: `ایمیل «${email}» را کس دیگری دارد` }); continue; }
    takenEmails.add(email);
    if (!p.email) report.standInEmails.push(`${p.fullName} → ${email}`);
    report.people.push({ name: p.fullName, unit: p.unit, roles: p.roles, email, status: 'create' });
    await write('people', p.ref, 'user', async (t) => {
      const dept = departments.find((d) => d.code === p.unit) ?? departments.find((d) => d.code === 'OP')!;
      const user = await t.user.create({
        data: {
          organizationId, departmentId: dept.id, email, fullName: p.fullName, jobTitle: p.jobTitle, phone: p.phone,
          // No password crosses from another system: this one can never verify. The person sets their own
          // from a one-time link the administrator issues (Admin → Users) — and a removed person never does.
          passwordHash: `${PENDING_PREFIX}${randomBytes(12).toString('hex')}`, mustChangePassword: false,
          isActive: !p.removed, ...(p.removed ? { deletedAt: new Date() } : {}),
          roles: { create: p.roles.map((code) => ({ roleId: roles.find((r) => r.code === code)!.id })) },
        },
        select: { id: true },
      });
      unitOfUser.set(user.id, dept.code);
      await audit({ organizationId, actorId: actor.id, action: 'CREATE', entityType: 'user', entityId: user.id, after: { fullName: p.fullName, unit: dept.code, roles: p.roles, removed: p.removed, source }, reason: REASON[source] }, t);
      return user.id;
    });
  }

  /* ── clients and their contacts ── */
  const existingCompanies = await prisma.company.findMany({ where: { organizationId, deletedAt: null }, select: { id: true, legalName: true, clientCode: true } });
  // A client this source made brings its contacts; one linked to a client already here leaves that client's contacts alone.
  const contacts: { ref: string; clientRef: string; ct: MigContact }[] = [];
  const withContacts = (c: MigClient) => c.contacts.forEach((ct, i) => contacts.push({ ref: `${c.ref}:contact:${i}`, clientRef: c.ref, ct }));
  for (const c of m.clients) {
    if (ids.has(c.ref)) { made('clients').skip++; withContacts(c); continue; }
    const same = existingCompanies.find((x) => (c.code && x.clientCode === c.code) || nameKey(x.legalName) === nameKey(c.legalName));
    if (same) { await link('clients', c.ref, 'company', same.id); continue; }
    withContacts(c);
    await write('clients', c.ref, 'company', async (t) => {
      const company = await t.company.create({
        data: {
          organizationId, legalName: c.legalName, brandName: c.brandName, industry: c.industry, nationalId: c.nationalId,
          economicCode: c.economicCode, postalCode: c.postalCode, phone: c.phone, email: c.email, website: c.website,
          address: c.address, notes: c.notes, clientCode: c.code, accountOwnerId: real(idOf(c.accountOwnerRef)) ?? actor.id,
          createdAt: at(c.createdAt),
        },
        select: { id: true },
      });
      await audit({ organizationId, actorId: actor.id, action: 'CREATE', entityType: 'company', entityId: company.id, after: { legalName: c.legalName, clientCode: c.code, source }, reason: REASON[source] }, t);
      return company.id;
    });
  }
  for (const { ref, clientRef, ct } of contacts) {
    if (ids.has(ref)) { made('contacts').skip++; continue; }
    const companyId = idOf(clientRef);
    if (!companyId) { made('contacts').failed++; continue; }
    await write('contacts', ref, 'contact', async (t) => {
      const contact = await t.contact.create({ data: { organizationId, companyId, fullName: ct.fullName, jobTitle: ct.jobTitle, phone: ct.phone, email: ct.email }, select: { id: true } });
      await audit({ organizationId, actorId: actor.id, action: 'CREATE', entityType: 'contact', entityId: contact.id, after: { companyId, fullName: ct.fullName, source }, reason: REASON[source] }, t);
      return contact.id;
    });
  }

  /* ── sales opportunities: won, lost or open, in the stage the source left them ── */
  for (const o of m.opportunities) {
    if (ids.has(o.ref)) { made('opportunities').skip++; continue; }
    const companyId = idOf(o.clientRef);
    if (!companyId) { made('opportunities').failed++; report.failures.push({ kind: 'opportunities', ref: o.ref, messageFa: `مشتری فرصت «${o.title}» ساخته نشد` }); continue; }
    await write('opportunities', o.ref, 'opportunity', async (t) => {
      const row = await t.opportunity.create({
        data: {
          organizationId, code: await nextCode(t, 'opportunity'), title: o.title.slice(0, 200), companyId, estimatedValue: o.value,
          description: o.description?.slice(0, 4000) ?? null, ownerId: real(idOf(o.ownerRef)) ?? actor.id, lostReason: o.lostReason,
          wonAt: o.wonAt, expectedCloseDate: o.expectedCloseDate, createdAt: at(o.createdAt),
        },
        select: { id: true, code: true },
      });
      await audit({ organizationId, actorId: actor.id, action: 'CREATE', entityType: 'opportunity', entityId: row.id, after: { code: row.code, title: o.title, value: o.value, source }, reason: REASON[source] }, t);
      if (o.state !== 'NEW') await recordOpeningState(t, { entity: 'opportunity', id: row.id, toState: o.state, reason: REASON[source], actor });
      return row.id;
    });
  }

  /* ── projects ── */
  const lastDoneOf = new Map<string, Date>();
  for (const t of m.tasks) if (t.doneAt && t.doneAt > (lastDoneOf.get(t.projectRef) ?? new Date(0))) lastDoneOf.set(t.projectRef, t.doneAt);
  for (const p of m.projects) {
    if (ids.has(p.ref)) { made('projects').skip++; continue; }
    const companyId = idOf(p.clientRef);
    if (!companyId) { made('projects').failed++; report.failures.push({ kind: 'projects', ref: p.ref, messageFa: `مشتری پروژهٔ «${p.name}» ساخته نشد` }); continue; }
    if (p.state === 'ACTIVE') report.withoutAuthorization++;
    await write('projects', p.ref, 'project', async (t) => {
      const project = await t.project.create({
        data: {
          organizationId, code: await nextCode(t, 'project'), name: p.name.slice(0, 200), companyId, legacyRef: p.legacyRef,
          accountOwnerId: real(idOf(p.accountOwnerRef)) ?? actor.id, plannedStart: p.plannedStart, plannedEnd: p.plannedEnd,
          opportunityId: real(idOf(p.opportunityRef)), createdAt: at(p.createdAt),
          ...(p.state === 'ON_HOLD' ? { holdReason: p.stateReason } : p.state === 'CANCELLED' ? { cancelReason: p.stateReason } : {}),
        },
        select: { id: true, code: true },
      });
      await audit({ organizationId, actorId: actor.id, action: 'CREATE', entityType: 'project', entityId: project.id, after: { code: project.code, name: p.name, legacyRef: p.legacyRef, source }, reason: REASON[source] }, t);
      if (p.state !== 'DRAFT') {
        await recordOpeningState(t, { entity: 'project', id: project.id, toState: p.state, reason: REASON[source], actor });
        if (p.state === 'CLOSED' || p.state === 'CANCELLED') await t.project.update({ where: { id: project.id }, data: { closedAt: p.closedAt ?? lastDoneOf.get(p.ref) ?? p.createdAt ?? new Date() } });
      }
      return project.id;
    });
  }

  /* ── tasks ── */
  for (const task of m.tasks) {
    if (ids.has(task.ref)) { made('tasks').skip++; continue; }
    const projectId = idOf(task.projectRef);
    if (!projectId) { made('tasks').failed++; report.failures.push({ kind: 'tasks', ref: task.ref, messageFa: `پروژهٔ وظیفهٔ «${task.title}» ساخته نشد` }); continue; }
    await write('tasks', task.ref, 'task', async (t) => {
      const assigneeId = real(idOf(task.assigneeRef));
      const creatorId = real(idOf(task.createdByRef)) ?? actor.id;
      // The unit whose task it is: the one the source filed it under, else its doer's, else its creator's, else operations.
      const unit = task.unit || (assigneeId && unitOfUser.get(assigneeId)) || (task.assigneeRef && unitOfRef.get(task.assigneeRef))
        || unitOfUser.get(creatorId) || 'OP';
      const row = await t.task.create({
        data: {
          organizationId, code: await nextCode(t, 'task'), projectId, title: task.title.slice(0, 200), description: task.description?.slice(0, 4000) ?? null,
          departmentCode: unit, assigneeId, dueDate: task.dueDate, sourceType: 'TASK', sourceRef: REASON[source].slice(0, 120),
          createdById: creatorId, createdAt: at(task.createdAt),
        },
        select: { id: true, code: true },
      });
      await audit({ organizationId, actorId: actor.id, action: 'CREATE', entityType: 'task', entityId: row.id, after: { code: row.code, title: task.title, source }, reason: REASON[source] }, t);
      const state = task.done ? OPEN_TASK.CLOSED : !assigneeId ? OPEN_TASK.CREATED : task.progress > 0 ? OPEN_TASK.IN_PROGRESS : OPEN_TASK.ASSIGNED;
      if (state !== OPEN_TASK.CREATED) await recordOpeningState(t, { entity: 'task', id: row.id, toState: state, reason: REASON[source], actor });
      if (state === OPEN_TASK.CLOSED) await t.task.update({ where: { id: row.id }, data: { closedAt: task.doneAt ?? new Date() } });
      return row.id;
    });
  }

  /* ── comments: the history, under its own authors and dates ── */
  const people = new Map(m.people.map((p) => [p.ref, p.fullName]));
  for (const c of m.comments) {
    if (ids.has(c.ref)) { made('comments').skip++; continue; }
    const projectId = idOf(c.projectRef);
    const taskId = c.taskRef ? idOf(c.taskRef) : null;
    if (!projectId) { made('comments').failed++; continue; }
    const authorId = real(idOf(c.authorRef));
    // Someone the move could not find writes nothing under another's name: the administrator carries it, signed.
    const body = authorId ? c.body : `«${(c.authorRef && people.get(c.authorRef)) || 'نامشخص'}»: ${c.body}`;
    await write('comments', c.ref, 'comment', async (t) => {
      const row = await t.comment.create({
        data: {
          entityType: taskId ? 'task' : 'project', entityId: (taskId ?? projectId)!, projectId: real(projectId), taskId: real(taskId),
          body: body.slice(0, 8000), authorId: authorId ?? actor.id, createdAt: at(c.createdAt),
        },
        select: { id: true },
      });
      return row.id;
    });
  }

  if (opts.commit) {
    await audit({
      organizationId, actorId: actor.id, action: 'BULK_IMPORT', entityType: 'migration', entityId: source,
      after: { source, counts: report.counts, failures: report.failures.length }, reason: REASON[source],
    });
  }
  return report;
}
