/**
 * How much a read that grows with the data may bring back (audit PERF-4). Each such read takes one row
 * more than its cap, so the caller can tell a full list from a cut one and say so — `truncated: true`
 * in the answer — rather than quietly showing part of the picture as the whole.
 */

/** A queue a person works through: what waits longest comes first, and a few hundred is a day's work. */
export const QUEUE_CAP = 200;
/** A list shown on a page. */
export const LIST_CAP = 500;
/** Records an answer or a report is computed from. */
export const FACT_CAP = 20_000;

/** The `take` for a capped read: one more than the cap, to know whether there was more. */
export const over = (cap: number) => cap + 1;

/** The rows within the cap, and whether there were more. */
export function capped<T>(rows: T[], cap: number): { rows: T[]; truncated: boolean } {
  return rows.length > cap ? { rows: rows.slice(0, cap), truncated: true } : { rows, truncated: false };
}
