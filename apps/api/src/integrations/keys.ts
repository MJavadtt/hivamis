/**
 * API keys (roadmap #46): an identity for a system rather than a person.
 *
 * A key is `hiva_<prefix>_<secret>`. The prefix finds the key; only a SHA-256 of the whole key is
 * kept, compared in constant time. A key acts with its creator's authority, narrowed to the
 * permissions it was given and recomputed on every request from the creator's *own* roles — so
 * demoting the creator shrinks every key they made, a delegation they hold never reaches a key,
 * and a deactivated creator's keys stop. Each key has its own per-minute budget.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { NON_KEY_PERMISSIONS } from '@hiva/contracts';
import { prisma } from '../db.js';
import { AppError, unauthorized } from '../lib/errors.js';
import type { AccessTokenClaims } from '../auth/tokens.js';
import { userPermissions } from '../auth/overrides.js';

export const KEY_PATTERN = /^hiva_([a-z0-9]{10})_([A-Za-z0-9_-]{43})$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function generateKey(): { key: string; prefix: string; secretHash: string } {
  const bytes = randomBytes(10);
  const prefix = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  const key = `hiva_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, secretHash: hashKey(key) };
}

/** The permissions a key may be given: what its creator holds in their own right, less the few no key may carry. */
export function grantable(creatorPermissions: readonly string[]): string[] {
  return creatorPermissions.filter((p) => !NON_KEY_PERMISSIONS.includes(p as never));
}

/* A fixed one-minute window per key. In-process: a multi-instance deployment has one budget per instance. */
const windows = new Map<string, { start: number; count: number }>();
export function spend(keyId: string, limit: number, now = Date.now()): { ok: boolean; retryAfter: number } {
  const w = windows.get(keyId);
  if (!w || now - w.start >= 60_000) { windows.set(keyId, { start: now, count: 1 }); return { ok: true, retryAfter: 0 }; }
  if (w.count >= limit) return { ok: false, retryAfter: Math.ceil((w.start + 60_000 - now) / 1000) };
  w.count++;
  return { ok: true, retryAfter: 0 };
}

/** Resolve a presented key to the claims a request runs with, or refuse. */
export async function authenticateKey(presented: string, ip: string | null): Promise<AccessTokenClaims & { apiKeyId: string; retryAfter?: number }> {
  const m = presented.match(KEY_PATTERN);
  if (!m) throw unauthorized('کلید API نامعتبر است');
  const key = await prisma.apiKey.findUnique({
    where: { prefix: m[1]! },
    include: { createdBy: { select: { id: true, organizationId: true, isActive: true, deletedAt: true, department: { select: { code: true } }, roles: { select: { role: { select: { code: true } } } } } } },
  });
  const expected = key ? Buffer.from(key.secretHash, 'hex') : Buffer.alloc(32);
  const given = Buffer.from(hashKey(presented), 'hex');
  if (!key || !timingSafeEqual(expected, given)) throw unauthorized('کلید API نامعتبر است');
  if (key.revokedAt) throw unauthorized('این کلید API باطل شده است');
  if (key.expiresAt && key.expiresAt <= new Date()) throw unauthorized('این کلید API منقضی شده است');
  const creator = key.createdBy;
  if (!creator.isActive || creator.deletedAt) throw unauthorized('سازندهٔ این کلید دیگر فعال نیست؛ کلید کار نمی‌کند');

  const budget = spend(key.id, key.rateLimitPerMinute);
  if (!budget.ok) {
    throw new AppError(429, 'API_KEY_RATE_LIMITED', `سهمیهٔ این کلید (${key.rateLimitPerMinute} درخواست در دقیقه) تمام شده است؛ ${budget.retryAfter} ثانیهٔ دیگر.`, { retryAfter: budget.retryAfter });
  }
  const own = grantable(await userPermissions({ id: key.createdById, organizationId: key.organizationId, roles: creator.roles.map((r) => r.role.code) }));
  const permissions = key.permissions.filter((p) => own.includes(p));

  // Last use, at most once a minute: enough to answer "is this key still in use?", without a write per request.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date(), lastUsedIp: ip } }).catch(() => undefined);
  }
  return {
    sub: creator.id, organizationId: creator.organizationId, departmentCode: creator.department?.code ?? null,
    roles: [], permissions, apiKeyId: key.id,
  };
}

/** Where a key may never go: the creator's own account, delegating, and managing keys and webhooks. */
// The messenger (#40) links a chat that then decides as the person with all their permissions,
// not a key's narrowed set: only the person may link it.
export const HUMAN_ONLY_PREFIXES = ['/api/v1/auth/', '/api/v1/delegations', '/api/v1/admin/api-keys', '/api/v1/admin/webhooks', '/api/v1/messenger/', '/api/v1/admin/messenger', '/api/v1/me/', '/api/v1/signup-requests', '/api/v1/settings/signup', '/api/v1/admin/sms-outbox', '/api/v1/ai/chat', '/api/v1/ai/conversations'];
