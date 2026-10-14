import type { FastifyPluginAsync } from 'fastify';
import path from 'node:path';
import { z } from 'zod';
import {
  addChatMembersSchema, chatMemberRoleSchema, chatMemberSettingsSchema, createConversationSchema, editChatMessageSchema,
  oversightViewSchema, sendChatMessageSchema, updateConversationSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { withAvatar } from '../profile/avatars.js';
import {
  conversationsOf, directKey, forgetMembers, membership, messageInclude, messageView, recordsNamed, tellMembers, unreadCounts,
} from '../chat/service.js';

/**
 * Team chat (audit F-5). Every route needs `chat.use`; a conversation answers only to its members,
 * and to anyone else it does not exist (404). Oversight is separate, below: its own permission, held
 * by nobody unless the system administrator gave it, a reason for every look, and a record of each
 * that cannot be deleted.
 */

const PAGE = 50;
const OVERSIGHT_PAGE = 200;
const pageQuery = z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(PAGE).default(PAGE) });

const teamChatRoutes: FastifyPluginAsync = async (app) => {
  const storageRoot = path.resolve(env.STORAGE_DIR);
  const chat = { preHandler: [app.authenticate, app.requirePermissions('chat.use')] };
  const manage = (role: string) => role === 'OWNER' || role === 'ADMIN';

  /** Active people of this organisation, by id; anyone else is refused by name. */
  async function colleagues(organizationId: string, ids: string[]) {
    const found = await prisma.user.findMany({ where: { id: { in: ids }, organizationId, isActive: true, deletedAt: null }, select: { id: true } });
    const missing = ids.filter((i) => !found.some((f) => f.id === i));
    if (missing.length) throw badRequest('UNKNOWN_USER', 'یکی از همکاران انتخاب‌شده پیدا نشد.', { userIds: missing });
    return found.map((f) => f.id);
  }

  /* ── Conversations ──────────────────────────────────────────────────────────────────────── */

  app.get('/chat/conversations', chat, async (req) => {
    const { archived } = req.query as { archived?: string };
    return conversationsOf(actorFrom(req), { archived: archived === 'true' });
  });

  /** For the sidebar: unread messages in conversations the person has not muted. */
  app.get('/chat/unread', chat, async (req) => {
    const actor = actorFrom(req);
    const counts = await unreadCounts(actor);
    const muted = new Set((await prisma.chatMember.findMany({ where: { userId: actor.id, leftAt: null, muted: true }, select: { conversationId: true } })).map((m) => m.conversationId));
    const open = [...counts].filter(([id, n]) => n > 0 && !muted.has(id));
    return { total: open.reduce((t, [, n]) => t + n, 0), conversations: open.length };
  });

  /** Channels anyone here may find and join. */
  app.get('/chat/channels', chat, async (req) => {
    const actor = actorFrom(req);
    const rows = await prisma.chatConversation.findMany({
      where: { organizationId: actor.organizationId, kind: 'CHANNEL', archivedAt: null },
      select: {
        id: true, title: true, topic: true, lastMessageAt: true,
        _count: { select: { members: { where: { leftAt: null } } } },
        members: { where: { userId: actor.id, leftAt: null }, select: { userId: true } },
      },
      orderBy: { title: 'asc' }, take: 200,
    });
    return rows.map((c) => ({ id: c.id, title: c.title, topic: c.topic, lastMessageAt: c.lastMessageAt, memberCount: c._count.members, joined: c.members.length > 0 }));
  });

  app.post('/chat/conversations', chat, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createConversationSchema, req.body);
    if (input.kind === 'CHANNEL' && !actor.permissions.includes('chat.channel.create')) throw forbidden('ساخت کانال به دسترسی «ساخت کانال گفت‌وگو» نیاز دارد.');
    const others = (await colleagues(actor.organizationId, [...new Set(input.memberIds)])).filter((id) => id !== actor.id);

    if (input.kind === 'DIRECT') {
      const other = others[0];
      if (!other) throw badRequest('DIRECT_SELF', 'گفت‌وگوی دونفره با یک همکار دیگر است.');
      const key = directKey(actor.id, other);
      const existing = await prisma.chatConversation.findUnique({ where: { organizationId_directKey: { organizationId: actor.organizationId, directKey: key } } });
      if (existing) {
        // Someone who left a direct conversation is back in it when they open it again.
        await prisma.chatMember.updateMany({ where: { conversationId: existing.id, userId: actor.id, leftAt: { not: null } }, data: { leftAt: null } });
        return { id: existing.id, existing: true };
      }
      const c = await prisma.$transaction(async (tx) => {
        const created = await tx.chatConversation.create({
          data: {
            organizationId: actor.organizationId, kind: 'DIRECT', directKey: key, createdById: actor.id,
            members: { create: [{ userId: actor.id, role: 'MEMBER' }, { userId: other, role: 'MEMBER' }] },
          },
        });
        await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'chatConversation', entityId: created.id, after: { kind: 'DIRECT', members: [actor.id, other] }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
        return created;
      }).catch(async (e) => {
        // Two people opening the same pair at once: one conversation, both get it.
        if ((e as { code?: string }).code === 'P2002') return prisma.chatConversation.findUniqueOrThrow({ where: { organizationId_directKey: { organizationId: actor.organizationId, directKey: key } } });
        throw e;
      });
      return reply.code(201).send({ id: c.id, existing: false });
    }

    const c = await prisma.$transaction(async (tx) => {
      const created = await tx.chatConversation.create({
        data: {
          organizationId: actor.organizationId, kind: input.kind, title: input.title, topic: input.topic ?? null, createdById: actor.id,
          members: {
            create: [
              { userId: actor.id, role: 'OWNER', notify: 'ALL' },
              // In a channel one hears of what names one; in a group, of everything.
              ...others.map((userId) => ({ userId, role: 'MEMBER', notify: input.kind === 'CHANNEL' ? 'MENTIONS' : 'ALL' })),
            ],
          },
        },
      });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'chatConversation', entityId: created.id, after: { kind: input.kind, title: input.title, members: [actor.id, ...others] }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return created;
    });
    return reply.code(201).send({ id: c.id, existing: false });
  });

  app.get('/chat/conversations/:id', chat, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const me = await membership(id, actor);
    const c = me.conversation;
    const people = await prisma.chatMember.findMany({
      where: { conversationId: id, leftAt: null },
      select: { role: true, joinedAt: true, user: { select: { id: true, fullName: true, jobTitle: true, avatarDocumentId: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    const other = c.kind === 'DIRECT' ? people.map((p) => p.user).find((u) => u.id !== actor.id) : undefined;
    const peer = other ? { id: other.id, fullName: other.fullName } : null;
    return {
      id: c.id, kind: c.kind, title: peer?.fullName ?? c.title ?? '', topic: c.topic, peer, archived: !!c.archivedAt, createdAt: c.createdAt,
      me: { role: me.role, muted: me.muted, notify: me.notify, lastReadAt: me.lastReadAt },
      members: people.map((p) => ({ ...withAvatar(p.user), role: p.role, joinedAt: p.joinedAt })),
    };
  });

  app.patch('/chat/conversations/:id', chat, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(updateConversationSchema, req.body);
    const me = await membership(id, actor);
    if (me.conversation.kind === 'DIRECT') throw badRequest('DIRECT_FIXED', 'گفت‌وگوی دونفره نام و موضوع ندارد.');
    if (!manage(me.role)) throw forbidden('این کار با مالک یا مدیر گفت‌وگوست.');
    const before = me.conversation;
    const after = await prisma.$transaction(async (tx) => {
      const updated = await tx.chatConversation.update({
        where: { id, organizationId: actor.organizationId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
          ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
        },
      });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'chatConversation', entityId: id, before: { title: before.title, topic: before.topic, archivedAt: before.archivedAt }, after: { title: updated.title, topic: updated.topic, archivedAt: updated.archivedAt }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return updated;
    });
    return { id: after.id, title: after.title, topic: after.topic, archived: !!after.archivedAt };
  });

  /** A channel is open to every colleague: joining needs nobody's leave. */
  app.post('/chat/conversations/:id/join', chat, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const c = await prisma.chatConversation.findFirst({ where: { id, organizationId: actor.organizationId, kind: 'CHANNEL', archivedAt: null } });
    if (!c) throw notFound('کانال');
    await prisma.chatMember.upsert({
      where: { conversationId_userId: { conversationId: id, userId: actor.id } },
      create: { conversationId: id, userId: actor.id, role: 'MEMBER', notify: 'MENTIONS' },
      update: { leftAt: null },
    });
    forgetMembers(id);
    return { id, joined: true };
  });

  app.post('/chat/conversations/:id/leave', chat, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const me = await membership(id, actor);
    if (me.conversation.kind === 'DIRECT') throw badRequest('DIRECT_FIXED', 'از گفت‌وگوی دونفره نمی‌شود بیرون رفت؛ می‌شود آن را بی‌صدا کرد.');
    await prisma.$transaction(async (tx) => {
      await tx.chatMember.update({ where: { conversationId_userId: { conversationId: id, userId: actor.id } }, data: { leftAt: new Date(), role: 'MEMBER' } });
      // The last owner leaving hands the conversation to the longest-standing member.
      if (me.role === 'OWNER' && !(await tx.chatMember.count({ where: { conversationId: id, leftAt: null, role: 'OWNER' } }))) {
        const next = await tx.chatMember.findFirst({ where: { conversationId: id, leftAt: null }, orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }] });
        if (next) await tx.chatMember.update({ where: { conversationId_userId: { conversationId: id, userId: next.userId } }, data: { role: 'OWNER' } });
      }
    });
    forgetMembers(id);
    return { id, left: true };
  });

  app.post('/chat/conversations/:id/members', chat, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(addChatMembersSchema, req.body);
    const me = await membership(id, actor);
    if (me.conversation.kind === 'DIRECT') throw badRequest('DIRECT_FIXED', 'گفت‌وگوی دونفره دو نفر دارد؛ برای جمع، گروه بسازید.');
    if (!manage(me.role)) throw forbidden('افزودن همکار با مالک یا مدیر گفت‌وگوست.');
    const ids = await colleagues(actor.organizationId, [...new Set(input.userIds)]);
    await prisma.$transaction(async (tx) => {
      for (const userId of ids) {
        await tx.chatMember.upsert({
          where: { conversationId_userId: { conversationId: id, userId } },
          create: { conversationId: id, userId, role: 'MEMBER', notify: me.conversation.kind === 'CHANNEL' ? 'MENTIONS' : 'ALL' },
          update: { leftAt: null },
        });
      }
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'chatConversation', entityId: id, after: { added: ids }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
    });
    forgetMembers(id);
    return { id, added: ids };
  });

  app.delete('/chat/conversations/:id/members/:userId', chat, async (req) => {
    const actor = actorFrom(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const me = await membership(id, actor);
    if (!manage(me.role)) throw forbidden('بیرون کردن همکار با مالک یا مدیر گفت‌وگوست.');
    const them = await prisma.chatMember.findFirst({ where: { conversationId: id, userId, leftAt: null } });
    if (!them || me.conversation.kind === 'DIRECT') throw notFound('عضو');
    if (them.role === 'OWNER') throw forbidden('مالک گفت‌وگو بیرون نمی‌رود؛ خودش می‌تواند ترک کند.');
    await prisma.$transaction(async (tx) => {
      await tx.chatMember.update({ where: { conversationId_userId: { conversationId: id, userId } }, data: { leftAt: new Date(), role: 'MEMBER' } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'chatConversation', entityId: id, after: { removed: [userId] }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
    });
    forgetMembers(id);
    return { id, removed: userId };
  });

  app.patch('/chat/conversations/:id/members/:userId', chat, async (req) => {
    const actor = actorFrom(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const input = parse(chatMemberRoleSchema, req.body);
    const me = await membership(id, actor);
    if (me.role !== 'OWNER') throw forbidden('نقش اعضا را مالک گفت‌وگو تعیین می‌کند.');
    const them = await prisma.chatMember.findFirst({ where: { conversationId: id, userId, leftAt: null } });
    if (!them || them.role === 'OWNER') throw notFound('عضو');
    await prisma.chatMember.update({ where: { conversationId_userId: { conversationId: id, userId } }, data: { role: input.role } });
    return { id, userId, role: input.role };
  });

  /** How the person wants to hear of this conversation. */
  app.patch('/chat/conversations/:id/me', chat, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(chatMemberSettingsSchema, req.body);
    await membership(id, actor);
    const m = await prisma.chatMember.update({ where: { conversationId_userId: { conversationId: id, userId: actor.id } }, data: input });
    return { muted: m.muted, notify: m.notify };
  });

  app.post('/chat/conversations/:id/read', chat, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    await membership(id, actor);
    const at = new Date();
    await prisma.chatMember.update({ where: { conversationId_userId: { conversationId: id, userId: actor.id } }, data: { lastReadAt: at } });
    // Its notices are read with it.
    await prisma.notification.updateMany({ where: { userId: actor.id, entityType: 'chatConversation', entityId: id, readAt: null }, data: { readAt: at } });
    return { lastReadAt: at };
  });

  /* ── Messages ───────────────────────────────────────────────────────────────────────────── */

  app.get('/chat/conversations/:id/messages', chat, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const q = parse(pageQuery, req.query);
    await membership(id, actor);
    const rows = await prisma.chatMessage.findMany({
      where: { conversationId: id, organizationId: actor.organizationId, ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}) },
      include: messageInclude, orderBy: { createdAt: 'desc' }, take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit).reverse();
    const items = page.map((m) => messageView(m));
    return { items, hasMore: rows.length > q.limit, records: await recordsNamed(app, actor.id, req.headers.authorization ?? '', items.map((m) => m.body)) };
  });

  app.post('/chat/conversations/:id/messages', chat, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(sendChatMessageSchema, req.body);
    const me = await membership(id, actor);
    if (me.conversation.archivedAt) throw new AppError(409, 'CHAT_ARCHIVED', 'این گفت‌وگو بایگانی شده است.');
    if (input.replyToId && !(await prisma.chatMessage.count({ where: { id: input.replyToId, conversationId: id } }))) {
      throw badRequest('UNKNOWN_REFERENCE', 'پیامی که به آن پاسخ می‌دهید در این گفت‌وگو نیست.');
    }
    // Only people in the conversation can be named in it.
    const named = input.mentionIds.length
      ? (await prisma.chatMember.findMany({ where: { conversationId: id, userId: { in: input.mentionIds }, leftAt: null }, select: { userId: true } })).map((m) => m.userId)
      : [];
    const message = await prisma.$transaction(async (tx) => {
      const m = await tx.chatMessage.create({
        data: { organizationId: actor.organizationId, conversationId: id, authorId: actor.id, body: input.body, replyToId: input.replyToId ?? null, mentionIds: named },
      });
      if (input.attachmentIds.length) {
        // Files this person shared here and has not yet sent with another message.
        const r = await tx.document.updateMany({
          where: { id: { in: input.attachmentIds }, organizationId: actor.organizationId, chatConversationId: id, uploadedById: actor.id, chatMessageId: null, deletedAt: null },
          data: { chatMessageId: m.id },
        });
        if (r.count !== input.attachmentIds.length) throw badRequest('UNKNOWN_REFERENCE', 'یکی از فایل‌ها برای این گفت‌وگو بارگذاری نشده است.');
      }
      await tx.chatConversation.update({ where: { id, organizationId: actor.organizationId }, data: { lastMessageAt: m.createdAt } });
      // What one writes, one has read.
      await tx.chatMember.update({ where: { conversationId_userId: { conversationId: id, userId: actor.id } }, data: { lastReadAt: m.createdAt } });
      return tx.chatMessage.findUniqueOrThrow({ where: { id: m.id }, include: messageInclude });
    });
    void tellMembers({ id: message.id, conversationId: id, authorId: actor.id, mentionIds: named }).catch((e) => req.log.warn({ err: e }, 'chat notice'));
    return reply.code(201).send(messageView(message));
  });

  /** Only its author edits a message; what it said before is kept. */
  app.patch('/chat/messages/:id', chat, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(editChatMessageSchema, req.body);
    const m = await prisma.chatMessage.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } });
    if (!m) throw notFound('پیام');
    await membership(m.conversationId, actor);
    if (m.authorId !== actor.id) throw forbidden('پیام را فقط نویسنده‌اش ویرایش می‌کند.');
    if (m.body === input.body) return messageView(await prisma.chatMessage.findUniqueOrThrow({ where: { id }, include: messageInclude }));
    const updated = await prisma.$transaction(async (tx) => {
      await tx.chatMessageEdit.create({ data: { messageId: id, body: m.body } });
      return tx.chatMessage.update({ where: { id, organizationId: actor.organizationId }, data: { body: input.body, editedAt: new Date() }, include: messageInclude });
    });
    return messageView(updated);
  });

  /** Its author, or the conversation's owner or administrator, removes a message from view; it is kept. */
  app.delete('/chat/messages/:id', chat, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const m = await prisma.chatMessage.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } });
    if (!m) throw notFound('پیام');
    const me = await membership(m.conversationId, actor);
    const own = m.authorId === actor.id;
    if (!own && !manage(me.role)) throw forbidden('پیام دیگران را فقط مالک یا مدیر گفت‌وگو برمی‌دارد.');
    await prisma.$transaction(async (tx) => {
      await tx.chatMessage.update({ where: { id, organizationId: actor.organizationId }, data: { deletedAt: new Date(), deletedById: actor.id } });
      // Someone else's words taken down is a moderator's act, and is recorded.
      if (!own) await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: 'chatMessage', entityId: id, before: { conversationId: m.conversationId, authorId: m.authorId }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
    });
    return { id, deleted: true };
  });

  /** A file shared in a conversation, to its members. Always a download: nothing renders in place. */
  app.get('/chat/files/:id', {
    ...chat,
    onSend: async (_req, reply, payload) => { reply.header('Content-Type', 'application/octet-stream'); return payload; },
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const doc = await prisma.document.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null, purgedAt: null, chatConversationId: { not: null } } });
    if (!doc) throw notFound('فایل');
    await membership(doc.chatConversationId!, actor);
    // A file not yet sent is its uploader's alone.
    if (!doc.chatMessageId && doc.uploadedById !== actor.id) throw notFound('فایل');
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'FILE_DOWNLOAD', entityType: 'document', entityId: id, ipAddress: actor.ipAddress });
    return reply
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .sendFile(doc.storedName, storageRoot);
  });

  /* ── Oversight ──────────────────────────────────────────────────────────────────────────── */

  const oversight = { preHandler: [app.authenticate, app.requirePermissions('chat.oversight')] };

  /**
   * The conversations of the organisation — who is in each and when it was last used, not what was
   * said. Looking is itself recorded: who talks with whom is not nothing.
   */
  app.get('/chat/oversight/conversations', oversight, async (req) => {
    const actor = actorFrom(req);
    const { q } = req.query as { q?: string };
    const term = q?.trim().slice(0, 100) || null;
    const rows = await prisma.chatConversation.findMany({
      where: {
        organizationId: actor.organizationId,
        ...(term ? { OR: [{ title: { contains: term, mode: 'insensitive' } }, { members: { some: { user: { fullName: { contains: term, mode: 'insensitive' } } } } }] } : {}),
      },
      select: {
        id: true, kind: true, title: true, lastMessageAt: true, archivedAt: true, createdAt: true,
        _count: { select: { messages: true } },
        members: { where: { leftAt: null }, select: { user: { select: { id: true, fullName: true } } }, take: 12 },
      },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], take: 100,
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CHAT_OVERSIGHT_LIST', entityType: 'chatConversation', after: { query: term, shown: rows.length }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return rows.map((c) => ({
      id: c.id, kind: c.kind, title: c.title, lastMessageAt: c.lastMessageAt, archived: !!c.archivedAt, createdAt: c.createdAt,
      messageCount: c._count.messages, members: c.members.map((m) => m.user),
    }));
  });

  /**
   * One conversation, read-only, for a stated reason. The record of the look — who, which, when,
   * why — is written in the same transaction as the reading, so there is no reading without it; and
   * the database refuses to change or delete it afterwards (migration 20261019090000_team_chat).
   */
  app.post('/chat/oversight/conversations/:id/view', oversight, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(oversightViewSchema.extend({ before: z.string().datetime().optional() }), req.body);
    return prisma.$transaction(async (tx) => {
      const c = await tx.chatConversation.findFirst({
        where: { id, organizationId: actor.organizationId },
        select: {
          id: true, kind: true, title: true, topic: true, createdAt: true, archivedAt: true,
          members: { select: { role: true, joinedAt: true, leftAt: true, user: { select: { id: true, fullName: true } } }, orderBy: { joinedAt: 'asc' } },
        },
      });
      if (!c) throw notFound('گفت‌وگو');
      const rows = await tx.chatMessage.findMany({
        where: { conversationId: id, organizationId: actor.organizationId, ...(input.before ? { createdAt: { lt: new Date(input.before) } } : {}) },
        include: { ...messageInclude, edits: { orderBy: { editedAt: 'asc' }, select: { body: true, editedAt: true } } },
        orderBy: { createdAt: 'desc' }, take: OVERSIGHT_PAGE + 1,
      });
      const page = rows.slice(0, OVERSIGHT_PAGE).reverse();
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'CHAT_OVERSIGHT_VIEW', entityType: 'chatConversation', entityId: id,
        reason: input.reason,
        after: { kind: c.kind, title: c.title, members: c.members.map((m) => m.user.id), messages: page.length, from: page[0]?.createdAt ?? null, to: page.at(-1)?.createdAt ?? null },
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      }, tx);
      return {
        conversation: { ...c, members: c.members.map((m) => ({ ...m.user, role: m.role, joinedAt: m.joinedAt, leftAt: m.leftAt })) },
        items: page.map((m) => ({ ...messageView(m, { reviewer: true }), edits: m.edits })),
        hasMore: rows.length > OVERSIGHT_PAGE,
      };
    });
  });

  /** A file of a conversation under review: a reason, and a record, for each. */
  app.post('/chat/oversight/files/:id', {
    ...oversight,
    onSend: async (_req, reply, payload) => { reply.header('Content-Type', 'application/octet-stream'); return payload; },
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(oversightViewSchema, req.body);
    const doc = await prisma.document.findFirst({ where: { id, organizationId: actor.organizationId, purgedAt: null, chatConversationId: { not: null } } });
    if (!doc) throw notFound('فایل');
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CHAT_OVERSIGHT_VIEW', entityType: 'document', entityId: id, reason: input.reason, after: { conversationId: doc.chatConversationId, fileName: doc.fileName }, ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId });
    return reply
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .sendFile(doc.storedName, storageRoot);
  });
};

export default teamChatRoutes;
