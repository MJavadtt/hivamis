import type { FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { notFound, unauthorized } from './errors.js';

/**
 * Which organisation a request is about (roadmap #50). A signed-in request carries its organisation
 * in its token and never asks. A request without one — signing in, asking to join, a sign-in with
 * Google — is about the organisation of the address it came to: in `single` mode the one
 * organisation; in `multi` mode the one whose host names include this host.
 *
 * `tenancy.mode` is read at each call, so a test can switch it.
 */
export const tenancy = { mode: env.TENANT_MODE as 'single' | 'multi' };

/** The host the browser asked for, as the proxy passed it on, without a port. */
export function requestHost(req: FastifyRequest): string {
  return (req.hostname ?? '').toLowerCase().replace(/:\d+$/, '');
}

const SELECT = { id: true, name: true, slug: true, settings: true } as const;

export async function organizationForHost(host: string) {
  if (!host) return null;
  return prisma.organization.findFirst({ where: { isActive: true, hosts: { has: host.toLowerCase() } }, select: SELECT });
}

/**
 * Where an anonymous request may find its person (audit LOG-4): the organisation its address names, or
 * — with one organisation, or at the installation's own address — any. An email is unique only within
 * an organisation, so the address is the first thing that says which.
 */
export async function hostScope(req: FastifyRequest): Promise<{ organizationId?: string }> {
  if (tenancy.mode !== 'multi') return {};
  const here = await organizationForHost(requestHost(req));
  return here ? { organizationId: here.id } : {};
}

/** The organisation of an anonymous request, or null when the address names none. */
export async function organizationForRequest(req: FastifyRequest) {
  if (tenancy.mode === 'single') {
    return prisma.organization.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' }, select: SELECT });
  }
  return organizationForHost(requestHost(req));
}

/** As {@link organizationForRequest}, refusing a request whose address names no organisation. */
export async function requireOrganization(req: FastifyRequest) {
  const org = await organizationForRequest(req);
  if (!org) throw notFound('سازمان');
  return org;
}

/**
 * A person signs in at their own organisation's address, or at an address that names none (the
 * installation's own). At another organisation's address they are told what a wrong password is
 * told, so the address does not confirm the account exists elsewhere.
 */
export async function assertSignInHere(req: FastifyRequest, organizationId: string): Promise<void> {
  if (tenancy.mode !== 'multi') return;
  const here = await organizationForHost(requestHost(req));
  if (here && here.id !== organizationId) throw unauthorized('ایمیل یا رمز عبور نادرست است');
}
