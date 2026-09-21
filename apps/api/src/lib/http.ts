import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from './errors.js';
import { currentUser } from '../auth/plugin.js';

/** Parse+validate a request part, converting Zod issues into a 400 with field-level detail. */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('VALIDATION_ERROR', 'اطلاعات ورودی نامعتبر است.', {
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  return result.data;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function page<T>(items: T[], total: number, p: { page: number; pageSize: number }): Page<T> {
  return {
    items,
    total,
    page: p.page,
    pageSize: p.pageSize,
    pageCount: Math.max(1, Math.ceil(total / p.pageSize)),
  };
}

export function orderBy(sort: string | undefined, order: 'asc' | 'desc', allowed: string[], fallback = 'createdAt') {
  const field = sort && allowed.includes(sort) ? sort : fallback;
  return { [field]: order } as Record<string, 'asc' | 'desc'>;
}

/** Audit/actor context assembled from the authenticated request. */
export function actorFrom(req: FastifyRequest) {
  const u = currentUser(req);
  return {
    id: u.sub,
    organizationId: u.organizationId,
    departmentCode: u.departmentCode,
    permissions: u.permissions,
    roles: u.roles,
    delegated: u.delegated ?? {},
    delegatedRoles: u.delegatedRoles ?? {},
    /** Who delegated this permission to the actor, or null if they hold it in their own right. */
    onBehalfOfFor: (permission: string | undefined | null): string | null =>
      (permission && u.delegated?.[permission]) || null,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: req.id as string,
  };
}

export const created = (reply: FastifyReply, body: unknown) => reply.code(201).send(body);
