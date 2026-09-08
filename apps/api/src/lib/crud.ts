import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeAny } from 'zod';
import type { Permission } from '@hiva/contracts';
import { paginationSchema } from '@hiva/contracts';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { actorFrom, orderBy, page, parse } from './http.js';
import { allowedFor } from '../workflow/engine.js';
import { nextCode } from './codes.js';

export interface CrudOptions<C extends ZodTypeAny, U extends ZodTypeAny> {
  /** URL segment, e.g. "projects". */
  path: string;
  /** Prisma model name, e.g. "project". */
  model: string;
  /** Workflow entity key; when set, list rows carry the caller's available transitions. */
  workflowEntity?: string;
  permissions: { read: Permission; write: Permission };
  createSchema: C;
  updateSchema: U;
  /** Fields the client may sort by. */
  sortable?: string[];
  /** Fields included in the `q` free-text filter. */
  searchable?: string[];
  /** Relations included on list responses. */
  listInclude?: Record<string, unknown>;
  /** Relations included on detail responses. */
  detailInclude?: Record<string, unknown>;
  /** Extra Prisma `where` derived from query params (filters, scoping). */
  filter?: (req: FastifyRequest) => Record<string, unknown>;
  /** Generate a human code (LEAD-000001 …) on create. */
  codeScope?: string;
  /** Map validated input to Prisma create data. */
  toCreate?: (input: any, actor: ReturnType<typeof actorFrom>) => Record<string, unknown>;
  /** Runs inside the create request, after the row exists — for SLA clocks and derived rows. */
  afterCreate?: (record: any, actor: ReturnType<typeof actorFrom>) => Promise<void>;
  /** Soft-delete instead of hard delete. */
  softDelete?: boolean;
  deletePermission?: Permission;
}

/**
 * Registers the standard list/detail/create/update(/delete) endpoints for a domain entity,
 * with permission checks, pagination, free-text search and audit logging applied uniformly.
 * State changes are deliberately NOT part of this surface — they go through the workflow engine.
 */
export function registerCrud<C extends ZodTypeAny, U extends ZodTypeAny>(
  app: FastifyInstance,
  opts: CrudOptions<C, U>,
): void {
  const model = () => (prisma as any)[opts.model];
  const sortable = opts.sortable ?? ['createdAt', 'updatedAt'];

  app.get(`/${opts.path}`, { preHandler: [app.authenticate, app.requirePermissions(opts.permissions.read)] },
    async (req) => {
      const actor = actorFrom(req);
      const q = parse(paginationSchema, req.query);
      const where: Record<string, unknown> = {
        ...(opts.filter?.(req) ?? {}),
        ...(opts.softDelete ? { deletedAt: null } : {}),
      };
      if (fieldsOf(opts.model).has('organizationId')) where.organizationId = actor.organizationId;
      if (q.q && opts.searchable?.length) {
        where.OR = opts.searchable.map((f) => ({ [f]: { contains: q.q, mode: 'insensitive' } }));
      }

      const [items, total] = await Promise.all([
        model().findMany({
          where,
          include: opts.listInclude,
          orderBy: orderBy(q.sort, q.order, sortable),
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        model().count({ where }),
      ]);

      const decorated = opts.workflowEntity
        ? items.map((it: any) => ({
            ...it,
            availableTransitions: allowedFor(opts.workflowEntity!, it.state, actor.permissions),
          }))
        : items;

      return page(decorated, total, q);
    });

  /**
   * Tenant-scoped lookup by id.
   *
   * `findUnique` cannot take a non-unique filter, so this is `findFirst` with the organisation
   * in the predicate. A record belonging to another organisation returns 404 rather than 403:
   * a 403 would confirm the id exists, which is itself the thing tenancy withholds.
   */
  const findScoped = async (id: string, organizationId: string, include?: unknown) => {
    const where: Record<string, unknown> = { id };
    if (fieldsOf(opts.model).has('organizationId')) where.organizationId = organizationId;
    return model().findFirst({ where, ...(include ? { include } : {}) });
  };

  app.get(`/${opts.path}/:id`, { preHandler: [app.authenticate, app.requirePermissions(opts.permissions.read)] },
    async (req) => {
      const actor = actorFrom(req);
      const { id } = req.params as { id: string };
      const record = await findScoped(id, actor.organizationId, opts.detailInclude);
      if (!record || (opts.softDelete && record.deletedAt)) throw notFound();
      return opts.workflowEntity
        ? { ...record, availableTransitions: allowedFor(opts.workflowEntity, record.state, actor.permissions) }
        : record;
    });

  app.post(`/${opts.path}`, { preHandler: [app.authenticate, app.requirePermissions(opts.permissions.write)] },
    async (req, reply) => {
      const actor = actorFrom(req);
      const input = parse(opts.createSchema, req.body);
      const base = opts.toCreate ? opts.toCreate(input, actor) : { ...(input as object) };
      const fields = fieldsOf(opts.model);

      const data: Record<string, unknown> = { ...base };
      if (fields.has('organizationId')) data.organizationId = actor.organizationId;
      if (opts.codeScope && fields.has('code')) data.code = await nextCode(prisma, opts.codeScope);
      if (fields.has('createdById') && data.createdById == null) data.createdById = actor.id;

      const record = await model().create({ data });
      await opts.afterCreate?.(record, actor);
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE',
        entityType: opts.model, entityId: record.id, after: record,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      });
      return reply.code(201).send(record);
    });

  app.patch(`/${opts.path}/:id`, { preHandler: [app.authenticate, app.requirePermissions(opts.permissions.write)] },
    async (req) => {
      const actor = actorFrom(req);
      const { id } = req.params as { id: string };
      const input = parse(opts.updateSchema, req.body);
      const before = await findScoped(id, actor.organizationId);
      if (!before) throw notFound();
      // `state` is owned exclusively by the workflow engine.
      const { state: _ignored, ...safe } = input as Record<string, unknown>;
      const record = await model().update({ where: { id }, data: safe });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
        entityType: opts.model, entityId: id, before, after: record,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      });
      return record;
    });

  if (opts.deletePermission) {
    app.delete(`/${opts.path}/:id`, { preHandler: [app.authenticate, app.requirePermissions(opts.deletePermission)] },
      async (req, reply) => {
        const actor = actorFrom(req);
        const { id } = req.params as { id: string };
        const before = await findScoped(id, actor.organizationId);
        if (!before) throw notFound();
        if (opts.softDelete) await model().update({ where: { id }, data: { deletedAt: new Date() } });
        else await model().delete({ where: { id } });
        await audit({
          organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE',
          entityType: opts.model, entityId: id, before,
          ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
        });
        return reply.code(204).send();
      });
  }
}

/**
 * Column names per model, built once from Prisma's generated DMMF.
 * Used to decide whether a model carries `organizationId`, `code` or `createdById`
 * so the factory can populate them without each caller repeating itself.
 */
const MODEL_FIELDS: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    map.set(model.name.toLowerCase(), new Set(model.fields.map((f) => f.name)));
  }
  return map;
})();

function fieldsOf(model: string): Set<string> {
  const fields = MODEL_FIELDS.get(model.toLowerCase());
  if (!fields) {
    throw new Error(`registerCrud: unknown Prisma model "${model}"`);
  }
  return fields;
}
