import type { Tx } from '../db.js';
import { requestContext } from './request-context.js';
import { prisma } from '../db.js';

export interface AuditContext {
  organizationId: string;
  actorId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuditInput extends AuditContext {
  /** The delegator, when the actor held the permission only through a delegation. */
  onBehalfOfId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Fields that must never be written into the audit trail. */
const REDACTED = new Set(['passwordHash', 'password', 'refreshTokenHash', 'token', 'secret']);

/**
 * Serialise a record for the audit trail.
 *
 * Uses JSON.stringify with a replacer rather than walking the object graph: Prisma returns
 * Decimal and Date instances whose internals must not be traversed (Decimal exposes `s`/`e`/`d`
 * and a function-valued `constructor`, which Prisma then refuses to store as JSON).
 * Every such value has a toJSON, so a single stringify pass yields a clean, storable snapshot.
 */
function scrub(value: unknown): unknown {
  if (value == null) return undefined;
  try {
    return JSON.parse(
      JSON.stringify(value, (key, v) => {
        if (REDACTED.has(key)) return '[redacted]';
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'function') return undefined;
        return v;
      }),
    );
  } catch {
    // Never let an unserialisable payload break the operation being audited.
    return { unserializable: true };
  }
}

/**
 * Append an immutable audit record. Doc_H §7 (Single Source of Truth) and the audit requirement
 * mean every consequential mutation lands here with who / what / when / before / after / why.
 */
export async function audit(input: AuditInput, tx: Tx = prisma): Promise<void> {
  await tx.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      onBehalfOfId: input.onBehalfOfId ?? null,
      // Which API key, when the request came through one (#46) — without every caller passing it.
      apiKeyId: requestContext.getStore()?.apiKeyId ?? null,
      actorId: input.actorId ?? null,
      before: (scrub(input.before) as object) ?? undefined,
      after: (scrub(input.after) as object) ?? undefined,
      reason: input.reason ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    },
  });
}
