import type { Tx } from '../db.js';

/**
 * Human-readable business codes (LEAD-000123, PRJ-000045 …).
 * Allocated inside the caller's transaction via an atomic UPDATE … RETURNING so concurrent
 * requests can never collide on the same number.
 */
const PREFIXES: Record<string, string> = {
  lead: 'LEAD', opportunity: 'OPP', brief: 'BRF', proposal: 'PRP', project: 'PRJ',
  workOrder: 'WO', task: 'TSK', deliverable: 'DLV', qcReview: 'QC', revision: 'REV',
  changeRequest: 'CR', contract: 'CNT', invoice: 'INV', risk: 'RSK', issue: 'ISS',
  decision: 'DEC', meeting: 'MTG', statusReport: 'RPT', outsourceRequest: 'OSR',
  formSubmission: 'FRM', handoff: 'HND',
};

export async function nextCode(tx: Tx, scope: keyof typeof PREFIXES | string): Promise<string> {
  const prefix = PREFIXES[scope] ?? scope.toUpperCase().slice(0, 4);
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO counters (id, scope, value) VALUES (gen_random_uuid(), ${scope}, 1)
    ON CONFLICT (scope) DO UPDATE SET value = counters.value + 1
    RETURNING value
  `;
  const n = rows[0]?.value ?? 1;
  return `${prefix}-${String(n).padStart(6, '0')}`;
}
