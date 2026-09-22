import PgBoss from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import { env, mailEnabled } from '../env.js';
import { prisma } from '../db.js';
import { tickSlaClocks } from '../sla/engine.js';
import { notifyPredictedBreaches } from '../sla/predict.js';
import { reindexMemory } from '../memory/index.js';
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
  for (const queue of ['sla:tick', 'digest:overdue', 'mail:send', 'report:client-weekly', 'memory:index']) {
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
    const overdue = await prisma.task.findMany({
      where: {
        dueDate: { lt: new Date() },
        state: { notIn: ['APPROVED', 'CLOSED', 'CANCELLED'] },
        assigneeId: { not: null },
      },
      select: { assigneeId: true },
    });
    const byUser = new Map<string, number>();
    for (const t of overdue) {
      if (t.assigneeId) byUser.set(t.assigneeId, (byUser.get(t.assigneeId) ?? 0) + 1);
    }
    for (const [userId, count] of byUser) {
      await prisma.notification.create({
        data: {
          userId, kind: 'OVERDUE_DIGEST',
          title: `${count} وظیفه سررسید گذشته دارید`,
          body: 'برای مشاهده فهرست وظایف کلیک کنید.',
          severity: 'WARNING',
        },
      }).catch(() => undefined);
    }
    logger.info({ users: byUser.size, tasks: overdue.length }, 'overdue digest sent');
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

  await boss.schedule('sla:tick', '*/5 * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('digest:overdue', '0 8 * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('report:client-weekly', '0 9 * * 6', {}, { tz: 'Asia/Tehran' });

  await boss.schedule('memory:index', '17 * * * *', {}, { tz: 'Asia/Tehran' });
  logger.info('background jobs started (sla:tick every 5m, digest:overdue daily 08:00, report:client-weekly Sat 09:00, memory:index hourly)');
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
