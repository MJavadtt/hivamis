import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DEPARTMENT_LABELS, createUnitSchema, customUnitCode, isProcessUnit, teamSchema, teamUpdateSchema, unitUpdateSchema, type DepartmentCode } from '@hiva/contracts';
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

  const assertFreeShortCode = async (organizationId: string, shortCode: string) => {
    const taken = await prisma.department.findFirst({ where: { organizationId, shortCode }, select: { nameFa: true } });
    if (taken) throw new AppError(409, 'UNIT_CODE_TAKEN', `حرف اختصاری «${shortCode}» از آنِ واحد «${taken.nameFa}» است.`, { field: 'shortCode' });
  };

  /**
   * A unit the organisation adds (the owner, 2026-11-16; ADR-133): «امکان اضافه کردن و یا پاک کردن
   * واحدها وجود ندارد». People belong to it, it has a manager and teams, and its two letters begin
   * its documents' codes. The ten process units stay the stations the process routes work to.
   */
  app.post('/departments', settings, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createUnitSchema, req.body);
    await assertFreeShortCode(actor.organizationId, input.shortCode);
    const last = await prisma.department.aggregate({ where: { organizationId: actor.organizationId }, _max: { sortOrder: true } });
    const made = await prisma.$transaction(async (tx) => {
      const unit = await tx.department.create({
        data: {
          organizationId: actor.organizationId, code: customUnitCode(input.shortCode), shortCode: input.shortCode,
          nameFa: input.nameFa, nameEn: input.nameEn || input.nameFa, namesOwned: true, sortOrder: (last._max.sortOrder ?? 0) + 1,
        },
      });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'department', entityId: unit.id, after: { code: unit.code, shortCode: unit.shortCode, nameFa: unit.nameFa }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return unit;
    });
    return reply.code(201).send(made);
  });

  /** A unit of the organisation's own, once nobody is in it. A process unit stays: work is routed to it. */
  app.delete('/departments/:code', settings, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const unit = await prisma.department.findFirst({ where: { code, organizationId: actor.organizationId } });
    if (!unit) throw notFound('واحد');
    if (isProcessUnit(unit.code)) throw new AppError(409, 'PROCESS_UNIT', 'این واحد یکی از ایستگاه‌های فرآیند است و کار به آن می‌رسد؛ حذف نمی‌شود. نام، حرف اختصاری و مدیرش را می‌توانید عوض کنید.');
    const people = await prisma.user.count({ where: { departmentId: unit.id, organizationId: actor.organizationId, deletedAt: null } });
    if (people) throw new AppError(409, 'UNIT_HAS_PEOPLE', `${people} نفر در این واحدند؛ نخست آن‌ها را به واحد دیگری ببرید.`, { people });
    await prisma.$transaction(async (tx) => {
      await tx.user.updateMany({ where: { departmentId: unit.id }, data: { departmentId: null, teamId: null } });
      await tx.department.delete({ where: { id: unit.id } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: 'department', entityId: unit.id, before: { code: unit.code, shortCode: unit.shortCode, nameFa: unit.nameFa }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
    });
    return { deleted: unit.code };
  });

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
    if (input.shortCode && input.shortCode !== before.shortCode) {
      await assertFreeShortCode(actor.organizationId, input.shortCode);
      data.shortCode = input.shortCode;
    }
    if (input.managerId !== undefined) {
      if (input.managerId) await memberOf(actor.organizationId, before.id, input.managerId, 'MANAGER_NOT_IN_UNIT', 'مدیر واحد باید از کارکنان فعال همین واحد باشد.');
      data.managerId = input.managerId ?? null;
    }
    return prisma.$transaction(async (tx) => {
      const after = await tx.department.update({ where: { id: before.id }, data });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'department', entityId: before.id,
        before: { nameFa: before.nameFa, nameEn: before.nameEn, managerId: before.managerId, shortCode: before.shortCode },
        after: { nameFa: after.nameFa, nameEn: after.nameEn, managerId: after.managerId, namesOwned: after.namesOwned, shortCode: after.shortCode },
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

  /** A team deleted outright (ADR-133) — made by mistake, or no longer wanted: its members are left without a team. */
  app.delete('/teams/:id', settings, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const team = await prisma.team.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!team) throw notFound('تیم');
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({ where: { teamId: id, organizationId: actor.organizationId }, data: { teamId: null } });
      await tx.team.delete({ where: { id } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: 'team', entityId: id, before: { nameFa: team.nameFa, departmentId: team.departmentId, membersReleased: count }, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return { id, membersReleased: count };
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
