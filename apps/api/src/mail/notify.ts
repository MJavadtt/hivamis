import { prisma } from '../db.js';
import { env, mailEnabled } from '../env.js';
import { enqueueMail } from '../jobs/runner.js';
import {
  formApprovalMail, overdueDigestMail, slaBreachMail, slaWarningMail, type MailBody,
} from './templates.js';

/**
 * The one place a person is told something.
 *
 * Writes the in-app Notification row and, when mail is configured and the kind warrants it,
 * queues an email. Notification never participates in the business transaction: it is called
 * after the commit and it swallows its own failures, because a notification that cannot be
 * delivered must not roll back the work it was describing.
 */

/**
 * Kinds worth an email. A constant rather than scattered conditionals: the decision is "does
 * this need someone who is not looking at the app", and it is easier to argue about in one list.
 * FORM_APPROVED and FORM_REJECTED are deliberately absent — the person who submitted is
 * already in the app, and mailing every outcome is how people learn to filter the sender.
 */
export const EMAILED_KINDS = new Set([
  'SLA_BREACH',
  'SLA_WARNING',
  // The prediction (roadmap #8) is emailed for the same reason the warning is, and fires at
  // most once per clock — earlier than the fixed threshold, which is the whole point of it.
  'SLA_PREDICTED_BREACH',
  'FORM_APPROVAL_REQUIRED',
  'OVERDUE_DIGEST',
]);

export interface NotifyInput {
  userId: string | null;
  kind: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  severity?: string;
  /** Supplies the email body when the kind is emailed; omitted kinds stay in-app only. */
  mail?: MailBody;
}

export async function notify(input: NotifyInput): Promise<void> {
  if (!input.userId) return;

  await prisma.notification.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      severity: input.severity ?? 'INFO',
    },
  }).catch(() => undefined);

  // The messenger (roadmap #40) for what matters away from the app. Imported late: the messenger
  // decides forms through the forms engine, which itself notifies.
  await import('../messenger/service.js')
    .then((m) => m.pushNotification({ ...input, userId: input.userId! }))
    .catch(() => undefined);

  if (!mailEnabled || !EMAILED_KINDS.has(input.kind) || !input.mail) return;

  const user = await prisma.user
    .findUnique({ where: { id: input.userId }, select: { email: true, isActive: true } })
    .catch(() => null);
  if (!user?.email || !user.isActive) return;

  // Queued, not sent inline: a slow relay would otherwise hold the SLA tick or the request.
  await enqueueMail({ to: user.email, ...input.mail }).catch(() => undefined);
}

/** Absolute link back into the SPA, so an email is actionable rather than just informative. */
export function appUrl(path: string): string {
  const base = env.CORS_ORIGIN.split(',')[0]!.trim().replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export { formApprovalMail, overdueDigestMail, slaBreachMail, slaWarningMail };
