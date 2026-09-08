import { prisma } from '../db.js';

/**
 * The demo accounts seeded for local development all live on this domain and share a password
 * that is published in README.md. Finding any of them active in production means the seed's
 * demo phase ran somewhere it should not have.
 */
const DEMO_EMAIL_DOMAIN = '@hiva.local';

export interface DemoAccountReport {
  readonly count: number;
  readonly emails: string[];
}

/** Cheap existence check — matches on the email domain rather than verifying password hashes. */
export async function findActiveDemoAccounts(): Promise<DemoAccountReport> {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: DEMO_EMAIL_DOMAIN }, isActive: true, deletedAt: null },
    select: { email: true },
    orderBy: { email: 'asc' },
  });
  return { count: users.length, emails: users.map((u) => u.email) };
}

/**
 * Warns rather than refusing to start, deliberately. A running service with a loud, monitorable
 * warning can be remediated through its own admin API; a service that refuses to boot cannot,
 * and turns a configuration mistake into an outage. The count is also surfaced on
 * GET /health/ready so monitoring can alert on it.
 */
export async function warnOnDemoAccounts(log: {
  fatal: (obj: object, msg: string) => void;
}): Promise<DemoAccountReport | null> {
  const report = await findActiveDemoAccounts().catch(() => null);
  if (!report || report.count === 0) return report;

  log.fatal(
    { demoAccounts: report.emails },
    `SECURITY: ${report.count} demo account(s) are active in production. They share a password ` +
      'published in README.md. Deactivate them now: POST /api/v1/users/:id/deactivate, ' +
      'or see the production readiness checklist in docs/operations.md.',
  );
  return report;
}
