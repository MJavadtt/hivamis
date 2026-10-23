import { Prisma } from '@prisma/client';
import type { Tx } from '../db.js';
import { endSessions } from './session.js';

/**
 * Removing a person (owner's report, 2026-10-23, and the owner's answer): someone with history is
 * removed but keeps their name in it; someone with none is deleted outright.
 *
 * History is any row elsewhere that points at them — a task, a document, an approval, a comment, an
 * audit row (their own sign-ins included). Those rows must keep saying who it was, so such a person
 * is marked deleted: no sign-in, out of every list and picker, their address freed for someone new,
 * and their name where it was. A person nothing points at — made and never used — leaves no trace.
 *
 * The person's own state is not history: their sessions, roles, notifications, the browsers and
 * messenger that reach them, sign-in codes and links, their private conversations with the
 * assistant. Those go with them either way.
 */

const OWN_STATE = new Set([
  'UserRole.userId', 'Session.userId', 'Session.impersonatorId', 'UserPermissionOverride.userId', 'UserPermissionOverride.grantedById',
  'Notification.userId', 'MessengerLink.userId', 'MessengerAction.userId', 'PushSubscription.userId', 'UserIdentity.userId',
  'OtpCode.userId', 'SmsMessage.userId', 'OAuthState.userId', 'IdentityLinkOffer.userId', 'LoginTicket.userId',
  'SignupRequest.decidedById', 'SignupRequest.userId', 'IdempotencyKey.userId', 'AiPlan.userId', 'AiConversation.userId',
  'ChatMember.userId', 'Team.leadId', 'PersonHold.userId',
]);

/** Every column that points at a person and is history, read from Prisma's own description of the schema. */
export const HISTORY_COLUMNS: readonly { model: string; field: string }[] = Prisma.dmmf.datamodel.models.flatMap((m) =>
  m.fields
    .filter((f) => f.kind === 'object' && f.type === 'User' && (f.relationFromFields?.length ?? 0) === 1)
    .map((f) => ({ model: m.name, field: f.relationFromFields![0]! }))
    .filter((c) => !OWN_STATE.has(`${c.model}.${c.field}`)),
);

const delegate = (tx: Tx, model: string) =>
  (tx as unknown as Record<string, { count(args: unknown): Promise<number> }>)[model[0]!.toLowerCase() + model.slice(1)]!;

/** Whether anything that is history points at this person. */
export async function hasHistory(tx: Tx, userId: string): Promise<boolean> {
  for (const c of HISTORY_COLUMNS) {
    if (await delegate(tx, c.model).count({ where: { [c.field]: userId } })) return true;
  }
  return false;
}

export async function removeUser(tx: Tx, user: { id: string }): Promise<'removed' | 'deleted'> {
  if (!(await hasHistory(tx, user.id))) {
    await tx.user.delete({ where: { id: user.id } });
    return 'deleted';
  }
  await endSessions(tx, user.id, 'REMOVED');
  await tx.user.update({
    where: { id: user.id },
    data: {
      deletedAt: new Date(), isActive: false,
      // The address and the mobile are freed for whoever comes next; the name stays in the history.
      email: `removed-${user.id}@removed.invalid`, phone: null, phoneVerifiedAt: null, teamId: null,
    },
  });
  // What reached them or spoke for them ends with them.
  await tx.userRole.deleteMany({ where: { userId: user.id } });
  await tx.userPermissionOverride.deleteMany({ where: { userId: user.id } });
  await tx.userIdentity.deleteMany({ where: { userId: user.id } });
  await tx.pushSubscription.deleteMany({ where: { userId: user.id } });
  await tx.messengerLink.deleteMany({ where: { userId: user.id } });
  await tx.delegation.updateMany({ where: { OR: [{ fromUserId: user.id }, { toUserId: user.id }], revokedAt: null }, data: { revokedAt: new Date() } });
  return 'removed';
}
