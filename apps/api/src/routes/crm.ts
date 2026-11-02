import type { FastifyPluginAsync } from 'fastify';
import {
  convertLeadSchema, createActivitySchema, createCompanySchema, createContactSchema, createLeadSchema,
  createOpportunitySchema, updateCompanySchema, updateContactSchema, updateLeadSchema,
  updateOpportunitySchema, paginationSchema, createLeadReferrerSchema, updateLeadReferrerSchema,
  DIRECT_CHANNELS, DIRECT_CHANNEL_LABELS, LEAD_SOURCE_KINDS, LEAD_SOURCE_LABELS, SALES_DEPARTMENT, normalizeIranMobile,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { registerCrud } from '../lib/crud.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { AppError, forbidden, notFound, badRequest } from '../lib/errors.js';
import { findDuplicates, referrerName, refuseDuplicate, resolveLeadSource } from '../crm/lead-sources.js';
import { nextCode } from '../lib/codes.js';
import { audit } from '../lib/audit.js';
import { transitionWithin } from '../workflow/engine.js';
import { assertOwnReferences } from '../lib/scope.js';

const crmRoutes: FastifyPluginAsync = async (app) => {
  registerCrud(app, {
    path: 'companies', model: 'company',
    permissions: { read: 'crm.company.read', write: 'crm.company.write' },
    createSchema: createCompanySchema, updateSchema: updateCompanySchema,
    sortable: ['legalName', 'clientCode', 'createdAt', 'healthScore'],
    searchable: ['legalName', 'brandName', 'industry', 'clientCode'],
    listInclude: {
      accountOwner: { select: { id: true, fullName: true } },
      salesOwner: { select: { id: true, fullName: true } },
      _count: { select: { projects: true, opportunities: true, contacts: true } },
    },
    detailInclude: {
      accountOwner: { select: { id: true, fullName: true } },
      salesOwner: { select: { id: true, fullName: true } },
      contacts: { where: { deletedAt: null } },
    },
    softDelete: true, deletePermission: 'crm.company.write',
  });

  registerCrud(app, {
    path: 'contacts', model: 'contact',
    permissions: { read: 'crm.contact.read', write: 'crm.contact.write' },
    createSchema: createContactSchema, updateSchema: updateContactSchema,
    searchable: ['fullName', 'email', 'jobTitle'],
    filter: (req) => {
      const { companyId } = req.query as { companyId?: string };
      return companyId ? { companyId } : {};
    },
    listInclude: { company: { select: { id: true, legalName: true, brandName: true } } },
    softDelete: true, deletePermission: 'crm.contact.write',
  });

  registerCrud(app, {
    path: 'leads', model: 'lead', workflowEntity: 'lead', codeScope: 'lead',
    permissions: { read: 'crm.lead.read', write: 'crm.lead.write' },
    createSchema: createLeadSchema, updateSchema: updateLeadSchema,
    sortable: ['createdAt', 'estimatedValue', 'name'],
    searchable: ['name', 'companyName', 'contactName', 'phone'],
    filter: (req) => {
      const { state, ownerId, source } = req.query as { state?: string; ownerId?: string; source?: string };
      return { ...(state ? { state } : {}), ...(ownerId ? { ownerId } : {}), ...(source ? { source } : {}) };
    },
    listInclude: {
      owner: { select: { id: true, fullName: true } },
      sourceUser: { select: { id: true, fullName: true } },
      sourceReferrer: { select: { id: true, name: true, kind: true } },
    },
    detailInclude: {
      owner: { select: { id: true, fullName: true } },
      sourceUser: { select: { id: true, fullName: true } },
      sourceReferrer: { select: { id: true, name: true, kind: true } },
    },
    // Hivamis task 2: one mobile number is one lead unless someone says otherwise, and the source
    // names who or what exactly.
    toCreate: async (input, actor) => {
      const { confirmDuplicate, sourcePartnerName, ...rest } = input;
      await refuseDuplicate(actor.organizationId, input.phone, confirmDuplicate);
      const source = await resolveLeadSource(prisma, actor.organizationId, actor.id, { ...input, sourcePartnerName });
      return { ...rest, ...source, ownerId: input.ownerId ?? actor.id };
    },
    toUpdate: async (input, before, actor) => {
      const { confirmDuplicate, sourcePartnerName, source, sourceUserId, sourceReferrerId, sourceChannel, ...rest } = input as Record<string, any>;
      if (rest.phone && rest.phone !== before.phone) await refuseDuplicate(actor.organizationId, rest.phone, confirmDuplicate, before.id);
      const touched = [source, sourceUserId, sourceReferrerId, sourceChannel, sourcePartnerName].some((v) => v !== undefined);
      if (!touched) return rest;
      // A new kind brings its own second step; the same kind may change only its detail.
      const resolved = await resolveLeadSource(prisma, actor.organizationId, actor.id, source && source !== before.source
        ? { source, sourceUserId, sourceReferrerId, sourceChannel, sourcePartnerName }
        : {
            source: before.source,
            sourceUserId: sourceUserId !== undefined ? sourceUserId : before.sourceUserId,
            sourceReferrerId: sourceReferrerId !== undefined ? sourceReferrerId : before.sourceReferrerId,
            sourceChannel: sourceChannel !== undefined ? sourceChannel : before.sourceChannel,
            sourcePartnerName,
          });
      return { ...rest, ...resolved };
    },
    softDelete: true,
  });

  /** "Is this number already someone?" — asked while the lead is being typed. */
  app.get('/leads/duplicates', { preHandler: [app.authenticate, app.requirePermissions('crm.lead.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { phone, exclude } = req.query as { phone?: string; exclude?: string };
    const normalized = normalizeIranMobile(phone);
    return { phone: normalized, ...(normalized ? await findDuplicates(actor.organizationId, normalized, exclude) : { leads: [], contacts: [] }) };
  });

  /** Everything the two-step source picker offers, in one request. */
  app.get('/leads/source-options', { preHandler: [app.authenticate, app.requirePermissions('crm.lead.read')] }, async (req) => {
    const actor = actorFrom(req);
    const [people, referrers] = await Promise.all([
      prisma.user.findMany({
        where: { organizationId: actor.organizationId, isActive: true, deletedAt: null },
        select: { id: true, fullName: true, jobTitle: true, department: { select: { code: true, nameFa: true } } },
        orderBy: { fullName: 'asc' },
      }),
      prisma.leadReferrer.findMany({ where: { organizationId: actor.organizationId, isActive: true }, select: { id: true, kind: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    const person = (u: (typeof people)[number]) => ({ id: u.id, fullName: u.fullName, jobTitle: u.jobTitle, department: u.department?.nameFa ?? null });
    return {
      kinds: LEAD_SOURCE_KINDS.map((k) => ({ value: k, ...LEAD_SOURCE_LABELS[k] })),
      channels: DIRECT_CHANNELS.map((c) => ({ value: c, ...DIRECT_CHANNEL_LABELS[c] })),
      salesTeam: people.filter((u) => u.department?.code === SALES_DEPARTMENT).map(person),
      staff: people.filter((u) => u.department?.code !== SALES_DEPARTMENT).map(person),
      marketers: referrers.filter((r) => r.kind === 'MARKETER').map(({ id, name }) => ({ id, name })),
      partners: referrers.filter((r) => r.kind === 'PARTNER').map(({ id, name }) => ({ id, name })),
      canManageMarketers: actor.permissions.includes('admin.settings'),
      canAddPartners: actor.permissions.includes('crm.lead.write'),
    };
  });

  /* ── Marketers and partner companies a lead may name ── */
  app.get('/lead-referrers', { preHandler: [app.authenticate, app.requirePermissions('crm.lead.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { kind, all } = req.query as { kind?: string; all?: string };
    const rows = await prisma.leadReferrer.findMany({
      where: { organizationId: actor.organizationId, ...(kind ? { kind } : {}), ...(all === 'true' ? {} : { isActive: true }) },
      include: { _count: { select: { leads: true } } }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return { items: rows.map(({ _count, ...r }) => ({ ...r, leads: _count.leads })), total: rows.length };
  });

  app.post('/lead-referrers', { preHandler: [app.authenticate] }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createLeadReferrerSchema, req.body);
    // Marketers may be owed a commission, so the admin keeps their list; a partner company is a name.
    const needed = input.kind === 'MARKETER' ? 'admin.settings' : 'crm.lead.write';
    if (!actor.permissions.includes(needed as never)) throw forbidden(`افزودن ${input.kind === 'MARKETER' ? 'بازاریاب' : 'شرکت همکار'} به دسترسی «${needed}» نیاز دارد.`);
    const name = referrerName(input.name);
    const exists = await prisma.leadReferrer.findFirst({ where: { organizationId: actor.organizationId, kind: input.kind, name } });
    if (exists) throw new AppError(409, 'REFERRER_EXISTS', `«${name}» پیش‌تر در فهرست هست${exists.isActive ? '' : ' (کنار گذاشته شده)'}.`, { id: exists.id });
    const row = await prisma.leadReferrer.create({ data: { organizationId: actor.organizationId, kind: input.kind, name, phone: input.phone || null, note: input.note || null, createdById: actor.id } });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'leadReferrer', entityId: row.id, after: row, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return reply.code(201).send(row);
  });

  app.patch('/lead-referrers/:id', { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(updateLeadReferrerSchema, req.body);
    const before = await prisma.leadReferrer.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!before) throw notFound('منبع');
    const name = input.name ? referrerName(input.name) : undefined;
    if (name && name !== before.name && await prisma.leadReferrer.findFirst({ where: { organizationId: actor.organizationId, kind: before.kind, name } })) {
      throw new AppError(409, 'REFERRER_EXISTS', `«${name}» پیش‌تر در فهرست هست.`);
    }
    const row = await prisma.leadReferrer.update({
      where: { id },
      data: { ...(name ? { name } : {}), ...(input.phone !== undefined ? { phone: input.phone || null } : {}), ...(input.note !== undefined ? { note: input.note || null } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) },
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'leadReferrer', entityId: id, before, after: row, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return row;
  });

  registerCrud(app, {
    path: 'opportunities', model: 'opportunity', workflowEntity: 'opportunity', codeScope: 'opportunity',
    permissions: { read: 'crm.opportunity.read', write: 'crm.opportunity.write' },
    createSchema: createOpportunitySchema, updateSchema: updateOpportunitySchema,
    sortable: ['createdAt', 'estimatedValue', 'expectedCloseDate'],
    searchable: ['title', 'description'],
    filter: (req) => {
      const { state, companyId, ownerId } = req.query as Record<string, string | undefined>;
      return {
        ...(state ? { state } : {}), ...(companyId ? { companyId } : {}), ...(ownerId ? { ownerId } : {}),
      };
    },
    listInclude: {
      company: { select: { id: true, legalName: true, brandName: true } },
      owner: { select: { id: true, fullName: true } },
    },
    detailInclude: {
      company: true, owner: { select: { id: true, fullName: true } },
      briefs: { select: { id: true, code: true, title: true, state: true, completenessScore: true } },
    },
    toCreate: (input, actor) => ({ ...input, ownerId: input.ownerId ?? actor.id }),
    softDelete: true,
  });

  /** Convert a qualified lead into an opportunity, carrying the company across. */
  app.post('/leads/:id/convert', {
    preHandler: [app.authenticate, app.requirePermissions('crm.lead.convert')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { companyId, title, estimatedValue } = parse(convertLeadSchema, req.body ?? {});

    const lead = await prisma.lead.findFirst({
      where: { id, organizationId: actor.organizationId },
    });
    if (!lead) throw notFound('سرنخ');
    // The client named must be this organisation's: another's answers as one that does not exist (SEC-12).
    if (companyId) await assertOwnReferences('opportunity', { companyId }, actor.organizationId);

    const result = await prisma.$transaction(async (tx) => {
      let targetCompanyId = companyId;
      if (!targetCompanyId) {
        const company = await tx.company.create({
          data: {
            organizationId: actor.organizationId,
            legalName: lead.companyName,
            phone: lead.phone,
            salesOwnerId: lead.ownerId,
          },
        });
        targetCompanyId = company.id;
      }
      const opportunity = await tx.opportunity.create({
        data: {
          organizationId: actor.organizationId,
          code: await nextCode(tx, 'opportunity'),
          title: title ?? `فرصت — ${lead.companyName}`,
          companyId: targetCompanyId,
          leadId: lead.id,
          estimatedValue: estimatedValue ?? lead.estimatedValue ?? 0,
          description: lead.need,
          ownerId: lead.ownerId ?? actor.id,
        },
      });

      /**
       * The lead's own state moves through the engine rather than an inline UPDATE, so the
       * declared precondition applies: LEAD_WORKFLOW allows `convert` only from QUALIFIED.
       * Previously a NEW or CONTACTED lead could be converted directly, skipping the lifecycle.
       *
       * It joins this transaction rather than calling transition() — the Company and Opportunity
       * above must be created atomically with the conversion, and Prisma has no nested
       * interactive transactions.
       */
      await transitionWithin(tx, {
        entity: 'lead',
        id,
        action: 'convert',
        payload: { companyId: targetCompanyId },
        actor: {
          id: actor.id, organizationId: actor.organizationId, permissions: actor.permissions,
          ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
        },
      });

      return opportunity;
    });

    return reply.code(201).send(result);
  });

  app.get('/activities', {
    preHandler: [app.authenticate, app.requirePermissions('crm.activity.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(paginationSchema, req.query);
    const { companyId, opportunityId, projectId } = req.query as Record<string, string | undefined>;
    const where = {
      organizationId: actor.organizationId,
      ...(companyId ? { companyId } : {}),
      ...(opportunityId ? { opportunityId } : {}),
      ...(projectId ? { projectId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.activity.findMany({
        where, orderBy: { occurredAt: 'desc' },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      prisma.activity.count({ where }),
    ]);
    return page(items, total, q);
  });

  app.post('/activities', {
    preHandler: [app.authenticate, app.requirePermissions('crm.activity.write')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createActivitySchema, req.body);
    // Every record the activity is filed against must be the caller's organisation's (audit SEC-12).
    await assertOwnReferences('activity', input, actor.organizationId);
    const activity = await prisma.activity.create({
      data: { ...input, organizationId: actor.organizationId, createdById: actor.id },
    });
    return reply.code(201).send(activity);
  });

  /** Customer 360 — the unified client view mandated by the master requirements. */
  app.get('/companies/:id/360', {
    preHandler: [app.authenticate, app.requirePermissions('crm.company.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const canSeeFinance = actor.permissions.includes('finance.read');

    const company = await prisma.company.findFirst({ where: { id, organizationId: actor.organizationId },
      include: {
        accountOwner: { select: { id: true, fullName: true } },
        salesOwner: { select: { id: true, fullName: true } },
        contacts: { where: { deletedAt: null } },
      },
    });
    if (!company) throw notFound('مشتری');

    const [opportunities, projects, contracts, invoices, payments, activities, meetings, feedbacks, documents] =
      await Promise.all([
        prisma.opportunity.findMany({
          where: { companyId: id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 50,
        }),
        prisma.project.findMany({
          where: { companyId: id, deletedAt: null },
          include: { _count: { select: { tasks: true, deliverables: true, changeRequests: true } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.contract.findMany({ where: { companyId: id }, orderBy: { createdAt: 'desc' } }),
        canSeeFinance
          ? prisma.invoice.findMany({ where: { companyId: id }, orderBy: { issueDate: 'desc' } })
          : Promise.resolve([]),
        canSeeFinance
          ? prisma.payment.findMany({
              where: { invoice: { companyId: id } }, orderBy: { occurredAt: 'desc' }, take: 50,
            })
          : Promise.resolve([]),
        prisma.activity.findMany({ where: { companyId: id }, orderBy: { occurredAt: 'desc' }, take: 30 }),
        prisma.meeting.findMany({ where: { companyId: id }, orderBy: { heldAt: 'desc' }, take: 20 }),
        prisma.feedback.findMany({
          where: { project: { companyId: id } }, orderBy: { createdAt: 'desc' }, take: 20,
        }),
        prisma.document.findMany({
          where: { companyId: id, deletedAt: null, supersededAt: null }, orderBy: { createdAt: 'desc' }, take: 50,
        }),
      ]);

    const invoiced = invoices.reduce((s, i) => s + Number(i.total), 0);
    const received = invoices.reduce((s, i) => s + Number(i.paidAmount), 0);
    const avgCsat = feedbacks.length
      ? feedbacks.reduce((s, f) => s + f.csat, 0) / feedbacks.length
      : null;

    return {
      company,
      opportunities,
      projects,
      contracts,
      activities,
      meetings,
      feedbacks,
      documents,
      // Financial figures are only present when the caller holds `finance.read`.
      finance: canSeeFinance
        ? { invoices, payments, totals: { invoiced, received, outstanding: invoiced - received } }
        : null,
      metrics: {
        openOpportunities: opportunities.filter((o) => !['WON', 'LOST'].includes(o.state)).length,
        wonOpportunities: opportunities.filter((o) => o.state === 'WON').length,
        activeProjects: projects.filter((p) => ['ACTIVE', 'PLANNING', 'AUTHORIZED'].includes(p.state)).length,
        closedProjects: projects.filter((p) => p.state === 'CLOSED').length,
        avgCsat,
        healthScore: company.healthScore,
      },
    };
  });
};

export default crmRoutes;
