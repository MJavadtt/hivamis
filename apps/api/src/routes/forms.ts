import type { FastifyPluginAsync } from 'fastify';
import { formDecisionSchema, submitFormSchema, paginationSchema, FORM_CATEGORY_LABELS } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { decideForm, submitForm } from '../forms/engine.js';

const formRoutes: FastifyPluginAsync = async (app) => {
  /** The full Doc_H form catalogue, grouped for the navigator. */
  app.get('/forms/definitions', {
    preHandler: [app.authenticate, app.requirePermissions('form.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { category, module, mine } = req.query as Record<string, string | undefined>;
    const definitions = await prisma.formDefinition.findMany({
      where: {
        organizationId: actor.organizationId, isActive: true,
        ...(category ? { category } : {}), ...(module ? { module } : {}),
        // `mine=true` narrows to the forms this user's department is allowed to originate.
        ...(mine === 'true' && actor.departmentCode ? { senderDepts: { has: actor.departmentCode } } : {}),
      },
      orderBy: { no: 'asc' },
    });
    return {
      categories: Object.entries(FORM_CATEGORY_LABELS).map(([key, labelFa]) => ({
        key, labelFa, count: definitions.filter((d) => d.category === key).length,
      })),
      definitions: definitions.map((d) => ({
        ...d,
        canSubmit:
          d.senderDepts.length === 0 ||
          (actor.departmentCode ? d.senderDepts.includes(actor.departmentCode) : false) ||
          actor.roles.some((r) => ['SUPER_ADMIN', 'CEO', 'DEPUTY'].includes(r)),
      })),
    };
  });

  app.get('/forms/definitions/:code', {
    preHandler: [app.authenticate, app.requirePermissions('form.read')],
  }, async (req) => {
    const { code } = req.params as { code: string };
    const def = await prisma.formDefinition.findUnique({ where: { code } });
    if (!def) throw notFound('تعریف فرم');
    const sla = def.slaCode ? await prisma.slaPolicy.findUnique({ where: { code: def.slaCode } }) : null;
    return { ...def, sla };
  });

  app.get('/forms/submissions', {
    preHandler: [app.authenticate, app.requirePermissions('form.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(paginationSchema, req.query);
    const { state, formCode, projectId, mine, awaitingMe } = req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = {
      organizationId: actor.organizationId,
      ...(state ? { state } : {}),
      ...(projectId ? { projectId } : {}),
      ...(formCode ? { definition: { code: formCode } } : {}),
      ...(mine === 'true' ? { submittedById: actor.id } : {}),
    };
    // Approval inbox: forms pending a decision from one of the caller's roles.
    if (awaitingMe === 'true') {
      where.state = 'PENDING_APPROVAL';
      where.definition = { approverRoles: { hasSome: actor.roles } };
      where.submittedById = { not: actor.id };
    }

    const [items, total] = await Promise.all([
      prisma.formSubmission.findMany({
        where,
        include: {
          definition: { select: { code: true, nameFa: true, category: true, module: true, approverRoles: true } },
          submittedBy: { select: { id: true, fullName: true } },
          project: { select: { id: true, code: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      prisma.formSubmission.count({ where }),
    ]);
    return page(items, total, q);
  });

  app.get('/forms/submissions/:id', {
    preHandler: [app.authenticate, app.requirePermissions('form.read')],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const submission = await prisma.formSubmission.findUnique({
      where: { id },
      include: {
        definition: true,
        submittedBy: { select: { id: true, fullName: true, email: true } },
        assignedTo: { select: { id: true, fullName: true } },
        approvals: { include: { approver: { select: { id: true, fullName: true } } } },
        project: { select: { id: true, code: true, name: true } },
        documents: true,
      },
    });
    if (!submission) throw notFound('فرم');
    const sla = await prisma.slaClock.findFirst({
      where: { entityType: 'formSubmission', entityId: id },
      include: { policy: true }, orderBy: { createdAt: 'desc' },
    });
    return { ...submission, sla };
  });

  app.post('/forms/submissions', {
    preHandler: [app.authenticate, app.requirePermissions('form.submit')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(submitFormSchema, req.body);
    const submission = await submitForm({
      formCode: input.formCode, data: input.data, projectId: input.projectId,
      companyId: input.companyId, opportunityId: input.opportunityId,
      assignedToId: input.assignedToId, asDraft: input.asDraft,
      actor: {
        id: actor.id, organizationId: actor.organizationId, departmentCode: actor.departmentCode,
        roles: actor.roles, permissions: actor.permissions,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      },
    });
    return reply.code(201).send(submission);
  });

  app.post('/forms/submissions/:id/decision', {
    preHandler: [app.authenticate, app.requirePermissions('form.approve')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(formDecisionSchema, req.body);
    return decideForm({
      submissionId: id, decision: input.decision, comment: input.comment,
      actor: {
        id: actor.id, organizationId: actor.organizationId, departmentCode: actor.departmentCode,
        roles: actor.roles, permissions: actor.permissions,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      },
    });
  });
};

export default formRoutes;
