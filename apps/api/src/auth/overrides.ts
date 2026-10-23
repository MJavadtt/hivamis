import { OVERSIGHT_GRANTOR_ROLE, OVERSIGHT_PERMISSIONS, PERMISSIONS, type Permission } from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { forgetStanding } from './standing.js';
import { oversightRefused, permissionsFor } from './grants.js';

/**
 * One person's own permissions (owner's report, 2026-10-23): the administrator controls what each
 * user may do, not only what each role may. A row gives a permission their roles do not (`grant`)
 * or withholds one they do (`deny`); what a person may do is their roles' permissions, plus their
 * grants, less their denials.
 *
 * The system administrator is not narrowed this way — they answer for the whole installation — and
 * oversight of conversations is given by the system administrator alone, here as for a role (F-5).
 */

export interface Overrides { grant: string[]; deny: string[] }

const NONE: Overrides = { grant: [], deny: [] };

export async function overridesOf(userIds: readonly string[], tx: Tx = prisma): Promise<Map<string, Overrides>> {
  const out = new Map<string, Overrides>();
  if (!userIds.length) return out;
  const rows = await tx.userPermissionOverride.findMany({ where: { userId: { in: [...userIds] } }, select: { userId: true, permission: true, effect: true } });
  for (const r of rows) {
    const o = out.get(r.userId) ?? { grant: [], deny: [] };
    (r.effect === 'deny' ? o.deny : o.grant).push(r.permission);
    out.set(r.userId, o);
  }
  return out;
}

/** Roles' permissions, plus the person's grants, less their denials. Unknown codes are dropped. */
export function applyOverrides(fromRoles: readonly string[], o: Overrides = NONE): Permission[] {
  const out = new Set<string>(fromRoles);
  for (const p of o.grant) if (p in PERMISSIONS) out.add(p);
  for (const p of o.deny) out.delete(p);
  return [...out] as Permission[];
}

/** What this person may do now, in their own right — roles and their own grants and denials. */
export async function userPermissions(user: { id: string; organizationId: string; roles: readonly string[] }, tx: Tx = prisma): Promise<Permission[]> {
  return applyOverrides(await permissionsFor(user.organizationId, user.roles), (await overridesOf([user.id], tx)).get(user.id));
}

/**
 * Replace a person's grants and denials with exactly these. Raises their `authVersion`, so the token
 * they hold is refused at its next use and the app takes a fresh one — the change applies at once,
 * without signing them out. Returns what was added and taken away, for the audit row.
 */
export async function setOverrides(tx: Tx, input: {
  organizationId: string; userId: string; userRoles: readonly string[];
  grant: readonly string[]; deny: readonly string[]; actorId: string; mayGrantOversight: boolean;
}) {
  const unknown = [...input.grant, ...input.deny].filter((p) => !(p in PERMISSIONS));
  if (unknown.length) throw badRequest('UNKNOWN_PERMISSION', `دسترسی ناشناخته: ${unknown.join('، ')}`);
  const both = input.grant.filter((p) => input.deny.includes(p));
  if (both.length) throw badRequest('GRANT_AND_DENY', `یک دسترسی هم داده و هم گرفته شده است: ${both.join('، ')}`);
  if (input.deny.length && input.userRoles.includes(OVERSIGHT_GRANTOR_ROLE)) {
    throw badRequest('SYSTEM_ADMIN_UNRESTRICTED', 'مدیر سیستم به همهٔ سامانه دسترسی دارد و دسترسی‌اش کم نمی‌شود.');
  }
  const before = (await overridesOf([input.userId], tx)).get(input.userId) ?? NONE;
  const added = input.grant.filter((p) => !before.grant.includes(p));
  if (!input.mayGrantOversight && added.some((p) => OVERSIGHT_PERMISSIONS.includes(p as Permission))) throw oversightRefused();

  await tx.userPermissionOverride.deleteMany({ where: { userId: input.userId } });
  const rows = [
    ...[...new Set(input.grant)].map((permission) => ({ permission, effect: 'grant' })),
    ...[...new Set(input.deny)].map((permission) => ({ permission, effect: 'deny' })),
  ];
  if (rows.length) {
    await tx.userPermissionOverride.createMany({
      data: rows.map((r) => ({ ...r, organizationId: input.organizationId, userId: input.userId, grantedById: input.actorId })),
    });
  }
  await tx.user.update({ where: { id: input.userId }, data: { authVersion: { increment: 1 } } });
  forgetStanding(input.userId);
  return {
    before,
    after: { grant: [...new Set(input.grant)].sort(), deny: [...new Set(input.deny)].sort() },
  };
}
