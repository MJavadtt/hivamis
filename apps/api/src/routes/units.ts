import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DEPARTMENT_LABELS, teamSchema, teamUpdateSchema, unitUpdateSchema, type DepartmentCode } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { AppError, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

/**
 * The units the organisation runs (list 3, item 6). Doc_H's ten units stay — the process routes work
 * orders, unit QC and approvals to them — but the organisation names them, chooses each one's manager,
 * and divides a unit into teams: «split Creative» is Creative with «طراحی» and «ویدئو» inside it.
 */

const listQuery = z.object({ all: z.coerce.boolean().default(false) });

const unitsRoutes: FastifyPluginAsync = async (app) => {
  const settings = { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] };

  /** A member of the unit, active: the only kind of person who may manage it or lead a team in it. */
  const memberOf = async (organizationId: string, departmentId: string, userId: string, code: string, messageFa: string) => {
    const ok = await prisma.user.count({ where: { id: userId, organizationId, departmentId, isActive: true, deletedAt: null } });
    if (!ok) throw new AppError(422, code, messageFa, { field: code === 'MANAGER_NOT_IN_UNIT' ? 'managerId' : 'leadId' });
  };

  app.patch('/departments/:code', settings, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const input = parse(unitUpdateSchema, req.body ?? {});
    const before = await prisma.department.findFirst({ where: { code, organizationId: actor.organizationId } });
    if (!before) throw notFound('واحد');
    const data: Record<string, unknown> = {};
    if (input.nameFa === null || input.nameEn === null) {
      // Back to the code's names, which follow the product from then on.
      const own = DEPARTMENT_LABELS[before.code as DepartmentCode];
      if (own) Object.assign(data, { nameFa: own.fa, nameEn: own.en, namesOwned: false });
    } else if (input.nameFa || input.nameEn) {
      Object.assign(data, { ...(input.nameFa ? { nameFa: input.nameFa } : {}), ...(input.nameEn ? { nameEn: input.nameEn } : {}), namesOwned: true });
    }
    if (input.managerId !== undefined) {
      if (input.managerId) await memberOf(actor.organizationId, before.id, input.managerId, 'MANAGER_NOT_IN_UNIT', 'مدیر واحد باید از کارکنان فعال همین واحد باشد.');
      data.managerId = input.managerId ?? null;
    }
    return prisma.$transaction(async (tx) => {
      const after = await tx.department.update({ where: { id: before.id }, data });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'department', entityId: before.id,
        before: { nameFa: before.nameFa, nameEn: before.nameEn, managerId: before.managerId },
        after: { nameFa: after.nameFa, nameEn: after.nameEn, managerId: after.managerId, namesOwned: after.namesOwned },
        ipAddress: actor.ipAddress, requestId: actor.requestId,
      }, tx);
      return after;
    });
  });

  /** The organisation's teams, for every screen that shows or chooses one; the wound-up ones on request. */
  app.get('/teams', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(listQuery, req.query);
    const all = q.all && actor.permissions.includes('admin.settings');
    const teams = await prisma.team.findMany({
      where: { organizationId: actor.organizationId, ...(all ? {} : { archivedAt: null }) },
      include: {
        department: { select: { code: true } },
        lead: { select: { id: true, fullName: true } },
        _count: { select: { members: true } },
      },
      orderBy: [{ department: { sortOrder: 'asc' } }, { nameFa: 'asc' }], take: 500,
    });
    return teams.map(({ department, _count, ...t }) => ({ ...t, departmentCode: department.code, members: _count.members }));
  });

  app.post('/teams', settings, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(teamSchema, req.body);
    const unit = await prisma.department.findUnique({ where: { organizationId_code: { organizationId: actor.organizationId, code: input.departmentCode } } });
    if (!unit) throw notFound('واحد');
    if (input.leadId) await memberOf(actor.organizationId, unit.id, input.leadId, 'LEAD_NOT_IN_UNIT', 'سرپرست تیم باید از کارکنان فعال همین واحد باشد.');
    if (await prisma.team.count({ where: { organizationId: actor.organizationId, departmentId: unit.id, nameFa: input.nameFa } })) {
      throw new AppError(409, 'TEAM_EXISTS', 'تیمی با این نام در این واحد هست.');
    }
    const made = await prisma.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: { organizationId: actor.organizationId, departmentId: unit.id, nameFa: input.nameFa, nameEn: input.nameEn, leadId: input.leadId ?? null, color: input.color ?? null },
      });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'team', entityId: team.id, after: { ...team, unit: input.departmentCode }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return team;
    });
    return reply.code(201).send(made);
  });

  app.patch('/teams/:id', settings, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(teamUpdateSchema, req.body ?? {});
    const before = await prisma.team.findFirst({ where: { id, organizationId: actor.organizationId, archivedAt: null } });
    if (!before) throw notFound('تیم');
    if (input.leadId) await memberOf(actor.organizationId, before.departmentId, input.leadId, 'LEAD_NOT_IN_UNIT', 'سرپرست تیم باید از کارکنان فعال همین واحد باشد.');
    if (input.nameFa && input.nameFa !== before.nameFa
      && await prisma.team.count({ where: { organizationId: actor.organizationId, departmentId: before.departmentId, nameFa: input.nameFa } })) {
      throw new AppError(409, 'TEAM_EXISTS', 'تیمی با این نام در این واحد هست.');
    }
    return prisma.$transaction(async (tx) => {
      const after = await tx.team.update({
        where: { id },
        data: {
          ...(input.nameFa ? { nameFa: input.nameFa } : {}), ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.leadId !== undefined ? { leadId: input.leadId ?? null } : {}), ...(input.color !== undefined ? { color: input.color ?? null } : {}),
        },
      });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'team', entityId: id, before, after, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });

  /** A team wound up: its members are left without a team; the team and its history stay. */
  app.post('/teams/:id/archive', settings, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const team = await prisma.team.findFirst({ where: { id, organizationId: actor.organizationId, archivedAt: null } });
    if (!team) throw notFound('تیم');
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({ where: { teamId: id, organizationId: actor.organizationId }, data: { teamId: null } });
      const after = await tx.team.update({ where: { id }, data: { archivedAt: new Date() } });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'team', entityId: id,
        before: { archivedAt: null }, after: { archivedAt: after.archivedAt, membersReleased: count }, reason: 'team wound up',
        ipAddress: actor.ipAddress, requestId: actor.requestId,
      }, tx);
      return { id, archivedAt: after.archivedAt, membersReleased: count };
    });
  });
};

export default unitsRoutes;
