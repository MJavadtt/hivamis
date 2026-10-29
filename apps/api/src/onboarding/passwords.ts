/**
 * Temporary first passwords for the people a move brought in (the owner's answer, 2026-10-30).
 *
 * Instead of a link each (activation.ts), a password the administrator hands on, which the person must
 * change at the first sign-in. Only for those who never had one — their hash is still the activation
 * placeholder; anyone who set their own keeps it. Each password is given back once, for the file the
 * command writes, and kept nowhere else: only its argon2 hash is stored, and the record says who set it.
 */
import { randomInt } from 'node:crypto';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { hashPassword } from '../auth/password.js';
import { endSessions } from '../auth/session.js';
import { PENDING_PREFIX } from './activation.js';

/** No 0/O or 1/l/I: read aloud or copied from paper without a mistake. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Twelve random letters in three groups («Xk7m-Pq3r-Tz9w»), with the lower case, upper case and digit the policy asks for. */
export function temporaryPassword(): string {
  for (;;) {
    const s = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  }
}

export interface Waiting { id: string; fullName: string; email: string; unit: string | null }

/** Who has never had a password: active, not removed, the activation placeholder still in place. */
export async function waitingForPassword(organizationId: string): Promise<Waiting[]> {
  const people = await prisma.user.findMany({
    where: { organizationId, isActive: true, deletedAt: null, passwordHash: { startsWith: PENDING_PREFIX } },
    select: { id: true, fullName: true, email: true, department: { select: { nameFa: true } } },
    orderBy: [{ department: { code: 'asc' } }, { fullName: 'asc' }],
  });
  return people.map((p) => ({ id: p.id, fullName: p.fullName, email: p.email, unit: p.department?.nameFa ?? null }));
}

/**
 * Sets each waiting person's temporary password, one transaction each, and yields it as soon as it is
 * set — so a run that stops has already handed over every password it set. Someone who sets their own
 * in the meantime is passed over.
 */
export async function* issueTemporaryPasswords(actor: { id: string; organizationId: string }): AsyncGenerator<Waiting & { password: string }> {
  for (const person of await waitingForPassword(actor.organizationId)) {
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    const set = await prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: person.id, organizationId: actor.organizationId, passwordHash: { startsWith: PENDING_PREFIX } },
        data: { passwordHash, mustChangePassword: true, lockedUntil: null },
      });
      if (!count) return false;
      // A link still open would set another password over this one: it stops working.
      await tx.accountActivation.updateMany({ where: { userId: person.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      await endSessions(tx, person.id, 'PASSWORD_SET_BY_ADMIN');
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'PASSWORD_SET', entityType: 'user', entityId: person.id,
        after: { mustChangePassword: true, temporary: true },
      }, tx);
      return true;
    });
    if (set) yield { ...person, password };
  }
}
