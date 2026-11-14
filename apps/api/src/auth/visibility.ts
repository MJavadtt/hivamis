import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { isSystemAdmin } from './grants.js';
import { notFound } from '../lib/errors.js';
import { actorFrom } from '../lib/http.js';

/**
 * Whose records a person sees (the owner, 2026-11-14; ADR-127): «هر کاربر باید وظایف، پروژه‌ها و
 * موارد مربوط به خودش را صرفاً دسترسی داشته باشد، مدیر هر بخش برای تمام نفرات بخش خودش و مدیران
 * بالاتر برای همه را».
 *
 * - **All**: the system administrator, and whoever holds `record.see_all` (the managing director, the
 *   deputy, and the operations manager who runs the project portfolio, by default).
 * - **A unit**: the manager the unit names (`Department.managerId`), and whoever holds `record.see_unit`
 *   for their own unit — every record anyone in it owns, is assigned or made, and the unit's work.
 * - **Their own**: everyone else — what they own, are assigned to or made, and what hangs off it: the
 *   project a task of theirs is in, its client, its contract.
 * - `record.see_commercial` adds every client, project, contract, invoice and payment — finance and legal
 *   issue them for every client — but not another unit's tasks.
 *
 * Applied where a record is read: lists, detail pages, pickers, search, the assistant, printing and
 * files. Permissions still decide whether a kind of record is read at all; this decides which ones.
 * Totals on the management reports are not narrowed — they are a manager's view, gated by permission.
 */

export interface Reach {
  /** Sees every record. */
  all: boolean;
  /** Sees every commercial record (clients, projects, contracts, invoices, payments). */
  commercial: boolean;
  me: string;
  /** Whose records count as theirs: themselves, and everyone in the units they manage. */
  users: string[];
  /** The codes of the units they manage. */
  units: string[];
  /** What they may do: a record waiting for a move they may make is in their unit's inbox. */
  permissions: readonly string[];
}

export interface ReachActor {
  id: string; organizationId: string; departmentCode?: string | null;
  permissions: readonly string[]; roles: readonly string[]; delegatedRoles?: Record<string, string>;
}

const TTL_MS = 5_000;
const memo = new Map<string, { at: number; reach: Reach }>();

export async function reachOf(actor: ReachActor): Promise<Reach> {
  const all = isSystemAdmin({ roles: actor.roles, delegatedRoles: actor.delegatedRoles }) || actor.permissions.includes('record.see_all');
  const commercial = actor.permissions.includes('record.see_commercial');
  if (all) return { all, commercial: true, me: actor.id, users: [actor.id], units: [], permissions: actor.permissions };
  const key = `${actor.id}|${actor.permissions.includes('record.see_unit') ? 'u' : ''}|${actor.departmentCode ?? ''}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.reach, commercial, permissions: actor.permissions };

  const managed = await prisma.department.findMany({
    where: {
      organizationId: actor.organizationId,
      OR: [
        { managerId: actor.id },
        ...(actor.permissions.includes('record.see_unit') && actor.departmentCode ? [{ code: actor.departmentCode }] : []),
      ],
    },
    select: { id: true, code: true },
  });
  const people = managed.length
    ? await prisma.user.findMany({ where: { organizationId: actor.organizationId, departmentId: { in: managed.map((d) => d.id) } }, select: { id: true } })
    : [];
  const reach: Reach = {
    all: false, commercial, me: actor.id,
    users: [...new Set([actor.id, ...people.map((p) => p.id)])],
    units: managed.map((d) => d.code),
    permissions: actor.permissions,
  };
  memo.set(key, { at: Date.now(), reach });
  return reach;
}

/** The request's reach, worked out once a request. */
const perRequest = new WeakMap<FastifyRequest, Promise<Reach>>();
export function reachFor(req: FastifyRequest, actor: ReachActor): Promise<Reach> {
  let r = perRequest.get(req);
  if (!r) { r = reachOf(actor); perRequest.set(req, r); }
  return r;
}

export const forgetReach = () => memo.clear();

/** The kinds of record a reach narrows. */
export const VISIBLE_MODELS = [
  'project', 'task', 'workOrder', 'lead', 'opportunity', 'company', 'contact', 'activity', 'brief', 'proposal',
  'contract', 'invoice', 'payment', 'deliverable', 'qcReview', 'revision', 'changeRequest', 'risk', 'issue', 'decision',
  'meeting', 'statusReport', 'outsourceRequest', 'mediaOrder', 'milestone', 'siteProject',
] as const;
export type VisibleModel = (typeof VISIBLE_MODELS)[number];
export const isVisibleModel = (m: string): m is VisibleModel => (VISIBLE_MODELS as readonly string[]).includes(m);

const COMMERCIAL: ReadonlySet<VisibleModel> = new Set(['company', 'contact', 'project', 'contract', 'invoice', 'payment', 'opportunity', 'lead', 'proposal', 'mediaOrder', 'siteProject']);

type Where = Record<string, unknown>;

/**
 * The Prisma `where` that keeps `model` to what this reach sees; undefined when it sees them all. Built
 * from a few roots — a project, a client, a sale — that the rest hang off.
 */
export function visibleWhere(model: VisibleModel, reach: Reach): Where | undefined {
  if (reach.all || (reach.commercial && COMMERCIAL.has(model))) return undefined;
  const U = { in: reach.users };
  const D = reach.units.length ? { in: reach.units } : null;

  // A project is theirs when they own it, are on its RACI or allocated to it, hold a task or work order
  // in it, or — for a unit's manager — the unit has work in it.
  const project: Where = {
    OR: [
      { accountOwnerId: U },
      { raciAssignments: { some: { userId: U } } },
      { allocations: { some: { userId: U } } },
      { tasks: { some: { OR: [{ assigneeId: U }, { createdById: U }] } } },
      { workOrders: { some: { ownerId: U } } },
      { company: { OR: [{ accountOwnerId: U }, { salesOwnerId: U }] } },
      ...(D ? [
        { tasks: { some: { departmentCode: D } } },
        { workOrders: { some: { targetDepartmentCode: D } } },
        { raciAssignments: { some: { departmentCode: D } } },
      ] : []),
    ],
  };
  // A sale is theirs when they own it, or own the lead it came from.
  const opportunity: Where = { OR: [{ ownerId: U }, { lead: { OR: [{ ownerId: U }, { sourceUserId: U }] } }, { projects: { some: project } }] };
  // A client is theirs when they hold its account or its sale, own one of its leads or sales, or work on one of its projects.
  const company: Where = {
    OR: [
      { accountOwnerId: U }, { salesOwnerId: U },
      { leads: { some: { OR: [{ ownerId: U }, { sourceUserId: U }] } } },
      { opportunities: { some: { ownerId: U } } },
      { projects: { some: project } },
    ],
  };
  // A brief sent to Account waits in its inbox for whoever reviews briefs; once one of them starts the
  // review it is theirs — and the proposal made from it with it.
  const can = (p: string) => reach.permissions.includes(p);
  const brief: Where = {
    OR: [
      { submittedById: U }, { reviewedById: U }, { opportunity },
      { opportunity: { company: { accountOwnerId: U } } },
      { projects: { some: project } },
      ...(can('brief.review') ? [{ state: 'SUBMITTED' }] : []),
    ],
  };
  // A proposal is also the units' that have a work order on it.
  const proposal: Where = {
    OR: [
      { pricedById: U }, { pricingApprovedById: U }, { brief }, { projects: { some: project } },
      { workOrders: { some: { OR: [{ ownerId: U }, { tasks: { some: { assigneeId: U } } }, ...(D ? [{ targetDepartmentCode: D }] : [])] } } },
    ],
  };
  const task: Where = {
    OR: [
      { assigneeId: U }, { createdById: U },
      { workOrder: { ownerId: U } },
      { project: { accountOwnerId: U } },
      ...(D ? [{ departmentCode: D }] : []),
    ],
  };
  const workOrder: Where = {
    OR: [
      { ownerId: U }, { acceptedById: U },
      { tasks: { some: { assigneeId: U } } },
      { project: { accountOwnerId: U } },
      ...(D ? [{ targetDepartmentCode: D }] : []),
    ],
  };
  const deliverable: Where = { OR: [{ project }, { proposal }, { workOrder }, { tasks: { some: { assigneeId: U } } }, ...(D ? [{ departmentCode: D }] : [])] };

  switch (model) {
    case 'project': return project;
    case 'company': return company;
    case 'opportunity': return opportunity;
    case 'brief': return brief;
    case 'proposal': return proposal;
    case 'task': return task;
    case 'workOrder': return workOrder;
    case 'deliverable': return deliverable;
    // A lead nobody owns yet waits in the sales team's inbox.
    case 'lead': return { OR: [{ ownerId: U }, { sourceUserId: U }, { opportunities: { some: { ownerId: U } } }, ...(can('crm.lead.write') ? [{ ownerId: null }] : [])] };
    case 'contact': return { company };
    case 'activity': return { OR: [{ createdById: U }, { project }, { opportunity }, { company }] };
    case 'contract': return { OR: [{ createdById: U }, { project }, { company }] };
    case 'invoice': return { OR: [{ createdById: U }, { project }, { company }] };
    case 'payment': return { OR: [{ createdById: U }, { project }, { invoice: { OR: [{ project }, { company }] } }] };
    case 'qcReview': return { OR: [{ reviewerId: U }, { deliverable }, { task }] };
    case 'revision': return { OR: [{ assigneeId: U }, { requestedById: U }, { deliverable }, ...(D ? [{ responsibleDepartmentCode: D }] : [])] };
    case 'risk': case 'issue': return { OR: [{ ownerId: U }, { project }] };
    case 'decision': return { OR: [{ decidedById: U }, { project }] };
    case 'changeRequest': return { OR: [{ createdById: U }, { project }] };
    case 'meeting': return { OR: [{ createdById: U }, { project }, { company }] };
    case 'statusReport': return { OR: [{ createdById: U }, { project }] };
    case 'milestone': return { project };
    case 'mediaOrder': return { OR: [{ createdById: U }, { project }] };
    case 'outsourceRequest': return { OR: [{ requestedById: U }, { project }, { workOrder }] };
    case 'siteProject': return { OR: [{ responsibleId: U }, { createdById: U }, { assignments: { some: { userId: U } } }, { project }] };
  }
}

/** `where` with what the reach sees added to it. */
export function narrowed(model: VisibleModel, reach: Reach, where: Where): Where {
  const v = visibleWhere(model, reach);
  return v ? { AND: [where, v] } : where;
}

/** Whether one record is in reach — for the paths that read it by id. */
export async function canSee(model: VisibleModel, reach: Reach, id: string): Promise<boolean> {
  const v = visibleWhere(model, reach);
  if (!v) return true;
  const delegate = (prisma as unknown as Record<string, { count(args: unknown): Promise<number> }>)[model]!;
  return (await delegate.count({ where: { AND: [{ id }, v] } })) > 0;
}

/** The address segment each kind of record is read under: `/projects/:id/...`. */
const SEGMENTS: Record<string, VisibleModel> = {
  projects: 'project', tasks: 'task', 'work-orders': 'workOrder', leads: 'lead', opportunities: 'opportunity',
  companies: 'company', contacts: 'contact', briefs: 'brief', proposals: 'proposal', contracts: 'contract',
  invoices: 'invoice', payments: 'payment', deliverables: 'deliverable', 'qc-reviews': 'qcReview', revisions: 'revision',
  'change-requests': 'changeRequest', risks: 'risk', issues: 'issue', decisions: 'decision', meetings: 'meeting',
  'status-reports': 'statusReport', 'outsource-requests': 'outsourceRequest', 'media-orders': 'mediaOrder',
  'site-projects': 'siteProject',
};
/** The workflow's names for them (`/workflow/:entity/:id`). */
const ENTITIES: Record<string, VisibleModel> = Object.fromEntries((VISIBLE_MODELS as readonly string[]).map((m) => [m, m as VisibleModel]));
/** And the printed documents' (`/pdf/:kind/:id`). */
const PDF_KINDS: Record<string, VisibleModel> = {
  brief: 'brief', proposal: 'proposal', contract: 'contract', invoice: 'invoice', project: 'project', company: 'company',
  'work-order': 'workOrder', deliverable: 'deliverable', 'qc-review': 'qcReview', revision: 'revision',
  'change-request': 'changeRequest', 'status-report': 'statusReport', meeting: 'meeting', 'closure-report': 'project',
};

/** The record a printed document of this kind is made from. */
export const pdfKindModel = (kind: string): VisibleModel | undefined => PDF_KINDS[kind];

/**
 * The permission that reads each workflow entity and printed document: a caller without it is refused
 * by the route itself, with the 403 and its audit row, before whether they see the record matters.
 */
let readPermission: { entity: (e: string) => string | undefined; kind: (k: string) => readonly string[] | undefined } = { entity: () => undefined, kind: () => undefined };
export function setReadPermissions(p: typeof readPermission) { readPermission = p; }

/** Which record a route reads by id, and how its kind is named: fixed by the address, or by its `:entity`/`:kind`. */
function recordOf(url: string): { model?: VisibleModel; param?: 'entity' | 'kind' } | null {
  if (/\/workflow\/:entity\/:id(\/|$)/.test(url)) return { param: 'entity' };
  if (/\/pdf\/:kind\/:id(\/|$)/.test(url)) return { param: 'kind' };
  const m = /\/([a-z-]+)\/:id(\/|$)/.exec(url);
  return m && SEGMENTS[m[1]!] ? { model: SEGMENTS[m[1]!] } : null;
}

/**
 * Every route that reads or acts on one record by its id answers 404 for a record out of the caller's
 * reach, as for one that does not exist (ADR-127) — appended after the route's own checks, so the
 * caller is known and allowed that kind of record first. Registered before the routes it guards.
 */
export function guardRecordRoutes(api: FastifyInstance) {
  api.addHook('onRoute', (route) => {
    const target = recordOf(route.url);
    if (!target) return;
    const check = async (req: FastifyRequest) => {
      if (!req.user) return;
      const params = req.params as Record<string, string | undefined>;
      const model = target.model ?? (target.param === 'entity' ? ENTITIES[params.entity ?? ''] : PDF_KINDS[params.kind ?? '']);
      if (!model || !params.id) return;
      const needs = target.param === 'entity' ? [readPermission.entity(params.entity ?? '')] : target.param === 'kind' ? readPermission.kind(params.kind ?? '') ?? [] : [];
      if (needs.some((p) => p && !req.user!.permissions.includes(p))) return;
      if (!(await canSee(model, await reachFor(req, actorFrom(req)), params.id))) throw notFound();
    };
    const before = route.preHandler ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler]) : [];
    route.preHandler = [...before, check] as typeof route.preHandler;
  });
}
