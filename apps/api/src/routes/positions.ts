import type { FastifyPluginAsync } from 'fastify';
import { createPositionSchema, updatePositionSchema } from '@hiva/contracts';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { findRoles } from '../auth/roles.js';

/**
 * The organisation's positions (audit F-3): a job title kept once, in a unit, with the roles it
 * usually brings. A person's title follows their position — renamed here, renamed on everyone who
 * holds it. The default roles are offered when someone is given the position, never granted silently.
 */

const SELECT = {
  id: true, nameFa: true, nameEn: true, defaultRoleCodes: true, archivedAt: true,
  department: { select: { code: true } }, _count: { select: { users: { where: { deletedAt: null } } } },
} satisfies Prisma.PositionSelect;

const shape = (p: Prisma.PositionGetPayload<{ select: typeof SELECT }>) => ({
  id: p.id, nameFa: p.nameFa, nameEn: p.nameEn, defaultRoleCodes: p.defaultRoleCodes, archived: p.archivedAt !== null,
  departmentCode: p.department?.code ?? null, holders: p._count.users,
});

async function departmentId(tx: Tx, organizationId: string, code: string | null | undefined) {
  if (!code) return null;
  const d = await tx.department.findFirst({ where: { organizationId, code }, select: { id: true } });
  if (!d) throw badRequest('UNKNOWN_DEPARTMENT', 'واحد سازمانی نامعتبر است.');
  return d.id;
}

const taken = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

const positionRoutes: FastifyPluginAsync = async (app) => {
  /** The catalogue, for anyone choosing a position; the archived ones only for whoever keeps it. */
  app.get('/positions', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const all = (req.query as { all?: string }).all === '1' && actor.permissions.includes('admin.users');
    const rows = await prisma.position.findMany({
      where: { organizationId: actor.organizationId, ...(all ? {} : { archivedAt: null }) },
      orderBy: { nameFa: 'asc' }, take: 500, select: SELECT,
    });
    return rows.map(shape);
  });

  app.post('/positions', { preHandler: [app.authenticate, app.requirePermissions('admin.users')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createPositionSchema, req.body);
    await findRoles(prisma, actor.organizationId, input.defaultRoleCodes);
    try {
      const created = await prisma.$transaction(async (tx) => {
        const p = await tx.position.create({
          data: {
            organizationId: actor.organizationId, nameFa: input.nameFa, nameEn: input.nameEn,
            departmentId: await departmentId(tx, actor.organizationId, input.departmentCode), defaultRoleCodes: input.defaultRoleCodes,
          },
          select: SELECT,
        });
        await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'position', entityId: p.id, after: shape(p), ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
        return p;
      });
      return reply.code(201).send(shape(created));
    } catch (e) {
      if (taken(e)) throw conflict('POSITION_EXISTS', 'سمتی با همین عنوان پیش‌تر ساخته شده است.');
      throw e;
    }
  });

  app.patch('/positions/:id', { preHandler: [app.authenticate, app.requirePermissions('admin.users')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(updatePositionSchema, req.body);
    const before = await prisma.position.findFirst({ where: { id, organizationId: actor.organizationId }, select: SELECT });
    if (!before) throw notFound('سمت');
    if (input.defaultRoleCodes) await findRoles(prisma, actor.organizationId, input.defaultRoleCodes);
    try {
      const after = await prisma.$transaction(async (tx) => {
        const p = await tx.position.update({
          where: { id: before.id, organizationId: actor.organizationId },
          data: {
            ...(input.nameFa !== undefined ? { nameFa: input.nameFa } : {}),
            ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
            ...(input.departmentCode !== undefined ? { departmentId: await departmentId(tx, actor.organizationId, input.departmentCode) } : {}),
            ...(input.defaultRoleCodes !== undefined ? { defaultRoleCodes: input.defaultRoleCodes } : {}),
            ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
          },
          select: SELECT,
        });
        // The title everyone holding it shows follows the position.
        if (input.nameFa !== undefined && input.nameFa !== before.nameFa) {
          await tx.user.updateMany({ where: { organizationId: actor.organizationId, positionId: p.id }, data: { jobTitle: p.nameFa } });
        }
        await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'position', entityId: p.id, before: shape(before), after: shape(p), ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
        return p;
      });
      return shape(after);
    } catch (e) {
      if (taken(e)) throw conflict('POSITION_EXISTS', 'سمتی با همین عنوان پیش‌تر ساخته شده است.');
      throw e;
    }
  });
};

export default positionRoutes;
