/**
 * Team chat (audit F-5). A conversation is its members': every read and write here is scoped to the
 * organisation and checked against membership, and a conversation someone is not in answers 404 —
 * as another organisation's record would. Beyond the members, only a reviewer holding
 * chat.oversight reads it, each look recorded with its reason (routes/team-chat.ts).
 */
import type { FastifyInstance } from 'fastify';
import { RECORD_CODE, type ChatConversationSummary, type ChatMessageView, type ChatNotify } from '@hiva/contracts';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { notFound } from '../lib/errors.js';
import { asAgentFor } from '../lib/request-context.js';
import { notify } from '../mail/notify.js';
import { withAvatar } from '../profile/avatars.js';

export interface Actor { id: string; organizationId: string }

/** A member's own row, in force; otherwise the conversation does not exist for them. */
export async function membership(conversationId: string, actor: Actor, tx: Tx = prisma) {
  const m = await tx.chatMember.findFirst({
    where: { conversationId, userId: actor.id, leftAt: null, conversation: { organizationId: actor.organizationId } },
    include: { conversation: true },
  });
  if (!m) throw notFound('گفت‌وگو');
  return m;
}

export const directKey = (a: string, b: string) => [a, b].sort().join(':');

/* ── Live delivery: who may hear of a conversation ─────────────────────────────────────────── */

const MEMBERS_TTL_MS = 60_000;
const members = new Map<string, { users: Set<string>; at: number }>();

/** Whether a person is in a conversation now — asked for every message by every open stream, so kept a minute. */
export async function isMember(conversationId: string, userId: string): Promise<boolean> {
  const hit = members.get(conversationId);
  if (hit && Date.now() - hit.at < MEMBERS_TTL_MS) return hit.users.has(userId);
  const rows = await prisma.chatMember.findMany({ where: { conversationId, leftAt: null }, select: { userId: true } });
  members.set(conversationId, { users: new Set(rows.map((r) => r.userId)), at: Date.now() });
  return rows.some((r) => r.userId === userId);
}
/** Someone joined or left: what was known of the conversation is forgotten. */
export const forgetMembers = (conversationId: string) => members.delete(conversationId);

/* ── Reading ────────────────────────────────────────────────────────────────────────────────── */

/** What each of the person's conversations has unread: messages of others since they last read it. */
export async function unreadCounts(actor: Actor): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ conversationId: string; n: number }[]>(Prisma.sql`
    SELECT m."conversationId", count(*)::int AS n
    FROM chat_messages m
    JOIN chat_members cm ON cm."conversationId" = m."conversationId" AND cm."userId" = ${actor.id} AND cm."leftAt" IS NULL
    WHERE m."organizationId" = ${actor.organizationId} AND m."deletedAt" IS NULL AND m."authorId" <> ${actor.id}
      AND m."createdAt" >= cm."joinedAt" AND (cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt")
    GROUP BY m."conversationId"`);
  return new Map(rows.map((r) => [r.conversationId, r.n]));
}

/** The person's conversations, the most recently active first. */
export async function conversationsOf(actor: Actor, opts: { archived?: boolean } = {}): Promise<ChatConversationSummary[]> {
  const rows = await prisma.chatMember.findMany({
    where: {
      userId: actor.id, leftAt: null,
      conversation: { organizationId: actor.organizationId, archivedAt: opts.archived ? { not: null } : null },
    },
    include: {
      conversation: {
        include: {
          _count: { select: { members: { where: { leftAt: null } } } },
          members: { where: { leftAt: null }, take: 3, select: { user: { select: { id: true, fullName: true, avatarDocumentId: true } } } },
          messages: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, createdAt: true, author: { select: { fullName: true } } } },
        },
      },
    },
    orderBy: [{ conversation: { lastMessageAt: { sort: 'desc', nulls: 'last' } } }, { joinedAt: 'desc' }],
    take: 300,
  });
  const unread = await unreadCounts(actor);
  return rows.map(({ conversation: c, ...m }) => {
    const other = c.kind === 'DIRECT' ? c.members.map((x) => x.user).find((u) => u.id !== actor.id) : undefined;
    const peer = other ? withAvatar(other) : null;
    const last = c.messages[0];
    return {
      id: c.id, kind: c.kind as ChatConversationSummary['kind'], title: peer?.fullName ?? c.title ?? '', topic: c.topic, peer,
      memberCount: c._count.members, unread: unread.get(c.id) ?? 0, muted: m.muted, notify: m.notify as ChatNotify,
      role: m.role as ChatConversationSummary['role'],
      lastMessage: last ? { authorName: last.author.fullName, body: last.body.slice(0, 160), at: last.createdAt.toISOString() } : null,
      archived: !!c.archivedAt,
    };
  });
}

type MessageRow = Prisma.ChatMessageGetPayload<{ include: typeof messageInclude }>;
export const messageInclude = {
  author: { select: { id: true, fullName: true, avatarDocumentId: true } },
  replyTo: { select: { id: true, body: true, deletedAt: true, author: { select: { fullName: true } } } },
  attachments: { where: { deletedAt: null }, select: { id: true, fileName: true, mimeType: true, sizeBytes: true } },
} satisfies Prisma.ChatMessageInclude;

/** A message as a member sees it: a deleted one says so, and no longer what it said. */
export function messageView(m: MessageRow, opts: { reviewer?: boolean } = {}): ChatMessageView & { deletedAt?: string | null } {
  const hidden = !!m.deletedAt && !opts.reviewer;
  return {
    id: m.id, author: withAvatar(m.author),
    body: hidden ? '' : m.body,
    replyTo: m.replyTo ? { id: m.replyTo.id, authorName: m.replyTo.author.fullName, body: m.replyTo.deletedAt && !opts.reviewer ? '' : m.replyTo.body.slice(0, 200) } : null,
    attachments: hidden ? [] : m.attachments,
    mentionIds: m.mentionIds,
    editedAt: m.editedAt?.toISOString() ?? null,
    deleted: !!m.deletedAt,
    createdAt: m.createdAt.toISOString(),
    // The reviewer sees when it was deleted, and what it said.
    ...(opts.reviewer ? { deletedAt: m.deletedAt?.toISOString() ?? null } : {}),
  };
}

/**
 * The records the messages name by code, as the reader may see them: each code is looked up through
 * the global search, as that person — a code they may not open stays plain text.
 */
export async function recordsNamed(app: FastifyInstance, readerId: string, authorization: string, bodies: string[]) {
  const codes = [...new Set(bodies.flatMap((b) => b.match(RECORD_CODE) ?? []))].slice(0, 20);
  const out: Record<string, { type: string; id: string; title: string }> = {};
  await Promise.all(codes.map(async (code) => {
    const res = await asAgentFor(readerId, () => app.inject({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(code)}`, headers: { authorization } }));
    if (res.statusCode !== 200) return;
    const groups = (JSON.parse(res.body) as { groups?: { type: string; items: { id: string; code?: string; title?: string; name?: string }[] }[] }).groups ?? [];
    for (const g of groups) {
      const hit = g.items.find((i) => i.code === code);
      if (hit) { out[code] = { type: g.type, id: hit.id, title: hit.title ?? hit.name ?? code }; return; }
    }
  }));
  return out;
}

/* ── Telling members away from the page ─────────────────────────────────────────────────────── */

/**
 * After a message is sent: members who want to hear of it are told — by name if they were named.
 * The notice says who wrote and where, never what: it may go to a phone's lock screen or through a
 * messenger outside the installation. One notice per conversation until it is read; a mention
 * always gets its own.
 */
export async function tellMembers(message: { id: string; conversationId: string; authorId: string; mentionIds: string[] }) {
  const c = await prisma.chatConversation.findUnique({
    where: { id: message.conversationId },
    select: {
      kind: true, title: true,
      members: { where: { leftAt: null, userId: { not: message.authorId } }, select: { userId: true, muted: true, notify: true, lastReadAt: true } },
    },
  });
  const author = await prisma.user.findUnique({ where: { id: message.authorId }, select: { fullName: true } });
  if (!c || !author) return;
  for (const m of c.members) {
    const named = message.mentionIds.includes(m.userId);
    if (m.muted || m.notify === 'NONE' || (m.notify === 'MENTIONS' && !named)) continue;
    if (!named) {
      const told = await prisma.notification.count({
        where: { userId: m.userId, kind: 'CHAT_MESSAGE', entityType: 'chatConversation', entityId: message.conversationId, readAt: null, ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {}) },
      });
      if (told) continue;
    }
    const where = c.kind === 'DIRECT' ? null : c.title;
    await notify({
      userId: m.userId, kind: named ? 'CHAT_MENTION' : 'CHAT_MESSAGE',
      title: named
        ? (where ? `${author.fullName} در «${where}» شما را نام برد` : `${author.fullName} شما را نام برد`)
        : (where ? `پیام تازه از ${author.fullName} در «${where}»` : `پیام تازه از ${author.fullName}`),
      entityType: 'chatConversation', entityId: message.conversationId,
    });
  }
}
