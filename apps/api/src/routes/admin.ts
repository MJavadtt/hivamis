import type { FastifyPluginAsync } from 'fastify';
import {
  createUserSchema, updateUserSchema, paginationSchema, roleGrantSchema,
  ALL_PERMISSIONS, FULL_ACCESS_ROLES, PERMISSIONS, ROLE_PERMISSIONS, type RoleCode,
} from '@hiva/contracts';
import { forgetGrants, grantsOf, setRoleGrant } from '../auth/grants.js';
import { registerRuleSets, resetRulesCache } from '../workflow/rules.js';
import { prisma } from '../db.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { hasPermission } from '../auth/plugin.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { hashPassword } from '../auth/password.js';
import { audit } from '../lib/audit.js';
import { deactivateUser, endSessions } from '../auth/session.js';
import { pauseSla, resumeSla, loadCalendar, resetCalendarCache } from '../sla/engine.js';
import { predictClocks } from '../sla/predict.js';
import { businessHoursBetween } from '../lib/business-calendar.js';
import { SLA_PAUSE_KINDS, unitColor, unitColorSchema, updateOrganizationSchema, updateSlaPolicySchema, type SlaPauseKind } from '@hiva/contracts';

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
    let rolesNow: string[] | undefined;
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data });
      if (input.roleCodes) {
        const roles = await tx.role.findMany({ where: { code: { in: input.roleCodes } } });
        rolesNow = roles.map((r) => r.code).sort();
        rolesChanged = JSON.stringify(rolesNow) !== JSON.stringify(currentRoles);
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });

        /**
         * Permissions are carried in the access token, so a demotion would otherwise leave the
         * old grants usable until it expires. Ending the sessions and dating the tokens (audit
         * SEC-3) takes them away on the next request, as change-password and deactivate do.
         */
        if (rolesChanged) await endSessions(tx, id, 'ROLES_CHANGED');
      }
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
        entityType: 'user', entityId: id, before: { ...before, roles: currentRoles },
        after: { ...updated, ...(rolesNow ? { roles: rolesNow } : {}) },
        reason: rolesChanged ? 'roles changed — sessions revoked' : undefined,
        ipAddress: actor.ipAddress, requestId: actor.requestId,
      }, tx);
      return updated;
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
      select: { id: true, organizationId: true },
    });
    if (!target) throw notFound('کاربر');
    await prisma.$transaction((tx) => deactivateUser(tx, target, actor, 'deactivated'));
    return { id, isActive: false };
  });

  /* ── Reference data ──────────────────────────────────────────────────── */
  app.get('/departments', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const units = await prisma.department.findMany({
      where: { organizationId: actor.organizationId },
      include: { _count: { select: { users: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    // `color` is what every screen shows the unit in; `tagColor` is the administrator's choice, if any.
    return units.map((u) => ({ ...u, color: unitColor(u.code, u.tagColor) }));
  });

  /**
   * A unit's tag colour (Hivamis task 9): the colour its tag has on every screen. The system
   * administrator chooses it; null returns the unit to its default. Recorded in the audit trail.
   */
  app.patch('/departments/:code/color', { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] }, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const { color } = parse(unitColorSchema, req.body ?? {});
    const dept = await prisma.department.findFirst({ where: { code, organizationId: actor.organizationId } });
    if (!dept) throw notFound('واحد');
    const updated = await prisma.department.update({ where: { id: dept.id }, data: { tagColor: color } });
    if (dept.tagColor !== updated.tagColor) {
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'department', entityId: dept.id,
        before: { tagColor: dept.tagColor }, after: { tagColor: updated.tagColor }, reason: 'tag colour', ipAddress: actor.ipAddress,
      });
    }
    return { code: updated.code, tagColor: updated.tagColor, color: unitColor(updated.code, updated.tagColor) };
  });

  /* ── Calendars per unit and per person (roadmap #13) ────────────────── */

  const DAYS = [0, 1, 2, 3, 4, 5, 6];
  /** null clears an override (inherit); an array or number sets one. Validated, then audited. */
  function calendarPatch(body: Record<string, unknown>, keys: string[]) {
    const data: Record<string, unknown> = {};
    for (const k of keys) {
      if (!(k in body)) continue;
      const v = body[k];
      if (k === 'workingDays') {
        if (v === null) { data[k] = []; continue; }
        if (!Array.isArray(v) || !v.every((d) => DAYS.includes(Number(d))) || v.length === 0) {
          throw badRequest('INVALID_WORKING_DAYS', 'روزهای کاری باید فهرستی از ۰ (یکشنبه) تا ۶ (شنبه) باشد');
        }
        data[k] = [...new Set(v.map(Number))];
        continue;
      }
      if (v === null) { data[k] = null; continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 24) throw badRequest('INVALID_HOUR', `«${k}» باید عددی بین ۰ و ۲۴ باشد`);
      data[k] = n;
    }
    const start = data.workStartHour as number | null | undefined;
    const end = data.workEndHour as number | null | undefined;
    if (start != null && end != null && end <= start) throw badRequest('INVALID_HOURS', 'ساعت پایان باید بعد از شروع باشد');
    return data;
  }

  app.patch('/departments/:code/calendar', {
    preHandler: [app.authenticate, app.requirePermissions('admin.settings')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const before = await prisma.department.findFirst({ where: { code, organizationId: actor.organizationId } });
    if (!before) throw notFound('واحد');
    const data = calendarPatch((req.body ?? {}) as Record<string, unknown>, ['workingDays', 'workStartHour', 'workEndHour', 'breakHours']);
    const updated = await prisma.department.update({ where: { id: before.id }, data });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'department', entityId: before.id,
      before: { workingDays: before.workingDays, workStartHour: before.workStartHour, workEndHour: before.workEndHour, breakHours: before.breakHours },
      after: { workingDays: updated.workingDays, workStartHour: updated.workStartHour, workEndHour: updated.workEndHour, breakHours: updated.breakHours },
      reason: 'calendar', ipAddress: actor.ipAddress,
    });
    resetCalendarCache();
    return updated;
  });

  /** Internal hourly cost, on a unit (the default) or a person (their own). pricing.read is not enough to set it. */
  app.patch('/departments/:code/rate', { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] }, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const { hourlyCost } = (req.body ?? {}) as { hourlyCost?: number | null };
    const dept = await prisma.department.findFirst({ where: { code, organizationId: actor.organizationId } });
    if (!dept) throw notFound('واحد');
    if (hourlyCost != null && (!Number.isFinite(Number(hourlyCost)) || Number(hourlyCost) < 0)) throw badRequest('INVALID_RATE', 'نرخ ساعتی معتبر نیست');
    const updated = await prisma.department.update({ where: { id: dept.id }, data: { hourlyCost: hourlyCost == null ? null : Number(hourlyCost) } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'department', entityId: dept.id, before: { hourlyCost: dept.hourlyCost }, after: { hourlyCost: updated.hourlyCost }, reason: 'hourly cost', ipAddress: actor.ipAddress });
    return { code: updated.code, hourlyCost: updated.hourlyCost };
  });

  app.patch('/users/:id/rate', { preHandler: [app.authenticate, app.requirePermissions('admin.users')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { hourlyCost } = (req.body ?? {}) as { hourlyCost?: number | null };
    const user = await prisma.user.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!user) throw notFound('کاربر');
    if (hourlyCost != null && (!Number.isFinite(Number(hourlyCost)) || Number(hourlyCost) < 0)) throw badRequest('INVALID_RATE', 'نرخ ساعتی معتبر نیست');
    const updated = await prisma.user.update({ where: { id }, data: { hourlyCost: hourlyCost == null ? null : Number(hourlyCost) }, select: { id: true, hourlyCost: true } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: id, before: { hourlyCost: user.hourlyCost }, after: { hourlyCost: updated.hourlyCost }, reason: 'hourly cost', ipAddress: actor.ipAddress });
    return updated;
  });

  app.patch('/users/:id/calendar', {
    preHandler: [app.authenticate, app.requirePermissions('admin.users')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const before = await prisma.user.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!before) throw notFound('کاربر');
    const data = calendarPatch((req.body ?? {}) as Record<string, unknown>, ['workingDays', 'workStartHour', 'workEndHour']);
    const updated = await prisma.user.update({ where: { id }, data, select: { id: true, workingDays: true, workStartHour: true, workEndHour: true } });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: id,
      before: { workingDays: before.workingDays, workStartHour: before.workStartHour, workEndHour: before.workEndHour },
      after: { workingDays: updated.workingDays, workStartHour: updated.workStartHour, workEndHour: updated.workEndHour },
      reason: 'calendar', ipAddress: actor.ipAddress,
    });
    resetCalendarCache();
    return updated;
  });

  /** A person may see their own leave; managing it takes admin.users. */
  app.get('/users/:id/leaves', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    if (id !== actor.id && !hasPermission(req, 'admin.users')) throw forbidden();
    return prisma.userLeave.findMany({ where: { userId: id, user: { organizationId: actor.organizationId } }, orderBy: { from: 'desc' } });
  });

  app.post('/users/:id/leaves', {
    preHandler: [app.authenticate, app.requirePermissions('admin.users')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const user = await prisma.user.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!user) throw notFound('کاربر');
    const { from, to, kind, note } = (req.body ?? {}) as { from?: string; to?: string; kind?: string; note?: string };
    const a = from ? new Date(from) : null; const b = to ? new Date(to) : a;
    if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) throw badRequest('INVALID_RANGE', 'بازهٔ مرخصی معتبر نیست');
    if (b < a) throw badRequest('INVALID_RANGE', 'پایان مرخصی پیش از شروع آن است');
    if ((b.getTime() - a.getTime()) / 86_400_000 > 366) throw badRequest('INVALID_RANGE', 'مرخصی نمی‌تواند بیش از یک سال باشد');
    const leave = await prisma.userLeave.create({
      data: { userId: id, from: a, to: b, kind: kind ?? 'VACATION', note: note ?? null, createdById: actor.id },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'userLeave', entityId: leave.id,
      after: { userId: id, from: leave.from, to: leave.to, kind: leave.kind }, ipAddress: actor.ipAddress,
    });
    resetCalendarCache();
    return reply.code(201).send(leave);
  });

  app.delete('/users/:id/leaves/:leaveId', {
    preHandler: [app.authenticate, app.requirePermissions('admin.users')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id, leaveId } = req.params as { id: string; leaveId: string };
    const leave = await prisma.userLeave.findFirst({ where: { id: leaveId, userId: id, user: { organizationId: actor.organizationId } } });
    if (!leave) throw notFound('مرخصی');
    await prisma.userLeave.delete({ where: { id: leaveId } });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: 'userLeave', entityId: leaveId,
      before: { userId: id, from: leave.from, to: leave.to, kind: leave.kind }, ipAddress: actor.ipAddress,
    });
    resetCalendarCache();
    return { ok: true };
  });

  /** The calendar actually in force for a person or a unit, after inheritance. */
  app.get('/calendar/effective', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { userId, departmentCode } = req.query as Record<string, string | undefined>;
    const cal = await loadCalendar(actor.organizationId, { userId: userId ?? null, departmentCode: departmentCode ?? null });
    return { ...cal, holidays: [...cal.holidays].sort() };
  });

  /**
   * The roles as this organisation has them (Hivamis task 6): the four full-access roles holding
   * everything, the rest holding what the system administrator granted — or their default, marked
   * as not yet reviewed — with who granted it, when, and how many people hold the role here.
   */
  app.get('/roles', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const [roles, holders, grants] = await Promise.all([
      prisma.role.findMany({ orderBy: { code: 'asc' } }),
      prisma.userRole.groupBy({ by: ['roleId'], where: { user: { organizationId: actor.organizationId, deletedAt: null } }, _count: { _all: true } }),
      grantsOf(actor.organizationId),
    ]);
    const granters = await prisma.user.findMany({ where: { id: { in: [...grants.current.values()].map((g) => g.grantedById) } }, select: { id: true, fullName: true } });
    return roles.map((r) => {
      const code = r.code as RoleCode;
      const grant = grants.current.get(code);
      const permissions = [...(grants.map[code] ?? [])];
      const defaults = ROLE_PERMISSIONS[code] ?? [];
      return {
        id: r.id, code, nameFa: r.nameFa, nameEn: r.nameEn,
        userCount: holders.find((h) => h.roleId === r.id)?._count._all ?? 0,
        fullAccess: FULL_ACCESS_ROLES.includes(code),
        permissions, defaults,
        review: grant ? { at: grant.createdAt, note: grant.note, grantedBy: granters.find((g) => g.id === grant.grantedById) ?? null } : null,
        differsFromDefault: permissions.length !== defaults.length || permissions.some((p) => !defaults.includes(p)),
      };
    });
  });

  /** Grant a role exactly these permissions here. A new version of the permissions rule set; takes effect at once. */
  app.put('/roles/:code/permissions', { preHandler: [app.authenticate, app.requirePermissions('admin.roles')] }, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const input = parse(roleGrantSchema, req.body);
    const role = await prisma.role.findUnique({ where: { code } });
    if (!role) throw notFound('نقش');
    try {
      const result = await prisma.$transaction(async (tx) => {
        const r = await setRoleGrant(tx, { organizationId: actor.organizationId, roleCode: code, permissions: input.permissions, note: input.note, actorId: actor.id });
        // The rules a transition is judged by changed: a new version of the permissions set (roadmap #4).
        await registerRuleSets(tx, undefined, `دسترسی نقش «${role.nameFa}»: ${r.added.length} داده، ${r.removed.length} گرفته${input.note ? ` — ${input.note}` : ''}`);
        await audit({
          organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'role', entityId: code,
          before: { removed: r.removed }, after: { added: r.added, permissions: r.row.permissions }, reason: input.note ?? null,
          ipAddress: actor.ipAddress, requestId: actor.requestId,
        }, tx);
        return r;
      });
      return { code, added: result.added, removed: result.removed, permissions: result.row.permissions };
    } catch (e) {
      // A version registered inside a transaction that then rolled back must not stay cached.
      resetRulesCache();
      throw e;
    } finally {
      forgetGrants(actor.organizationId);
    }
  });

  /** Who granted a role what, and when — newest first. */
  app.get('/roles/:code/grants', { preHandler: [app.authenticate, app.requirePermissions('admin.roles')] }, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const rows = await prisma.roleGrant.findMany({ where: { organizationId: actor.organizationId, roleCode: code }, orderBy: { createdAt: 'desc' }, take: 50 });
    const people = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.grantedById) } }, select: { id: true, fullName: true } });
    return rows.map((r) => ({ ...r, grantedBy: people.find((p) => p.id === r.grantedById) ?? null }));
  });

  app.get('/permissions', { preHandler: [app.authenticate] }, async (req) => {
    const { map } = await grantsOf(actorFrom(req).organizationId);
    return ALL_PERMISSIONS.map((code) => ({
      code, nameFa: PERMISSIONS[code],
      grantedTo: (Object.keys(map) as RoleCode[]).filter((r) => map[r].includes(code)),
    }));
  });

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
    const { hours, warnAt, isActive } = parse(updateSlaPolicySchema, req.body ?? {});
    const before = await prisma.slaPolicy.findFirst({ where: { code, organizationId: actor.organizationId } });
    if (!before) throw notFound('سیاست SLA');
    const updated = await prisma.slaPolicy.update({
      where: { id: before.id },
      data: {
        ...(hours != null ? { hours } : {}),
        ...(warnAt != null ? { warnAt } : {}),
        ...(isActive != null ? { isActive } : {}),
        // Hours set here are the organisation's; an upgrade no longer moves them (roadmap #50).
        ...(hours != null || warnAt != null ? { customizedAt: new Date() } : {}),
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
    const data = parse(updateOrganizationSchema, req.body ?? {});
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
    const start = data.workStartHour ?? before.workStartHour, end = data.workEndHour ?? before.workEndHour;
    if (start >= end) throw badRequest('INVALID_HOURS', 'ساعت پایان کار باید پس از شروع باشد');
    const updated = await prisma.organization.update({ where: { id: actor.organizationId }, data });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'organization', entityId: actor.organizationId,
      before: { name: before.name, workingDays: before.workingDays, workStartHour: before.workStartHour, workEndHour: before.workEndHour, breakHours: before.breakHours },
      after: data, ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    // The SLA engine caches the calendar; invalidate it so new hours take effect immediately.
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

  /**
   * Which open deadlines are going to be missed (roadmap #8) — before the fixed threshold
   * fires, and with the evidence attached. `mine=true` narrows it to the caller's own clocks;
   * `minProbability` (0–1) to the ones worth acting on.
   */
  app.get('/sla-clocks/predictions', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { mine, minProbability, limit } = req.query as Record<string, string | undefined>;
    const predictions = await predictClocks(prisma, actor.organizationId);
    const floor = minProbability ? Number(minProbability) : 0;
    const rows = predictions
      .filter((p) => p.probability >= floor && (mine === 'true' ? p.ownerId === actor.id : true))
      .slice(0, Math.min(Number(limit ?? 50) || 50, 200));
    return {
      generatedAt: new Date(),
      model: 'نسبت نقض در مهلت‌های مشابهِ همان سیاست و واحد که تا همین مرحله باز مانده بودند، تعدیل‌شده با بار کاری فعلی مسئول',
      counts: {
        total: rows.length,
        critical: rows.filter((p) => p.risk === 'CRITICAL').length,
        likely: rows.filter((p) => p.risk === 'LIKELY').length,
        // Predicted to fail while the fixed warnAt threshold is still silent — the whole point.
        earlierThanThreshold: rows.filter((p) => p.beatsWarnAt).length,
      },
      predictions: rows,
    };
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
