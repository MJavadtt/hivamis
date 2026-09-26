/**
 * Live updates (roadmap #39): one PostgreSQL connection per API process listens on `hiva_events`,
 * where triggers announce every state transition and notification as their transaction commits.
 * Whatever wrote the row — a request, a job, another API instance — the announcement comes from
 * the database, so no code path can forget to publish, and a rolled-back change never is.
 *
 * The listener starts with the first subscriber and stops with the last; if the connection drops it
 * reconnects with backoff, and subscribers are told so they can re-read what they show.
 */
import { EventEmitter } from 'node:events';
import pg, { type Client } from 'pg';
import { env } from '../env.js';

export interface TransitionEvent { t: 'transition'; org: string; entity: string; id: string; from: string; to: string; action: string; actor: string; at: string }
export interface NotificationEvent { t: 'notification'; user: string; kind: string; severity: string }
export type LiveEvent = TransitionEvent | NotificationEvent;

/** The schema this process's rows live in — `?schema=` on the URL, `public` without it. */
function target() {
  const url = new URL(env.DATABASE_URL);
  const schema = url.searchParams.get('schema') ?? 'public';
  // `pg` would pass unknown parameters to the server as settings; Prisma's are not settings.
  for (const k of [...url.searchParams.keys()]) url.searchParams.delete(k);
  return { schema, connectionString: url.toString() };
}

class LiveBus extends EventEmitter {
  private client: Client | null = null;
  private starting: Promise<void> | null = null;
  private retry = 0;
  private stopped = true;
  connected = false;

  constructor() { super(); this.setMaxListeners(0); }

  subscribe(fn: (e: LiveEvent) => void, onReset?: () => void) {
    this.on('event', fn);
    if (onReset) this.on('reset', onReset);
    void this.ensure();
    return () => {
      this.off('event', fn);
      if (onReset) this.off('reset', onReset);
      if (this.listenerCount('event') === 0) void this.stop();
    };
  }

  private ensure() {
    this.stopped = false;
    if (this.client || this.starting) return this.starting ?? Promise.resolve();
    const { schema, connectionString } = target();
    this.starting = (async () => {
      const client = new pg.Client({ connectionString, application_name: 'hiva-live' });
      client.on('notification', (msg) => {
        if (msg.channel !== 'hiva_events' || !msg.payload) return;
        try {
          const e = JSON.parse(msg.payload) as LiveEvent & { schema?: string };
          if (e.schema !== schema) return;
          this.emit('event', e);
        } catch { /* not ours */ }
      });
      const lost = () => {
        if (this.client !== client) return;
        this.client = null; this.connected = false;
        this.emit('reset');
        if (!this.stopped) setTimeout(() => void this.ensure(), Math.min(30_000, 1000 * 2 ** this.retry++)).unref();
      };
      client.on('error', lost);
      client.on('end', lost);
      try {
        await client.connect();
        await client.query('LISTEN hiva_events');
        this.client = client; this.connected = true; this.retry = 0;
      } catch {
        await client.end().catch(() => undefined);
        if (!this.stopped) setTimeout(() => void this.ensure(), Math.min(30_000, 1000 * 2 ** this.retry++)).unref();
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Wait until listening — for tests, and for a stream that wants to say it is live. */
  async ready(timeoutMs = 5000) {
    const until = Date.now() + timeoutMs;
    while (!this.connected && Date.now() < until) { await this.ensure(); if (!this.connected) await new Promise((r) => setTimeout(r, 50)); }
    return this.connected;
  }

  async stop() {
    this.stopped = true;
    await this.starting?.catch(() => undefined);
    const c = this.client;
    this.client = null; this.connected = false;
    await c?.end().catch(() => undefined);
  }
}

export const liveBus = new LiveBus();
