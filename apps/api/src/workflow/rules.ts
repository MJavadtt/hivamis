/**
 * Effective-dated rule sets (roadmap #4).
 *
 * The rules — state machines, role permissions, the SLA catalogue — are data, declared in
 * @hiva/contracts. Until now a change to any of them rewrote history: there was no way to say
 * under which rules a transition had been allowed. Now each rule set is fingerprinted at boot;
 * a new fingerprint is a new version row with the full snapshot; and every transition records
 * the versions in force when it happened. An auditor can ask "was this right under the rules of
 * that time", and get the rules of that time.
 */
import { createHash } from 'node:crypto';
import { ROLE_PERMISSIONS, SLA_POLICIES, WORKFLOWS } from '@hiva/contracts';
import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { extensionSnapshot } from './registry.js';
import { grantSnapshot } from '../auth/grants.js';
import { customRoleCatalogue } from '../auth/roles.js';

export type RuleKind = 'workflows' | 'permissions' | 'sla';
export const RULE_KINDS: readonly RuleKind[] = ['workflows', 'permissions', 'sla'];

export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  workflows: 'ماشین‌های حالت (گردش کار، Guardها، دسترسی هر انتقال)',
  permissions: 'نقش‌ها و دسترسی‌ها',
  sla: 'سیاست‌های SLA',
};

/** Key order does not matter to a rule; it must not matter to its fingerprint either. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const fingerprint = (snapshot: unknown) => createHash('sha256').update(canonical(snapshot)).digest('hex').slice(0, 24);

/**
 * What installed extensions add (roadmap #47) rides in the workflows snapshot under this key:
 * installing, changing or removing one is a change of the rules, so it becomes a new version and
 * every transition names it. With none installed the snapshot is exactly Doc_H's.
 */
export const EXTENSIONS_KEY = '~extensions';

/**
 * What organisations' administrators granted their roles (Hivamis task 6) rides in the permissions
 * snapshot under this key, by organisation: a grant changes the rules a transition is judged by, so
 * it is a new version. Shown to a reader only for their own organisation (`scopeSnapshot`).
 */
export const ORGANISATIONS_KEY = '~organisations';
/** Each organisation's own roles, by code (audit F-3): made, renamed or deleted is a new version. */
export const ROLES_KEY = '~roles';

/** The rule sets as the running code declares them, with what organisations granted. Injectable so a change can be simulated. */
export async function currentSnapshots(tx: Tx = prisma): Promise<Record<RuleKind, unknown>> {
  const ext = extensionSnapshot();
  const grants = await grantSnapshot(tx);
  const roles = await customRoleCatalogue(tx);
  return {
    workflows: ext ? { ...WORKFLOWS, [EXTENSIONS_KEY]: ext } : WORKFLOWS,
    permissions: {
      ...ROLE_PERMISSIONS,
      ...(Object.keys(grants).length ? { [ORGANISATIONS_KEY]: grants } : {}),
      ...(Object.keys(roles).length ? { [ROLES_KEY]: roles } : {}),
    },
    sla: SLA_POLICIES,
  };
}

/** A snapshot as one organisation may read it: its own grants, not another's. */
export function scopeSnapshot(kind: string, snapshot: unknown, organizationId: string): unknown {
  if (kind !== 'permissions' || !snapshot || typeof snapshot !== 'object') return snapshot;
  const s = snapshot as Record<string, unknown>;
  const { [ORGANISATIONS_KEY]: _grants, [ROLES_KEY]: _roles, ...rest } = s;
  const out: Record<string, unknown> = { ...rest };
  // Its own grants and its own roles: never another organisation's.
  for (const key of [ORGANISATIONS_KEY, ROLES_KEY]) {
    const all = s[key] as Record<string, unknown> | undefined;
    if (all?.[organizationId]) out[key] = { [organizationId]: all[organizationId] };
  }
  return out;
}

export interface CurrentRules { workflows: string; permissions: string; sla: string }

let current: CurrentRules | null = null;

/**
 * Register whatever the running code declares. Idempotent: an unchanged set registers nothing;
 * a changed one becomes the next version, effective from now. Returns the ids in force.
 */
export async function registerRuleSets(
  tx: Tx = prisma, given?: Record<RuleKind, unknown>, note?: string,
): Promise<CurrentRules & { registered: RuleKind[] }> {
  const snapshots = given ?? await currentSnapshots(tx);
  const ids: Partial<CurrentRules> = {};
  const registered: RuleKind[] = [];
  for (const kind of RULE_KINDS) {
    const snapshot = snapshots[kind];
    const hash = fingerprint(snapshot);
    const existing = await tx.ruleSetVersion.findUnique({ where: { kind_hash: { kind, hash } } });
    if (existing) { ids[kind] = existing.id; continue; }
    const last = await tx.ruleSetVersion.findFirst({ where: { kind }, orderBy: { version: 'desc' }, select: { version: true } });
    const row = await tx.ruleSetVersion.create({
      data: { kind, version: (last?.version ?? 0) + 1, hash, snapshot: snapshot as object, note: note ?? null },
    }).catch(async (e: unknown) => {
      // Another process registered the same rules a moment earlier: theirs is the version. Outside a
      // transaction only — inside one, the failed insert has already ended it.
      if (tx !== prisma || (e as { code?: string }).code !== 'P2002') throw e;
      const theirs = await tx.ruleSetVersion.findUnique({ where: { kind_hash: { kind, hash } } });
      if (!theirs) throw e;
      return theirs;
    });
    ids[kind] = row.id;
    if (row.hash === hash && row.version === (last?.version ?? 0) + 1) registered.push(kind);
  }
  current = ids as CurrentRules;
  return { ...current, registered };
}

let registering: Promise<unknown> | null = null;

/**
 * The versions in force now — what a transition stamps itself with. Requests that arrive together
 * after a change share one registration: separately, they raced to create the same version, and the
 * loser answered 500.
 */
export async function rulesInForce(tx: Tx = prisma): Promise<CurrentRules> {
  if (current) return current;
  if (tx !== prisma) { await registerRuleSets(tx); return current!; }
  registering ??= registerRuleSets().finally(() => { registering = null; });
  await registering;
  return current!;
}

/** For tests and hot reloads: forget the cached ids so the next call re-registers. */
export function resetRulesCache(): void { current = null; }

/** Which version of each kind was effective at an instant. */
export async function rulesAt(tx: Tx, at: Date) {
  const out: Record<RuleKind, { id: string; version: number; effectiveFrom: Date } | null> = { workflows: null, permissions: null, sla: null };
  for (const kind of RULE_KINDS) {
    const row = await tx.ruleSetVersion.findFirst({
      where: { kind, effectiveFrom: { lte: at } }, orderBy: { version: 'desc' },
      select: { id: true, version: true, effectiveFrom: true },
    });
    out[kind] = row;
  }
  return out;
}

export interface RuleDiff {
  kind: RuleKind;
  from: number;
  to: number;
  /** Human-readable lines, Persian, one per change. */
  changes: string[];
}

/** What changed between two versions of one kind, in words a person can act on. */
export function diffRuleSets(kind: RuleKind, from: unknown, to: unknown): string[] {
  const changes: string[] = [];
  if (kind === 'workflows') {
    const a = from as Record<string, { transitions: Array<Record<string, unknown>>; states: string[] }>;
    const b = to as Record<string, { transitions: Array<Record<string, unknown>>; states: string[] }>;
    for (const entity of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (entity === EXTENSIONS_KEY) continue;
      if (!a[entity]) { changes.push(`ماشین حالت «${entity}» اضافه شد`); continue; }
      if (!b[entity]) { changes.push(`ماشین حالت «${entity}» حذف شد`); continue; }
      for (const s of b[entity].states.filter((x) => !a[entity]!.states.includes(x))) changes.push(`${entity}: وضعیت «${s}» اضافه شد`);
      for (const s of a[entity].states.filter((x) => !b[entity]!.states.includes(x))) changes.push(`${entity}: وضعیت «${s}» حذف شد`);
      const key = (t: Record<string, unknown>) => `${(t.from as string[]).join('|')}→${t.to}:${t.action}`;
      const am = new Map(a[entity].transitions.map((t) => [key(t), t]));
      const bm = new Map(b[entity].transitions.map((t) => [key(t), t]));
      for (const [k, t] of bm) {
        const prev = am.get(k);
        if (!prev) { changes.push(`${entity}: انتقال «${t.action}» اضافه شد`); continue; }
        for (const field of ['permission', 'guards', 'requiresReason', 'startsSla', 'stopsSla', 'pausesSla', 'resumesSla']) {
          if (canonical(prev[field]) !== canonical(t[field])) {
            changes.push(`${entity}.${t.action}: «${field}» از ${JSON.stringify(prev[field] ?? null)} به ${JSON.stringify(t[field] ?? null)} تغییر کرد`);
          }
        }
      }
      for (const [k, t] of am) if (!bm.has(k)) changes.push(`${entity}: انتقال «${t.action}» حذف شد`);
    }
    const none = { guards: [], attachments: [], effects: [] } as Record<string, string[]>;
    const ea = ((a as Record<string, unknown>)[EXTENSIONS_KEY] ?? none) as Record<string, string[]>;
    const eb = ((b as Record<string, unknown>)[EXTENSIONS_KEY] ?? none) as Record<string, string[]>;
    for (const [field, label] of [['guards', 'قانون'], ['attachments', 'قانون روی انتقال'], ['effects', 'اثر']] as const) {
      for (const x of (eb[field] ?? []).filter((v) => !(ea[field] ?? []).includes(v))) changes.push(`افزونه: ${label} «${x}» اضافه شد`);
      for (const x of (ea[field] ?? []).filter((v) => !(eb[field] ?? []).includes(v))) changes.push(`افزونه: ${label} «${x}» حذف شد`);
    }
  } else if (kind === 'permissions') {
    const a = from as Record<string, string[]>; const b = to as Record<string, string[]>;
    // What an organisation's administrator granted, in words (Hivamis task 6).
    const ga = (a as Record<string, unknown>)[ORGANISATIONS_KEY] as Record<string, Record<string, string[]>> | undefined ?? {};
    const gb = (b as Record<string, unknown>)[ORGANISATIONS_KEY] as Record<string, Record<string, string[]>> | undefined ?? {};
    for (const org of new Set([...Object.keys(ga), ...Object.keys(gb)])) {
      for (const role of new Set([...Object.keys(ga[org] ?? {}), ...Object.keys(gb[org] ?? {})])) {
        const was = ga[org]?.[role] ?? a[role] ?? [], now = gb[org]?.[role] ?? b[role] ?? [];
        for (const p of now.filter((x) => !was.includes(x))) changes.push(`${role}: دسترسی «${p}» را مدیر سیستم داد`);
        for (const p of was.filter((x) => !now.includes(x))) changes.push(`${role}: دسترسی «${p}» را مدیر سیستم گرفت`);
      }
    }
    // The roles an organisation made, renamed or deleted (audit F-3).
    type Catalogue = Record<string, Record<string, { nameFa: string }>>;
    const ra = (a as Record<string, unknown>)[ROLES_KEY] as Catalogue | undefined ?? {};
    const rb = (b as Record<string, unknown>)[ROLES_KEY] as Catalogue | undefined ?? {};
    for (const org of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      for (const code of new Set([...Object.keys(ra[org] ?? {}), ...Object.keys(rb[org] ?? {})])) {
        const was = ra[org]?.[code], now = rb[org]?.[code];
        if (!was) changes.push(`نقش «${now!.nameFa}» (${code}) را مدیر سیستم ساخت`);
        else if (!now) changes.push(`نقش «${was.nameFa}» (${code}) را مدیر سیستم حذف کرد`);
        else if (was.nameFa !== now.nameFa) changes.push(`نقش ${code}: نامش از «${was.nameFa}» به «${now.nameFa}» تغییر کرد`);
      }
    }
    for (const role of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (role === ORGANISATIONS_KEY || role === ROLES_KEY) continue;
      if (!a[role]) { changes.push(`نقش «${role}» اضافه شد`); continue; }
      if (!b[role]) { changes.push(`نقش «${role}» حذف شد`); continue; }
      for (const p of b[role].filter((x) => !a[role]!.includes(x))) changes.push(`${role}: دسترسی «${p}» اضافه شد`);
      for (const p of a[role].filter((x) => !b[role]!.includes(x))) changes.push(`${role}: دسترسی «${p}» حذف شد`);
    }
  } else {
    const a = new Map((from as Array<Record<string, unknown>>).map((p) => [p.code as string, p]));
    const b = new Map((to as Array<Record<string, unknown>>).map((p) => [p.code as string, p]));
    for (const [code, p] of b) {
      const prev = a.get(code);
      if (!prev) { changes.push(`سیاست «${code}» اضافه شد`); continue; }
      for (const field of ['hours', 'warnAt']) {
        if (prev[field] !== p[field]) changes.push(`${code}: «${field}» از ${prev[field]} به ${p[field]} تغییر کرد`);
      }
    }
    for (const code of a.keys()) if (!b.has(code)) changes.push(`سیاست «${code}» حذف شد`);
  }
  return changes;
}
