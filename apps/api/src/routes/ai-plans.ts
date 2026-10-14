import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { transcribe, transcriptionConfigured } from '../meetings/transcribe.js';
import { executePlan } from '../ai/plans.js';

/**
 * Speaking to the assistant, and acting on what it proposes (audit F-4).
 *
 * - Speech becomes text on the installation's own speech server (TRANSCRIPTION_URL — a local
 *   Whisper-compatible server in the `speech` Compose profile), so audio never leaves it. The audio is
 *   not kept; the text goes back to the person, who sends it — or not.
 * - A plan the assistant proposed runs only the steps its owner approves, as them, through the
 *   ordinary API. Nobody else may run, see or decline it.
 */

/** Long enough for a sentence or three; a meeting has its own route. */
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const AUDIO = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac|m4a)(;.*)?$/;
/** A plan older than this is not run: what it read may have moved. */
const PLAN_TTL_MS = 30 * 60_000;

const executeSchema = z.object({ steps: z.array(z.number().int().min(0).max(7)).max(8) });

const aiPlanRoutes: FastifyPluginAsync = async (app) => {
  const guard = { preHandler: [app.authenticate, app.requirePermissions('ai.chat')] };

  app.get('/ai/voice/status', guard, async () => ({ configured: transcriptionConfigured() }));

  app.post('/ai/voice/transcribe', { ...guard, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const actor = actorFrom(req);
    const file = await (req as unknown as { file: () => Promise<{ mimetype: string; filename: string; toBuffer: () => Promise<Buffer> } | undefined> }).file();
    if (!file) throw badRequest('NO_FILE', 'صدایی فرستاده نشده است.');
    if (!AUDIO.test(file.mimetype)) throw badRequest('UNSUPPORTED_TYPE', `نوع صدای «${file.mimetype}» پشتیبانی نمی‌شود.`);
    const audio = await file.toBuffer();
    if (audio.length > MAX_VOICE_BYTES) throw new AppError(413, 'VOICE_TOO_LONG', 'پیام صوتی بلندتر از حد است؛ کوتاه‌تر بگویید.');
    const started = Date.now();
    try {
      const r = await transcribe(audio, file.filename || 'voice.webm', file.mimetype);
      await prisma.aiInteraction.create({ data: { organizationId: actor.organizationId, userId: actor.id, capability: 'VOICE', model: r.model, promptSummary: 'voice', latencyMs: Date.now() - started, succeeded: true } }).catch(() => undefined);
      return { text: r.text };
    } catch (e) {
      await prisma.aiInteraction.create({ data: { organizationId: actor.organizationId, userId: actor.id, capability: 'VOICE', model: 'transcription', promptSummary: 'voice', latencyMs: Date.now() - started, succeeded: false, errorMessage: (e as Error).message.slice(0, 500) } }).catch(() => undefined);
      throw e;
    }
  });

  async function ownPlan(id: string, actor: { id: string; organizationId: string }) {
    const plan = await prisma.aiPlan.findFirst({ where: { id, userId: actor.id, organizationId: actor.organizationId } });
    if (!plan) throw notFound('برنامه');
    if (plan.status !== 'PROPOSED') throw conflict('PLAN_DECIDED', 'دربارهٔ این برنامه پیش‌تر تصمیم گرفته شده است.');
    if (Date.now() - plan.createdAt.getTime() > PLAN_TTL_MS) throw conflict('PLAN_EXPIRED', 'این برنامه کهنه شده است؛ دوباره از دستیار بخواهید.');
    return plan;
  }

  /** A plan's state, for its card — reopened from the history, it says what became of it. */
  app.get('/ai/plans/:id', guard, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const plan = await prisma.aiPlan.findFirst({
      where: { id, userId: actor.id, organizationId: actor.organizationId },
      select: { id: true, status: true, outcome: true, createdAt: true, decidedAt: true },
    });
    if (!plan) throw notFound('برنامه');
    return { ...plan, expired: plan.status === 'PROPOSED' && Date.now() - plan.createdAt.getTime() > PLAN_TTL_MS };
  });

  /** The approved steps, run in order as the person; the rest declined. */
  app.post('/ai/plans/:id/execute', guard, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(executeSchema, req.body);
    const plan = await ownPlan(id, actor);
    return executePlan(app, plan, input.steps, req.headers.authorization ?? '', String(req.headers['accept-language'] ?? 'fa'));
  });

  app.post('/ai/plans/:id/decline', guard, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const plan = await ownPlan(id, actor);
    return executePlan(app, plan, [], req.headers.authorization ?? '', String(req.headers['accept-language'] ?? 'fa'));
  });
};

export default aiPlanRoutes;
