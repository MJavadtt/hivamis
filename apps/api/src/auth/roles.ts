/**
 * The roles an organisation has (audit F-3): the ones the code defines, which every organisation
 * shares and nobody deletes, and the ones its administrator made, which only it sees. A role of
 * another organisation's is not found here — 404, never 403.
 */
import { randomBytes } from 'node:crypto';
import { FULL_ACCESS_ROLES, ROLE_CODES, type RoleCode } from '@hiva/contracts';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db.js';
import { badRequest } from '../lib/errors.js';

/** Where clause: the code's roles, and this organisation's own. */
export const rolesOf = (organizationId: string): Prisma.RoleWhereInput => ({ OR: [{ organizationId: null }, { organizationId }] });

export const isSystemRole = (code: string): code is RoleCode => (ROLE_CODES as readonly string[]).includes(code);
export const isFullAccess = (code: string) => FULL_ACCESS_ROLES.includes(code as RoleCode);

/** The roles named, all of them the organisation's to give — or 400 naming the ones that are not. */
export async function findRoles(tx: Tx, organizationId: string, codes: readonly string[]) {
  const unique = [...new Set(codes)];
  const roles = await tx.role.findMany({ where: { code: { in: unique }, ...rolesOf(organizationId) } });
  if (roles.length !== unique.length) {
    const missing = unique.filter((c) => !roles.some((r) => r.code === c));
    throw badRequest('UNKNOWN_ROLE', `نقش نامعتبر است: ${missing.join('، ')}`, { missing });
  }
  return roles;
}

/** A new custom role's code: `C_` and eight letters or digits, unused anywhere. */
export async function newRoleCode(tx: Tx): Promise<string> {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const code = `C_${[...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
    if (!(await tx.role.findUnique({ where: { code }, select: { id: true } }))) return code;
  }
}

export interface RoleReferences { holders: number; delegations: number; forms: number; pendingSubmissions: number; rules: number }

/**
 * Everything in the organisation that still names a role: the people who hold it, delegations in
 * force, form definitions it approves, submissions waiting on it, and rules in force that notify it.
 * A role with any of these is not deleted (409, with this list).
 */
export async function roleReferences(tx: Tx, organizationId: string, code: string, now = new Date()): Promise<RoleReferences> {
  const [holders, delegations, forms, pendingSubmissions, rules] = await Promise.all([
    tx.userRole.count({ where: { role: { code }, user: { organizationId, deletedAt: null } } }),
    tx.delegation.count({ where: { organizationId, roles: { has: code }, revokedAt: null, endsAt: { gt: now } } }),
    tx.formDefinition.count({ where: { organizationId, approverRoles: { has: code } } }),
    tx.formSubmission.count({ where: { organizationId, currentRoles: { has: code }, state: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } }),
    tx.customRule.count({ where: { organizationId, notifyRoles: { has: code }, retiredAt: null } }),
  ]);
  return { holders, delegations, forms, pendingSubmissions, rules };
}

/** Each organisation's own roles, for the permissions rule set: a made, renamed or deleted role is a new version. */
export async function customRoleCatalogue(tx: Tx): Promise<Record<string, Record<string, { nameFa: string; nameEn: string; color: string | null }>>> {
  const rows = await tx.role.findMany({
    where: { organizationId: { not: null } }, orderBy: { code: 'asc' },
    select: { code: true, organizationId: true, nameFa: true, nameEn: true, color: true },
  });
  const out: Record<string, Record<string, { nameFa: string; nameEn: string; color: string | null }>> = {};
  for (const r of rows) (out[r.organizationId!] ??= {})[r.code] = { nameFa: r.nameFa, nameEn: r.nameEn, color: r.color };
  return out;
}
