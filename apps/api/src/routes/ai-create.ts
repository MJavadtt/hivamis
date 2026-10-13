import type { FastifyPluginAsync } from 'fastify';
import { aiImageSchema, aiWriteSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { requestLocale } from '../lib/i18n.js';
import { openEventStream } from '../lib/sse.js';
import { chat, ollama, turns } from '../ai/ollama.js';
import { thinkFilter } from '../ai/agent.js';
import { writeMessages } from '../ai/write.js';
import { drawImage, imageServer, imageStatus } from '../ai/image.js';

/**
 * Writing and pictures with the assistant (audit F-2), for every role by default (`ai.write`,
 * `ai.image`), withdrawn like any other permission. Both run inside the installation. Neither reads
 * a record: writing works from what the person gives it, and a picture is filed through the same
 * route as any upload, with the person's own token, so every check an upload has applies.
 */

/** A picture on a CPU can take minutes; past this it is abandoned. */
const IMAGE_TIMEOUT_MS = 10 * 60_000;

const aiCreateRoutes: FastifyPluginAsync = async (app) => {
  /** A draft or a rewrite, streamed as server-sent events: meta, queue, delta, done | error. */
  app.post('/ai/write', {
    preHandler: [app.authenticate, app.requirePermissions('ai.write')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const actor = actorFrom(req);
    if (env.CHAT_MODE === 'off') throw new AppError(503, 'CHAT_OFF', 'دستیار در این نصب خاموش است.');
    const input = parse(aiWriteSchema, req.body);

    const out = openEventStream(reply);
    const send = (event: string, data: unknown) => { if (!out.writableEnded) out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const controller = new AbortController();
    req.raw.on('close', () => { if (!out.writableEnded) controller.abort(); });
    const started = Date.now();
    send('meta', { model: ollama.model });
    let release: (() => void) | null = null;
    let tokensIn: number | null = null, tokensOut: number | null = null;
    try {
      release = await turns.acquire((position) => send('queue', { position }), controller.signal);
      const visible = thinkFilter();
      for await (const c of chat(writeMessages(input), [], controller.signal)) {
        if (c.delta) { const text = visible(c.delta); if (text) send('delta', { text }); }
        if (c.done) ({ tokensIn, tokensOut } = c.done);
      }
      // What was asked and written stays with the person; the log keeps that it was done, and for what.
      await prisma.aiInteraction.create({
        data: {
          organizationId: actor.organizationId, userId: actor.id, capability: 'WRITE', model: ollama.model,
          promptSummary: `write — ${input.kind}${input.text ? ' (rewrite)' : ''}`, tokensIn, tokensOut,
          latencyMs: Date.now() - started, succeeded: true,
        },
      }).catch(() => undefined);
      send('done', {});
    } catch (e) {
      if (!controller.signal.aborted) {
        req.log.warn({ err: e }, 'write failed');
        await prisma.aiInteraction.create({
          data: { organizationId: actor.organizationId, userId: actor.id, capability: 'WRITE', model: ollama.model, promptSummary: `write — ${input.kind}`, latencyMs: Date.now() - started, succeeded: false, errorMessage: (e as Error).message.slice(0, 500) },
        }).catch(() => undefined);
        send('error', { code: 'WRITE_FAILED', message: requestLocale(req.headers['accept-language']) === 'en'
          ? 'The assistant could not write this right now. Is the local model running?'
          : 'دستیار الان نتوانست بنویسد. آیا مدل محلی در حال اجراست؟' });
      }
    } finally {
      release?.();
      if (!out.writableEnded) out.end();
    }
  });

  app.get('/ai/image/status', { preHandler: [app.authenticate, app.requirePermissions('ai.image')] }, async () => imageStatus());

  /**
   * One picture from a description, filed as a document of the project or client given. The prompt,
   * the model, who asked and when go with it (metadata.generated) and into the audit trail.
   */
  app.post('/ai/image', {
    preHandler: [app.authenticate, app.requirePermissions('ai.image', 'document.write')],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const actor = actorFrom(req);
    if (env.IMAGE_MODE === 'off') throw new AppError(503, 'IMAGE_OFF', 'ساخت تصویر در این نصب خاموش است.');
    const input = parse(aiImageSchema, req.body);
    const started = Date.now();
    const fail = async (e: unknown) => {
      await prisma.aiInteraction.create({
        data: { organizationId: actor.organizationId, userId: actor.id, capability: 'IMAGE', model: imageServer.model, promptSummary: 'image', latencyMs: Date.now() - started, succeeded: false, errorMessage: (e as Error).message.slice(0, 500) },
      }).catch(() => undefined);
    };

    let png: Buffer;
    try {
      png = await drawImage(input.prompt, input.size, AbortSignal.timeout(IMAGE_TIMEOUT_MS));
    } catch (e) {
      req.log.warn({ err: e }, 'image failed');
      await fail(e);
      throw new AppError(502, 'IMAGE_FAILED', 'سرور تصویر نتوانست این تصویر را بسازد. دوباره امتحان کنید یا به مدیر سیستم خبر دهید.');
    }

    // Filed as the person files any upload — their token, the documents route — so permission,
    // quota, the file's real type and the record it is attached to are each checked there.
    const boundary = `----hiva-image-${Date.now().toString(36)}`;
    const field = (k: string, v: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const parts = [
      ...(input.projectId ? [field('projectId', input.projectId)] : []),
      ...(input.companyId ? [field('companyId', input.companyId)] : []),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ai-image-${stamp}.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const filed = await app.inject({
      method: 'POST', url: '/api/v1/documents', payload: Buffer.concat(parts),
      headers: {
        authorization: req.headers.authorization ?? '', 'accept-language': req.headers['accept-language'] ?? 'fa',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
    const body = JSON.parse(filed.body) as { id: string; metadata?: Record<string, unknown> | null };
    if (filed.statusCode >= 400) {
      await fail(new Error(`documents ${filed.statusCode}`));
      return reply.code(filed.statusCode).send(body);
    }

    const generated = { prompt: input.prompt, model: imageServer.model, size: input.size, by: actor.id, at: new Date().toISOString() };
    const document = await prisma.$transaction(async (tx) => {
      const d = await tx.document.update({
        where: { id: body.id, organizationId: actor.organizationId },
        data: { metadata: { ...(body.metadata ?? {}), generated }, tags: { push: 'ai-generated' } },
      });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'GENERATE', entityType: 'document', entityId: d.id,
        after: generated, ipAddress: actor.ipAddress, requestId: actor.requestId,
      }, tx);
      return d;
    });
    await prisma.aiInteraction.create({
      data: { organizationId: actor.organizationId, userId: actor.id, capability: 'IMAGE', model: imageServer.model, promptSummary: 'image', entityType: 'document', entityId: document.id, latencyMs: Date.now() - started, succeeded: true },
    }).catch(() => undefined);
    return reply.code(201).send(document);
  });
};

export default aiCreateRoutes;
