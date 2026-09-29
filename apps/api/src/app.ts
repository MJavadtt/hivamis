import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { env, trustProxy } from './env.js';
import { prisma } from './db.js';
import { findActiveDemoAccounts } from './lib/demo-accounts.js';
import { AppError } from './lib/errors.js';
import { requestContext } from './lib/request-context.js';
import { pdfEngineHealthyCached } from './pdf/renderer.js';
import authPlugin from './auth/plugin.js';
import authRoutes from './routes/auth.js';
import workflowRoutes from './routes/workflow.js';
import crmRoutes from './routes/crm.js';
import deliveryRoutes from './routes/delivery.js';
import qualityRoutes from './routes/quality.js';
import commercialRoutes from './routes/commercial.js';
import resourceRoutes from './routes/resources.js';
import governanceRoutes from './routes/governance.js';
import formRoutes from './routes/forms.js';
import reportRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';
import documentRoutes from './routes/documents.js';
import aiRoutes from './routes/ai.js';
import searchRoutes from './routes/search.js';
import pdfRoutes from './routes/pdf.js';
import historyRoutes from './routes/history.js';
import myWorkRoutes from './routes/my-work.js';
import memoryRoutes from './routes/memory.js';
import securityRoutes from './routes/security.js';
import meetingRoutes from './routes/meetings.js';
import askRoutes from './routes/ask.js';
import fxRoutes from './routes/fx.js';
import revenueRoutes from './routes/revenue.js';
import mediaRoutes from './routes/media.js';
import integrationRoutes from './routes/integrations.js';
import taxRoutes from './routes/tax.js';
import accountingRoutes from './routes/accounting.js';
import clientApprovalRoutes from './routes/client-approvals.js';
import portalRoutes from './routes/portal.js';
import esignRoutes from './routes/esign.js';
import liveRoutes from './routes/live.js';
import messengerRoutes from './routes/messenger.js';
import annotationRoutes from './routes/annotations.js';
import brandRoutes from './routes/brand.js';
import delegationRoutes from './routes/delegations.js';
import waiverRoutes from './routes/waivers.js';
import ruleRoutes from './routes/rules.js';
import orgRuleRoutes from './routes/org-rules.js';
import onboardingRoutes from './routes/onboarding.js';

export async function buildApp(): Promise<FastifyInstance> {
  // The rules the running code declares become a version row if they changed since last boot,
  // so every transition can name the rules that allowed it (roadmap #4).
  // Extensions first (roadmap #47): what they add is part of the rules being registered. A broken
  // one stops the boot — see src/extensions/loader.ts.
  const { loadExtensions } = await import('./extensions/loader.js');
  await loadExtensions();
  const { registerRuleSets } = await import('./workflow/rules.js');
  await registerRuleSets().catch(() => undefined);
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
      // Never let credentials or tokens reach the logs.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'body.password', 'body.newPassword', 'body.currentPassword'],
    },
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
    // Never `true` by default: with unconditional trust, any client can set X-Forwarded-For
    // and rotate itself through rate-limit buckets. See TRUST_PROXY in env.ts.
    trustProxy,
  });

  // A request-scoped store (roadmap #46): opened here, so everything the request runs sees its own.
  app.addHook('onRequest', (_req, _reply, done) => requestContext.run({}, done));

  await app.register(helmet, {
    contentSecurityPolicy: false, // the API serves JSON + downloads only; the SPA sets its own CSP
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    // Keyed on IP only. @fastify/rate-limit runs in onRequest and authentication runs in
    // preHandler, so req.user is not yet populated here — a per-user branch would be dead code
    // that reads as a protection the limiter does not actually provide.
    keyGenerator: (req) => req.ip,
  });
  await app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  });
  await app.register(fastifyStatic, {
    root: path.resolve(env.STORAGE_DIR),
    serve: false, // reply.sendFile only — no directory listing, no public path
  });

  await app.register(authPlugin);

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.messageFa,
          details: error.details ?? undefined,
          requestId: req.id,
        },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'تعداد درخواست‌ها بیش از حد مجاز است.', requestId: req.id },
      });
    }
    // Prisma unique-constraint violation
    if ((error as { code?: string }).code === 'P2002') {
      return reply.code(409).send({
        error: { code: 'DUPLICATE', message: 'رکورد تکراری است.', requestId: req.id },
      });
    }
    if ((error as { code?: string }).code === 'P2025') {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'رکورد یافت نشد.', requestId: req.id },
      });
    }
    if ((error as { code?: string }).code === 'P2003') {
      return reply.code(400).send({
        error: { code: 'FK_VIOLATION', message: 'ارجاع نامعتبر به رکورد دیگر.', requestId: req.id },
      });
    }
    req.log.error({ err: error }, 'unhandled error');
    // Internal details are logged, never returned.
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'خطای داخلی سرور رخ داد.', requestId: req.id },
    });
  });

  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/health/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return reply.code(503).send({ status: 'not-ready', database: 'down' });
    }
    // Non-blocking: seeded demo accounts are a deployment defect, not an outage. Reported so
    // monitoring can alert on a non-zero count without the service failing its readiness probe.
    const demoAccounts =
      env.NODE_ENV === 'production'
        ? await findActiveDemoAccounts().then((r) => r.count).catch(() => null)
        : 0;
    // Also non-blocking: a missing browser degrades PDF export to a 503 and leaves the rest of
    // the platform working (ADR-014), so it must not fail the readiness probe. docs/pdf-export.md
    // told operators to verify the engine here, which until now reported nothing about it.
    const pdf = await pdfEngineHealthyCached().catch(() => false);
    return { status: 'ready', database: 'up', demoAccounts, pdf: pdf ? 'up' : 'unavailable' };
  });

  app.get('/health/live', async () => ({ status: 'alive' }));

  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(workflowRoutes);
    await api.register(crmRoutes);
    await api.register(deliveryRoutes);
    await api.register(qualityRoutes);
    await api.register(commercialRoutes);
    await api.register(resourceRoutes);
    await api.register(governanceRoutes);
    await api.register(formRoutes);
    await api.register(reportRoutes);
    await api.register(adminRoutes);
    await api.register(documentRoutes);
    await api.register(aiRoutes);
    await api.register(searchRoutes);
    await api.register(pdfRoutes);
    await api.register(historyRoutes);
    await api.register(myWorkRoutes);
    await api.register(delegationRoutes);
    await api.register(waiverRoutes);
    await api.register(ruleRoutes);
    await api.register(orgRuleRoutes);
    await api.register(onboardingRoutes);
    await api.register(memoryRoutes);
    await api.register(securityRoutes);
    await api.register(meetingRoutes);
    await api.register(askRoutes);
    await api.register(fxRoutes);
    await api.register(revenueRoutes);
    await api.register(mediaRoutes);
    await api.register(integrationRoutes);
    await api.register(taxRoutes);
    await api.register(accountingRoutes);
    await api.register(clientApprovalRoutes);
    await api.register(portalRoutes);
    await api.register(esignRoutes);
    await api.register(liveRoutes);
    await api.register(messengerRoutes);
    await api.register(annotationRoutes);
    await api.register(brandRoutes);
  }, { prefix: '/api/v1' });

  /** Machine-readable route inventory, used by the docs and smoke tests. */
  app.get('/api/v1/_routes', async () =>
    app.printRoutes({ commonPrefix: false }).split('\n').filter(Boolean));

  return app;
}
