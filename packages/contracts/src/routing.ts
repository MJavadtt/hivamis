import { ROLE_LABELS, type RoleCode } from './enums.js';
import type { FieldDef } from './form-fields.js';

/**
 * Conditional approval routing (roadmap #17).
 *
 * Doc_H fixes each form's `approverRoles`, and that is the floor: who must always see it. But
 * real authority is conditional — "a contract above this figure goes through Legal", "a margin
 * under the floor needs the CEO" — and until now the only way to express that was a separate
 * form, or nothing at all.
 *
 * The field-condition pattern already exists in this file's neighbour: `visibleWhen` decides
 * whether a field is shown. The same shape, with comparisons and boolean grouping, decides who
 * has to approve. Rules are data on the definition, versioned with it (#16), and every rule
 * carries `whenFa` — the sentence a manager wrote — so the reason an approver was added can be
 * shown to the person filling the form and kept on the submission afterwards.
 *
 * Thresholds are the organisation's, not Doc_H's: the catalogue ships a small set of defaults
 * (`source: 'DEFAULT'`) that an administrator is expected to adjust.
 */

export type RoutingOperator =
  | 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'
  | 'in' | 'notIn'
  | 'isTrue' | 'isFalse' | 'isSet' | 'isEmpty'
  /** Numeric comparison against another field: "sale price below total cost". */
  | 'ltField' | 'gtField';

export interface RoutingLeaf {
  readonly field: string;
  readonly op: RoutingOperator;
  /** A number, a string, a list for `in`/`notIn`, or another field's key for `ltField`/`gtField`. */
  readonly value?: number | string | readonly string[];
}
export interface RoutingAll { readonly all: readonly RoutingCondition[] }
export interface RoutingAny { readonly any: readonly RoutingCondition[] }
export type RoutingCondition = RoutingLeaf | RoutingAll | RoutingAny;

export interface RoutingRule {
  /** Stable id, referenced by the submission that was routed through it. */
  readonly id: string;
  /** The rule as a person would say it — shown while filling, and kept on the submission. */
  readonly whenFa: string;
  readonly when: RoutingCondition;
  /** Roles that must also approve. The form's own approverRoles are never removed. */
  readonly addApprovers?: readonly RoleCode[];
  /** Roles merely told, with no veto. */
  readonly notifyRoles?: readonly RoleCode[];
  /** DOC_H when the rule restates a clause; DEFAULT for a threshold the organisation should set. */
  readonly source?: 'DOC_H' | 'DEFAULT' | 'ORG';
  readonly docRef?: string;
  readonly isActive?: boolean;
}

export interface RoutingOutcome {
  /** Every role that must approve: the form's own, plus whatever the matched rules added. */
  readonly roles: RoleCode[];
  readonly notifyRoles: RoleCode[];
  readonly matched: { id: string; whenFa: string; addApprovers: RoleCode[]; notifyRoles: RoleCode[] }[];
  /** Rules that were evaluated and did not fire — shown so a threshold can be seen coming. */
  readonly unmatched: { id: string; whenFa: string }[];
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[,٬\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** One condition against one submission's data. Unknown fields are simply absent, never an error. */
export function matchesCondition(cond: RoutingCondition, data: Record<string, unknown>): boolean {
  if ('all' in cond) return cond.all.every((c) => matchesCondition(c, data));
  if ('any' in cond) return cond.any.some((c) => matchesCondition(c, data));

  const raw = data[cond.field];
  switch (cond.op) {
    case 'isSet': return !isEmpty(raw);
    case 'isEmpty': return isEmpty(raw);
    case 'isTrue': return raw === true || raw === 'true' || raw === 'YES';
    case 'isFalse': return raw === false || raw === 'false' || raw === 'NO';
    case 'in': return Array.isArray(cond.value) && cond.value.includes(String(raw));
    case 'notIn': return Array.isArray(cond.value) && !cond.value.includes(String(raw));
    case 'eq': return String(raw) === String(cond.value);
    case 'ne': return String(raw) !== String(cond.value);
    case 'ltField':
    case 'gtField': {
      const a = num(raw); const b = num(data[String(cond.value)]);
      if (a == null || b == null) return false;
      return cond.op === 'ltField' ? a < b : a > b;
    }
    default: {
      const a = num(raw); const b = num(cond.value);
      if (a == null || b == null) return false;
      if (cond.op === 'gt') return a > b;
      if (cond.op === 'gte') return a >= b;
      if (cond.op === 'lt') return a < b;
      return a <= b;
    }
  }
}

/**
 * The approvers this submission needs. Pure, so the browser can show the answer while the form
 * is being filled and the server can reach the same one when it is submitted.
 */
export function evaluateRouting(
  baseRoles: readonly RoleCode[] | readonly string[],
  rules: readonly RoutingRule[] | null | undefined,
  data: Record<string, unknown>,
): RoutingOutcome {
  const roles = new Set<RoleCode>(baseRoles as readonly RoleCode[]);
  const notify = new Set<RoleCode>();
  const matched: RoutingOutcome['matched'] = [];
  const unmatched: RoutingOutcome['unmatched'] = [];

  for (const rule of rules ?? []) {
    if (rule.isActive === false) continue;
    if (!matchesCondition(rule.when, data)) {
      unmatched.push({ id: rule.id, whenFa: rule.whenFa });
      continue;
    }
    for (const r of rule.addApprovers ?? []) roles.add(r);
    for (const r of rule.notifyRoles ?? []) notify.add(r);
    matched.push({
      id: rule.id, whenFa: rule.whenFa,
      addApprovers: [...(rule.addApprovers ?? [])], notifyRoles: [...(rule.notifyRoles ?? [])],
    });
  }
  return { roles: [...roles], notifyRoles: [...notify], matched, unmatched };
}

const OP_FA: Record<RoutingOperator, string> = {
  gt: 'بزرگ‌تر از', gte: 'بزرگ‌تر یا مساوی', lt: 'کوچک‌تر از', lte: 'کوچک‌تر یا مساوی',
  eq: 'برابر', ne: 'نابرابر با', in: 'یکی از', notIn: 'هیچ‌یک از',
  isTrue: 'تیک‌خورده', isFalse: 'تیک‌نخورده', isSet: 'پر شده', isEmpty: 'خالی',
  ltField: 'کمتر از مقدار فیلد', gtField: 'بیشتر از مقدار فیلد',
};

/** The condition in Persian, for an editor that must not require reading JSON. */
export function describeCondition(cond: RoutingCondition, fields: readonly FieldDef[] = []): string {
  if ('all' in cond) return cond.all.map((c) => describeCondition(c, fields)).join(' و ');
  if ('any' in cond) return cond.any.map((c) => describeCondition(c, fields)).join(' یا ');
  const label = fields.find((f) => f.key === cond.field)?.labelFa ?? cond.field;
  const op = OP_FA[cond.op];
  if (['isTrue', 'isFalse', 'isSet', 'isEmpty'].includes(cond.op)) return `«${label}» ${op} باشد`;
  if (cond.op === 'ltField' || cond.op === 'gtField') {
    const other = fields.find((f) => f.key === String(cond.value))?.labelFa ?? String(cond.value);
    return `«${label}» ${op} «${other}» باشد`;
  }
  const value = Array.isArray(cond.value) ? cond.value.join('، ') : String(cond.value);
  return `«${label}» ${op} ${value} باشد`;
}

export const rolesFa = (roles: readonly string[]): string =>
  roles.map((r) => ROLE_LABELS[r as RoleCode]?.fa ?? r).join('، ');

export const ROUTING_OPERATORS = Object.keys(OP_FA) as RoutingOperator[];
export const ROUTING_OPERATOR_LABELS = OP_FA;
