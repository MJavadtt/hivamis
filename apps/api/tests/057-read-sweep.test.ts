import { describe, it, expect } from 'vitest';
import { readSweep } from '../scripts/read-sweep.js';
import { REVIEWED } from '../scripts/read-sweep.reviewed.js';

/**
 * Audit PERF-4: every `findMany` without a `take` has been read and given a reason it is bounded; a read
 * that grows with the data was capped instead. A new uncapped read fails here until someone says why it
 * is safe — or caps it.
 */
describe('Unbounded reads (audit PERF-4)', () => {
  const keys = readSweep().map((r) => r.key);

  it('has a reviewed verdict for every findMany without a take', () => {
    expect(keys.filter((k) => !(k in REVIEWED))).toEqual([]);
  });

  it('keeps the list true: no verdict for a read that is now capped or gone', () => {
    const live = new Set(keys);
    expect(Object.keys(REVIEWED).filter((k) => !live.has(k))).toEqual([]);
  });
});
