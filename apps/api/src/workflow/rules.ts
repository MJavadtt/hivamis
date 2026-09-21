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

/** The rule sets as the running code declares them. Injectable so a change can be simulated. */
export function currentSnapshots(): Record<RuleKind, unknown> {
  return { workflows: WORKFLOWS, permissions: ROLE_PERMISSIONS, sla: SLA_POLICIES };
}

export interface CurrentRules { workflows: string; permissions: string; sla: string }

let current: CurrentRules | null = null;

/**
 * Register whatever the running code declares. Idempotent: an unchanged set registers nothing;
 * a changed one becomes the next version, effective from now. Returns the ids in force.
 */
export async function registerRuleSets(
  tx: Tx = prisma, snapshots: Record<RuleKind, unknown> = currentSnapshots(), note?: string,
): Promise<CurrentRules & { registered: RuleKind[] }> {
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
    });
    ids[kind] = row.id;
    registered.push(kind);
  }
  current = ids as CurrentRules;
  return { ...current, registered };
}

/** The versions in force now — what a transition stamps itself with. */
export async function rulesInForce(tx: Tx = prisma): Promise<CurrentRules> {
  if (!current) await registerRuleSets(tx);
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
  } else if (kind === 'permissions') {
    const a = from as Record<string, string[]>; const b = to as Record<string, string[]>;
    for (const role of new Set([...Object.keys(a), ...Object.keys(b)])) {
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
