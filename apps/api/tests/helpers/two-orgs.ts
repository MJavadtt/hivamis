import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../src/db.js';
import { hashPassword } from '../../src/auth/password.js';
import { tenancy } from '../../src/lib/tenant.js';
import { provisionOrganization } from '../../src/setup/tenant.js';
import { app, DEV_PASSWORD } from '../helpers.js';

/**
 * Two organisations on one installation, for tenant-isolation tests (audit P0-1).
 *
 * B is the seeded organisation: it already holds the demo data, and `fillTenant` gives it one row of
 * every tenant-owned kind the seed leaves empty, so every list and every `/:id` has something of B's
 * to leak. A is provisioned fresh — the outsider — with a full-access user and one ordinary role.
 *
 * Everything here is driven by Prisma's own model description (DMMF) and the database's CHECK
 * constraints, not by a hand-kept list: a model added later is filled, fingerprinted and snapshotted
 * without anyone remembering to.
 */

export interface Org {
  id: string;
  /** Holds every permission: a refusal from this user is about tenancy, never about a role. */
  full: { email: string; token: string };
  /** One ordinary role. */
  ordinary: { email: string; token: string };
}

export interface TwoOrgs {
  a: Org;
  b: Org;
  /** Re-sign-in for a user whose token was retired mid-sweep (a role change in their own organisation). */
  relogin: (who: { email: string; token: string }) => Promise<string>;
}

type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];
type DmmfField = DmmfModel['fields'][number];

const MODELS = Prisma.dmmf.datamodel.models;
const ENUMS = new Map(Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]));
const byName = new Map(MODELS.map((m) => [m.name, m]));
export const tableOf = (m: DmmfModel) => m.dbName ?? m.name;
const accessor = (m: DmmfModel) => m.name[0]!.toLowerCase() + m.name.slice(1);
const columnOf = (f: DmmfField) => f.dbName ?? f.name;
const hasOrg = (m: DmmfModel) => m.fields.some((f) => f.name === 'organizationId' && f.kind === 'scalar');
const relations = (m: DmmfModel) => m.fields.filter((f) => f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0);

/** Models whose rows belong to an organisation: by their own column, or through a parent that does. */
export const TENANT_MODELS: DmmfModel[] = (() => {
  const tenant = new Set(MODELS.filter(hasOrg).map((m) => m.name));
  tenant.add('Organization');
  for (let grew = true; grew;) {
    grew = false;
    for (const m of MODELS) {
      if (tenant.has(m.name)) continue;
      if (relations(m).some((r) => r.isRequired && tenant.has(r.type))) { tenant.add(m.name); grew = true; }
    }
  }
  return MODELS.filter((m) => tenant.has(m.name));
})();
const isTenant = new Set(TENANT_MODELS.map((m) => m.name));

/** The values a column's CHECK constraint allows, read from the database: `col = ANY (ARRAY['A', …])`. */
async function checkedValues(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<{ tbl: string; def: string }[]>`
    SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE contype = 'c' AND connamespace = current_schema()::regnamespace`;
  const out = new Map<string, string>();
  for (const { tbl, def } of rows) {
    const table = tbl.replace(/^.*\./, '').replace(/"/g, '');
    for (const m of def.matchAll(/\(?"?(\w+)"? = ANY \(ARRAY\['([^']+)'/g)) {
      if (!out.has(`${table}.${m[1]}`)) out.set(`${table}.${m[1]}`, m[2]!);
    }
    for (const m of def.matchAll(/\(\(?"?(\w+)"? = '([^']+)'::text\)/g)) {
      if (!out.has(`${table}.${m[1]}`)) out.set(`${table}.${m[1]}`, m[2]!);
    }
  }
  return out;
}

/** Field values a CHECK combines with others, which no single-column reading can satisfy. */
const OVERRIDES: Record<string, (ids: (model: string) => Promise<string>) => Promise<Record<string, unknown>>> = {
  Annotation: async () => ({ kind: 'PIN', x: 0.5, y: 0.5, note: 'B' }),
  SignupRequest: async () => ({ method: 'PHONE', phone: '09120000999', status: 'PENDING' }),
  PortalMessage: async (ids) => ({ userId: await ids('User'), portalUserId: null, body: 'B' }),
  // Unique across the installation: each organisation filled gets its own (audit Phase 6, both orgs).
  TaxSubmission: async () => ({ taxId: `B${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.padEnd(22, 'X').slice(0, 22) }),
  CustomRule: async () => ({ kind: 'NOTIFY' }),
  AiMessage: async () => ({ role: 'user', toolName: null }),
  OAuthState: async () => ({ mode: 'LOGIN', userId: null }),
  ClientApproval: async () => ({ decision: null, evidenceHash: null }),
  Document: async () => ({ supersededAt: null, supersededById: null }),
  PushSubscription: async () => ({ disabledAt: null, disabledReason: null }),
  User: async () => ({ phone: null, phoneVerifiedAt: null }),
  // A direct conversation is a pair's (its key names them); a group needs no pair.
  ChatConversation: async () => ({ kind: 'GROUP', directKey: null, title: 'B' }),
  // A booking and its holds span a time (audit F-9): an hour, from tomorrow.
  Booking: async () => ({ startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000), approverId: null }),
  ResourceHold: async () => ({ startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000) }),
  PersonHold: async () => ({ startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000) }),
};

let counter = 0;

/** Gives organisation `orgId` one row of every tenant-owned kind it does not yet have. */
export async function fillTenant(orgId: string): Promise<{ created: string[] }> {
  const checks = await checkedValues();
  const created: string[] = [];
  const owned = await ownedIds(orgId);
  const pick = async (modelName: string, stack: string[] = []): Promise<string> => {
    const m = byName.get(modelName)!;
    const mine = owned.get(tableOf(m));
    if (mine?.size) return [...mine][0]!;
    if (!isTenant.has(modelName)) {
      const any = await (prisma as any)[accessor(m)].findFirst({ select: { id: true } });
      if (any) return any.id as string;
    }
    return create(m, stack);
  };
  const create = async (m: DmmfModel, stack: string[]): Promise<string> => {
    if (stack.includes(m.name)) throw new Error(`fillTenant: cycle through ${[...stack, m.name].join(' → ')}`);
    const data: Record<string, unknown> = {};
    const table = tableOf(m);
    for (const f of m.fields) {
      if (f.kind === 'object' || f.isId || f.isUpdatedAt || (f.hasDefaultValue && !f.isRequired)) continue;
      if (f.name === 'organizationId') { data[f.name] = orgId; continue; }
      const rel = relations(m).find((r) => r.relationFromFields!.includes(f.name));
      if (rel) {
        if (f.isRequired) data[f.name] = await pick(rel.type, [...stack, m.name]);
        continue;
      }
      if (!f.isRequired || f.hasDefaultValue) continue;
      const checked = checks.get(`${table}.${columnOf(f)}`);
      if (f.isList) data[f.name] = [];
      else if (f.kind === 'enum') data[f.name] = ENUMS.get(f.type)![0];
      else if (checked !== undefined) data[f.name] = checked;
      else if (f.type === 'String') data[f.name] = `B-${m.name}-${++counter}`;
      else if (f.type === 'Int' || f.type === 'BigInt') data[f.name] = 1;
      else if (f.type === 'Float' || f.type === 'Decimal') data[f.name] = 1;
      else if (f.type === 'Boolean') data[f.name] = false;
      else if (f.type === 'DateTime') data[f.name] = new Date();
      else if (f.type === 'Json') data[f.name] = {};
      else if (f.type === 'Bytes') data[f.name] = Buffer.from('B');
    }
    Object.assign(data, await OVERRIDES[m.name]?.((name) => pick(name, [...stack, m.name])));
    const row = await (prisma as any)[accessor(m)].create({ data, select: { id: true } });
    (owned.get(table) ?? owned.set(table, new Set()).get(table)!).add(row.id);
    created.push(m.name);
    return row.id as string;
  };
  for (const m of TENANT_MODELS) {
    if (m.name === 'Organization' || !m.fields.some((f) => f.name === 'id')) continue;
    if (!owned.get(tableOf(m))?.size) await create(m, []);
  }
  return { created };
}

/**
 * Every row that belongs to `orgId`, by table: its own `organizationId`, or — for a child without
 * one — a foreign key into a row that does. Computed to a fixed point, so a grandchild counts too.
 */
export async function ownedIds(orgId: string): Promise<Map<string, Set<string>>> {
  const owned = new Map<string, Set<string>>();
  const add = (table: string, ids: string[]) => {
    const set = owned.get(table) ?? owned.set(table, new Set()).get(table)!;
    let grew = false;
    for (const id of ids) if (!set.has(id)) { set.add(id); grew = true; }
    return grew;
  };
  add('organizations', [orgId]);
  for (const m of TENANT_MODELS) {
    if (!hasOrg(m) || !m.fields.some((f) => f.name === 'id')) continue;
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text FROM "${tableOf(m)}" WHERE "organizationId" = $1`, orgId);
    add(tableOf(m), rows.map((r) => r.id));
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const m of TENANT_MODELS) {
      if (hasOrg(m) || !m.fields.some((f) => f.name === 'id')) continue;
      for (const r of relations(m)) {
        const parent = byName.get(r.type)!;
        const parents = [...(owned.get(tableOf(parent)) ?? [])];
        if (!parents.length || r.relationFromFields!.length !== 1) continue;
        const fk = columnOf(m.fields.find((f) => f.name === r.relationFromFields![0])!);
        const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id::text FROM "${tableOf(m)}" WHERE "${fk}"::text = ANY($1::text[])`, parents);
        if (add(tableOf(m), rows.map((x) => x.id))) grew = true;
      }
    }
  }
  return owned;
}

/** A checksum of every row `orgId` owns, by table and id: two snapshots differ exactly where a row changed. */
export async function snapshot(orgId: string, skip: string[] = []): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const owned = await ownedIds(orgId);
  for (const [table, ids] of owned) {
    if (skip.includes(table) || !ids.size) continue;
    const rows = await prisma.$queryRawUnsafe<{ id: string; h: string }[]>(
      `SELECT t.id::text AS id, md5(t::text) AS h FROM "${table}" t WHERE t.id::text = ANY($1::text[])`, [...ids]);
    for (const r of rows) out.set(`${table}/${r.id}`, r.h);
  }
  // A join table has no id of its own (a user's roles): its rows are known by their content.
  for (const m of TENANT_MODELS) {
    if (m.fields.some((f) => f.name === 'id') || skip.includes(tableOf(m))) continue;
    for (const r of relations(m)) {
      const parents = [...(owned.get(tableOf(byName.get(r.type)!)) ?? [])];
      if (!parents.length || r.relationFromFields!.length !== 1) continue;
      const fk = columnOf(m.fields.find((f) => f.name === r.relationFromFields![0])!);
      const rows = await prisma.$queryRawUnsafe<{ h: string }[]>(
        `SELECT md5(t::text) AS h FROM "${tableOf(m)}" t WHERE t."${fk}"::text = ANY($1::text[])`, parents);
      for (const x of rows) out.set(`${tableOf(m)}/#${x.h}`, x.h);
    }
  }
  return out;
}

/** What would identify `orgId`'s data in a response: row ids, business codes (PRJ-000016) and emails. */
export async function fingerprints(orgId: string): Promise<{ ids: Set<string>; codes: Set<string>; emails: Set<string> }> {
  const owned = await ownedIds(orgId);
  const ids = new Set([...owned.values()].flatMap((s) => [...s]));
  const codes = new Set<string>();
  const emails = new Set<string>();
  for (const m of TENANT_MODELS) {
    const ownedHere = owned.get(tableOf(m));
    if (!ownedHere?.size) continue;
    for (const col of ['code', 'email']) {
      if (!m.fields.some((f) => f.name === col && f.kind === 'scalar' && f.type === 'String')) continue;
      const rows = await prisma.$queryRawUnsafe<{ v: string | null }[]>(
        `SELECT "${col}" AS v FROM "${tableOf(m)}" WHERE id::text = ANY($1::text[])`, [...ownedHere]);
      for (const { v } of rows) {
        if (!v) continue;
        // A reference code («A01_LEAD», «SALES_REP») is shared by every organisation; a business code is not.
        if (col === 'code' && /^[A-Z]+-\d{4,}$/.test(v)) codes.add(v);
        if (col === 'email') emails.add(v.toLowerCase());
      }
    }
  }
  return { ids, codes, emails };
}

/** Whatever of `fp` appears in `text`, leaving out what the request itself carried. */
export function leaked(text: string, fp: Awaited<ReturnType<typeof fingerprints>>, carried: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
    const id = m[0].toLowerCase();
    if (fp.ids.has(id) && !carried.includes(id)) out.add(id);
  }
  for (const m of text.matchAll(/[A-Z]+-\d{4,}/g)) if (fp.codes.has(m[0]) && !carried.includes(m[0])) out.add(m[0]);
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
    const e = m[0].toLowerCase();
    if (fp.emails.has(e) && !carried.toLowerCase().includes(e)) out.add(e);
  }
  return [...out];
}

/** One of `orgId`'s ids for each model, keyed by Prisma model name. */
export async function idsByModel(orgId: string): Promise<Map<string, string>> {
  const owned = await ownedIds(orgId);
  const out = new Map<string, string>();
  for (const m of TENANT_MODELS) {
    const first = [...(owned.get(tableOf(m)) ?? [])][0];
    if (first) out.set(m.name, first);
  }
  return out;
}

/**
 * Every foreign-key field name in the schema (`companyId`, `projectId`, `assigneeId`…), mapped to one
 * of `orgId`'s rows of the model it points at — what a hostile payload or query string would carry.
 */
export async function foreignKeyValues(orgId: string): Promise<Record<string, string>> {
  const ids = await idsByModel(orgId);
  const out: Record<string, string> = {};
  for (const m of MODELS) {
    for (const r of relations(m)) {
      if (r.relationFromFields!.length !== 1) continue;
      const id = ids.get(r.type);
      if (id && !(r.relationFromFields![0]! in out)) out[r.relationFromFields![0]!] = id;
    }
  }
  return out;
}

/**
 * The table a URL segment names: `work-orders` → `work_orders`, `workOrder` → `work_orders`,
 * `time` under `/tasks/:id` → `time_entries`, `alerts` under `/security` → `security_alerts`.
 */
export function tableForSegment(segment: string, parent = ''): string | undefined {
  const snake = segment.replace(/-/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const tables = MODELS.map(tableOf);
  const exact = tables.find((t) => t === snake || t === `${snake}s` || t === `${snake}es` || t === snake.replace(/y$/, 'ies'));
  if (exact) return exact;
  const loose = tables.filter((t) => t.endsWith(`_${snake}`) || t.startsWith(`${snake}_`));
  const stem = parent.replace(/-/g, '_').replace(/s$/, '');
  return loose.find((t) => stem && t.startsWith(stem)) ?? loose[0];
}

const loginAs = async (email: string): Promise<string> => {
  const res = await (await app()).inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: DEV_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  return res.json().accessToken as string;
};

/**
 * A: a new organisation with a full-access administrator and a sales representative. B: the seeded
 * organisation, filled out to one row of every tenant-owned kind.
 */
export async function twoOrgs(): Promise<TwoOrgs & { filled: string[] }> {
  tenancy.mode = 'multi';
  const bId = (await prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  const provisioned = await provisionOrganization({
    name: 'سازمان الف', slug: 'alef', admin: { email: 'boss@alef.test', fullName: 'مدیر الف' },
  });
  const aId = provisioned.organization.id;
  const hash = await hashPassword(DEV_PASSWORD);
  await prisma.user.updateMany({ where: { email: 'boss@alef.test' }, data: { passwordHash: hash, mustChangePassword: false } });
  const sales = await prisma.department.findFirstOrThrow({ where: { organizationId: aId, code: 'S' } });
  const rep = await prisma.role.findUniqueOrThrow({ where: { code: 'SALES_REP' } });
  await prisma.user.create({
    data: {
      organizationId: aId, departmentId: sales.id, email: 'rep@alef.test', fullName: 'فروشندهٔ الف',
      passwordHash: hash, mustChangePassword: false, roles: { create: [{ roleId: rep.id }] },
    },
  });
  const { created } = await fillTenant(bId);

  const a: Org = {
    id: aId,
    full: { email: 'boss@alef.test', token: await loginAs('boss@alef.test') },
    ordinary: { email: 'rep@alef.test', token: await loginAs('rep@alef.test') },
  };
  const b: Org = {
    id: bId,
    full: { email: 'admin@hiva.local', token: await loginAs('admin@hiva.local') },
    ordinary: { email: 'sales@hiva.local', token: await loginAs('sales@hiva.local') },
  };
  return {
    a, b, filled: created,
    relogin: async (who) => { who.token = await loginAs(who.email); return who.token; },
  };
}

interface Route { method: string; url: string }

/** Fastify's route tree, flattened: a child's path is its parent's plus its own segment. */
export function routesOf(server: FastifyInstance): Route[] {
  const out: Route[] = [];
  const stack: string[] = [];
  for (const line of server.printRoutes({ commonPrefix: false }).split('\n')) {
    const m = /^((?:│ {3}| {4})*)(?:├── |└── )(.*?)(?: \(([^)]*)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    const full = (stack[depth - 1] ?? '') + m[2];
    stack[depth] = full;
    for (const method of m[3]?.split(', ') ?? []) out.push({ method, url: full });
  }
  return out;
}
