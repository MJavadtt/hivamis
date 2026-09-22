/**
 * Sending what the outbox holds (roadmap #19).
 *
 * One at a time, oldest first, so the order forms were filled in is the order they are filed.
 * The three outcomes are kept apart on purpose:
 *   - accepted — the item is marked sent and carries the code the server gave it;
 *   - refused  — a rule said no (a closed project, a missing field, a permission). The item
 *                stays, with the server's Persian message, because only a person can decide
 *                whether to fix it or drop it;
 *   - unreached — still no network, or the server is down. Nothing is lost and nothing is said;
 *                 the item waits for the next attempt.
 */
import { api, ApiError } from './api';
import { listOutbox, updateItem, type OutboxItem } from './outbox';

export interface SyncResult {
  sent: number;
  rejected: number;
  waiting: number;
}

let running = false;

export async function syncOutbox(): Promise<SyncResult> {
  if (running) return { sent: 0, rejected: 0, waiting: 0 };
  running = true;
  const result: SyncResult = { sent: 0, rejected: 0, waiting: 0 };
  try {
    const items = (await listOutbox()).filter((i) => i.state === 'QUEUED' || i.state === 'SENDING');
    for (const item of items) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { result.waiting++; continue; }
      await updateItem(item.id, { state: 'SENDING', attempts: item.attempts + 1 });
      try {
        const res = await api<{ code?: string; duplicateOf?: string }>('/forms/submissions', {
          method: 'POST',
          body: { formCode: item.formCode, data: item.data, asDraft: item.asDraft, clientKey: item.id },
        });
        await updateItem(item.id, { state: 'SENT', submissionCode: res.duplicateOf ?? res.code, sentAt: Date.now(), errorFa: undefined, errorCode: undefined });
        result.sent++;
      } catch (e) {
        // A 4xx is an answer — the form was read and refused. A 5xx or a network failure is not.
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          const issues = e.issues.map((i) => i.message).join('؛ ');
          await updateItem(item.id, { state: 'REJECTED', errorFa: issues ? `${e.message} — ${issues}` : e.message, errorCode: e.body.code });
          result.rejected++;
        } else {
          await updateItem(item.id, { state: 'QUEUED' });
          result.waiting++;
        }
      }
    }
  } finally {
    running = false;
  }
  return result;
}

/** Retry an item the server refused, after the person edited it. */
export async function requeue(item: OutboxItem, data?: Record<string, unknown>): Promise<void> {
  await updateItem(item.id, { state: 'QUEUED', errorFa: undefined, errorCode: undefined, ...(data ? { data } : {}) });
}

/** Sync when the network returns, and once at start-up. Returns an unsubscribe function. */
export function watchConnectivity(onResult?: (r: SyncResult) => void): () => void {
  const run = () => { void syncOutbox().then((r) => { if (r.sent || r.rejected) onResult?.(r); }); };
  window.addEventListener('online', run);
  const timer = window.setTimeout(run, 1_500);
  return () => { window.removeEventListener('online', run); window.clearTimeout(timer); };
}
