import type { FastifyPluginAsync } from 'fastify';
import {
  createRiskSchema, createIssueSchema, createDecisionSchema, createMeetingSchema,
  createStatusReportSchema, createFeedbackSchema, createLessonLearnedSchema, paginationSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { registerCrud } from '../lib/crud.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { nextCode } from '../lib/codes.js';
import { audit } from '../lib/audit.js';

const governanceRoutes: FastifyPluginAsync = async (app) => {
  registerCrud(app, {
    path: 'risks', model: 'risk', codeScope: 'risk',
    permissions: { read: 'governance.read', write: 'governance.write' },
    createSchema: createRiskSchema, updateSchema: createRiskSchema.partial(),
    sortable: ['createdAt'], searchable: ['title', 'description'],
    filter: (req) => {
      const { projectId, state } = req.query as Record<string, string | undefined>;
      return { ...(projectId ? { projectId } : {}), ...(state ? { state } : {}) };
    },
    listInclude: {
      project: { select: { id: true, code: true, name: true } },
      owner: { select: { id: true, fullName: true } },
    },
  });

  registerCrud(app, {
    path: 'issues', model: 'issue', codeScope: 'issue',
    permissions: { read: 'governance.read', write: 'governance.write' },
    createSchema: createIssueSchema, updateSchema: createIssueSchema.partial(),
    sortable: ['createdAt', 'targetResolution'], searchable: ['title', 'description'],
    filter: (req) => {
      const { projectId, state } = req.query as Record<string, string | undefined>;
      return { ...(projectId ? { projectId } : {}), ...(state ? { state } : {}) };
    },
    listInclude: {
      project: { select: { id: true, code: true, name: true } },
      owner: { select: { id: true, fullName: true } },
    },
  });

  registerCrud(app, {
    path: 'decisions', model: 'decision', codeScope: 'decision',
    permissions: { read: 'governance.read', write: 'governance.write' },
    createSchema: createDecisionSchema, updateSchema: createDecisionSchema.partial(),
    sortable: ['decidedAt'], searchable: ['title', 'decision'],
    filter: (req) => {
      const { projectId } = req.query as Record<string, string | undefined>;
      return projectId ? { projectId } : {};
    },
    listInclude: {
      project: { select: { id: true, code: true, name: true } },
      decidedBy: { select: { id: true, fullName: true } },
    },
  });

  app.get('/meetings', {
    preHandler: [app.authenticate, app.requirePermissions('meeting.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(paginationSchema, req.query);
    const { projectId, companyId, kind } = req.query as Record<string, string | undefined>;
    const where = {
      organizationId: actor.organizationId,
      ...(projectId ? { projectId } : {}), ...(companyId ? { companyId } : {}), ...(kind ? { kind } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.meeting.findMany({
        where, include: { project: { select: { id: true, code: true, name: true } } },
        orderBy: { heldAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      prisma.meeting.count({ where }),
    ]);
    return page(items, total, q);
  });

  app.post('/meetings', {
    preHandler: [app.authenticate, app.requirePermissions('meeting.write')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createMeetingSchema, req.body);
    const meeting = await prisma.meeting.create({
      data: {
        organizationId: actor.organizationId,
        code: await nextCode(prisma, 'meeting'),
        projectId: input.projectId ?? null, companyId: input.companyId ?? null,
        kind: input.kind, subject: input.subject, heldAt: input.heldAt,
        attendees: input.attendees, agenda: input.agenda ?? null,
        decisions: input.decisions ?? null, actions: input.actions as object,
        minutesRecordedAt: input.decisions ? new Date() : null,
        createdById: actor.id,
      },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE',
      entityType: 'meeting', entityId: meeting.id, after: meeting,
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(meeting);
  });

  registerCrud(app, {
    path: 'status-reports', model: 'statusReport', codeScope: 'statusReport',
    permissions: { read: 'report.read', write: 'project.execute' },
    createSchema: createStatusReportSchema, updateSchema: createStatusReportSchema.partial(),
    sortable: ['createdAt'], searchable: ['period', 'progress'],
    filter: (req) => {
      const { projectId } = req.query as Record<string, string | undefined>;
      return projectId ? { projectId } : {};
    },
    listInclude: { project: { select: { id: true, code: true, name: true } } },
  });

  /** Doc_H §J — customer feedback also satisfies a closure condition. */
  app.post('/feedbacks', {
    preHandler: [app.authenticate, app.requirePermissions('customer_success.write')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createFeedbackSchema, req.body);
    const feedback = await prisma.$transaction(async (tx) => {
      const created = await tx.feedback.create({
        data: { ...input, organizationId: actor.organizationId, recordedById: actor.id },
      });
      await tx.closureChecklist.upsert({
        where: { projectId: input.projectId },
        create: { projectId: input.projectId, feedbackRecorded: true, updatedById: actor.id },
        update: { feedbackRecorded: true, updatedById: actor.id },
      });
      // Keep the customer health score aligned with the latest satisfaction signal.
      const project = await tx.project.findUnique({ where: { id: input.projectId } });
      if (project) {
        await tx.company.update({
          where: { id: project.companyId },
          data: { healthScore: Math.round((input.csat / 5) * 60 + (input.nps / 10) * 40) },
        });
      }
      return created;
    });
    return reply.code(201).send(feedback);
  });

  app.get('/feedbacks', {
    preHandler: [app.authenticate, app.requirePermissions('report.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { projectId } = req.query as Record<string, string | undefined>;
    return prisma.feedback.findMany({
      where: { organizationId: actor.organizationId, ...(projectId ? { projectId } : {}) },
      include: { project: { select: { id: true, code: true, name: true, companyId: true } } },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
  });

  app.post('/lessons-learned', {
    preHandler: [app.authenticate, app.requirePermissions('customer_success.write')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createLessonLearnedSchema, req.body);
    const lesson = await prisma.$transaction(async (tx) => {
      const created = await tx.lessonLearned.create({
        data: { ...input, organizationId: actor.organizationId, recordedById: actor.id },
      });
      await tx.closureChecklist.upsert({
        where: { projectId: input.projectId },
        create: { projectId: input.projectId, lessonsLearnedRecorded: true, updatedById: actor.id },
        update: { lessonsLearnedRecorded: true, updatedById: actor.id },
      });
      return created;
    });
    return reply.code(201).send(lesson);
  });

  app.get('/lessons-learned', {
    preHandler: [app.authenticate, app.requirePermissions('report.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { projectId, category } = req.query as Record<string, string | undefined>;
    return prisma.lessonLearned.findMany({
      where: {
        organizationId: actor.organizationId,
        ...(projectId ? { projectId } : {}), ...(category ? { category } : {}),
      },
      include: { project: { select: { id: true, code: true, name: true } } },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
  });
};

export default governanceRoutes;
