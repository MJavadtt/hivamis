import { describe, it, expect } from 'vitest';
import { sweep } from '../scripts/tenant-sweep.js';
import { REVIEWED } from '../scripts/tenant-sweep.reviewed.js';

/**
 * Audit SEC-2b: every Prisma query on tenant data whose `where` names no organisation has been read
 * and has a verdict — scoped earlier, the caller's own rows, a token, a background job… — in
 * scripts/tenant-sweep.reviewed.ts. A new such query fails here until someone reviews it.
 */
describe('Tenant sweep (audit SEC-2b)', () => {
  const hits = sweep();
  const functions = [...new Set(hits.map((h) => `${h.file}#${h.fn}`))];

  it('finds the queries to review', () => {
    expect(hits.length).toBeGreaterThan(400);
  });

  it('has a reviewed verdict for every function with an unscoped-looking query', () => {
    const unreviewed = functions.filter((f) => !REVIEWED[f]).map((f) => {
      const first = hits.find((h) => `${h.file}#${h.fn}` === f)!;
      return `${f}  (${first.file}:${first.line} ${first.model}.${first.op})`;
    });
    expect(unreviewed).toEqual([]);
  });

  it('keeps the list true: no verdict for a function that no longer has such a query', () => {
    const live = new Set(functions);
    expect(Object.keys(REVIEWED).filter((k) => !live.has(k))).toEqual([]);
  });
});
