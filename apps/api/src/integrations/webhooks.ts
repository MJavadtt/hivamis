/**
 * Webhooks on state transitions (roadmap #46).
 *
 * The transition log is already an outbox: every change of state is a row, written in the same
 * transaction as the change. A subscription keeps a cursor into it; the dispatcher turns new rows
 * that match the subscription — and that its creator may read — into deliveries, and sends them.
 *
 * Events are thin: which record, which move, from and to, when, and why — never the record
 * itself. A receiver that needs more asks the API with a key, under that key's permissions, so a
 * webhook can never leak what its creator could not have read.
 *
 * Every delivery is signed: `X-Hiva-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`, with
 * the timestamp in `X-Hiva-Timestamp` so a receiver can refuse replays. A failed delivery is
 * retried after 1, 5, 30, 120 and 720 minutes, then given up; twenty failures in a row disable the
 * subscription and tell its creator.
 *
 * The URL is somebody's input, and the server will call it: an address on the internal network
 * (loopback, private ranges, link-local — where cloud metadata lives) is refused, checked when the
 * URL is saved and again when the connection is made, after DNS, so a name that later resolves
 * inward is caught too. WEBHOOK_ALLOW_PRIVATE lifts this for on-premise installations whose
 * receivers are on the same network.
 */
import { createHmac, randomBytes } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { WORKFLOW_READ_PERMISSION, WORKFLOWS } from '@hiva/contracts';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { notify } from '../mail/notify.js';
import { delegate } from '../workflow/engine.js';
import { permissionsFor } from '../auth/grants.js';

export const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
export const DISABLE_AFTER_FAILURES = 20;
const fa = (v: string | number) => String(v).replace(/\d/g, (c) => '۰۱۲۳۴۵۶۷۸۹'[Number(c)]!);

export const newWebhookSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;
export const sign = (secret: string, timestamp: number, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/* ── Where the server may not be sent ──────────────────────────────────── */

const blocked = new net.BlockList();
for (const [net4, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked.addSubnet(net4, bits, 'ipv4');
}
for (const [net6, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) blocked.addSubnet(net6, bits, 'ipv6');

export function isPrivateAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) return blocked.check(address, 'ipv6');
  return true;
}

/** A URL the server may call, or the reason it may not. */
export function checkWebhookUrl(raw: string, allowPrivate = env.WEBHOOK_ALLOW_PRIVATE): { ok: true; url: URL } | { ok: false; messageFa: string } {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, messageFa: 'نشانی معتبر نیست' }; }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return { ok: false, messageFa: 'نشانی Webhook باید https باشد' };
  if (url.username || url.password) return { ok: false, messageFa: 'نام کاربری و گذرواژه در نشانی پذیرفته نیست؛ از امضای Webhook استفاده کنید' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isPrivateAddress(host)))) {
    return { ok: false, messageFa: 'نشانی‌های شبکهٔ داخلی (localhost، بازه‌های خصوصی، link-local) برای Webhook پذیرفته نیست' };
  }
  return { ok: true, url };
}

/** DNS resolution that refuses internal addresses at connection time — after any rebinding. */
export function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return callback(Object.assign(new Error(`address of ${hostname} is on an internal network`), { code: 'EBLOCKED' }));
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  }) as net.LookupFunction;
}

export interface PostResult { status: number | null; body: string; error: string | null }

/** POST a JSON body. No redirects are followed — a redirect is a second, unchecked destination. */
export function postJson(rawUrl: string, body: string, headers: Record<string, string>, allowPrivate = env.WEBHOOK_ALLOW_PRIVATE): Promise<PostResult> {
  const checked = checkWebhookUrl(rawUrl, allowPrivate);
  if (!checked.ok) return Promise.resolve({ status: null, body: '', error: checked.messageFa });
  const url = checked.url;
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(url, {
      method: 'POST', lookup: guardedLookup(allowPrivate), timeout: 10_000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'Hiva-Webhooks/1', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (text.length < 2000) text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? null, body: text.slice(0, 2000), error: null }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout after 10s')));
    req.on('error', (e) => resolve({ status: null, body: '', error: e.message }));
    req.end(body);
  });
}

/* ── Which events ──────────────────────────────────────────────────────── */

export function matches(patterns: string[], entity: string, action: string): boolean {
  return patterns.some((p) => p === '*' || p === `${entity}.*` || p === `${entity}.${action}`);
}

/** The subscribable events, as the catalogue shows them. */
export function eventCatalog() {
  return Object.entries(WORKFLOWS).flatMap(([entity, wf]) => {
    const seen = new Set<string>();
    return wf.transitions.filter((t) => !seen.has(t.action) && seen.add(t.action)).map((t) => ({
      event: `${entity}.${t.action}`, entity, entityLabelFa: wf.labelFa, labelFa: t.labelFa, to: t.to,
      readPermission: WORKFLOW_READ_PERMISSION[entity] ?? null,
    }));
  });
}

/** Each pattern names a real entity and action, and its creator may read what it would send. */
export function validateEvents(patterns: string[], creatorPermissions: readonly string[]): string[] {
  const problems: string[] = [];
  for (const p of patterns) {
    if (p === '*') continue;
    const [entity, action] = p.split('.') as [string, string];
    const wf = WORKFLOWS[entity];
    if (!wf) { problems.push(`«${p}»: موجودیتی به نام ${entity} نیست`); continue; }
    if (action !== '*' && !wf.transitions.some((t) => t.action === action)) { problems.push(`«${p}»: ${wf.labelFa} گذاری به نام ${action} ندارد`); continue; }
    const need = WORKFLOW_READ_PERMISSION[entity];
    if (need && !creatorPermissions.includes(need)) problems.push(`«${p}»: رویدادهای ${wf.labelFa} را فقط کسی که آن را می‌بیند می‌تواند دریافت کند`);
  }
  return problems;
}

/* ── Dispatching ───────────────────────────────────────────────────────── */

/**
 * The oldest transaction still running (audit LOG-1). Every transition with a smaller txid is written
 * and visible, and no transaction yet to commit can add one there — so a cursor that stops below it
 * never passes a row that has still to appear. A cursor by createdAt could: createdAt is when its
 * transaction began, and a transaction that began first and committed last landed behind the cursor
 * and was never sent.
 */
export async function logHorizon(): Promise<bigint> {
  const [row] = await prisma.$queryRaw<{ xmin: bigint }[]>`SELECT ((pg_snapshot_xmin(pg_current_snapshot()))::text)::bigint AS xmin`;
  return row!.xmin;
}

/** New transitions → deliveries, for every active subscription, from where each left off. */
export async function enqueueDeliveries(limitPerSubscription = 500): Promise<number> {
  const subs = await prisma.webhookSubscription.findMany({
    where: { active: true },
    omit: { cursorTxid: false },
    include: { createdBy: { select: { isActive: true, deletedAt: true, roles: { select: { role: { select: { code: true } } } } } } },
  });
  const below = await logHorizon();
  let created = 0;
  for (const sub of subs) {
    // The creator's own authority, read now: a webhook cannot outlive or outgrow its creator.
    if (!sub.createdBy.isActive || sub.createdBy.deletedAt) continue;
    const perms = await permissionsFor(sub.organizationId, sub.createdBy.roles.map((r) => r.role.code));
    const rows = await prisma.stateTransition.findMany({
      where: {
        organizationId: sub.organizationId, txid: { lt: below },
        OR: [{ txid: { gt: sub.cursorTxid } }, { txid: sub.cursorTxid, id: { gt: sub.cursorId ?? '' } }],
      },
      orderBy: [{ txid: 'asc' }, { id: 'asc' }], take: limitPerSubscription, omit: { txid: false },
    });
    if (!rows.length) continue;
    for (const t of rows) {
      // A state recorded on migration (#48), or anything from before the subscription (or its
      // reactivation), is not news. Read past all the same, so the cursor moves over it.
      if (t.opening || t.createdAt < sub.cursorAt) continue;
      const need = WORKFLOW_READ_PERMISSION[t.entityType];
      if (!matches(sub.events, t.entityType, t.action) || (need && !perms.includes(need))) continue;
      const record = await delegate(prisma, t.entityType).findUnique({ where: { id: t.entityId }, select: { code: true } }).catch(() => null);
      const transition = WORKFLOWS[t.entityType]?.transitions.find((x) => x.action === t.action);
      const payload = {
        event: `${t.entityType}.${t.action}`, eventId: t.id, occurredAt: t.createdAt.toISOString(),
        data: {
          entity: t.entityType, entityId: t.entityId, code: record?.code ?? null, action: t.action, actionFa: transition?.labelFa ?? null,
          from: t.fromState, to: t.toState, reason: t.reason ?? null, cascade: t.cascade,
        },
      };
      const r = await prisma.webhookDelivery.createMany({
        // Due now, on the application's clock — the one sendDue compares against.
        data: [{ organizationId: sub.organizationId, subscriptionId: sub.id, transitionId: t.id, event: payload.event, payload, nextAttemptAt: new Date() }], skipDuplicates: true,
      });
      created += r.count;
    }
    const last = rows.at(-1)!;
    await prisma.webhookSubscription.update({ where: { id: sub.id }, data: { cursorTxid: last.txid, cursorId: last.id } });
  }
  return created;
}

/** Send one delivery now, and record what happened. */
export async function attempt(deliveryId: string, now = new Date()) {
  const d = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { subscription: true } });
  const body = JSON.stringify({ id: d.id, ...(d.payload as object) });
  const ts = Math.floor(now.getTime() / 1000);
  const res = await postJson(d.subscription.url, body, {
    'x-hiva-event': d.event, 'x-hiva-delivery': d.id, 'x-hiva-timestamp': String(ts), 'x-hiva-signature': sign(d.subscription.secret, ts, body),
  });
  const ok = res.status != null && res.status >= 200 && res.status < 300;
  const attempts = d.attempts + 1;
  if (ok) {
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'DELIVERED', attempts, deliveredAt: now, lastStatusCode: res.status, lastError: null } });
    await prisma.webhookSubscription.update({ where: { id: d.subscriptionId }, data: { consecutiveFailures: 0 } });
    return { ok, status: res.status, error: null };
  }
  const error = res.error ?? `HTTP ${res.status}: ${res.body.slice(0, 300)}`;
  const dead = attempts >= MAX_ATTEMPTS;
  await prisma.webhookDelivery.update({
    where: { id: d.id },
    data: {
      status: dead ? 'DEAD' : 'PENDING', attempts, lastStatusCode: res.status, lastError: error,
      nextAttemptAt: dead ? d.nextAttemptAt : new Date(now.getTime() + BACKOFF_MINUTES[attempts - 1]! * 60_000),
    },
  });
  const sub = await prisma.webhookSubscription.update({ where: { id: d.subscriptionId }, data: { consecutiveFailures: { increment: 1 } } });
  if (sub.active && sub.consecutiveFailures >= DISABLE_AFTER_FAILURES) {
    await prisma.webhookSubscription.update({ where: { id: sub.id }, data: { active: false, disabledAt: now, disabledReason: `${fa(DISABLE_AFTER_FAILURES)} تحویل ناموفق پیاپی — آخرین خطا: ${error.slice(0, 200)}` } });
    await notify({
      userId: sub.createdById, kind: 'WEBHOOK_DISABLED', severity: 'WARNING',
      title: `Webhook «${sub.name}» غیرفعال شد`,
      body: `${fa(DISABLE_AFTER_FAILURES)} تحویل پیاپی به ${sub.url} ناموفق بود. پس از رفع مشکل گیرنده، آن را از «مدیریت ← یکپارچه‌سازی» دوباره فعال کنید.`,
      entityType: 'webhookSubscription', entityId: sub.id,
    });
  }
  return { ok, status: res.status, error };
}

export async function sendDue(now = new Date(), limit = 100) {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now }, subscription: { active: true } },
    orderBy: { nextAttemptAt: 'asc' }, take: limit, select: { id: true },
  });
  let delivered = 0, failed = 0;
  for (const d of due) (await attempt(d.id, now)).ok ? delivered++ : failed++;
  return { delivered, failed };
}

/** The job: read the log forward, then send what is due. */
export async function dispatchWebhooks(now = new Date()) {
  const enqueued = await enqueueDeliveries();
  // What was just enqueued is due too: "now" is read after it, not before.
  return { enqueued, ...(await sendDue(new Date(Math.max(now.getTime(), Date.now())))) };
}

export function assertWebhookUrl(raw: string) {
  const c = checkWebhookUrl(raw);
  if (!c.ok) throw new AppError(422, 'WEBHOOK_URL_REFUSED', c.messageFa);
}
