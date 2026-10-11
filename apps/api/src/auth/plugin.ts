import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Permission } from '@hiva/contracts';
import { verifyAccessToken, type AccessTokenClaims } from './tokens.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { grantsOf, staleFor } from './grants.js';
import { revokedBecause } from './standing.js';
import { audit } from '../lib/audit.js';
import { requestContext } from '../lib/request-context.js';
import { authenticateKey, HUMAN_ONLY_PREFIXES } from '../integrations/keys.js';

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
    const token = header.slice(7);
    // An API key (roadmap #46): a system acting with its creator's narrowed authority.
    if (token.startsWith('hiva_')) {
      const user = await authenticateKey(token, req.ip);
      const ctx = requestContext.getStore();
      if (ctx) ctx.apiKeyId = user.apiKeyId;
      if (HUMAN_ONLY_PREFIXES.some((p) => req.url.startsWith(p))) {
        // A key trying the creator's account, delegations or key management is a refusal worth
        // counting — the audit-trail detectors (#26) read exactly these rows.
        await audit({
          organizationId: user.organizationId, actorId: user.sub, action: 'PERMISSION_DENIED', entityType: 'authorization',
          reason: `human-only: ${req.url.split('?')[0]}`, ipAddress: req.ip, userAgent: req.headers['user-agent'] ?? null, requestId: req.id,
        }).catch(() => undefined);
        throw forbidden('این بخش فقط با ورود یک شخص در دسترس است، نه با کلید API.');
      }
      req.user = user;
      return;
    }
    let claims: AccessTokenClaims;
    try {
      claims = await verifyAccessToken(token);
    } catch {
      throw unauthorized('توکن نامعتبر یا منقضی شده است');
    }
    // Audit SEC-3: signed and unexpired is not enough — the sign-in and the person behind it must still
    // stand. A refusal sends the client to refresh, which fails for a session that is over.
    if (await revokedBecause(claims)) {
      throw new AppError(401, 'SESSION_REVOKED', 'نشست شما پایان یافته است؛ دوباره وارد شوید.');
    }
    // One of the holder's roles was granted anew since this token was issued (Hivamis task 6): it no
    // longer says what its holder may do. Refused, so the client takes a fresh one at once — a permission taken
    // away stops working now, not when the token would have expired.
    if (staleFor(await grantsOf(claims.organizationId), claims.roles, claims.gv)) {
      throw new AppError(401, 'GRANTS_CHANGED', 'دسترسی‌های نقش شما تغییر کرده است؛ دوباره بارگیری می‌شود.');
    }
    req.user = claims;
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
