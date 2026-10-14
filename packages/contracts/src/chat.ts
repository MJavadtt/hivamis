import { z } from 'zod';

/**
 * Team chat (audit F-5): direct conversations between two people, private groups, and channels any
 * colleague may join. Messages are the organisation's records like any other — kept, edited with
 * their history, deleted softly — and, disclosed to everyone, open to oversight under audit.
 */

export const CHAT_KINDS = ['DIRECT', 'GROUP', 'CHANNEL'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];
export const CHAT_MEMBER_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export type ChatMemberRole = (typeof CHAT_MEMBER_ROLES)[number];
/** When a member hears of a message away from the page: every one, when named, or never. */
export const CHAT_NOTIFY = ['ALL', 'MENTIONS', 'NONE'] as const;
export type ChatNotify = (typeof CHAT_NOTIFY)[number];

export const CHAT_MESSAGE_MAX = 4000;
export const CHAT_ATTACHMENTS_MAX = 10;

/**
 * What everyone is told about oversight, on the chat page and in the usage policy. The owner
 * confirmed this wording on 2026-10-14 (the fix prompt's ⛔ ASK for F-5); change it only with them.
 */
export const OVERSIGHT_NOTICE = {
  fa: 'گفت‌وگوها روی سامانهٔ سازمان انجام می‌شود. مدیران مجاز ممکن است آن‌ها را بازبینی کنند؛ هر بازبینی با نام بازبین، زمان و دلیلش در سابقهٔ حسابرسی ثبت می‌شود و پاک‌شدنی نیست.',
  en: "Conversations take place on the organisation's system. Authorised administrators may review them; every review is recorded in the audit trail with the reviewer, the time and the reason, and cannot be deleted.",
} as const;

/** The records a message may name by code, and the page each opens — the global search's types. */
export const RECORD_CODE = /\b(?:OPP|PRJ|TSK|BRF|PRP|CNT)-\d{6}\b/g;
export const RECORD_PAGES: Record<string, string> = {
  company: '/companies', opportunity: '/opportunities', project: '/projects',
  task: '/tasks', brief: '/briefs', proposal: '/proposals', contract: '/contracts',
};

const id = z.string().uuid();
const title = z.string().trim().min(2, 'نام دست‌کم دو حرف است').max(120);

export const createConversationSchema = z.discriminatedUnion('kind', [
  // The other person; a pair has one direct conversation, so asking again opens it.
  z.object({ kind: z.literal('DIRECT'), memberIds: z.array(id).length(1) }),
  z.object({ kind: z.literal('GROUP'), title, topic: z.string().trim().max(300).optional(), memberIds: z.array(id).min(1).max(200) }),
  // A channel is open to every colleague to find and join; its members are who joined.
  z.object({ kind: z.literal('CHANNEL'), title, topic: z.string().trim().max(300).optional(), memberIds: z.array(id).max(200).default([]) }),
]);
export type CreateConversation = z.infer<typeof createConversationSchema>;

export const updateConversationSchema = z.object({
  title: title.optional(),
  topic: z.string().trim().max(300).nullable().optional(),
  archived: z.boolean().optional(),
});

export const sendChatMessageSchema = z.object({
  body: z.string().trim().max(CHAT_MESSAGE_MAX).default(''),
  replyToId: id.optional(),
  attachmentIds: z.array(id).max(CHAT_ATTACHMENTS_MAX).default([]),
  /** People named in it, chosen in the composer: they hear of it even with notices set to mentions. */
  mentionIds: z.array(id).max(50).default([]),
}).refine((m) => m.body.length > 0 || m.attachmentIds.length > 0, { message: 'پیام خالی است', path: ['body'] });

export const editChatMessageSchema = z.object({ body: z.string().trim().min(1, 'پیام خالی است').max(CHAT_MESSAGE_MAX) });

export const chatMemberSettingsSchema = z.object({
  muted: z.boolean().optional(),
  notify: z.enum(CHAT_NOTIFY).optional(),
});

export const addChatMembersSchema = z.object({ userIds: z.array(id).min(1).max(50) });
export const chatMemberRoleSchema = z.object({ role: z.enum(['ADMIN', 'MEMBER']) });

/** A review needs a reason someone else could read and judge. */
export const oversightViewSchema = z.object({
  reason: z.string().trim().min(10, 'دلیل بازبینی را روشن بنویسید (دست‌کم ده حرف)').max(500),
});

export interface ChatConversationSummary {
  id: string;
  kind: ChatKind;
  title: string;
  topic: string | null;
  /** DIRECT: the other person. */
  peer: { id: string; fullName: string } | null;
  memberCount: number;
  unread: number;
  muted: boolean;
  notify: ChatNotify;
  role: ChatMemberRole | null;
  lastMessage: { authorName: string; body: string; at: string } | null;
  archived: boolean;
}

export interface ChatMessageView {
  id: string;
  author: { id: string; fullName: string };
  body: string;
  replyTo: { id: string; authorName: string; body: string } | null;
  attachments: { id: string; fileName: string; mimeType: string; sizeBytes: number }[];
  mentionIds: string[];
  editedAt: string | null;
  deleted: boolean;
  createdAt: string;
}
