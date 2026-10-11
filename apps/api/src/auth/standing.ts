import { prisma } from '../db.js';
import type { AccessTokenClaims } from './tokens.js';

/**
 * Audit SEC-3: whether what an access token was issued on still holds. Its signature only says it was
 * issued, and for fifteen minutes; a person signed out, deactivated, locked, demoted or with a new
 * password kept the old powers for that long. Checked on every request:
 *
 * - its sign-in is live: the session it names, or — after a rotation — a later row of the same family;
 * - its holder is active, not deleted, not locked;
 * - its `av` is the holder's `authVersion`, which a role, password or deactivation change raises.
 *
 * Read per session for at most five seconds. The process that ends a session or raises the version
 * forgets its copy and reads fresh for the next five, so the change holds here at once and on any
 * other process within the TTL.
 */

const TTL_MS = 5_000;

interface Standing {
  userId: string;
  live: boolean;
  usable: boolean;
  lockedUntil: Date | null;
  authVersion: number;
  at: number;
}

const cache = new Map<string, Standing>();
/** userId → until when its sessions are read fresh: a request in flight must not re-cache the old state. */
const freshUntil = new Map<string, number>();
/** The same, for everyone: an organisation suspended. */
let allFreshUntil = 0;

async function read(sid: string): Promise<Standing | null> {
  const now = new Date();
  const s = await prisma.session.findUnique({
    where: { id: sid },
    select: {
      userId: true, familyId: true, revokedAt: true, revokedReason: true, expiresAt: true,
      user: { select: { isActive: true, deletedAt: true, lockedUntil: true, authVersion: true } },
    },
  });
  if (!s) return null;
  let live = !s.revokedAt && s.expiresAt > now;
  // Rotated away is not over: the sign-in goes on in its successor, and so do tokens issued before it.
  if (!live && s.revokedReason === 'ROTATED') {
    live = (await prisma.session.count({ where: { familyId: s.familyId, revokedAt: null, expiresAt: { gt: now } } })) > 0;
  }
  return {
    userId: s.userId, live, usable: s.user.isActive && !s.user.deletedAt,
    lockedUntil: s.user.lockedUntil, authVersion: s.user.authVersion, at: Date.now(),
  };
}

/** Why this token no longer stands, or null when it does. */
export async function revokedBecause(claims: Pick<AccessTokenClaims, 'sub' | 'sid' | 'av'>): Promise<string | null> {
  // Every token a person signs in with names its session; one that does not was not issued here.
  if (!claims.sid) return 'no session';
  let s = cache.get(claims.sid);
  if (!s || Date.now() - s.at >= TTL_MS) {
    s = (await read(claims.sid)) ?? undefined;
    if (!s) { cache.delete(claims.sid); return 'no session'; }
    if (Math.max(freshUntil.get(s.userId) ?? 0, allFreshUntil) <= Date.now()) cache.set(claims.sid, s);
  }
  if (s.userId !== claims.sub) return 'not this person’s session';
  if (!s.live) return 'session ended';
  if (!s.usable) return 'account inactive';
  if (s.lockedUntil && s.lockedUntil > new Date()) return 'account locked';
  if ((claims.av ?? 0) !== s.authVersion) return 'roles, password or status changed';
  return null;
}

/** Forget what is known of a person's sessions (or everyone's), and read them fresh for the next TTL. */
export function forgetStanding(userId?: string): void {
  if (!userId) { cache.clear(); allFreshUntil = Date.now() + TTL_MS; return; }
  for (const [sid, s] of cache) if (s.userId === userId) cache.delete(sid);
  const until = Date.now() + TTL_MS;
  freshUntil.set(userId, until);
  // Not a leak: a person whose window passed has nothing to remember.
  for (const [id, t] of freshUntil) if (t < Date.now()) freshUntil.delete(id);
}
