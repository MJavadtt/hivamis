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
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { useToast } from '../components/ui';
import { localDigits } from './format';
import { enqueueOperation, listOutbox, newKey, outboxOwner, updateItem, type OutboxItem, type OutboxKind } from './outbox';
import { unreached } from './offline';
import { tr } from '../i18n';

export interface SyncResult {
  sent: number;
  rejected: number;
  waiting: number;
  /** Refused because the record moved meanwhile (audit F-7): the person decides what next. */
  conflicts?: number;
}

/** What a stored item sends: the form route with its client key, or the request it was queued as. */
function requestOf(item: OutboxItem): { path: string; body: unknown } {
  if (!item.kind || item.kind === 'form') {
    return { path: '/forms/submissions', body: { formCode: item.formCode, data: item.data, asDraft: item.asDraft, clientKey: item.id } };
  }
  return { path: item.path!, body: item.body };
}

/** A refusal because the world moved — a state, a rule, a record gone — rather than the request being wrong. */
const movedOn = (e: ApiError) => e.status === 409 || e.status === 422 || e.status === 404;

let running = false;

export async function syncOutbox(): Promise<SyncResult> {
  if (running) return { sent: 0, rejected: 0, waiting: 0 };
  running = true;
  const result: SyncResult = { sent: 0, rejected: 0, waiting: 0 };
  try {
    // Oldest first, and only the signed-in person's: a queue goes out under its owner's session.
    const me = outboxOwner();
    const items = (await listOutbox()).filter((i) => (i.state === 'QUEUED' || i.state === 'SENDING') && (!i.userId || i.userId === me));
    for (const item of items) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { result.waiting++; continue; }
      await updateItem(item.id, { state: 'SENDING', attempts: item.attempts + 1 });
      try {
        const { path, body } = requestOf(item);
        const res = await api<{ code?: string; duplicateOf?: string }>(path, { method: 'POST', body, headers: { 'Idempotency-Key': item.id } });
        await updateItem(item.id, { state: 'SENT', submissionCode: res?.duplicateOf ?? res?.code, sentAt: Date.now(), errorFa: undefined, errorCode: undefined });
        result.sent++;
      } catch (e) {
        // The same request is still being carried out (a send that crossed this one): wait for it.
        if (e instanceof ApiError && e.body.code === 'IDEMPOTENCY_IN_PROGRESS') {
          await updateItem(item.id, { state: 'QUEUED' });
          result.waiting++;
        } else if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          // A 4xx is an answer — the request was read and refused. A 5xx or a network failure is not.
          const issues = e.issues.map((i) => i.message).join(tr('؛ '));
          const errorFa = [e.message, e.rule ? `(${e.rule})` : '', issues ? `— ${issues}` : ''].filter(Boolean).join(' ');
          const conflict = item.kind !== undefined && item.kind !== 'form' && movedOn(e);
          await updateItem(item.id, { state: conflict ? 'CONFLICT' : 'REJECTED', errorFa, errorCode: e.body.code });
          if (conflict) result.conflicts = (result.conflicts ?? 0) + 1; else result.rejected++;
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

/**
 * Do it now if the server answers, or queue it if it does not (audit F-7). Either way under one key,
 * so the queued copy, sent later, cannot do it a second time. A refusal is thrown as it is.
 */
export async function sendOrQueue<T>(op: { kind: Exclude<OutboxKind, 'form'>; path: string; body: Record<string, unknown>; label: string; link?: string }):
  Promise<{ queued: false; result: T } | { queued: true }> {
  const id = newKey();
  if (typeof navigator === 'undefined' || navigator.onLine !== false) {
    try {
      return { queued: false, result: await api<T>(op.path, { method: 'POST', body: op.body, headers: { 'Idempotency-Key': id } }) };
    } catch (e) {
      if (!unreached(e)) throw e;
    }
  }
  await enqueueOperation({ ...op, id });
  return { queued: true };
}

/**
 * The queue replays wherever the person is (audit F-7) — not only while its card is on screen — and
 * says what became of it. Mounted once, in the shell.
 */
export function useQueueReplay() {
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => watchConnectivity((r) => {
    void qc.invalidateQueries();
    const refused = r.rejected + (r.conflicts ?? 0);
    toast(
      refused
        ? tr('{0} مورد از صف ارسال شد و {1} مورد نیاز به تصمیم شما دارد — «کارهای من» را ببینید.', localDigits(r.sent), localDigits(refused))
        : tr('{0} مورد از صف ارسال شد.', localDigits(r.sent)),
      refused ? 'warning' : 'success',
    );
  }), [qc, toast]);
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
