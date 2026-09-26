/**
 * The client portal's own sign-in (roadmap #34) — kept apart from staff sign-in on purpose.
 *
 * A portal token is signed with a key derived from JWT_SECRET for this purpose alone and carries
 * its own issuer, so it can never pass as a staff token (whose check requires issuer `hiva-os`),
 * nor a staff token as a portal one. It names a portal account, never roles or permissions, and it
 * dies with the account's `tokenVersion`: disabling an account, or a new password, ends every
 * session at once.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { unauthorized } from '../lib/errors.js';
import { hashToken } from '../auth/tokens.js';

const ISSUER = 'hiva-portal';
const TTL = '12h';
const key = createHmac('sha256', env.JWT_SECRET).update('hiva-portal-session-v1').digest();

export interface PortalClaims { sub: string; organizationId: string; companyId: string; v: number }

export const signPortalToken = (c: PortalClaims) =>
  new SignJWT({ organizationId: c.organizationId, companyId: c.companyId, v: c.v })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setIssuer(ISSUER).setSubject(c.sub).setExpirationTime(TTL).sign(key);

export async function verifyPortalToken(token: string): Promise<PortalClaims> {
  const { payload } = await jwtVerify(token, key, { issuer: ISSUER });
  return { sub: String(payload.sub), organizationId: String(payload.organizationId), companyId: String(payload.companyId), v: Number(payload.v) };
}

/** An invitation's secret: returned once, stored only as its hash. */
export function invitationToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** The signed-in portal account, re-read on every request — a disabled account stops at once. */
export async function portalUser(req: FastifyRequest) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw unauthorized('برای دیدن این صفحه وارد پورتال شوید.');
  let claims: PortalClaims;
  try { claims = await verifyPortalToken(token); } catch { throw unauthorized('نشست پورتال معتبر نیست؛ دوباره وارد شوید.'); }
  const u = await prisma.portalUser.findUnique({
    where: { id: claims.sub },
    include: { contact: { select: { fullName: true, deletedAt: true } }, company: { select: { legalName: true, brandName: true, deletedAt: true } } },
  });
  if (!u || u.status !== 'ACTIVE' || u.tokenVersion !== claims.v || u.contact.deletedAt || u.company.deletedAt) {
    throw unauthorized('نشست پورتال به پایان رسیده است؛ دوباره وارد شوید.');
  }
  return u;
}
