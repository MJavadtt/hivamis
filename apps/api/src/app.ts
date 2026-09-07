import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { env } from './env.js';
import { prisma } from './db.js';
import { AppError } from './lib/errors.js';
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

export async function buildApp(): Promise<FastifyInstance> {
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
    trustProxy: true,
  });

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
    keyGenerator: (req) => (req as any).user?.sub ?? req.ip,
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
      return { status: 'ready', database: 'up' };
    } catch {
      return reply.code(503).send({ status: 'not-ready', database: 'down' });
    }
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
  }, { prefix: '/api/v1' });

  /** Machine-readable route inventory, used by the docs and smoke tests. */
  app.get('/api/v1/_routes', async () =>
    app.printRoutes({ commonPrefix: false }).split('\n').filter(Boolean));

  return app;
}
