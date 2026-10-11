import { permissionsForRoles, type RoleCode } from '@hiva/contracts';
import { prisma } from '../db.js';
import { AppError, unauthorized } from '../lib/errors.js';
import { grantsOf, permissionsFor, versionsFor } from './grants.js';

/** The claims a user signs in with — roles, permissions, delegations as of now. Also used by the messenger (#40). */
export async function claimsFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { department: true, roles: { include: { role: true } }, organization: { select: { isActive: true } } },
  });
  if (!user) throw unauthorized();
  // Roadmap #50: a suspended organisation signs nobody in, and its sessions stop refreshing.
  if (!user.organization.isActive) throw new AppError(401, 'ORG_SUSPENDED', 'سازمان شما موقتاً از دسترس خارج است.');
  const roles = user.roles.map((r) => r.role.code as RoleCode);
  // As the organisation's administrator granted them (Hivamis task 6); `gv` dates the grants.
  const grants = await grantsOf(user.organizationId);
  const native = permissionsForRoles(roles, grants.map);
  const { permissions, delegated, delegatedRoles, roles: allRoles } = await withDelegations(user.id, user.organizationId, roles, native);
  return {
    user,
    claims: {
      sub: user.id,
      organizationId: user.organizationId,
      departmentCode: user.department?.code ?? null,
      roles: allRoles,
      permissions,
      gv: versionsFor(grants, allRoles),
      av: user.authVersion,
      ...(Object.keys(delegated).length ? { delegated } : {}),
      ...(Object.keys(delegatedRoles).length ? { delegatedRoles } : {}),
    },
  };
}

/**
 * Fold the user's active delegations into their grants (roadmap #6). A delegated permission is
 * only granted if the delegator still holds it themselves at this moment — a delegation must
 * not outlive a demotion — and never overrides what the delegate already has natively, so the
 * attribution map names only what came from someone else.
 */
async function withDelegations(userId: string, organizationId: string, roles: RoleCode[], native: readonly string[]) {
  const now = new Date();
  const active = await prisma.delegation.findMany({
    where: { toUserId: userId, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { createdAt: 'asc' },
  });
  const permissions = new Set<string>(native);
  const allRoles = new Set<string>(roles);
  const delegated: Record<string, string> = {};
  const delegatedRoles: Record<string, string> = {};
  for (const d of active) {
    const from = await prisma.user.findUnique({
      where: { id: d.fromUserId }, select: { isActive: true, roles: { select: { role: { select: { code: true } } } } },
    });
    if (!from?.isActive) continue;
    const fromRoles = from.roles.map((r) => r.role.code as RoleCode);
    const fromPerms = new Set<string>(await permissionsFor(organizationId, fromRoles));
    for (const p of d.permissions) {
      if (!fromPerms.has(p) || permissions.has(p)) continue;
      permissions.add(p); delegated[p] = d.fromUserId;
    }
    for (const r of d.roles) {
      if (!fromRoles.includes(r as RoleCode) || allRoles.has(r)) continue;
      allRoles.add(r); delegatedRoles[r] = d.fromUserId;
    }
  }
  return { permissions: [...permissions], roles: [...allRoles], delegated, delegatedRoles };
}
