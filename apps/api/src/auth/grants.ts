/**
 * What each role may do in an organisation (Hivamis task 6). The managing director, deputy, system
 * administrator and account manager hold everything; every other role holds what the organisation's
 * administrator granted — or, until then, the default it started with. A change is a new grant row,
 * the old one kept, and a new version of the permissions rule set (roadmap #4).
 *
 * Read on every sign-in and token refresh, and its version on every request, so it is cached per
 * organisation for a few seconds; the process that makes a change forgets its copy at once.
 */
import {
  FULL_ACCESS_ROLES, PERMISSIONS, effectiveRoleMap, permissionsForRoles,
  type Permission, type RoleCode, type RoleMap,
} from '@hiva/contracts';
import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { badRequest } from '../lib/errors.js';

export interface GrantRow { roleCode: string; permissions: string[]; note: string | null; grantedById: string; createdAt: Date }
export interface OrgGrants {
  map: RoleMap;
  /** How many grants each role has had here — a token naming an older count for one of its roles is stale. */
  roleVersions: Record<string, number>;
  current: Map<string, GrantRow>;
  at: number;
}

const TTL_MS = 10_000;
const cache = new Map<string, OrgGrants>();

export async function grantsOf(organizationId: string, tx: Tx = prisma): Promise<OrgGrants> {
  const fresh = tx === prisma ? cache.get(organizationId) : undefined;
  if (fresh && Date.now() - fresh.at < TTL_MS) return fresh;
  const rows = await tx.roleGrant.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } });
  const current = rows.filter((r) => !r.supersededAt);
  const out: OrgGrants = {
    map: effectiveRoleMap(Object.fromEntries(current.map((r) => [r.roleCode, r.permissions]))),
    roleVersions: rows.reduce<Record<string, number>>((v, r) => ({ ...v, [r.roleCode]: (v[r.roleCode] ?? 0) + 1 }), {}),
    current: new Map(current.map((r) => [r.roleCode, r])),
    at: Date.now(),
  };
  if (tx === prisma) cache.set(organizationId, out);
  return out;
}

/** The grant counts of these roles — what a token is stamped with, so a later grant to one of them dates it. */
export function versionsFor(grants: OrgGrants, roles: readonly string[]): Record<string, number> {
  return Object.fromEntries(roles.filter((r) => grants.roleVersions[r]).map((r) => [r, grants.roleVersions[r]!]));
}

/** Whether a role of this token's was granted anew since the token was issued. */
export function staleFor(grants: OrgGrants, roles: readonly string[], stamped: Record<string, number> | undefined): boolean {
  return roles.some((r) => (grants.roleVersions[r] ?? 0) > (stamped?.[r] ?? 0));
}

export const forgetGrants = (organizationId?: string) => (organizationId ? cache.delete(organizationId) : cache.clear());

/** A person's permissions from their roles, as their organisation has them. */
export async function permissionsFor(organizationId: string, roles: readonly string[]): Promise<Permission[]> {
  return permissionsForRoles(roles as RoleCode[], (await grantsOf(organizationId)).map);
}

/** The grants in force in every organisation — the part of the permissions rule set organisations write. */
export async function grantSnapshot(tx: Tx = prisma): Promise<Record<string, Record<string, string[]>>> {
  const rows = await tx.roleGrant.findMany({ where: { supersededAt: null }, select: { organizationId: true, roleCode: true, permissions: true } });
  const out: Record<string, Record<string, string[]>> = {};
  for (const r of rows) (out[r.organizationId] ??= {})[r.roleCode] = [...r.permissions].sort();
  return out;
}

/**
 * Grant a role exactly these permissions in an organisation. The full-access roles are not grantable:
 * they hold everything. Returns what changed against what the role held a moment ago.
 */
export async function setRoleGrant(tx: Tx, input: { organizationId: string; roleCode: string; permissions: readonly string[]; note?: string | null; actorId: string }) {
  if (FULL_ACCESS_ROLES.includes(input.roleCode as RoleCode)) {
    throw badRequest('FULL_ACCESS_ROLE', 'این نقش به همهٔ سامانه دسترسی دارد و دسترسی‌اش کم یا زیاد نمی‌شود.');
  }
  const unknown = input.permissions.filter((p) => !(p in PERMISSIONS));
  if (unknown.length) throw badRequest('UNKNOWN_PERMISSION', `دسترسی ناشناخته: ${unknown.join('، ')}`);
  const permissions = [...new Set(input.permissions)].sort();
  const before = new Set<string>((await grantsOf(input.organizationId, tx)).map[input.roleCode as RoleCode] ?? []);
  await tx.roleGrant.updateMany({ where: { organizationId: input.organizationId, roleCode: input.roleCode, supersededAt: null }, data: { supersededAt: new Date() } });
  const row = await tx.roleGrant.create({
    data: { organizationId: input.organizationId, roleCode: input.roleCode, permissions, note: input.note ?? null, grantedById: input.actorId },
  });
  return { row, added: permissions.filter((p) => !before.has(p)), removed: [...before].filter((p) => !permissions.includes(p)).sort() };
}
