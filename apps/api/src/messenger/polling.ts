import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { configuredProvider, type MessengerProvider } from './provider.js';
import { handleUpdate } from './service.js';

/**
 * The bot by long polling (audit F-9), for a server the Bot API cannot call: behind NAT, or on a
 * network that lets only outbound traffic through. Brought over from the meeting platform, which
 * learned it the hard way: a loop that has quietly stopped looks the same as one that is waiting.
 *
 * - One reader. Telegram hands a bot's updates to whoever asks, and a second reader gets 409. A
 *   lease in `messenger_poll_state`, renewed by every poll, names the one process that asks; the
 *   others check back and take over when it lapses.
 * - The offset is kept there too, so a restart neither drops nor repeats what was handled.
 * - Liveness is when a poll last *completed* (`lastPollAt`), not that a loop was started. The
 *   administration page shows it; each request has its own deadline, so a hung one ends and the
 *   loop starts it again, waiting longer after each failure.
 */

export const POLL_TIMEOUT_S = 25;
export const LEASE_MS = 90_000;
/** Older than this, polling is reported as stalled. */
export const STALE_MS = 2 * (POLL_TIMEOUT_S + 15) * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Takes or renews the lease; the offset to ask from when this process holds it, else null. */
export async function claimLease(provider: string, holder: string): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ nextOffset: bigint }[]>`
    INSERT INTO messenger_poll_state (provider, holder, "leaseUntil", "updatedAt")
    VALUES (${provider}, ${holder}, now() + ${`${LEASE_MS} milliseconds`}::interval, now())
    ON CONFLICT (provider) DO UPDATE SET holder = EXCLUDED.holder, "leaseUntil" = EXCLUDED."leaseUntil", "updatedAt" = now()
    WHERE messenger_poll_state.holder = EXCLUDED.holder
       OR messenger_poll_state."leaseUntil" IS NULL OR messenger_poll_state."leaseUntil" < now()
    RETURNING "nextOffset"`;
  return rows[0] ? Number(rows[0].nextOffset) : null;
}

/**
 * One poll: the updates since the offset, each handled as the webhook would, the offset moved past
 * each as it is done. A failure handling one update is logged and passed over — the Bot API would
 * otherwise send it again forever.
 */
export async function pollOnce(p: MessengerProvider, holder: string, log?: Pick<FastifyBaseLogger, 'warn'>): Promise<'NOT_HOLDER' | number> {
  const offset = await claimLease(p.name, holder);
  if (offset === null) return 'NOT_HOLDER';
  const updates = await p.getUpdates!(offset, POLL_TIMEOUT_S);
  for (const u of updates) {
    await handleUpdate(p, u).catch((e) => log?.warn({ err: e }, 'messenger update failed'));
    if (typeof u.update_id === 'number') {
      await prisma.messengerPollState.updateMany({ where: { provider: p.name, holder }, data: { nextOffset: u.update_id + 1 } });
    }
  }
  await prisma.messengerPollState.updateMany({ where: { provider: p.name, holder }, data: { lastPollAt: new Date(), lastError: null } });
  return updates.length;
}

/** What the administration page shows. */
export async function pollingStatus(provider: string) {
  const row = await prisma.messengerPollState.findUnique({ where: { provider } });
  const lastPollAt = row?.lastPollAt ?? null;
  return {
    transport: env.MESSENGER_TRANSPORT,
    lastPollAt,
    stalled: env.MESSENGER_TRANSPORT === 'polling' && (!lastPollAt || Date.now() - lastPollAt.getTime() > STALE_MS),
    lastError: row?.lastError ?? null,
  };
}

/** Starts the loop when the installation polls; returns how to stop it, releasing the lease. */
export function startPolling(log: FastifyBaseLogger): (() => Promise<void>) | null {
  const p = configuredProvider();
  if (env.MESSENGER_TRANSPORT !== 'polling' || !p?.getUpdates || !p.deleteWebhook) return null;
  const holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let webhookCleared = false;
  void (async () => {
    let backoff = 1000;
    while (!stopped) {
      try {
        // A webhook still set makes getUpdates answer 409; it is cleared once this process reads.
        if (!webhookCleared && (await claimLease(p.name, holder)) !== null) { await p.deleteWebhook!(); webhookCleared = true; }
        if (await pollOnce(p, holder, log) === 'NOT_HOLDER') { await sleep(LEASE_MS / 3); continue; }
        backoff = 1000;
      } catch (e) {
        if (stopped) break;
        // The adapter's errors never carry the URL, which holds the token.
        const message = (e as Error).message.slice(0, 500);
        if (/webhook/i.test(message)) webhookCleared = false;
        log.warn({ err: message, retryInMs: backoff }, 'messenger polling failed; starting again');
        await prisma.messengerPollState.updateMany({ where: { provider: p.name, holder }, data: { lastError: message } }).catch(() => undefined);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  })();
  log.info({ provider: p.name }, 'messenger polling started');
  return async () => {
    stopped = true;
    // The poll under way ends within its own timeout; nothing waits on it.
    await prisma.messengerPollState.updateMany({ where: { provider: p.name, holder }, data: { leaseUntil: null } }).catch(() => undefined);
  };
}
