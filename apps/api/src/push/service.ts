/**
 * Web Push to the phone (roadmap #49). A four-working-hour deadline is kept by someone who hears
 * about the work while their phone is in their pocket — not by an app they would have to open.
 *
 * Only the three loops whose deadlines are hours reach the phone: a work order to accept, a form
 * to decide, a deliverable to check at unit level — and the SLA warnings on those. Everything else
 * stays in the app; a phone that buzzes for everything is a phone whose owner turns this off.
 *
 * Each notice goes into an outbox row per browser, is sent at once, and retried by the job when
 * the push service was busy or unreachable. What the service says is kept on the row, so "did it
 * reach the phone" has an answer up to the point this server can see: the push service took it.
 */
import http from 'node:http';
import https from 'node:https';
import { createECDH, createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { guardedLookup } from '../integrations/webhooks.js';
import { b64u, encrypt, generateVapidKeys, vapidAuthorization, type VapidKeys } from './crypto.js';

/* ── What reaches the phone ──────────────────────────────────────────────────────────────── */

/** The loops themselves: work that has just arrived and has hours, not days. */
export const PUSHED_KINDS = new Set([
  'WORK_ORDER_ISSUED', 'WORK_ORDER_CLARIFIED', 'FORM_APPROVAL_REQUIRED', 'QC_UNIT_REQUIRED',
  // Team chat (audit F-5), as each member chose; the notice names the writer, not the words.
  'CHAT_MESSAGE', 'CHAT_MENTION',
  // Meeting bookings (audit F-9): a request waiting on its approver, a booking to confirm, an invitation.
  'BOOKING_APPROVAL_REQUIRED', 'BOOKING_APPROVED', 'BOOKING_INVITED', 'BOOKING_CANCELLED',
]);
const SLA_KINDS = new Set(['SLA_WARNING', 'SLA_BREACH', 'SLA_PREDICTED_BREACH']);
/** Loud on the lock screen and delivered promptly even to a phone saving its battery. */
const URGENT = new Set(['SLA_BREACH', 'SLA_WARNING', 'SLA_PREDICTED_BREACH']);
/** The entities the mobile screen can act on — where tapping a notice opens. */
export const MOBILE_ENTITIES = new Set(['workOrder', 'formSubmission', 'deliverable']);

export interface PushNotice {
  userId: string;
  kind: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** For SLA notices: which clock, since only the loops' own clocks are pushed. */
  policyCode?: string | null;
}

/**
 * An SLA notice is pushed only for the loops' clocks: acceptance of a work order, and a form's
 * approval (the unit QC form's clock, SLA_UNIT_QC, is one of those). A task's acceptance clock is
 * the same policy on another entity, and stays in the app.
 */
export function pushable(n: Pick<PushNotice, 'kind' | 'entityType' | 'policyCode'>): boolean {
  if (PUSHED_KINDS.has(n.kind)) return true;
  if (!SLA_KINDS.has(n.kind)) return false;
  return n.entityType === 'formSubmission' || (n.entityType === 'workOrder' && n.policyCode === 'SLA_TASK_ACCEPTANCE');
}

export const mobileUrl = (entityType?: string | null, entityId?: string | null) =>
  entityType && entityId && MOBILE_ENTITIES.has(entityType) ? `/m?open=${entityType}:${entityId}` : '/m';

/** How long a push service should keep trying a phone that is off: past it, the notice is stale. */
function ttlFor(kind: string): number {
  if (kind === 'TEST') return 300;
  if (SLA_KINDS.has(kind)) return 3600;
  if (kind === 'FORM_APPROVAL_REQUIRED') return 8 * 3600;
  return 4 * 3600;
}

/** Undelivered notices about the same thing replace each other at the push service (RFC 8030 §5.4). */
const topicOf = (tag: string) => createHash('sha256').update(tag).digest('base64url').slice(0, 32);

/* ── Keys ────────────────────────────────────────────────────────────────────────────────── */

function checkPair(keys: VapidKeys): VapidKeys {
  const pub = b64u.decode(keys.publicKey), priv = b64u.decode(keys.privateKey);
  if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32) throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not a P-256 pair in base64url');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(priv);
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY');
  return keys;
}

let keysOnce: Promise<VapidKeys> | null = null;

/** The configured pair, or the one this installation made for itself the first time it was asked. */
export function vapidKeys(): Promise<VapidKeys> {
  keysOnce ??= (async () => {
    if (env.VAPID_PUBLIC_KEY || env.VAPID_PRIVATE_KEY) return checkPair({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY });
    // Two processes starting together: whichever writes first, both use its pair.
    await prisma.serverKey.createMany({ data: [{ name: 'vapid', ...generateVapidKeys() }], skipDuplicates: true });
    const kept = await prisma.serverKey.findUniqueOrThrow({ where: { name: 'vapid' } });
    return checkPair({ publicKey: kept.publicKey, privateKey: kept.privateKey });
  })().catch((e) => { keysOnce = null; throw e; });
  return keysOnce;
}

/** RFC 8292 wants a contact: the configured one, the app's https address, or a mailto: at its host. */
export function vapidSubject(): string {
  if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
  try {
    const u = new URL((env.PUBLIC_APP_URL || env.CORS_ORIGIN.split(',')[0]!).trim());
    return u.protocol === 'https:' ? u.origin : `mailto:admin@${u.hostname}`;
  } catch {
    return 'mailto:admin@localhost';
  }
}

/* ── Where the server may send ───────────────────────────────────────────────────────────── */

export const serviceHosts = () => env.PUSH_SERVICE_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

/**
 * A subscription's endpoint is an address the server will POST to, supplied by a browser — that is,
 * by whoever is signed in. It is held to the browsers' own push services, over https, on the
 * standard port; the connection itself refuses internal addresses whatever the name resolves to.
 */
export function checkEndpoint(raw: string, hosts = serviceHosts()): { ok: true; url: URL } | { ok: false; messageFa: string } {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, messageFa: 'نشانی اشتراک اعلان معتبر نیست.' }; }
  if (url.protocol !== 'https:') return { ok: false, messageFa: 'نشانی اشتراک اعلان باید https باشد.' };
  if (url.username || url.password || url.port) return { ok: false, messageFa: 'نشانی اشتراک اعلان نباید نام کاربری، گذرواژه یا درگاه داشته باشد.' };
  const host = url.hostname.toLowerCase();
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { ok: false, messageFa: `«${host}» از سرویس‌های اعلان مرورگرها نیست؛ فقط سرویس‌های شناخته‌شده پذیرفته می‌شوند.` };
  }
  return { ok: true, url };
}

/** How delivery reaches the network; tests point it at a server of their own. */
export interface PushNet { hosts: string[]; allowPrivate: boolean; allowHttp: boolean }
const defaultNet = (): PushNet => ({ hosts: serviceHosts(), allowPrivate: false, allowHttp: false });

interface Posted { status: number | null; error: string | null; refused?: boolean }

function post(rawUrl: string, body: Buffer, headers: Record<string, string>, net: PushNet): Promise<Posted> {
  let url: URL;
  if (net.allowHttp) {
    try { url = new URL(rawUrl); } catch { return Promise.resolve({ status: null, error: 'bad endpoint' }); }
  } else {
    const checked = checkEndpoint(rawUrl, net.hosts);
    if (!checked.ok) return Promise.resolve({ status: null, error: checked.messageFa, refused: true });
    url = checked.url;
  }
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(url, {
      method: 'POST', lookup: guardedLookup(net.allowPrivate), timeout: 10_000,
      headers: { ...headers, 'content-length': String(body.length) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? null, error: null }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout after 10s')));
    req.on('error', (e) => resolve({ status: null, error: e.message }));
    req.end(body);
  });
}

/* ── Subscriptions ───────────────────────────────────────────────────────────────────────── */

/** A browser's keys as the Push API gives them: an uncompressed P-256 point, and 16 bytes. */
export function checkKeys(p256dh: string, auth: string): string | null {
  const point = b64u.decode(p256dh), secret = b64u.decode(auth);
  if (point.length !== 65 || point[0] !== 0x04) return 'کلید عمومی مرورگر (p256dh) نقطهٔ P-256 نیست.';
  try {
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(point);
  } catch { return 'کلید عمومی مرورگر (p256dh) روی منحنی P-256 نیست.'; }
  if (secret.length !== 16) return 'کلید احراز مرورگر (auth) باید ۱۶ بایت باشد.';
  return null;
}

/**
 * One browser, one row. A browser that signs in as someone else now belongs to them: the
 * endpoint moves, so the previous person's notices stop arriving on a phone they no longer use.
 */
export async function subscribe(actor: { id: string; organizationId: string }, input: { endpoint: string; p256dh: string; auth: string; userAgent?: string | null }) {
  const now = new Date();
  const data = {
    organizationId: actor.organizationId, userId: actor.id, p256dh: input.p256dh, auth: input.auth,
    userAgent: input.userAgent?.slice(0, 300) ?? null, lastSeenAt: now, failures: 0, disabledAt: null, disabledReason: null,
  };
  return prisma.pushSubscription.upsert({ where: { endpoint: input.endpoint }, create: { endpoint: input.endpoint, ...data }, update: data });
}

/* ── Sending ─────────────────────────────────────────────────────────────────────────────── */

const MAX_ATTEMPTS = 4;
/** Failures in a row after which a browser is taken to be gone without the service saying so. */
const MAX_FAILURES = 5;

export type Delivered = 'SENT' | 'QUEUED' | 'FAILED' | 'GONE';

/**
 * One attempt at one message. The push service's answer decides what follows: 2xx it took it;
 * 404/410 the browser is gone; 401/403 it refused our key (the subscription was made for another);
 * 400/413 the message itself was wrong; anything else — 429, 5xx, no answer — is tried again.
 */
export async function deliver(id: string, net: PushNet = defaultNet()): Promise<Delivered | null> {
  const m = await prisma.pushMessage.findUnique({ where: { id }, include: { subscription: true } });
  if (!m || m.status !== 'QUEUED') return null;
  const s = m.subscription;
  if (s.disabledAt) {
    await prisma.pushMessage.update({ where: { id }, data: { status: 'FAILED', error: 'اشتراک این مرورگر خاموش شده است.' } });
    return 'FAILED';
  }

  let posted: Posted;
  try {
    const keys = await vapidKeys();
    const payload = Buffer.from(JSON.stringify({ id: m.id, kind: m.kind, title: m.title, body: m.body, url: m.url, tag: m.tag, urgent: URGENT.has(m.kind) }));
    const body = encrypt(payload, { p256dh: s.p256dh, auth: s.auth });
    posted = await post(s.endpoint, body, {
      'content-type': 'application/octet-stream',
      'content-encoding': 'aes128gcm',
      ttl: String(ttlFor(m.kind)),
      urgency: URGENT.has(m.kind) ? 'high' : 'normal',
      ...(m.tag ? { topic: topicOf(m.tag) } : {}),
      authorization: vapidAuthorization(s.endpoint, keys, vapidSubject()),
    }, net);
  } catch (e) {
    posted = { status: null, error: e instanceof Error ? e.message : String(e) };
  }

  const attempts = m.attempts + 1;
  const code = posted.status;
  const status: Delivered = code && code >= 200 && code < 300 ? 'SENT'
    : code === 404 || code === 410 ? 'GONE'
    : posted.refused || code === 400 || code === 401 || code === 403 || code === 413 ? 'FAILED'
    : attempts >= MAX_ATTEMPTS ? 'FAILED' : 'QUEUED';
  const error = status === 'SENT' ? null : (posted.error ?? `HTTP ${code}`).slice(0, 500);

  await prisma.pushMessage.update({
    where: { id }, data: { status, attempts, statusCode: code, error, ...(status === 'SENT' ? { sentAt: new Date() } : {}) },
  });
  if (status === 'SENT') {
    await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastSuccessAt: new Date(), failures: 0 } });
  } else if (status === 'GONE') {
    await prisma.pushSubscription.update({ where: { id: s.id }, data: { disabledAt: new Date(), disabledReason: 'GONE' } });
  } else if (code === 401 || code === 403) {
    await prisma.pushSubscription.update({ where: { id: s.id }, data: { disabledAt: new Date(), disabledReason: 'REJECTED' } });
  } else if (posted.refused) {
    // PUSH_SERVICE_HOSTS no longer lists where this browser's service is.
    await prisma.pushSubscription.update({ where: { id: s.id }, data: { disabledAt: new Date(), disabledReason: 'NOT_ALLOWED' } });
  } else if (status === 'FAILED') {
    const failures = s.failures + 1;
    await prisma.pushSubscription.update({
      where: { id: s.id }, data: failures >= MAX_FAILURES ? { failures, disabledAt: new Date(), disabledReason: 'FAILING' } : { failures },
    });
  }
  return status;
}

async function queueFor(n: PushNotice & { url: string; tag: string | null }): Promise<string[]> {
  const subs = await prisma.pushSubscription.findMany({
    where: { userId: n.userId, disabledAt: null, user: { isActive: true, deletedAt: null } },
    select: { id: true, organizationId: true },
  });
  const ids: string[] = [];
  for (const s of subs) {
    const m = await prisma.pushMessage.create({
      data: {
        organizationId: s.organizationId, userId: n.userId, subscriptionId: s.id, kind: n.kind,
        title: n.title.slice(0, 200), body: n.body?.slice(0, 400) ?? null, url: n.url, tag: n.tag,
      },
      select: { id: true },
    });
    ids.push(m.id);
  }
  // Sent now, but not on the caller's time: a slow push service must not hold a request or a
  // tick. Whatever does not go is retried by the job.
  if (env.PUSH_DELIVERY === 'on') for (const id of ids) void deliver(id).catch(() => undefined);
  return ids;
}

/** Called by notify() for every notification; queues the ones that belong on the phone. */
export async function pushNotification(n: PushNotice): Promise<string[]> {
  if (!pushable(n)) return [];
  const tag = n.entityType && n.entityId ? `${n.entityType}:${n.entityId}` : null;
  // A conversation opens itself, on the phone as on the desk.
  const url = n.entityType === 'chatConversation' && n.entityId ? `/chat/${n.entityId}` : mobileUrl(n.entityType, n.entityId);
  return queueFor({ ...n, url, tag });
}

/** "Does my phone hear this?" — to every browser of one person, sent and answered before returning. */
export async function sendTest(userId: string, net: PushNet = defaultNet()) {
  const subs = await prisma.pushSubscription.findMany({ where: { userId, disabledAt: null }, select: { id: true, organizationId: true, endpoint: true } });
  const results: { subscriptionId: string; host: string; status: Delivered | 'OFF'; error: string | null }[] = [];
  for (const s of subs) {
    const host = new URL(s.endpoint).hostname;
    if (env.PUSH_DELIVERY === 'off') { results.push({ subscriptionId: s.id, host, status: 'OFF', error: null }); continue; }
    const m = await prisma.pushMessage.create({
      data: { organizationId: s.organizationId, userId, subscriptionId: s.id, kind: 'TEST', title: 'آزمایش اعلان هیوامیس', body: 'اگر این را روی گوشی می‌بینید، اعلان‌ها می‌رسند.', url: '/m', tag: 'test' },
      select: { id: true },
    });
    const status = (await deliver(m.id, net)) ?? 'FAILED';
    const row = await prisma.pushMessage.findUnique({ where: { id: m.id }, select: { error: true } });
    results.push({ subscriptionId: s.id, host, status, error: row?.error ?? null });
  }
  return results;
}

/** The job: what the push service was too busy for, or could not be reached for, a minute ago. */
export async function retryQueued(now = new Date()) {
  if (env.PUSH_DELIVERY === 'off') return { retried: 0, expired: 0 };
  // Past the longest time-to-live a notice has, it is news nobody needs: dropped, not sent late.
  const expired = await prisma.pushMessage.updateMany({
    where: { status: 'QUEUED', createdAt: { lt: new Date(now.getTime() - 8 * 3600_000) } },
    data: { status: 'FAILED', error: 'پیش از رسیدن کهنه شد' },
  });
  const due = await prisma.pushMessage.findMany({
    where: { status: 'QUEUED', createdAt: { lt: new Date(now.getTime() - 30_000) } }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: 200,
  });
  for (const m of due) await deliver(m.id).catch(() => undefined);
  return { retried: due.length, expired: expired.count };
}
