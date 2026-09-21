import type { FastifyPluginAsync } from 'fastify';
import {
  createUserSchema, updateUserSchema, paginationSchema,
  ALL_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, type RoleCode,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { hasPermission } from '../auth/plugin.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { hashPassword } from '../auth/password.js';
import { audit } from '../lib/audit.js';
import { pauseSla, resumeSla, loadCalendar } from '../sla/engine.js';
import { businessHoursBetween } from '../lib/business-calendar.js';
import { SLA_PAUSE_KINDS, type SlaPauseKind } from '@hiva/contracts';

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
    const before = await prisma.user.findFirst({
      where: { id, organizationId: actor.organizationId },
    });
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
    const target = await prisma.user.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { id: true },
    });
    if (!target) throw notFound('کاربر');
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
    const { state, entityType, entityId, mine } = req.query as Record<string, string | undefined>;
    const clocks = await prisma.slaClock.findMany({
      where: {
        organizationId: actor.organizationId,
        // Default is the open ones; a record page wants its full history, hence ALL.
        ...(state === 'ALL' ? {} : state ? { state } : { state: { in: ['RUNNING', 'AT_RISK', 'PAUSED', 'BREACHED'] } }),
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
        ...(mine === 'true' ? { ownerId: actor.id } : {}),
      },
      include: { policy: true, pauses: { orderBy: { pausedAt: 'asc' } } },
      orderBy: { dueAt: 'asc' }, take: 200,
    });
    // Two numbers, not one: how long the clock has been open, and how much of that was ours.
    // Only the second is a fair basis for judging anyone.
    const cal = await loadCalendar(actor.organizationId);
    const now = new Date();
    return clocks.map((c) => {
      const end = c.stoppedAt ?? now;
      const elapsedHours = businessHoursBetween(c.startedAt, end, cal);
      const openPause = c.state === 'PAUSED' && c.pausedAt ? businessHoursBetween(c.pausedAt, end, cal) : 0;
      const pausedHours = Number(c.pausedHours) + openPause;
      return {
        ...c,
        elapsedHours: Math.round(elapsedHours * 100) / 100,
        pausedHours: Math.round(pausedHours * 100) / 100,
        controlledHours: Math.round((elapsedHours - pausedHours) * 100) / 100,
        budgetHours: Number(c.policy.hours),
      };
    });
  });

  /* ── SLA pause / resume ─────────────────────────────────────────────── */

  /** The clock's owner, or whoever manages traffic. Nobody else gets to stop a deadline. */
  async function pausableClock(req: Parameters<typeof actorFrom>[0], id: string) {
    const actor = actorFrom(req);
    const clock = await prisma.slaClock.findFirst({
      where: { id, organizationId: actor.organizationId }, include: { policy: true },
    });
    if (!clock) throw notFound('ساعت SLA');
    if (clock.ownerId !== actor.id && !hasPermission(req, 'traffic.manage')) {
      throw forbidden('فقط مسئول این مهلت یا مدیر ترافیک می‌تواند آن را متوقف یا از سر بگیرد');
    }
    return { actor, clock };
  }

  app.post('/sla-clocks/:id/pause', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const { kind, reason } = (req.body ?? {}) as { kind?: string; reason?: string };
    if (!kind || !(SLA_PAUSE_KINDS as readonly string[]).includes(kind) || kind === 'TRANSITION') {
      throw badRequest('INVALID_PAUSE_KIND', 'نوع توقف باید یکی از موارد مجاز باشد', { allowed: SLA_PAUSE_KINDS.filter((k) => k !== 'TRANSITION') });
    }
    if (!reason?.trim()) throw badRequest('REASON_REQUIRED', 'دلیل توقف الزامی است');

    const { actor, clock } = await pausableClock(req, id);
    if (!['RUNNING', 'AT_RISK'].includes(clock.state)) {
      throw badRequest('CLOCK_NOT_RUNNING', 'فقط مهلت در جریان را می‌توان متوقف کرد', { state: clock.state });
    }
    await prisma.$transaction(async (tx) => {
      await pauseSla(tx, {
        entityType: clock.entityType, entityId: clock.entityId, policyCodes: [clock.policy.code],
        kind: kind as SlaPauseKind, reason: reason.trim(), actorId: actor.id,
      });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'SLA_PAUSE',
        entityType: clock.entityType, entityId: clock.entityId,
        after: { policy: clock.policy.code, kind, reason: reason.trim() }, ipAddress: actor.ipAddress,
      }, tx);
    });
    return prisma.slaClock.findUnique({ where: { id }, include: { policy: true, pauses: true } });
  });

  app.post('/sla-clocks/:id/resume', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string };
    const { actor, clock } = await pausableClock(req, id);
    if (clock.state !== 'PAUSED') {
      throw badRequest('CLOCK_NOT_PAUSED', 'این مهلت متوقف نیست', { state: clock.state });
    }
    await prisma.$transaction(async (tx) => {
      await resumeSla(tx, clock.entityType, clock.entityId, actor.id, [clock.policy.code]);
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'SLA_RESUME',
        entityType: clock.entityType, entityId: clock.entityId,
        after: { policy: clock.policy.code }, ipAddress: actor.ipAddress,
      }, tx);
    });
    return prisma.slaClock.findUnique({ where: { id }, include: { policy: true, pauses: true } });
  });
};

export default adminRoutes;
