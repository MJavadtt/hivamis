import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { env } from '../env.js';
import type { CodePurpose } from './sms.js';

/**
 * One-time codes by SMS (Hivamis task 4): six digits, five minutes, one use, five tries.
 *
 * Only an HMAC of the code is kept, keyed with the server's secret and bound to its purpose and
 * number, so the table cannot be read back into codes and a sign-up code cannot sign anyone in. A new
 * code spends the one before it. A number gets one code a minute and five an hour, whoever asks.
 */

export const CODE_TTL_MS = 5 * 60_000;
export const RESEND_MS = 60_000;
export const MAX_PER_HOUR = 5;
export const MAX_ATTEMPTS = 5;

const mac = (purpose: CodePurpose, phone: string, code: string) =>
  createHmac('sha256', env.JWT_SECRET).update(`${purpose}:${phone}:${code}`).digest('hex');

export type Issued = { code: string } | { retryAfterSeconds: number };

export async function issueCode(input: { purpose: CodePurpose; phone: string; userId?: string | null; ipAddress?: string | null }): Promise<Issued> {
  const now = Date.now();
  const recent = await prisma.otpCode.findMany({
    where: { phone: input.phone, purpose: input.purpose, createdAt: { gt: new Date(now - 3_600_000) } },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  const last = recent[0]?.createdAt.getTime();
  if (last && now - last < RESEND_MS) return { retryAfterSeconds: Math.ceil((RESEND_MS - (now - last)) / 1000) };
  if (recent.length >= MAX_PER_HOUR) return { retryAfterSeconds: Math.ceil((recent[recent.length - 1]!.createdAt.getTime() + 3_600_000 - now) / 1000) };

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.$transaction([
    prisma.otpCode.updateMany({ where: { phone: input.phone, purpose: input.purpose, consumedAt: null }, data: { consumedAt: new Date(now) } }),
    prisma.otpCode.create({
      data: {
        purpose: input.purpose, phone: input.phone, userId: input.userId ?? null, codeHash: mac(input.purpose, input.phone, code),
        expiresAt: new Date(now + CODE_TTL_MS), ipAddress: input.ipAddress ?? null,
      },
    }),
  ]);
  return { code };
}

/**
 * Spends the code if it is right. Each try counts before it is checked, and the last one is taken
 * with a conditional update, so two requests racing with the same code cannot both succeed.
 */
export async function checkCode(input: { purpose: CodePurpose; phone: string; code: string }): Promise<{ id: string; userId: string | null } | null> {
  const row = await prisma.otpCode.findFirst({
    where: { phone: input.phone, purpose: input.purpose, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  const counted = await prisma.otpCode.updateMany({
    where: { id: row.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count === 0) return null;
  const expected = Buffer.from(row.codeHash, 'hex');
  const given = Buffer.from(mac(input.purpose, input.phone, input.code), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    if (row.attempts + 1 >= MAX_ATTEMPTS) await prisma.otpCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    return null;
  }
  const spent = await prisma.otpCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
  return spent.count === 1 ? { id: row.id, userId: row.userId } : null;
}
