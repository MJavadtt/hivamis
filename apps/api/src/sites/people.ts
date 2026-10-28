import { FULL_ACCESS_ROLES, permissionsForRoles, type Permission } from '@hiva/contracts';
import { prisma } from '../db.js';
import { grantsOf } from '../auth/grants.js';
import { applyOverrides, overridesOf } from '../auth/overrides.js';

/**
 * Who holds a permission in an organisation, as it grants it today (ADR-103) — whom to tell that a
 * contract waits for approval, a closure for a decision, a rent for payment.
 *
 * `inOwnRight` leaves out the full-access roles (managing director, deputy, system administrator,
 * account manager), who hold everything by position: the rent of every counter is not theirs to be
 * reminded of unless they are given it themselves, by a role or a grant of their own.
 */
export async function holdersOf(organizationId: string, permission: Permission, opts: { inOwnRight?: boolean } = {}): Promise<string[]> {
  const { map } = await grantsOf(organizationId);
  const users = await prisma.user.findMany({
    where: { organizationId, isActive: true, deletedAt: null },
    select: { id: true, roles: { select: { role: { select: { code: true } } } } },
    take: 5000,
  });
  const own = await overridesOf(users.map((u) => u.id));
  return users.filter((u) => {
    const roles = u.roles.map((r) => r.role.code).filter((r) => !opts.inOwnRight || !FULL_ACCESS_ROLES.includes(r as never));
    return applyOverrides(permissionsForRoles(roles, map), own.get(u.id)).includes(permission);
  }).map((u) => u.id);
}
