import PgBoss from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { tickSlaClocks } from '../sla/engine.js';

/**
 * Background jobs run on pg-boss — a Postgres-backed queue. Chosen over Redis+BullMQ because the
 * platform already depends on Postgres and the job volume (SLA ticks, digests) is agency-scale;
 * adding a second datastore would be operational cost with no benefit at this size.
 */
export async function startJobs(logger: FastifyBaseLogger): Promise<PgBoss | null> {
  if (!env.JOBS_ENABLED) {
    logger.info('background jobs disabled (JOBS_ENABLED=false)');
    return null;
  }

  const boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();

  // pg-boss v10 requires a queue to exist before work() or schedule() references it.
  for (const queue of ['sla:tick', 'digest:overdue']) {
    await boss.createQueue(queue).catch(() => undefined);
  }

  await boss.work('sla:tick', async () => {
    const result = await tickSlaClocks();
    if (result.warned || result.breached) {
      logger.info({ ...result }, 'SLA tick');
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

  // Every 5 minutes: advance SLA clocks. Daily at 08:00: overdue digest.
  await boss.schedule('sla:tick', '*/5 * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule('digest:overdue', '0 8 * * *', {}, { tz: 'Asia/Tehran' });

  logger.info('background jobs started (sla:tick every 5m, digest:overdue daily 08:00)');
  return boss;
}
