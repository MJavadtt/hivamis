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
  /** Set when the request came through an API key (roadmap #46); `sub` is then the key's creator. */
  apiKeyId?: string;
  /** How many grants each of the holder's roles had had when this token was issued (Hivamis task 6). */
  gv?: Record<string, number>;
  /** The session this token was issued for, so a person can tell this device from their others (Hivamis task 4). */
  sid?: string;
  /** The holder's `authVersion` when it was issued (audit SEC-3): a role, password or status change dates it. */
  av?: number;
  /**
   * The system administrator working in this person's account (owner's report, 2026-10-23). `sub` is
   * whose account it is; this is who is at the keyboard, and every audit row says so.
   */
  imp?: string;
}

/** `ttl` overrides the usual lifetime: a session in someone else's account is short and never refreshed. */
export async function signAccessToken(claims: AccessTokenClaims, ttl: string = env.ACCESS_TOKEN_TTL): Promise<string> {
  return new SignJWT({ ...claims } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setExpirationTime(ttl)
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
