import PgBoss from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import { env, mailEnabled } from '../env.js';
import { prisma } from '../db.js';
import { tickSlaClocks } from '../sla/engine.js';
import { notifyPredictedBreaches } from '../sla/predict.js';
import { reindexMemory } from '../memory/index.js';
import { scanAll } from '../security/scan.js';
import { pruneFailures } from '../auth/throttle.js';
import { purgeDeletedFiles } from '../documents/storage.js';
import { pruneIdempotencyKeys } from '../lib/idempotency.js';
import { pruneAiToolRows } from '../ai/retention.js';
import { dispatchWebhooks } from '../integrations/webhooks.js';
import { runMoadian } from '../tax/submit.js';
import { runESign } from '../esign/service.js';
import { retryQueued as retryMessenger } from '../messenger/service.js';
import { retryQueued as retryPush } from '../push/service.js';
import { backfillMetadata } from '../documents/backfill.js';
import { getTransport } from '../mail/transport.js';
import { runWeekly } from '../reports/client-status.js';

/**
 * Background jobs run on pg-boss — a Postgres-backed queue. Chosen over Redis+BullMQ because the
 * platform already depends on Postgres and the job volume (SLA ticks, digests) is agency-scale;
 * adding a second datastore would be operational cost with no benefit at this size.
 */
/** Module-level handle so enqueueMail can reach the queue without threading it through callers. */
let runningBoss: PgBoss | null = null;

export async function startJobs(logger: FastifyBaseLogger): Promise<PgBoss | null> {
  if (!env.JOBS_ENABLED) {
    logger.info('background jobs disabled (JOBS_ENABLED=false)');
    return null;
  }

  const boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: 'pgboss' });
  runningBoss = boss;
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();

  // pg-boss v10 requires a queue to exist before work() or schedule() references it.
  for (const queue of ['sla:tick', 'digest:overdue', 'mail:send', 'report:client-weekly', 'memory:index', 'security:scan', 'webhooks:dispatch', 'moadian:run', 'esign:run', 'messenger:send', 'push:send', 'documents:metadata', 'documents:purge', 'ai:prune']) {
    await boss.createQueue(queue).catch(() => undefined);
  }

  /**
   * Delivery runs on the queue so a slow or unreachable relay cannot stall a request or the
   * SLA tick. pg-boss retries; a permanently failing address eventually lands in the dead
   * letter queue rather than being retried forever.
   */
  await boss.work('mail:send', async ([job]: { data: MailJob }[]) => {
    const transport = getTransport();
    if (!transport) return; // mail turned off between enqueue and delivery
    const { to, subject, html, text, attachments } = job.data;
    await transport.sendMail({
      from: env.SMTP_FROM, to, subject, html, text,
      attachments: attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.contentBase64, 'base64') })),
    });
  });

  await boss.work('sla:tick', async () => {
    const result = await tickSlaClocks();
    // The fixed threshold says "you are nearly out of time"; the prediction says "you are
    // going to run out", and says it earlier. Once per clock (roadmap #8).
    const predicted = await notifyPredictedBreaches();
    if (result.warned || result.breached || predicted.notified) {
      logger.info({ ...result, ...predicted }, 'SLA tick');
    }
  });

  await boss.work('digest:overdue', async () => {
    // Nudge every assignee who has work past its due date.
    // Counted per person by the database (audit PERF-4), not read task by task.
    const overdue = await prisma.task.groupBy({
      by: ['assigneeId'],
      where: { dueDate: { lt: new Date() }, state: { notIn: ['APPROVED', 'CLOSED', 'CANCELLED'] }, assigneeId: { not: null } },
      _count: { _all: true },
    });
    for (const { assigneeId: userId, _count: { _all: count } } of overdue) {
      if (!userId) continue;
      await prisma.notification.create({
        data: {
          userId, kind: 'OVERDUE_DIGEST',
          title: `${count} وظیفه سررسید گذشته دارید`,
          body: 'برای مشاهده فهرست وظایف کلیک کنید.',
          severity: 'WARNING',
        },
      }).catch(() => undefined);
    }
    logger.info({ users: overdue.length, tasks: overdue.reduce((n, o) => n + o._count._all, 0) }, 'overdue digest sent');
  });

  // Doc_H §14: the client gets a status report every week. Saturday 09:00 is the start of the
  // Iranian working week, so the report covers the week just closed.
  await boss.work('report:client-weekly', async () => {
    const result = await runWeekly();
    logger.info(result, 'client status reports');
  });

  // Every 5 minutes: advance SLA clocks. Daily at 08:00: overdue digest. Saturday 09:00: reports.
  await boss.work('memory:index', async () => {
    // Only what changed is re-embedded (roadmap #21), so an unchanged corpus costs a few
    // queries and no model calls at all.
    const orgs = await prisma.organization.findMany({ select: { id: true } });
    for (const org of orgs) {
      const result = await reindexMemory(org.id);
      if (result.indexed || result.removed) logger.info({ ...result, organizationId: org.id }, 'memory index');
    }
  });

  await boss.work('ai:prune', async () => {
    // The assistant's tool results, AI_HISTORY_RETENTION_DAYS on (audit PERF-5).
    const removed = await pruneAiToolRows();
    if (removed) logger.info({ removed }, 'old assistant tool results removed');
  });

  await boss.work('documents:purge', async () => {
    // Deleted documents' files, FILE_RETENTION_DAYS on, unless held (audit LOG-5).
    const r = await purgeDeletedFiles();
    if (r.purged) logger.info({ ...r }, 'deleted documents purged');
    // Answers kept for offline replays (audit F-7), past their week.
    const keys = await pruneIdempotencyKeys();
    if (keys) logger.info({ keys }, 'old idempotency keys removed');
    // Sign-in tickets and spent Mini App payloads (audit F-9): a day past their expiry they refuse nothing.
    const { count: tickets } = await prisma.loginTicket.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } } });
    if (tickets) logger.info({ tickets }, 'old sign-in tickets removed');
  });

  await boss.work('security:scan', async () => {
    // The audit trail read as it accumulates, not after the fact (roadmap #26).
    const result = await scanAll();
    if (result.created) logger.warn({ ...result }, 'security alerts raised');
    // Sign-in throttle state older than any window that reads it (audit SEC-10).
    await pruneFailures().catch((err) => logger.error({ err }, 'sign-in failures not pruned'));
  });

  await boss.work('webhooks:dispatch', async () => {
    // The transition log read forward and sent on (roadmap #46): at most a minute behind.
    const result = await dispatchWebhooks();
    if (result.enqueued || result.delivered || result.failed) logger.info({ ...result }, 'webhooks dispatched');
  });

  await boss.work('moadian:run', async () => {
    // E-invoices sent and followed until the authority answers (roadmap #32); nothing when sending is off.
    const result = await runMoadian();
    if (result.sent || result.failed || result.accepted || result.rejected) logger.info({ ...result }, 'moadian');
  });

  await boss.work('esign:run', async () => {
    // Contracts out for e-signature followed until signed, declined or lapsed (roadmap #36).
    const result = await runESign();
    if (result.synced || result.expired) logger.info({ ...result }, 'esign');
  });

  await boss.work('messenger:send', async () => {
    // Messenger messages that did not go out the first time (roadmap #40).
    const result = await retryMessenger();
    if (result.retried) logger.info({ ...result }, 'messenger');
  });

  await boss.work('push:send', async () => {
    // Pushes to phones the push service was too busy for, or could not be reached for (roadmap #49).
    const result = await retryPush();
    if (result.retried || result.expired) logger.info({ ...result }, 'push');
  });

  await boss.work('documents:metadata', async () => {
    // What files uploaded before roadmap #42 say about themselves, a few at a time.
    const result = await backfillMetadata();
    if (result.read) logger.info({ ...result }, 'documents metadata');
  });

  await boss.schedule('sla:tick', '*/5 * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('digest:overdue', '0 8 * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('report:client-weekly', '0 9 * * 6', {}, { tz: 'Asia/Tehran' });

  await boss.schedule('memory:index', '17 * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('security:scan', '*/15 * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('webhooks:dispatch', '* * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('moadian:run', '*/10 * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('esign:run', '*/10 * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('messenger:send', '* * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('push:send', '* * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('documents:metadata', '37 * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('documents:purge', '30 3 * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('ai:prune', '45 3 * * *', {}, { tz: 'Asia/Tehran' });
  logger.info('background jobs started (sla:tick every 5m, digest:overdue daily 08:00, report:client-weekly Sat 09:00, memory:index hourly, security:scan every 15m, webhooks:dispatch every minute, moadian:run every 10m, esign:run every 10m, messenger:send every minute, push:send every minute, documents:metadata hourly)');
  return boss;
}

export interface MailJob {
  to: string; subject: string; html: string; text: string;
  /** Base64 because the job is JSON in the queue; decoded at delivery. */
  attachments?: { filename: string; contentBase64: string }[];
}

/**
 * Hands a message to the queue. A no-op when mail is off or the runner has not started, so
 * callers never have to check — notification must not fail the work it describes.
 */
export async function enqueueMail(job: MailJob): Promise<void> {
  if (!mailEnabled || !runningBoss) return;
  await runningBoss.send('mail:send', job, { retryLimit: 3, retryDelay: 60, retryBackoff: true });
}
