import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'hiva-os';

export interface AccessTokenClaims {
  sub: string;
  organizationId: string;
  departmentCode: string | null;
  /** Native roles plus any held through an active delegation. */
  roles: string[];
  /** Native permissions plus any held through an active delegation. */
  permissions: string[];
  /** permission → the user who delegated it; absent for what the holder has in their own right. */
  delegated?: Record<string, string>;
  /** role → the user who delegated it. */
  delegatedRoles?: Record<string, string>;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ ...claims } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
  return payload as unknown as AccessTokenClaims;
}

/** Refresh tokens are opaque random strings; only their SHA-256 digest is stored. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Throws rather than guessing: env.ts validates the format, so reaching this is a bug. */
export function ttlToMs(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) throw new Error(`invalid TTL "${ttl}" — expected <number><s|m|h|d>, e.g. 15m`);
  const n = Number(m[1]);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * mult;
}
