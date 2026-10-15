/**
 * The messenger, both ways (roadmap #40). Notifications that matter reach a person in the chat
 * they linked; a form approval arrives with «تأیید / رد / باز کردن در سیستم», and pressing one
 * decides it through the same `decideForm` the app uses — the same approver roles, stages, quorum
 * and separation of duties, the same audit row — as that person, with their permissions of now.
 *
 * A button carries only an unguessable, single-use token that expires. It works only from the chat
 * linked to the person it was sent to; a chat is linked only by the code that person asked for in
 * the app and then sent to the bot themselves.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { tenancy } from '../lib/tenant.js';
import { decideForm } from '../forms/engine.js';
import { claimsFor } from '../routes/auth.js';
import { configuredProvider, messengerMode, type Button, type MessengerProvider } from './provider.js';

const LINK_TTL_MS = 15 * 60_000;
const ACTION_TTL_MS = 72 * 3_600_000;
const REASON_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

/** What is worth a message: what someone must act on, or would want to know away from the app. */
export const MESSENGER_KINDS = new Set([
  'FORM_APPROVAL_REQUIRED', 'SLA_BREACH', 'SLA_WARNING', 'SLA_PREDICTED_BREACH',
  'CLIENT_APPROVAL_DECIDED', 'PORTAL_MESSAGE', 'ESIGN_COMPLETED', 'ESIGN_DECLINED',
  // Team chat (audit F-5): who wrote and where — never what, which stays inside the installation.
  'CHAT_MESSAGE', 'CHAT_MENTION',
]);

const appUrl = (p = '') => `${(env.PUBLIC_APP_URL || env.CORS_ORIGIN.split(',')[0]!.trim()).replace(/\/+$/, '')}${p}`;
const OPEN_PATH: Record<string, (id: string) => string> = {
  formSubmission: (id) => `/forms?submission=${id}`, project: (id) => `/projects/${id}`, contract: (id) => `/contracts/${id}`,
  proposal: (id) => `/proposals/${id}`, chatConversation: (id) => `/chat/${id}`,
};
const token = () => randomBytes(9).toString('base64url');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const linkCode = () => `HV-${Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')}`;
export const sandboxChat = (userId: string) => `sandbox:${userId}`;

/* ── linking ─────────────────────────────────────────────────────────────── */

export async function startLink(user: { id: string; organizationId: string }) {
  const mode = messengerMode();
  if (mode === 'off') throw new AppError(422, 'MESSENGER_OFF', 'پیام‌رسان در این نصب خاموش است.');
  await prisma.messengerAction.updateMany({ where: { userId: user.id, kind: 'LINK', state: 'OPEN' }, data: { state: 'EXPIRED' } });
  const code = linkCode();
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await prisma.messengerAction.create({ data: { organizationId: user.organizationId, userId: user.id, kind: 'LINK', token: code, expiresAt } });
  const bot = env.MESSENGER_BOT_USERNAME;
  return {
    mode, code, expiresAt, bot: bot || null,
    deepLink: mode === 'telegram' && bot ? `https://t.me/${bot}?start=${code}` : null,
  };
}

export async function status(userId: string) {
  const [link, telegram] = await Promise.all([
    prisma.messengerLink.findUnique({ where: { userId } }),
    prisma.userIdentity.count({ where: { userId, provider: 'telegram' } }),
  ]);
  // Whether the Telegram Mini App signs this person in (audit F-9).
  return { mode: messengerMode(), linked: !!link && link.provider === messengerMode(), link, bot: env.MESSENGER_BOT_USERNAME || null, miniAppSignIn: telegram > 0 };
}

export async function unlink(user: { id: string; organizationId: string }) {
  const link = await prisma.messengerLink.findUnique({ where: { userId: user.id } });
  if (!link) return { unlinked: false };
  await prisma.$transaction(async (tx) => {
    await tx.messengerLink.delete({ where: { id: link.id } });
    await tx.messengerAction.updateMany({ where: { userId: user.id, state: { in: ['OPEN', 'AWAITING_REASON'] } }, data: { state: 'EXPIRED' } });
    // The Telegram account was linked with the chat, and goes with it: the Mini App no longer signs in.
    const { count } = await tx.userIdentity.deleteMany({ where: { userId: user.id, provider: 'telegram' } });
    await audit({ organizationId: user.organizationId, actorId: user.id, action: 'MESSENGER_UNLINKED', entityType: 'user', entityId: user.id, after: { provider: link.provider, signInIdentityRemoved: count > 0 } }, tx);
  });
  return { unlinked: true };
}

/* ── outbound ────────────────────────────────────────────────────────────── */

async function queue(p: MessengerProvider, o: { organizationId: string; userId: string | null; chatId: string; text: string; buttons?: Button[][]; kind?: string }) {
  const m = await prisma.messengerMessage.create({
    data: {
      organizationId: o.organizationId, userId: o.userId, provider: p.name, chatId: o.chatId, direction: 'OUT', text: o.text,
      buttons: o.buttons ? (o.buttons as object) : undefined, status: 'QUEUED', notificationKind: o.kind ?? null,
    },
  });
  await deliver(m.id, p);
  return m;
}

/** Send one queued message — claimed first, so the retry job and a first attempt never both send it. */
export async function deliver(id: string, p: MessengerProvider | null = configuredProvider()) {
  const m = await prisma.messengerMessage.findUnique({ where: { id } });
  if (!m || m.status !== 'QUEUED' || !p || p.name !== m.provider) return;
  const claimed = await prisma.messengerMessage.updateMany({ where: { id, status: 'QUEUED', attempts: m.attempts }, data: { attempts: m.attempts + 1 } });
  if (!claimed.count) return;
  try {
    const r = await p.send(m.chatId, m.text, (m.buttons as Button[][] | null) ?? undefined);
    const messageId = r.messageId || m.id;
    await prisma.messengerMessage.update({ where: { id }, data: { status: 'SENT', providerMessageId: messageId, sentAt: new Date(), error: null } });
    const actions = ((m.buttons as Button[][] | null) ?? []).flat().map((b) => b.action).filter(Boolean) as string[];
    if (actions.length) await prisma.messengerAction.updateMany({ where: { token: { in: actions } }, data: { chatId: m.chatId, messageId } });
  } catch (e) {
    await prisma.messengerMessage.update({
      where: { id }, data: { status: m.attempts + 1 >= MAX_ATTEMPTS ? 'FAILED' : 'QUEUED', error: (e instanceof Error ? e.message : String(e)).slice(0, 500) },
    });
  }
}

/** The job: send again what did not go out the first time. */
export async function retryQueued() {
  const p = configuredProvider();
  if (!p) return { retried: 0 };
  const due = await prisma.messengerMessage.findMany({ where: { status: 'QUEUED', provider: p.name, createdAt: { lt: new Date(Date.now() - 30_000) } }, select: { id: true }, take: 100 });
  for (const m of due) await deliver(m.id, p);
  return { retried: due.length };
}

/** Called by notify() for every notification; sends the ones that matter to a linked chat. */
export async function pushNotification(n: { userId: string; kind: string; title: string; body?: string | null; entityType?: string | null; entityId?: string | null }) {
  if (!MESSENGER_KINDS.has(n.kind)) return;
  const p = configuredProvider();
  if (!p) return;
  const link = await prisma.messengerLink.findUnique({ where: { userId: n.userId } });
  if (!link || link.provider !== p.name) return;
  const open = n.entityType && n.entityId && OPEN_PATH[n.entityType] ? appUrl(OPEN_PATH[n.entityType]!(n.entityId)) : appUrl('/my-work');
  const buttons: Button[][] = [];
  if (n.kind === 'FORM_APPROVAL_REQUIRED' && n.entityType === 'formSubmission' && n.entityId) {
    const approve = token(), reject = token();
    const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
    await prisma.messengerAction.createMany({ data: [
      { organizationId: link.organizationId, userId: n.userId, kind: 'FORM_DECISION', token: approve, expiresAt, payload: { submissionId: n.entityId, decision: 'APPROVE', pair: reject } },
      { organizationId: link.organizationId, userId: n.userId, kind: 'FORM_DECISION', token: reject, expiresAt, payload: { submissionId: n.entityId, decision: 'REJECT', pair: approve } },
    ] });
    buttons.push([{ text: 'تأیید', action: approve }, { text: 'رد', action: reject }]);
  }
  buttons.push([{ text: 'باز کردن در سیستم', url: open }]);
  await queue(p, { organizationId: link.organizationId, userId: n.userId, chatId: link.chatId, text: [n.title, n.body].filter(Boolean).join('\n'), buttons, kind: n.kind });
}

/* ── inbound ─────────────────────────────────────────────────────────────── */

export interface Update {
  update_id?: number;
  message?: { message_id?: number; chat: { id: number | string; type?: string }; from?: { id?: number; username?: string }; text?: string };
  callback_query?: { id: string; data?: string; from?: { username?: string }; message?: { message_id?: number; chat: { id: number | string } } };
}

/** What happened, for the sandbox page to show; a live bot is answered through the provider. */
export interface Handled { reply?: string; answer?: string }

/** A reply. A chat that belongs to no organisation is answered directly and filed nowhere. */
async function say(p: MessengerProvider, organizationId: string | null, userId: string | null, chatId: string, text: string) {
  if (organizationId) await queue(p, { organizationId, userId, chatId, text });
  else await p.send(chatId, text).catch(() => undefined);
  return text;
}

/**
 * One message or button press from the bot.
 *
 * Whose chat it is decides where it is filed: the linked account's organisation; else the signed-in
 * person's, for the sandbox page (`caller`); else, for a link code from an unlinked chat, the code's;
 * else, on a one-organisation installation, that one. A stranger's chat on a several-organisation
 * installation belongs to nobody, and is answered without being filed. (Before, it was filed under
 * whichever organisation came first — audit SEC-2b.)
 */
export async function handleUpdate(p: MessengerProvider, update: Update, caller?: { organizationId: string }): Promise<Handled> {
  const chatId = String(update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? '');
  if (!chatId) return {};
  const link = await prisma.messengerLink.findUnique({ where: { provider_chatId: { provider: p.name, chatId } } });
  const text = update.message?.text?.trim() ?? '';
  const sentCode = /(?:^\/(?:start|link)\s+)?(HV-[A-Z0-9]{6})$/i.exec(text)?.[1]?.toUpperCase();
  const codeOrg = !link && !caller && sentCode
    ? (await prisma.messengerAction.findUnique({ where: { token: sentCode }, select: { organizationId: true } }))?.organizationId
    : undefined;
  const orgId = link?.organizationId ?? caller?.organizationId ?? codeOrg
    ?? (tenancy.mode === 'single' ? (await prisma.organization.findFirst({ select: { id: true } }))?.id ?? null : null);
  // A press is logged as the button it was, not its token.
  const pressedToken = /^a:([\w-]{6,40})$/.exec(update.callback_query?.data ?? '')?.[1];
  const pressedAction = pressedToken ? await prisma.messengerAction.findUnique({ where: { token: pressedToken }, select: { payload: true } }) : null;
  const decisionFa = { APPROVE: 'تأیید', REJECT: 'رد' }[(pressedAction?.payload as { decision?: string } | null)?.decision ?? ''] ?? 'دکمه';
  const logged = update.callback_query ? `«${decisionFa}» زده شد` : text;
  if (orgId) await prisma.messengerMessage.create({ data: { organizationId: orgId, userId: link?.userId ?? null, provider: p.name, chatId, direction: 'IN', text: logged.slice(0, 2000), status: 'RECEIVED' } });

  if (update.callback_query) {
    const answer = await pressed(p, link, update.callback_query.data ?? '');
    await p.answerCallback(update.callback_query.id, answer).catch(() => undefined);
    return { answer };
  }
  if (!update.message?.text) return {};
  const code = sentCode;
  if (code) return { reply: await say(p, orgId, link?.userId ?? null, chatId, await linkChat(p, chatId, code, update.message)) };
  if (link) {
    const waiting = await prisma.messengerAction.findFirst({ where: { userId: link.userId, state: 'AWAITING_REASON', chatId, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (waiting) {
      if (/^(انصراف|cancel)$/i.test(text)) {
        await prisma.messengerAction.update({ where: { id: waiting.id }, data: { state: 'EXPIRED' } });
        return { reply: await say(p, orgId, link.userId, chatId, 'رد فرم لغو شد؛ از سامانه تصمیم بگیرید.') };
      }
      return { reply: await say(p, orgId, link.userId, chatId, await decide(p, link.userId, waiting, text)) };
    }
  }
  return {
    reply: await say(p, orgId, link?.userId ?? null, chatId, link
      ? 'این ربات اعلان‌ها و درخواست‌های تأیید هیوامیس را می‌فرستد؛ برای تصمیم، دکمه‌های زیر هر پیام را بزنید.'
      : 'برای اتصال، در هیوامیس «اتصال پیام‌رسان» را بزنید و کدی را که می‌گیرد همین‌جا بفرستید.'),
  };
}

/**
 * Links a chat by the code its person asked for in the app. On Telegram, a private chat is also the
 * person's Telegram account, so it becomes a sign-in identity for the Mini App (audit F-9): linked
 * only this way, by a code from a signed-in session — never by matching an email.
 */
async function linkChat(p: MessengerProvider, chatId: string, code: string, message: NonNullable<Update['message']>) {
  const a = await prisma.messengerAction.findUnique({ where: { token: code } });
  if (!a || a.kind !== 'LINK' || a.state !== 'OPEN' || a.expiresAt <= new Date()) return 'این کد معتبر نیست یا مهلتش گذشته است؛ در هیوامیس کد تازه بگیرید.';
  const other = await prisma.messengerLink.findUnique({ where: { provider_chatId: { provider: p.name, chatId } } });
  if (other && other.userId !== a.userId) return 'این گفت‌وگو به حساب دیگری در هیوامیس وصل است؛ نخست از آن حساب جدا شوید.';
  const telegramId = p.name === 'telegram' && message.chat.type === 'private' && message.from?.id ? String(message.from.id) : null;
  if (telegramId) {
    const owner = await prisma.userIdentity.findUnique({ where: { provider_subject: { provider: 'telegram', subject: telegramId } } });
    if (owner && owner.userId !== a.userId) return 'این حساب تلگرام به حساب دیگری در هیوامیس وصل است؛ نخست از آن حساب جدا شوید.';
  }
  const username = message.from?.username ?? null;
  const user = await prisma.user.findUnique({ where: { id: a.userId }, select: { fullName: true } });
  await prisma.$transaction(async (tx) => {
    await tx.messengerAction.update({ where: { id: a.id }, data: { state: 'DONE', usedAt: new Date(), chatId } });
    await tx.messengerLink.upsert({
      where: { userId: a.userId },
      create: { organizationId: a.organizationId, userId: a.userId, provider: p.name, chatId, username },
      update: { provider: p.name, chatId, username, linkedAt: new Date() },
    });
    // One Telegram account per person: linking another replaces the one before.
    await tx.userIdentity.deleteMany({ where: { userId: a.userId, provider: 'telegram', ...(telegramId ? { subject: { not: telegramId } } : {}) } });
    if (telegramId) {
      await tx.userIdentity.upsert({
        where: { provider_subject: { provider: 'telegram', subject: telegramId } },
        create: { userId: a.userId, provider: 'telegram', subject: telegramId },
        update: {},
      });
    }
    await audit({ organizationId: a.organizationId, actorId: a.userId, action: 'MESSENGER_LINKED', entityType: 'user', entityId: a.userId, after: { provider: p.name, username, signInIdentity: !!telegramId } }, tx);
  });
  return `اتصال برقرار شد: ${user?.fullName ?? ''}. از این پس اعلان‌های مهم و درخواست‌های تأیید را همین‌جا می‌گیرید.`;
}

async function pressed(p: MessengerProvider, link: { userId: string } | null, data: string): Promise<string> {
  const t = /^a:([\w-]{6,40})$/.exec(data)?.[1];
  const a = t ? await prisma.messengerAction.findUnique({ where: { token: t } }) : null;
  // A button only works from the chat linked to the person it was sent to.
  if (!a || !link || a.userId !== link.userId || a.kind !== 'FORM_DECISION') return 'این دکمه برای شما نیست.';
  if (a.state !== 'OPEN') return 'این دکمه پیش‌تر به کار رفته است.';
  if (a.expiresAt <= new Date()) {
    await prisma.messengerAction.update({ where: { id: a.id }, data: { state: 'EXPIRED' } });
    return 'مهلت این دکمه گذشته است؛ از سامانه تصمیم بگیرید.';
  }
  const payload = a.payload as { submissionId: string; decision: 'APPROVE' | 'REJECT'; pair: string };
  if (payload.decision === 'REJECT') {
    // A rejection needs its reason, as in the app: the next message from this chat is taken as it.
    await prisma.messengerAction.update({ where: { id: a.id }, data: { state: 'AWAITING_REASON', expiresAt: new Date(Date.now() + REASON_TTL_MS) } });
    await prisma.messengerAction.updateMany({ where: { token: payload.pair, state: 'OPEN' }, data: { state: 'EXPIRED' } });
    await say(p, a.organizationId, a.userId, a.chatId ?? '', 'دلیل رد را بنویسید و بفرستید (یا «انصراف»).');
    return 'دلیل رد را بنویسید.';
  }
  return decide(p, a.userId, a, null);
}

/** The decision itself — `decideForm`, unchanged, as the person whose chat this is. */
async function decide(p: MessengerProvider, userId: string, a: { id: string; token: string; payload: unknown; chatId: string | null; messageId: string | null }, reason: string | null): Promise<string> {
  const payload = a.payload as { submissionId: string; decision: 'APPROVE' | 'REJECT'; pair: string };
  await prisma.messengerAction.updateMany({ where: { token: { in: [a.token, payload.pair] } }, data: { state: 'DONE', usedAt: new Date() } });
  let outcome: string;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, deletedAt: true } });
    if (!user?.isActive || user.deletedAt) throw new AppError(403, 'FORBIDDEN', 'حساب شما در هیوامیس فعال نیست.');
    const { claims } = await claimsFor(userId);
    // The same gate as the app's decision endpoint, before the engine's own checks.
    if (!claims.permissions.includes('form.approve')) throw new AppError(403, 'FORBIDDEN', 'دسترسی تأیید فرم را ندارید.');
    const r = await decideForm({
      submissionId: payload.submissionId, decision: payload.decision, comment: reason ?? undefined,
      actor: {
        id: claims.sub, organizationId: claims.organizationId, departmentCode: claims.departmentCode, roles: claims.roles, permissions: claims.permissions,
        delegatedRoles: claims.delegatedRoles, ipAddress: null, userAgent: `messenger:${p.name}`, requestId: `messenger:${a.id}`,
      },
    });
    outcome = payload.decision === 'APPROVE'
      ? (r.state === 'APPROVED' ? '✅ تأیید شد.' : '✅ تأیید شما ثبت شد؛ فرم به مرحلهٔ بعد رفت.')
      : '⛔️ رد شد.';
    await prisma.messengerAction.update({ where: { id: a.id }, data: { result: { ok: true, state: r.state } } });
  } catch (e) {
    outcome = `انجام نشد: ${e instanceof Error ? e.message : String(e)}`;
    await prisma.messengerAction.update({ where: { id: a.id }, data: { result: { ok: false, error: outcome } } });
  }
  // The message with the buttons now says what happened, and has no buttons left.
  if (a.chatId && a.messageId) {
    const original = await prisma.messengerMessage.findFirst({ where: { chatId: a.chatId, providerMessageId: a.messageId, direction: 'OUT' } });
    if (original) {
      const text = `${original.text}\n\n${outcome} (از پیام‌رسان)`;
      await prisma.messengerMessage.update({ where: { id: original.id }, data: { text, buttons: [[{ text: 'باز کردن در سیستم', url: appUrl(`/forms?submission=${payload.submissionId}`) }]] } });
      await p.edit(a.chatId, a.messageId, text).catch(() => undefined);
    }
  }
  return outcome;
}
