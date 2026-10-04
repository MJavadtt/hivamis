import type { FastifyPluginAsync } from 'fastify';
import { chatRequestSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { AppError, notFound } from '../lib/errors.js';
import { requestLocale } from '../lib/i18n.js';
import { modelStatus, ollama, Turns, type ChatMessage } from '../ai/ollama.js';
import { runTurn, type ChatAction } from '../ai/agent.js';

/**
 * The chat assistant (Hivamis task 5): a local model, free and without a quota, for everyone the
 * administrator has not taken it from (`ai.chat`). It answers by streaming; while the model is busy
 * with someone else, a request waits its turn and is told its place. Conversations are the person's
 * own. Each turn — which model, which tools on which records, how long — goes to the AI log; what
 * was said does not.
 */

const turns = new Turns(env.CHAT_CONCURRENCY);
/** How much of the conversation the model is shown: enough to follow, little enough to stay quick. */
const HISTORY = 12;

const chatRoutes: FastifyPluginAsync = async (app) => {
  const guard = { preHandler: [app.authenticate, app.requirePermissions('ai.chat')] };

  app.get('/ai/chat/status', guard, async () => {
    if (env.CHAT_MODE === 'off') return { mode: 'off', ready: false, model: null, reachable: false, modelPresent: false, busy: 0, waiting: 0 };
    const s = await modelStatus();
    return { mode: env.CHAT_MODE, ready: s.reachable && s.modelPresent, model: s.model, reachable: s.reachable, modelPresent: s.modelPresent, busy: turns.busy, waiting: turns.queued };
  });

  app.get('/ai/conversations', guard, async (req) => {
    const actor = actorFrom(req);
    return prisma.aiConversation.findMany({
      where: { userId: actor.id }, orderBy: { updatedAt: 'desc' }, take: 50,
      select: { id: true, title: true, updatedAt: true },
    });
  });

  app.get('/ai/conversations/:id', guard, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const c = await prisma.aiConversation.findFirst({
      where: { id, userId: actor.id },
      include: { messages: { where: { role: { in: ['user', 'assistant'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, role: true, content: true, actions: true, createdAt: true } } },
    });
    if (!c) throw notFound('گفت‌وگو');
    return c;
  });

  app.delete('/ai/conversations/:id', guard, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const gone = await prisma.aiConversation.deleteMany({ where: { id, userId: actor.id } });
    if (!gone.count) throw notFound('گفت‌وگو');
    return reply.code(204).send();
  });

  /** A question, answered as a stream of server-sent events: meta, queue, tool, delta, action, done | error. */
  app.post('/ai/chat', { ...guard, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const actor = actorFrom(req);
    if (env.CHAT_MODE === 'off') throw new AppError(503, 'CHAT_OFF', 'دستیار در این نصب خاموش است.');
    const input = parse(chatRequestSchema, req.body);
    const me = await prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { fullName: true, jobTitle: true, organization: { select: { currency: true } } } });

    const conversation = input.conversationId
      ? await prisma.aiConversation.findFirst({ where: { id: input.conversationId, userId: actor.id } })
      : await prisma.aiConversation.create({ data: { organizationId: actor.organizationId, userId: actor.id, title: input.message.slice(0, 80) } });
    if (!conversation) throw notFound('گفت‌وگو');
    const earlier = await prisma.aiMessage.findMany({
      where: { conversationId: conversation.id, role: { in: ['user', 'assistant'] } }, orderBy: { createdAt: 'desc' }, take: HISTORY,
      select: { role: true, content: true },
    });
    await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: 'user', content: input.message } });

    reply.hijack();
    const out = reply.raw;
    out.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => { if (!out.writableEnded) out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const controller = new AbortController();
    req.raw.on('close', () => { if (!out.writableEnded) controller.abort(); });

    const started = Date.now();
    send('meta', { conversationId: conversation.id, model: ollama.model });
    let release: (() => void) | null = null;
    try {
      release = await turns.acquire((position) => send('queue', { position }), controller.signal);
      const history: ChatMessage[] = [...earlier.reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })), { role: 'user', content: input.message }];
      const result = await runTurn(history, {
        app, authorization: req.headers.authorization ?? '', locale: requestLocale(req.headers['accept-language']), currency: me.organization.currency,
        person: { fullName: me.fullName, jobTitle: me.jobTitle, unit: actor.departmentCode, roles: actor.roles },
        page: input.context ?? null,
      }, {
        onDelta: (text) => send('delta', { text }),
        onTool: (name, args) => send('tool', { name, args }),
        onAction: (action: ChatAction) => send('action', action),
        onToolResult: async (name, args, content) => {
          await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: 'tool', toolName: name, toolArgs: args as object, content: content.slice(0, 4000) } });
        },
      }, controller.signal);
      const saved = await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: 'assistant', content: result.answer, actions: result.actions as unknown as object } });
      await prisma.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      await prisma.aiInteraction.create({
        data: {
          organizationId: actor.organizationId, userId: actor.id, capability: 'CHAT', model: ollama.model,
          // What was asked and answered stays in the person's conversation; the log keeps what was done.
          promptSummary: result.used.length ? `chat — ${result.used.map((u) => u.tool).join(', ')}` : 'chat',
          groundingRefs: result.used as unknown as object, tokensIn: result.tokensIn || null, tokensOut: result.tokensOut || null,
          latencyMs: Date.now() - started, succeeded: true,
        },
      }).catch(() => undefined);
      send('done', { messageId: saved.id, actions: result.actions });
    } catch (e) {
      const aborted = controller.signal.aborted;
      if (!aborted) {
        req.log.warn({ err: e }, 'chat failed');
        await prisma.aiInteraction.create({
          data: { organizationId: actor.organizationId, userId: actor.id, capability: 'CHAT', model: ollama.model, promptSummary: 'chat', latencyMs: Date.now() - started, succeeded: false, errorMessage: (e as Error).message.slice(0, 500) },
        }).catch(() => undefined);
        send('error', { code: 'CHAT_FAILED', message: requestLocale(req.headers['accept-language']) === 'en'
          ? 'The assistant could not answer right now. Is the local model running?'
          : 'دستیار الان نتوانست پاسخ دهد. آیا مدل محلی در حال اجراست؟' });
      }
    } finally {
      release?.();
      if (!out.writableEnded) out.end();
    }
  });
};

export default chatRoutes;
