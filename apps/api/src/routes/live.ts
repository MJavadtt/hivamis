import type { FastifyPluginAsync } from 'fastify';
import { WORKFLOW_READ_PERMISSION } from '@hiva/contracts';
import { actorFrom } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { openEventStream } from '../lib/sse.js';
import { liveBus, type LiveEvent } from '../live/bus.js';
import { forgetMembers, isMember } from '../chat/service.js';

const HEARTBEAT_MS = 25_000;
const MAX_STREAM_MS = 60 * 60_000;
const MAX_PER_USER = 5;
const open = new Map<string, number>();
const streams = new Set<() => void>();

/**
 * Live updates (roadmap #39): a server-sent event stream per signed-in tab. It carries that a
 * record moved — entity, id, from, to — never its content, and only for entities the reader may
 * read; and the reader's own notifications. The page re-reads what it shows through the ordinary,
 * permission-checked endpoints.
 */
const liveRoutes: FastifyPluginAsync = async (app) => {
  // Streams never end on their own; the server cannot close until they do.
  app.addHook('preClose', async () => { for (const end of [...streams]) end(); await liveBus.stop(); });

  app.get('/events', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const count = open.get(actor.id) ?? 0;
    if (count >= MAX_PER_USER) throw new AppError(429, 'LIVE_TOO_MANY', 'تعداد اتصال‌های زندهٔ همزمان شما به سقف رسیده است.');
    open.set(actor.id, count + 1);

    const may = new Set(actor.permissions);
    const visible = (entity: string) => {
      const need = WORKFLOW_READ_PERMISSION[entity as keyof typeof WORKFLOW_READ_PERMISSION];
      return !!need && may.has(need);
    };

    const res = openEventStream(reply);
    const send = (event: string, data: object) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    res.write('retry: 5000\n\n');

    const unsubscribe = liveBus.subscribe((e: LiveEvent) => {
      if (e.t === 'transition' && e.org === actor.organizationId && visible(e.entity)) {
        send('transition', { entity: e.entity, id: e.id, from: e.from, to: e.to, action: e.action, at: e.at, mine: e.actor === actor.id });
      } else if (e.t === 'notification' && e.user === actor.id) {
        send('notification', { kind: e.kind, severity: e.severity });
      } else if (e.t === 'chat' && e.org === actor.organizationId && may.has('chat.use')) {
        // Team chat (audit F-5): to the conversation's members only.
        void isMember(e.conversation, actor.id).then((member) => {
          if (member) send('chat', { conversationId: e.conversation, messageId: e.message, op: e.op, mine: e.author === actor.id });
        }).catch(() => undefined);
      } else if (e.t === 'chat_members') {
        forgetMembers(e.conversation);
        if (e.user === actor.id) send('chat', { conversationId: e.conversation, membership: true });
      }
    }, () => send('reset', {}));
    // Said once the listener is up, so the page knows from when it may stop polling.
    void liveBus.ready().then((ok) => send('ready', { live: ok }));

    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, HEARTBEAT_MS);
    // The stream ends when the access token that opened it would; the page reconnects with a fresh one.
    const exp = (req.user as { exp?: number } | undefined)?.exp;
    const lifetime = Math.max(1000, Math.min(MAX_STREAM_MS, exp ? exp * 1000 - Date.now() : MAX_STREAM_MS));
    const endAt = setTimeout(() => { send('expired', {}); res.end(); }, lifetime);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      streams.delete(finish);
      clearInterval(heartbeat); clearTimeout(endAt); unsubscribe();
      const n = (open.get(actor.id) ?? 1) - 1;
      if (n <= 0) open.delete(actor.id); else open.set(actor.id, n);
    };
    const finish = () => { close(); if (!res.writableEnded) res.end(); };
    streams.add(finish);
    req.raw.on('close', close);
    res.on('close', close);
  });
};

export default liveRoutes;
