/**
 * The rule lab (roadmap #5): regression testing for organisational policy.
 *
 * A manager proposes a change — "Account QC is not required to approve a proposal", "Sales
 * may convert leads" — and the lab replays history under it: which past transitions would now
 * be blocked, and which past blocked attempts would now go through. Nothing is written. The
 * rules are data and the log is complete, which is why this is possible at all.
 *
 * What it can and cannot know, stated rather than glossed:
 *  - Permissions are replayed against the actor's *current* roles. Roles at the time are not
 *    recorded; the lab says so in `assumptions`.
 *  - A guard the candidate adds is evaluated against the record *as it stands today*, not as
 *    it stood then. That is the only data there is, and a guard that fails today on a record
 *    that has since moved on is a fair proxy for "this rule bites".
 *  - A guard the candidate removes is credited from TRANSITION_BLOCKED rows: attempts that
 *    failed on exactly that guard. Attempts before that row existed are invisible.
 */
import { ROLE_PERMISSIONS, WORKFLOWS } from '@hiva/contracts';
import type { Tx } from '../db.js';
import { runAllGuards } from './guards.js';
import { allGuards, hasGuard } from './registry.js';
import { delegate } from './engine.js';
import { grantsOf } from '../auth/grants.js';

export type LabEdit =
  | { kind: 'transition'; entity: string; action: string; guards?: string[]; permission?: string | null; requiresReason?: boolean }
  | { kind: 'role'; role: string; add?: string[]; remove?: string[] };

export interface LabInput {
  edits: LabEdit[];
  since?: Date;
  /** Cap on transitions replayed, newest first. */
  limit?: number;
}

export interface LabFinding {
  transitionId: string | null;
  auditId: string | null;
  entity: string;
  entityId: string;
  action: string;
  at: Date;
  actorId: string | null;
  /** Why the candidate rules reach a different verdict. */
  because: 'ILLEGAL' | 'PERMISSION' | 'GUARD_ADDED' | 'GUARD_REMOVED';
  detail: string;
}

export interface LabResult {
  edits: LabEdit[];
  candidate: { workflows: typeof WORKFLOWS; permissions: Record<string, string[]> };
  replayed: number;
  blockedAttempts: number;
  wouldBlock: LabFinding[];
  wouldAllow: LabFinding[];
  summary: { wouldBlock: number; wouldAllow: number; byEntity: Record<string, { wouldBlock: number; wouldAllow: number }> };
  assumptions: string[];
  invalid: string[];
}

/** The candidate rule sets: the running ones, with the edits applied. */
export function applyEdits(edits: LabEdit[], base: Record<string, readonly string[]> = ROLE_PERMISSIONS): { workflows: typeof WORKFLOWS; permissions: Record<string, string[]>; invalid: string[] } {
  // A deep copy, typed loosely: the edits write fields the declared types hold readonly.
  const workflows = JSON.parse(JSON.stringify(WORKFLOWS)) as unknown as Record<string, { transitions: Array<Record<string, unknown>> }>;
  const permissions = JSON.parse(JSON.stringify(base)) as Record<string, string[]>;
  const invalid: string[] = [];
  for (const e of edits) {
    if (e.kind === 'transition') {
      const wf = workflows[e.entity];
      const def = wf?.transitions.find((t) => t.action === e.action);
      if (!def) { invalid.push(`انتقال «${e.entity}.${e.action}» وجود ندارد`); continue; }
      if (e.guards) {
        const unknown = e.guards.filter((g) => !hasGuard(g));
        if (unknown.length) { invalid.push(`قانون کنترلی ناشناخته: ${unknown.join('، ')}`); continue; }
        def.guards = e.guards;
      }
      if (e.permission !== undefined) def.permission = e.permission ?? undefined;
      if (e.requiresReason !== undefined) def.requiresReason = e.requiresReason;
    } else {
      if (!permissions[e.role]) { invalid.push(`نقش «${e.role}» وجود ندارد`); continue; }
      const set = new Set(permissions[e.role]);
      for (const p of e.add ?? []) set.add(p);
      for (const p of e.remove ?? []) set.delete(p);
      permissions[e.role] = [...set];
    }
  }
  return { workflows: workflows as unknown as typeof WORKFLOWS, permissions, invalid };
}

export async function runLab(tx: Tx, organizationId: string, input: LabInput): Promise<LabResult> {
  // Against the roles as this organisation has granted them (Hivamis task 6), not the defaults.
  const { workflows, permissions, invalid } = applyEdits(input.edits, (await grantsOf(organizationId, tx)).map);
  const limit = Math.min(input.limit ?? 2000, 5000);
  const touched = new Set(input.edits.filter((e): e is Extract<LabEdit, { kind: 'transition' }> => e.kind === 'transition').map((e) => e.entity));
  const roleEdits = input.edits.filter((e) => e.kind === 'role');

  const rows = await tx.stateTransition.findMany({
    where: {
      organizationId, cascade: false, opening: false,
      ...(touched.size && !roleEdits.length ? { entityType: { in: [...touched] } } : {}),
      ...(input.since ? { createdAt: { gte: input.since } } : {}),
    },
    orderBy: { createdAt: 'desc' }, take: limit,
  });

  // Actors' roles, once.
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
  const roleRows = actorIds.length
    ? await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, roles: { select: { role: { select: { code: true } } } } } })
    : [];
  const rolesOf = new Map(roleRows.map((u) => [u.id, u.roles.map((r) => r.role.code)]));
  const permsUnder = (roles: string[]) => new Set(roles.flatMap((r) => permissions[r] ?? []));

  const wouldBlock: LabFinding[] = [];
  const recordCache = new Map<string, Record<string, unknown> | null>();

  for (const r of rows) {
    const original = WORKFLOWS[r.entityType]?.transitions.find((t) => t.action === r.action && t.from.includes(r.fromState));
    const wf = workflows[r.entityType];
    const def = wf?.transitions.find((t) => t.action === r.action && t.from.includes(r.fromState));
    const base = { transitionId: r.id, auditId: null, entity: r.entityType, entityId: r.entityId, action: r.action, at: r.createdAt, actorId: r.actorId };
    if (!def) { wouldBlock.push({ ...base, because: 'ILLEGAL', detail: `انتقال «${r.action}» از «${r.fromState}» دیگر تعریف نشده است` }); continue; }

    if (def.permission && r.actorId) {
      const held = permsUnder(rolesOf.get(r.actorId) ?? []);
      if (!held.has(def.permission)) {
        wouldBlock.push({ ...base, because: 'PERMISSION', detail: `عامل دسترسی «${def.permission}» را نمی‌داشت` });
        continue;
      }
    }

    const added = (def.guards ?? []).filter((g) => !(original?.guards ?? []).includes(g));
    if (added.length) {
      const key = `${r.entityType}:${r.entityId}`;
      if (!recordCache.has(key)) {
        recordCache.set(key, await delegate(tx, r.entityType).findFirst({ where: { id: r.entityId, organizationId } }));
      }
      const record = recordCache.get(key);
      if (record) {
        const checks = await runAllGuards(added, { tx, entity: r.entityType, id: r.entityId, record, payload: {}, actorId: r.actorId ?? '' });
        const failing = checks.find((c) => !c.ok);
        if (failing) wouldBlock.push({ ...base, because: 'GUARD_ADDED', detail: `${failing.labelFa}: ${failing.messageFa ?? ''} (بر اساس وضعیت امروز رکورد)` });
      }
    }
  }

  // Attempts that failed on a guard the candidate no longer has.
  const removedByAction = new Map<string, Set<string>>();
  for (const e of input.edits) {
    if (e.kind !== 'transition' || !e.guards) continue;
    const original = WORKFLOWS[e.entity]?.transitions.find((t) => t.action === e.action);
    const removed = (original?.guards ?? []).filter((g) => !e.guards!.includes(g));
    if (removed.length) removedByAction.set(`${e.entity}.${e.action}`, new Set(removed));
  }
  const wouldAllow: LabFinding[] = [];
  let blockedAttempts = 0;
  if (removedByAction.size) {
    const blocked = await tx.auditEvent.findMany({
      where: { organizationId, action: 'TRANSITION_BLOCKED', entityType: { in: [...new Set([...removedByAction.keys()].map((k) => k.split('.')[0]!))] }, ...(input.since ? { createdAt: { gte: input.since } } : {}) },
      orderBy: { createdAt: 'desc' }, take: limit,
    });
    blockedAttempts = blocked.length;
    for (const b of blocked) {
      const after = b.after as { action?: string; guard?: string | null; rule?: string } | null;
      const removed = removedByAction.get(`${b.entityType}.${after?.action}`);
      if (after?.guard && removed?.has(after.guard)) {
        wouldAllow.push({ transitionId: null, auditId: b.id, entity: b.entityType, entityId: b.entityId ?? '', action: after.action ?? '', at: b.createdAt, actorId: b.actorId, because: 'GUARD_REMOVED', detail: `قبلاً با «${after.guard}» مسدود شد؛ اکنون عبور می‌کرد` });
      }
    }
  }

  const byEntity: Record<string, { wouldBlock: number; wouldAllow: number }> = {};
  for (const f of wouldBlock) (byEntity[f.entity] ??= { wouldBlock: 0, wouldAllow: 0 }).wouldBlock++;
  for (const f of wouldAllow) (byEntity[f.entity] ??= { wouldBlock: 0, wouldAllow: 0 }).wouldAllow++;

  return {
    edits: input.edits, candidate: { workflows, permissions },
    replayed: rows.length, blockedAttempts, wouldBlock, wouldAllow,
    summary: { wouldBlock: wouldBlock.length, wouldAllow: wouldAllow.length, byEntity },
    assumptions: [
      'دسترسی‌ها بر اساس نقش‌های فعلی هر عامل بازپخش شده‌اند، نه نقش‌های او در زمان انتقال — نقش‌های آن زمان ثبت نمی‌شود.',
      'قانون کنترلی تازه‌افزوده روی وضعیت امروز رکورد ارزیابی شده است، نه وضعیت آن زمان.',
      'انتقال‌های آبشاری بازپخش نمی‌شوند؛ آن‌ها پیامد حرکتی روی رکورد دیگرند.',
    ],
    invalid,
  };
}

/** Every registered guard, core and extension — read when asked, since extensions load at boot. */
export const allGuardIds = () => allGuards().map((g) => g.key);
