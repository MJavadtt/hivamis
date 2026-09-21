import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Permission } from '@hiva/contracts';
import { verifyAccessToken, type AccessTokenClaims } from './tokens.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessTokenClaims;
  }
  interface FastifyInstance {
    /** Rejects the request unless a valid access token is present. */
    authenticate: (req: FastifyRequest) => Promise<void>;
    /** Rejects unless the caller holds EVERY listed permission. Denials are audited. */
    requirePermissions: (...perms: Permission[]) => (req: FastifyRequest) => Promise<void>;
  }
}

export function currentUser(req: FastifyRequest): AccessTokenClaims {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function hasPermission(req: FastifyRequest, perm: Permission): boolean {
  return req.user?.permissions.includes(perm) ?? false;
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('user', undefined);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    try {
      req.user = await verifyAccessToken(header.slice(7));
    } catch {
      throw unauthorized('توکن نامعتبر یا منقضی شده است');
    }
  });

  app.decorate('requirePermissions', (...perms: Permission[]) => async (req: FastifyRequest) => {
    const user = currentUser(req);
    const missing = perms.filter((p) => !user.permissions.includes(p));
    if (missing.length === 0) {
      // Passed — but if only because someone delegated it, that is a fact worth a row of its
      // own: every request made on a delegated permission, with who lent it and for what.
      const borrowed = perms.filter((p) => user.delegated?.[p]);
      if (borrowed.length) {
        await audit({
          organizationId: user.organizationId, actorId: user.sub, action: 'DELEGATION_USED',
          entityType: 'delegation', onBehalfOfId: user.delegated![borrowed[0]!] ?? null,
          after: { permissions: borrowed, from: borrowed.map((p) => user.delegated![p]), method: req.method, url: req.url },
          ipAddress: req.ip,
        }).catch(() => undefined);
      }
      return;
    }
    await audit({
      organizationId: user.organizationId,
      actorId: user.sub,
      action: 'PERMISSION_DENIED',
      entityType: 'authorization',
      reason: `missing: ${missing.join(', ')}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      requestId: req.id,
    }).catch(() => undefined);
    throw forbidden(`برای این عملیات به دسترسی «${missing.join('، ')}» نیاز دارید`);
  });
};

export default fp(authPlugin, { name: 'auth' });
