/**
 * Time travel over the audit trail (roadmap #3).
 *
 * `audit_events` already holds every mutation with `before` and `after`. The generic CRUD
 * writes whole rows on CREATE and UPDATE; the workflow engine writes `{ state }`; the specific
 * mutations write what they touched. Folding those in order reconstructs the record at any
 * instant, and diffing neighbours says who changed which field from what to what. No new table.
 *
 * Two things this must never do: show Sales a price it may not see because the change happened
 * to be in an audit row rather than on the record, and show anyone a password hash. Field
 * classification is shared with the PDF layer so the two answer the same question the same way.
 */
import { WORKFLOW_READ_PERMISSION, type Permission } from '@hiva/contracts';
import type { RedactionContext } from '../pdf/access.js';
import { classifyField } from '../pdf/access.js';

/** Which permission reads a record's history: the same one that reads the record. */
export const HISTORY_READ_PERMISSION: Record<string, Permission> = {
  ...WORKFLOW_READ_PERMISSION,
  company: 'crm.company.read',
  contact: 'crm.contact.read',
  risk: 'governance.read',
  issue: 'governance.read',
  decision: 'governance.read',
  statusReport: 'report.read',
  supplier: 'supplier.read',
  formSubmission: 'form.read',
  document: 'document.read',
  meeting: 'meeting.read',
  slaClock: 'report.read',
  slaPolicy: 'admin.settings',
  organization: 'admin.settings',
  user: 'admin.users',
};

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
  /** Present when the caller may not see this field; before/after are then absent. */
  withheld?: 'cost' | 'price' | 'sensitive';
}

export interface AuditRow {
  id: string;
  action: string;
  actorId: string | null;
  onBehalfOfId?: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ipAddress: string | null;
  createdAt: Date;
}

/**
 * Actions whose `after` describes the record. Everything else — an export, a download, an SLA
 * pause — is an event *about* the record whose `after` is event metadata: shown as details,
 * never folded into the record's state or diffed as if it were columns.
 */
export const RECORD_ACTIONS = new Set(['CREATE', 'UPDATE', 'DELETE', 'STATE_TRANSITION', 'APPROVE']);
export const changesRecord = (action: string) => RECORD_ACTIONS.has(action);

/** Bookkeeping columns: they change on every write and never mean anything to a reader. */
const NOISE = new Set(['updatedAt', 'createdAt', 'id', 'organizationId']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Field-level differences between two snapshots, in the order the keys appear. */
export function diff(before: unknown, after: unknown): FieldChange[] {
  const b = isObject(before) ? before : {};
  const a = isObject(after) ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !NOISE.has(k));
  return keys
    .filter((k) => !same(b[k], a[k]))
    .map((k) => ({ field: k, before: b[k] ?? null, after: a[k] ?? null }));
}

/**
 * The record as it stood at `at`, folded from its audit trail.
 *
 * A full `after` (CREATE, UPDATE) replaces what is known; a partial one (a transition's
 * `{ state }`) patches it. The first event's `before`, when present, seeds the fold — a row the
 * seed created has no CREATE event, and its first UPDATE is the earliest picture we have.
 * Returns null when nothing is known that early.
 */
export function reconstruct(
  events: AuditRow[],
  at: Date,
): { snapshot: Record<string, unknown>; asOf: AuditRow } | null {
  const ordered = [...events].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  let snapshot: Record<string, unknown> | null = null;
  let asOf: AuditRow | null = null;

  const first = ordered.find((e) => changesRecord(e.action));
  if (first && isObject(first.before)) {
    snapshot = { ...first.before };
    asOf = first;
  }
  for (const ev of ordered) {
    if (ev.createdAt > at) break;
    if (!changesRecord(ev.action) || !isObject(ev.after)) continue;
    snapshot = { ...(snapshot ?? {}), ...ev.after };
    asOf = ev;
  }
  return snapshot && asOf ? { snapshot, asOf } : null;
}

/**
 * The change each event made, with the running picture supplying `before` for partial events.
 * Events that do not change the record carry their metadata as `details` and no changes.
 */
export function timeline(
  events: AuditRow[],
): Array<AuditRow & { changes: FieldChange[]; details: Record<string, unknown> | null }> {
  const ordered = [...events].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  let running: Record<string, unknown> = {};
  return ordered.map((ev) => {
    if (!changesRecord(ev.action)) {
      return { ...ev, changes: [], details: isObject(ev.after) ? ev.after : null };
    }
    const before = isObject(ev.before) ? ev.before : running;
    const changes = isObject(ev.after)
      ? diff(before, isObject(ev.before) ? ev.after : { ...running, ...ev.after })
      : [];
    if (isObject(ev.after)) running = { ...running, ...ev.after };
    else if (isObject(ev.before)) running = { ...running, ...ev.before };
    return { ...ev, changes, details: null };
  });
}

const SENSITIVE = /password|secret|token|hash|otp/i;

/** Which class a field belongs to, if it is one the caller might not be allowed to see. */
export function fieldClass(field: string): FieldChange['withheld'] | null {
  if (SENSITIVE.test(field)) return 'sensitive';
  return classifyField(field);
}

/** Withhold what the caller may not see. Sensitive fields are withheld from everyone. */
export function redact(changes: FieldChange[], ctx: RedactionContext): FieldChange[] {
  return changes.map((c) => {
    const cls = fieldClass(c.field);
    if (!cls) return c;
    if (cls === 'sensitive' || (cls === 'cost' && !ctx.cost) || (cls === 'price' && !ctx.price)) {
      return { field: c.field, before: undefined, after: undefined, withheld: cls };
    }
    return c;
  });
}

/** The same rule applied to a whole snapshot. */
export function redactSnapshot(
  snapshot: Record<string, unknown>, ctx: RedactionContext,
): { snapshot: Record<string, unknown>; withheld: string[] } {
  const out: Record<string, unknown> = {};
  const withheld: string[] = [];
  for (const [k, v] of Object.entries(snapshot)) {
    const cls = fieldClass(k);
    if (cls === 'sensitive' || (cls === 'cost' && !ctx.cost) || (cls === 'price' && !ctx.price)) {
      withheld.push(k);
    } else {
      out[k] = v;
    }
  }
  return { snapshot: out, withheld };
}
