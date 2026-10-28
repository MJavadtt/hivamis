import type { FastifyRequest } from 'fastify';
import type { Permission } from '@hiva/contracts';
import { currentUser } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { forbidden } from '../lib/errors.js';

/**
 * A route open to whoever holds any one of these permissions (ADR-103): the venue lists are read by
 * those who place projects in venues and by those who pay for them alike. Refused, the request is
 * recorded as every refused permission is.
 */
export const anyOf = (...perms: Permission[]) => async (req: FastifyRequest) => {
  const user = currentUser(req);
  if (perms.some((p) => user.permissions.includes(p))) return;
  await audit({
    organizationId: user.organizationId, actorId: user.sub, action: 'PERMISSION_DENIED', entityType: 'authorization',
    reason: `missing one of: ${perms.join(', ')}`, ipAddress: req.ip,
  }).catch(() => undefined);
  throw forbidden(`برای این کار یکی از این دسترسی‌ها لازم است: ${perms.join('، ')}`);
};

/** Who may file a document as a venue's or a deployment project's, and who may read one so filed. */
export const SITE_FILE_KINDS = ['contract', 'approval', 'installation', 'negotiation', 'payment', 'deduction', 'general'] as const;
export const FINANCIAL_FILE_KINDS = new Set(['payment', 'deduction']);

export function mayReadSiteFile(permissions: readonly string[], doc: { venueId: string | null; siteProjectId: string | null; siteRecordType: string | null }) {
  if (doc.venueId && !permissions.includes('venue.read')) return false;
  if (doc.siteProjectId && !permissions.includes('site.read')) return false;
  // A payment's receipt or a deduction's evidence is the rental ledger's, read with it.
  if (doc.siteProjectId && doc.siteRecordType && FINANCIAL_FILE_KINDS.has(doc.siteRecordType) && !permissions.includes('rental.read')) return false;
  return true;
}
