import type { FastifyPluginAsync } from 'fastify';
import {
  createUserSchema, updateUserSchema, paginationSchema,
  ALL_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, type RoleCode,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { hasPermission } from '../auth/plugin.js';
import { badRequest, notFound } from '../lib/errors.js';
import { hashPassword } from '../auth/password.js';
import { audit } from '../lib/audit.js';

const adminRoutes: FastifyPluginAsync = async (app) => {
  /* ── Users (read is broad; write is admin-only) ──────────────────────── */
  app.get('/users', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(paginationSchema, req.query);
    const { unit, roleCode } = req.query as Record<string, string | undefined>;
    const where = {
      organizationId: actor.organizationId, deletedAt: null,
      ...(unit ? { department: { code: unit } } : {}),
      ...(roleCode ? { roles: { some: { role: { code: roleCode } } } } : {}),
      ...(q.q ? { OR: [{ fullName: { contains: q.q, mode: 'insensitive' as const } }, { email: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
    };
    /**
     * Two shapes from one route. Assignee and owner pickers across the app need a staff
     * directory, so the basic shape stays open to any authenticated user — name, job title,
     * work email and unit are ordinary internal information.
     *
     * Everything that describes a person's standing rather than identifying them —
     * account status, last sign-in, contracted hours, granted roles — requires `admin.users`.
     * The write routes already do.
     */
    const full = hasPermission(req, 'admin.users');
    const select = {
      id: true, email: true, fullName: true, jobTitle: true,
      department: { select: { code: true, nameFa: true } },
      ...(full
        ? {
            isActive: true,
            weeklyCapacityHours: true,
            lastLoginAt: true,
            roles: { select: { role: { select: { code: true, nameFa: true } } } },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select,
        orderBy: { fullName: 'asc' },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      prisma.user.count({ where }),
    ]);
    return page(items, total, q);
  });

  app.post('/users', {
    preHandler: [app.authenticate, app.requirePermissions('admin.users')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createUserSchema, req.body);
    const department = await prisma.department.findUnique({
      where: { organizationId_code: { organizationId: actor.organizationId, code: input.departmentCode } },
    });
    if (!department) throw badRequest('UNKNOWN_DEPARTMENT', 'واحد سازمانی نامعتبر است.');

    const roles = await prisma.role.findMany({ where: { code: { in: input.roleCodes } } });
    if (roles.length !== input.roleCodes.length) throw badRequest('UNKNOWN_ROLE', 'نقش نامعتبر است.');

    const user = await prisma.user.create({
      data: {
        organizationId: actor.organizationId,
        departmentId: department.id,
        email: input.email.toLowerCase(),
        fullName: input.fullName,
        jobTitle: input.jobTitle ?? null,
        phone: input.phone ?? null,
        weeklyCapacityHours: input.weeklyCapacityHours,
        passwordHash: await hashPassword(input.password),
        // A newly provisioned account must rotate its password on first sign-in.
        mustChangePassword: true,
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
      select: { id: true, email: true, fullName: true },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE',
      entityType: 'user', entityId: user.id, after: user,
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(user);
  });

  app.patch('/users/:id', {
    preHandler: [app.authenticate, app.requirePermissions('admin.users')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(updateUserSchema, req.body);
    const before = await prisma.user.findUnique({ where: { id } });
    if (!before) throw notFound('کاربر');

    const data: Record<string, unknown> = {};
    if (input.fullName) data.fullName = input.fullName;
    if (input.jobTitle !== undefined) data.jobTitle = input.jobTitle;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.weeklyCapacityHours !== undefined) data.weeklyCapacityHours = input.weeklyCapacityHours;
    if (input.departmentCode) {
      const dep = await prisma.department.findUnique({
        where: { organizationId_code: { organizationId: actor.organizationId, code: input.departmentCode } },
      });
      if (!dep) throw badRequest('UNKNOWN_DEPARTMENT', 'واحد سازمانی نامعتبر است.');
      data.departmentId = dep.id;
    }

    const currentRoles = (
      await prisma.userRole.findMany({ where: { userId: id }, include: { role: true } })
    ).map((r) => r.role.code).sort();

    let rolesChanged = false;
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data });
      if (input.roleCodes) {
        const roles = await tx.role.findMany({ where: { code: { in: input.roleCodes } } });
        rolesChanged =
          JSON.stringify(roles.map((r) => r.code).sort()) !== JSON.stringify(currentRoles);
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });

        /**
         * Permissions are carried in the access token, so a demotion would otherwise leave the
         * old grants usable until it expires. Fifteen minutes is too long a window for a
         * privilege that has just been taken away; revoking here forces an immediate re-auth.
         * Follows the precedent already set by change-password and deactivate.
         */
        if (rolesChanged) {
          await tx.session.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
      }
      return updated;
    });

    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
      entityType: 'user', entityId: id, before, after: user,
      reason: rolesChanged ? 'roles changed — sessions revoked' : undefined,
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return { id: user.id, email: user.email, fullName: user.fullName };
  });

  app.post('/users/:id/deactivate', {
    preHandler: [app.authenticate, app.requirePermissions('admin.users')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    if (id === actor.id) throw badRequest('SELF_DEACTIVATE', 'غیرفعال‌سازی حساب خودتان مجاز نیست.');
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id }, data: { isActive: false } });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      return u;
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
      entityType: 'user', entityId: id, after: { isActive: false }, reason: 'deactivated',
    });
    return { id: user.id, isActive: user.isActive };
  });

  /* ── Reference data ──────────────────────────────────────────────────── */
  app.get('/departments', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    return prisma.department.findMany({
      where: { organizationId: actor.organizationId },
      include: { _count: { select: { users: true } } },
      orderBy: { sortOrder: 'asc' },
    });
  });

  app.get('/roles', { preHandler: [app.authenticate] }, async () => {
    const roles = await prisma.role.findMany({
      include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
      orderBy: { code: 'asc' },
    });
    return roles.map((r) => ({
      id: r.id, code: r.code, nameFa: r.nameFa, nameEn: r.nameEn,
      userCount: r._count.users,
      permissions: r.permissions.map((p) => p.permission.code),
    }));
  });

  app.get('/permissions', { preHandler: [app.authenticate] }, async () =>
    ALL_PERMISSIONS.map((code) => ({
      code, nameFa: PERMISSIONS[code],
      grantedTo: (Object.keys(ROLE_PERMISSIONS) as RoleCode[]).filter((r) =>
        ROLE_PERMISSIONS[r].includes(code)),
    })));

  app.get('/sla-policies', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    return prisma.slaPolicy.findMany({
      where: { organizationId: actor.organizationId }, orderBy: { code: 'asc' },
    });
  });

  app.patch('/sla-policies/:code', {
    preHandler: [app.authenticate, app.requirePermissions('admin.settings')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const { hours, warnAt, isActive } = (req.body ?? {}) as Record<string, unknown>;
    const before = await prisma.slaPolicy.findUnique({ where: { code } });
    if (!before) throw notFound('سیاست SLA');
    const updated = await prisma.slaPolicy.update({
      where: { code },
      data: {
        ...(hours != null ? { hours: Number(hours) } : {}),
        ...(warnAt != null ? { warnAt: Number(warnAt) } : {}),
        ...(isActive != null ? { isActive: Boolean(isActive) } : {}),
      },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
      entityType: 'slaPolicy', entityId: updated.id, before, after: updated,
    });
    return updated;
  });

  app.get('/organization', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    return prisma.organization.findUnique({
      where: { id: actor.organizationId }, include: { holidays: { orderBy: { date: 'asc' } } },
    });
  });

  app.patch('/organization', {
    preHandler: [app.authenticate, app.requirePermissions('admin.settings')],
  }, async (req) => {
    const actor = actorFrom(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'legalName', 'currency', 'timezone'] as const) {
      if (typeof body[k] === 'string') data[k] = body[k];
    }
    for (const k of ['workStartHour', 'workEndHour', 'breakHours'] as const) {
      if (body[k] != null) data[k] = Number(body[k]);
    }
    if (Array.isArray(body.workingDays)) data.workingDays = body.workingDays.map(Number);
    const updated = await prisma.organization.update({ where: { id: actor.organizationId }, data });
    // The SLA engine caches the calendar; invalidate it so new hours take effect immediately.
    const { resetCalendarCache } = await import('../sla/engine.js');
    resetCalendarCache();
    return updated;
  });

  /* ── Audit trail ─────────────────────────────────────────────────────── */
  app.get('/audit-events', {
    preHandler: [app.authenticate, app.requirePermissions('admin.audit')],
  }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(paginationSchema, req.query);
    const { entityType, entityId, action, actorId, from, to } = req.query as Record<string, string | undefined>;
    const where = {
      organizationId: actor.organizationId,
      ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}),
      ...(action ? { action } : {}), ...(actorId ? { actorId } : {}),
      ...(from || to ? {
        createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) },
      } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where, include: { actor: { select: { id: true, fullName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      prisma.auditEvent.count({ where }),
    ]);
    return page(items, total, q);
  });

  /* ── Notifications ───────────────────────────────────────────────────── */
  app.get('/notifications', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { unreadOnly } = req.query as { unreadOnly?: string };
    const items = await prisma.notification.findMany({
      where: { userId: actor.id, ...(unreadOnly === 'true' ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    const unread = await prisma.notification.count({ where: { userId: actor.id, readAt: null } });
    return { items, unread };
  });

  app.post('/notifications/:id/read', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    await prisma.notification.updateMany({
      where: { id, userId: actor.id }, data: { readAt: new Date() },
    });
    return { ok: true };
  });

  app.post('/notifications/read-all', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const result = await prisma.notification.updateMany({
      where: { userId: actor.id, readAt: null }, data: { readAt: new Date() },
    });
    return { updated: result.count };
  });

  /* ── SLA clocks ──────────────────────────────────────────────────────── */
  app.get('/sla-clocks', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { state, entityType, mine } = req.query as Record<string, string | undefined>;
    return prisma.slaClock.findMany({
      where: {
        organizationId: actor.organizationId,
        ...(state ? { state } : { state: { in: ['RUNNING', 'AT_RISK', 'BREACHED'] } }),
        ...(entityType ? { entityType } : {}),
        ...(mine === 'true' ? { ownerId: actor.id } : {}),
      },
      include: { policy: true }, orderBy: { dueAt: 'asc' }, take: 200,
    });
  });
};

export default adminRoutes;
