import type { FastifyPluginAsync } from 'fastify';
import {
  createActivitySchema, createCompanySchema, createContactSchema, createLeadSchema,
  createOpportunitySchema, updateCompanySchema, updateContactSchema, updateLeadSchema,
  updateOpportunitySchema, paginationSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { registerCrud } from '../lib/crud.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { notFound, badRequest } from '../lib/errors.js';
import { nextCode } from '../lib/codes.js';
import { audit } from '../lib/audit.js';
import { transitionWithin } from '../workflow/engine.js';

const crmRoutes: FastifyPluginAsync = async (app) => {
  registerCrud(app, {
    path: 'companies', model: 'company',
    permissions: { read: 'crm.company.read', write: 'crm.company.write' },
    createSchema: createCompanySchema, updateSchema: updateCompanySchema,
    sortable: ['legalName', 'createdAt', 'healthScore'],
    searchable: ['legalName', 'brandName', 'industry'],
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
    searchable: ['name', 'companyName', 'contactName'],
    filter: (req) => {
      const { state, ownerId } = req.query as { state?: string; ownerId?: string };
      return { ...(state ? { state } : {}), ...(ownerId ? { ownerId } : {}) };
    },
    listInclude: { owner: { select: { id: true, fullName: true } } },
    toCreate: (input, actor) => ({ ...input, ownerId: input.ownerId ?? actor.id }),
    softDelete: true,
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
    const { companyId, title, estimatedValue } = (req.body ?? {}) as Record<string, any>;

    const lead = await prisma.lead.findFirst({
      where: { id, organizationId: actor.organizationId },
    });
    if (!lead) throw notFound('سرنخ');

    const result = await prisma.$transaction(async (tx) => {
      let targetCompanyId: string = companyId;
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
