import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { env } from '../env.js';
import { audit } from './audit.js';
import { AppError, conflict, notFound } from './errors.js';
import { canSee, isVisibleModel, reachOf, type ReachActor } from '../auth/visibility.js';

/**
 * Deleting a record for good (the owner, 2026-11-16; ADR-132): «امکان حذف کامل سرنخ، مشتری و… وجود
 * ندارد». A lead entered twice, a client made by mistake, a test project: gone, with everything
 * that hangs off it — a client's people, deals, briefs, projects and their tasks and files.
 *
 * What hangs off a record is read from the schema, not listed by hand: every row whose required
 * relation points at it goes first (children before parents), and what is tied to it by kind and
 * id — files, comments, notices, clocks — goes with it. The history stays: audit rows and workflow
 * transitions are never deleted, and the deletion itself is written there with what it took.
 *
 * Refused: a tree holding an invoice that reached the accounting export or the taxpayer system
 * (corrected by a correction, as the law asks), and anything that would take a person, a unit or
 * the organisation with it.
 */

/** Kinds a person may delete, by the name the app calls them; each is its Prisma model in lower camel. */
export const DELETABLE = [
  'lead', 'company', 'contact', 'opportunity', 'brief', 'proposal', 'project', 'task', 'workOrder', 'deliverable',
  'contract', 'invoice', 'payment', 'changeRequest', 'revision', 'risk', 'issue', 'decision', 'meeting', 'statusReport',
  'outsourceRequest', 'supplier', 'mediaOrder', 'venue', 'siteProject', 'booking',
] as const;
export type Deletable = (typeof DELETABLE)[number];
export const isDeletable = (k: string): k is Deletable => (DELETABLE as readonly string[]).includes(k);

/** Never taken along, whatever points at the record. */
const PROTECTED = new Set(['User', 'Organization', 'Department', 'Role', 'Position', 'Team', 'AuditEvent', 'StateTransition', 'SecurityAlert', 'Counter']);
/** History and logs that name a record by kind and id, and keep doing so after it is gone. */
const KEEPS_NAMING = new Set(['AuditEvent', 'StateTransition', 'SecurityAlert', 'AiInteraction']);

const models = Prisma.dmmf.datamodel.models;
const modelOf = (name: string) => models.find((m) => m.name === name)!;
const camel = (name: string) => name[0]!.toLowerCase() + name.slice(1);
const pascal = (kind: string) => kind[0]!.toUpperCase() + kind.slice(1);
type Delegate = {
  findMany(a: unknown): Promise<Record<string, unknown>[]>; deleteMany(a: unknown): Promise<{ count: number }>;
  count(a: unknown): Promise<number>; findFirst(a: unknown): Promise<Record<string, unknown> | null>;
};
const delegate = (db: Tx | typeof prisma, model: string) => (db as unknown as Record<string, Delegate>)[camel(model)]!;

interface Child { model: string; fk: string; cascade: boolean }
/** Rows of other models that cannot outlive a row of `parent`: required relations, and the database's own cascades. */
const childrenOf = (parent: string): Child[] => models.flatMap((m) => m.fields
  .filter((f) => f.kind === 'object' && f.type === parent && f.relationFromFields?.length)
  .map((f) => {
    const fk = f.relationFromFields!.find((c) => c !== 'organizationId') ?? f.relationFromFields![0]!;
    const required = m.fields.find((c) => c.name === fk)?.isRequired ?? false;
    const action = f.relationOnDelete ?? (required ? 'Restrict' : 'SetNull');
    return action === 'SetNull' ? null : { model: m.name, fk, cascade: action === 'Cascade' };
  })
  .filter((c): c is Child => !!c));

/** Models that point at a record by `entityType` + `entityId`. */
const POLYMORPHIC = models.filter((m) => !KEEPS_NAMING.has(m.name) && ['entityType', 'entityId'].every((n) => m.fields.some((f) => f.name === n && f.kind === 'scalar'))).map((m) => m.name);
const hasId = (model: string) => modelOf(model).fields.some((f) => f.name === 'id' && f.isId);

interface Step { model: string; ids: string[]; cascade: boolean }
interface Walk { steps: Step[]; counts: Record<string, number>; files: string[] }

/** Everything that goes with these rows, deepest first. */
async function walk(db: Tx | typeof prisma, model: string, ids: string[], out: Walk, seen: Set<string>, cascade = false): Promise<void> {
  const fresh = ids.filter((id) => !seen.has(`${model}:${id}`));
  if (!fresh.length) return;
  fresh.forEach((id) => seen.add(`${model}:${id}`));
  if (PROTECTED.has(model)) throw conflict('DELETE_WOULD_TAKE', 'این رکورد به بخشی از سازمان (همکار، واحد یا سابقه) گره خورده است و حذف نمی‌شود.');
  for (const c of childrenOf(model)) {
    if (!hasId(c.model)) continue; // join rows: the database's cascade, or the parent's delete below, takes them
    const rows = await delegate(db, c.model).findMany({ where: { [c.fk]: { in: fresh } }, select: { id: true } });
    if (rows.length) await walk(db, c.model, rows.map((r) => r.id as string), out, seen, c.cascade);
  }
  // What names it by kind and id: files, comments, notices, clocks, requests.
  for (const p of POLYMORPHIC) {
    const rows = await delegate(db, p).findMany({ where: { entityType: camel(model), entityId: { in: fresh } }, select: { id: true } });
    if (rows.length) await walk(db, p, rows.map((r) => r.id as string), out, seen);
  }
  // Its files: tied by their own column (a project's, a client's) or by kind and id (ADR-121).
  if (model !== 'Document') {
    const own = `${camel(model)}Id`;
    const byColumn = modelOf('Document').fields.some((f) => f.name === own) ? [{ [own]: { in: fresh } }] : [];
    const docs = await delegate(db, 'Document').findMany({ where: { OR: [...byColumn, { recordType: camel(model), recordId: { in: fresh } }] }, select: { id: true } });
    if (docs.length) await walk(db, 'Document', docs.map((d) => d.id as string), out, seen);
  }
  if (model === 'Document') {
    const docs = await prisma.document.findMany({ where: { id: { in: fresh } }, select: { storedName: true } });
    out.files.push(...docs.map((d) => d.storedName));
  }
  if (model === 'Invoice') {
    const locked = await prisma.invoice.count({
      where: { id: { in: fresh }, OR: [{ accountingExportId: { not: null } }, { taxSubmissions: { some: { status: { in: ['QUEUED', 'SENT', 'ACCEPTED'] } } } }] },
    });
    if (locked) throw conflict('DELETE_POSTED_INVOICE', 'فاکتوری در این مجموعه به خروجی حسابداری یا سامانهٔ مؤدیان رفته است و حذف نمی‌شود؛ اصلاحی یا ابطالی آن را صادر کنید.');
  }
  out.steps.push({ model, ids: fresh, cascade });
  out.counts[model] = (out.counts[model] ?? 0) + fresh.length;
}

async function load(actor: ReachActor, kind: string, id: string) {
  if (!isDeletable(kind)) throw new AppError(400, 'NOT_DELETABLE', 'این نوع رکورد حذف‌شدنی نیست.');
  const model = pascal(kind);
  const record = await delegate(prisma, model).findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!record) throw notFound('رکورد');
  if (isVisibleModel(kind) && !(await canSee(kind, await reachOf(actor), id))) throw notFound('رکورد');
  return { model, record };
}

const nameOf = (r: Record<string, unknown>) => [r.code ?? r.number, r.title ?? r.name ?? r.legalName ?? r.fullName ?? r.subject].filter(Boolean).join(' — ');

/** What deleting it would take, by model — said before the person confirms. */
export async function deletionPlan(actor: ReachActor, kind: string, id: string) {
  const { model, record } = await load(actor, kind, id);
  const out: Walk = { steps: [], counts: {}, files: [] };
  await walk(prisma, model, [id], out, new Set());
  const { [model]: _self, ...others } = out.counts;
  return { kind, id, name: nameOf(record), takes: others, files: out.files.length };
}

export interface DeleteActor extends ReachActor { ipAddress?: string | null; userAgent?: string | null; requestId?: string | null }

export async function deleteRecord(actor: DeleteActor, kind: string, id: string, reason?: string) {
  const { model, record } = await load(actor, kind, id);
  const out: Walk = { steps: [], counts: {}, files: [] };
  await prisma.$transaction(async (tx) => {
    await walk(tx, model, [id], out, new Set());
    for (const s of out.steps) await delegate(tx, s.model).deleteMany({ where: { id: { in: s.ids } } });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: kind, entityId: id,
      before: { name: nameOf(record), state: record.state ?? null }, after: { deleted: out.counts, files: out.files.length },
      reason: reason?.trim() || null, ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
    }, tx);
  }, { timeout: 120_000, maxWait: 20_000 });
  // The files go after the commit: a failure above leaves every file where it was.
  const root = path.resolve(env.STORAGE_DIR);
  for (const f of out.files) {
    const target = path.join(root, f);
    if (target.startsWith(root + path.sep)) await unlink(target).catch(() => undefined);
  }
  return { kind, id, name: nameOf(record), deleted: out.counts, files: out.files.length };
}
