import { prisma } from '../db.js';
import { deactivateUser } from '../auth/session.js';

/**
 * The demo accounts seeded for local development all live on this domain and share a password
 * that is published in README.md. Finding any of them active in production means the seed's
 * demo phase ran somewhere it should not have — or a development dump was restored there.
 */
export const DEMO_EMAIL_DOMAIN = '@hiva.local';

export const isDemoEmail = (email: string): boolean => email.trim().toLowerCase().endsWith(DEMO_EMAIL_DOMAIN);

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

/** The command that clears them while the API will not start: a one-off container needs no API. */
export const DEACTIVATE_COMMAND = 'docker compose run --rm api node dist/cli.js demo:deactivate';

/**
 * Audit SEC-8: production does not start with a login anyone holding the README can use.
 *
 * This used to warn and carry on, on the reasoning that a running service can be fixed through its
 * own admin API. But the warning went to a log, and the accounts kept working the whole time it sat
 * there. Now the operator clears them first — `demo:deactivate`, which needs no running API — or
 * says, with ALLOW_DEMO_ACCOUNTS=true, that they mean to run with them; that choice is logged at
 * fatal on every boot so it cannot quietly become permanent. A failed lookup does not refuse: the
 * database being unreachable is reported by everything else that follows.
 */
export async function demoAccountGate(
  log: { fatal: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void },
  allow: boolean,
): Promise<{ refuse: boolean; report: DemoAccountReport | null }> {
  const report = await findActiveDemoAccounts().catch((err: unknown) => {
    log.error({ err }, 'could not check for demo accounts');
    return null;
  });
  if (!report || report.count === 0) return { refuse: false, report };

  const what = `${report.count} demo account(s) are active in production; they share a password published in README.md.`;
  if (allow) {
    log.fatal({ demoAccounts: report.emails }, `SECURITY: ${what} Starting anyway because ALLOW_DEMO_ACCOUNTS=true. ` +
      `Deactivate them (${DEACTIVATE_COMMAND}) and remove the flag.`);
    return { refuse: false, report };
  }
  log.fatal({ demoAccounts: report.emails }, `SECURITY: ${what} Refusing to start. ` +
    `Deactivate them with: ${DEACTIVATE_COMMAND} — or set ALLOW_DEMO_ACCOUNTS=true to start with them (see docs/operations.md).`);
  return { refuse: true, report };
}

/** `demo:deactivate`: every active demo account on the installation, each audited as the system's act. */
export async function deactivateDemoAccounts(): Promise<{ deactivated: string[] }> {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: DEMO_EMAIL_DOMAIN }, isActive: true, deletedAt: null },
    select: { id: true, email: true, organizationId: true },
    orderBy: { email: 'asc' },
  });
  await prisma.$transaction(async (tx) => {
    for (const u of users) await deactivateUser(tx, u, { id: null }, 'demo account deactivated by the operator (audit SEC-8)');
  });
  return { deactivated: users.map((u) => u.email) };
}
