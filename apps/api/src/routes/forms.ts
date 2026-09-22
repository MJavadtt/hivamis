import type { FastifyPluginAsync } from 'fastify';
import {
  formDecisionSchema, submitFormSchema, paginationSchema, updateRoutingSchema,
  FORM_CATEGORY_LABELS, evaluateRouting, describeCondition, rolesFa,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { decideForm, pendingForRoles, submitForm } from '../forms/engine.js';
import { schemaForSubmission } from '../forms/versions.js';
import { exportCsv, previewImport, rowsFromCsv, runImport, templateCsv, templateFor } from '../forms/bulk.js';
import type { FormActor } from '../forms/engine.js';
import type { FieldDef, RoutingRule } from '@hiva/contracts';

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

  /**
   * Who this form will need, for these values, before it is submitted (roadmap #17). The
   * evaluator is the same pure function the server routes with, so the answer the person sees
   * while filling and the answer they get on submit cannot differ.
   */
  app.post('/forms/definitions/:code/routing/preview', {
    preHandler: [app.authenticate, app.requirePermissions('form.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const { data } = (req.body ?? {}) as { data?: Record<string, unknown> };
    const def = await prisma.formDefinition.findFirst({ where: { code, organizationId: actor.organizationId } });
    if (!def) throw notFound('تعریف فرم');
    const outcome = evaluateRouting(def.approverRoles, def.routing as unknown as RoutingRule[], data ?? {});
    return {
      formCode: def.code,
      baseRoles: def.approverRoles,
      ...outcome,
      rolesFa: rolesFa(outcome.roles),
    };
  });

  /** The conditional rules on a definition, in the order they are evaluated. */
  app.get('/forms/definitions/:code/routing', {
    preHandler: [app.authenticate, app.requirePermissions('form.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const def = await prisma.formDefinition.findFirst({
      where: { code, organizationId: actor.organizationId },
      select: { code: true, nameFa: true, version: true, approverRoles: true, routing: true, schema: true },
    });
    if (!def) throw notFound('تعریف فرم');
    const rules = (Array.isArray(def.routing) ? def.routing : []) as unknown as RoutingRule[];
    const fields = (Array.isArray(def.schema) ? def.schema : []) as unknown as FieldDef[];
    return {
      formCode: def.code, nameFa: def.nameFa, version: def.version,
      baseRoles: def.approverRoles,
      fields: fields.filter((f) => f.type !== 'table' && f.type !== 'attachment').map((f) => ({ key: f.key, labelFa: f.labelFa, type: f.type, options: f.options ?? null })),
      rules: rules.map((r) => ({ ...r, describedFa: describeCondition(r.when, fields) })),
    };
  });

  /**
   * Replace the rules on a definition. A routing change decides who must approve, so it mints a
   * new definition version (#16) exactly as a schema change does — submissions already filed
   * keep the rules they were judged under.
   */
  app.put('/forms/definitions/:code/routing', {
    preHandler: [app.authenticate, app.requirePermissions('admin.settings')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const input = parse(updateRoutingSchema, req.body);
    const def = await prisma.formDefinition.findFirst({ where: { code, organizationId: actor.organizationId } });
    if (!def) throw notFound('تعریف فرم');

    const ids = new Set<string>();
    for (const r of input.rules) {
      if (ids.has(r.id)) throw badRequest('DUPLICATE_RULE_ID', `شناسهٔ قانون «${r.id}» تکراری است`);
      ids.add(r.id);
    }
    const rules = input.rules.map((r) => ({ source: 'ORG' as const, ...r })) as unknown as object;

    const updated = await prisma.$transaction(async (tx) => {
      const version = def.version + 1;
      const row = await tx.formDefinition.update({ where: { id: def.id }, data: { routing: rules, version } });
      await tx.formDefinitionVersion.create({
        data: {
          definitionId: def.id, version, schema: def.schema as object, routing: rules,
          nameFa: def.nameFa, note: input.note ?? 'تغییر قواعد مسیریابی', createdById: actor.id,
        },
      });
      await audit({
        organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
        entityType: 'formDefinition', entityId: def.id,
        before: { routing: def.routing, version: def.version },
        after: { routing: rules, version },
        reason: input.note ?? null,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      }, tx);
      return row;
    });
    return { formCode: updated.code, version: updated.version, rules: updated.routing };
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
      Object.assign(where, pendingForRoles(actor.roles));
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
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const submission = await prisma.formSubmission.findFirst({ where: { id, organizationId: actor.organizationId },
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
    // The fields as they stood when this was filled in — not the definition's current schema.
    const schema = await schemaForSubmission(prisma, submission);
    return { ...submission, schema, sla };
  });

  /** Every version a definition has had, newest first, with how many submissions pin each. */
  app.get('/forms/definitions/:code/versions', {
    preHandler: [app.authenticate, app.requirePermissions('form.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { code } = req.params as { code: string };
    const definition = await prisma.formDefinition.findFirst({ where: { code, organizationId: actor.organizationId } });
    if (!definition) throw notFound('تعریف فرم');
    const [versions, counts] = await Promise.all([
      prisma.formDefinitionVersion.findMany({ where: { definitionId: definition.id }, orderBy: { version: 'desc' } }),
      prisma.formSubmission.groupBy({ by: ['definitionVersion'], where: { definitionId: definition.id }, _count: { _all: true } }),
    ]);
    const submissionsByVersion = new Map(counts.map((c) => [c.definitionVersion, c._count._all]));
    return {
      code: definition.code, current: definition.version,
      versions: versions.map((v) => ({
        version: v.version, nameFa: v.nameFa, note: v.note, createdAt: v.createdAt,
        fieldCount: Array.isArray(v.schema) ? v.schema.length : 0,
        submissions: submissionsByVersion.get(v.version) ?? 0,
        schema: v.schema,
      })),
    };
  });

  /* ── Bulk import / export (roadmap #20) ─────────────────────────────── */

  async function definitionFor(req: Parameters<typeof actorFrom>[0], code: string) {
    const actor = actorFrom(req);
    const definition = await prisma.formDefinition.findFirst({ where: { code, organizationId: actor.organizationId } });
    if (!definition) throw notFound('تعریف فرم');
    return { actor, definition, fields: definition.schema as unknown as FieldDef[] };
  }

  /** The importable columns of a form, with the words a person needs to fill each. */
  app.get('/forms/definitions/:code/template', {
    preHandler: [app.authenticate, app.requirePermissions('form.read')],
  }, async (req) => {
    const { code } = req.params as { code: string };
    const { definition, fields } = await definitionFor(req, code);
    return { code: definition.code, nameFa: definition.nameFa, version: definition.version, columns: templateFor(fields) };
  });

  app.get('/forms/definitions/:code/template.csv', {
    preHandler: [app.authenticate, app.requirePermissions('form.read')],
  }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const { fields } = await definitionFor(req, code);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${code}-template.csv"`)
      .send(templateCsv(fields));
  });

  /**
   * Rows arrive as CSV text or as JSON. `mode: preview` checks everything and writes nothing;
   * `draft` and `submit` write the valid rows through the form engine. Draft is the default —
   * a migration of last year's records should not open two hundred approvals.
   */
  app.post('/forms/definitions/:code/import', {
    preHandler: [app.authenticate, app.requirePermissions('form.submit')],
  }, async (req) => {
    const { code } = req.params as { code: string };
    const { actor, definition, fields } = await definitionFor(req, code);
    const body = (req.body ?? {}) as { csv?: string; rows?: Record<string, unknown>[]; mode?: string };
    const mode = body.mode ?? 'preview';
    if (!['preview', 'draft', 'submit'].includes(mode)) {
      throw badRequest('INVALID_MODE', 'حالت باید preview، draft یا submit باشد', { mode });
    }
    const rows = body.csv != null ? rowsFromCsv(String(body.csv), fields) : Array.isArray(body.rows) ? body.rows : null;
    if (!rows) throw badRequest('ROWS_REQUIRED', 'متن CSV یا فهرست ردیف‌ها لازم است');
    if (rows.length > 2000) throw badRequest('TOO_MANY_ROWS', 'حداکثر ۲۰۰۰ ردیف در هر بار', { rows: rows.length });

    if (mode === 'preview') return { mode, form: definition.code, ...(await previewImport(prisma, actor.organizationId, fields, rows)) };
    const formActor: FormActor = {
      id: actor.id, organizationId: actor.organizationId, departmentCode: actor.departmentCode,
      roles: actor.roles, permissions: actor.permissions, delegatedRoles: actor.delegatedRoles,
      ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
    };
    const result = await runImport(prisma, definition.code, fields, rows, { actor: formActor, asDraft: mode === 'draft' });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'BULK_IMPORT',
      entityType: 'formDefinition', entityId: definition.id,
      after: { form: definition.code, mode, total: result.total, created: result.created, failed: result.failed },
      ipAddress: actor.ipAddress,
    });
    return { mode, form: definition.code, ...result };
  });

  app.get('/forms/definitions/:code/export.csv', {
    preHandler: [app.authenticate, app.requirePermissions('form.read')],
  }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const { actor, definition } = await definitionFor(req, code);
    const csv = await exportCsv(prisma, actor.organizationId, definition.id);
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'EXPORT',
      entityType: 'formDefinition', entityId: definition.id, after: { format: 'csv', form: definition.code },
      ipAddress: actor.ipAddress,
    });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${code}.csv"`)
      .send(csv);
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
        roles: actor.roles, permissions: actor.permissions, delegatedRoles: actor.delegatedRoles,
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
        roles: actor.roles, permissions: actor.permissions, delegatedRoles: actor.delegatedRoles,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
      },
    });
  });
};

export default formRoutes;
