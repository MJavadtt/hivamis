import type { FastifyPluginAsync } from 'fastify';
import {
  createQcReviewSchema, createRevisionSchema, createChangeRequestSchema,
  scopeReviewSchema, commercialImpactSchema, paginationSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { registerCrud } from '../lib/crud.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { badRequest, forbidden, notFound, GovernanceError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';
import { allowedFor } from '../workflow/engine.js';
import { transitionWithin } from '../workflow/engine.js';
import { stageZero } from '../quality/stage-zero.js';
import { composeCorrection } from '../annotations/service.js';

/** Doc_H §9 — each QC level maps to the permission that only its owning role holds. */
const LEVEL_PERMISSION = { UNIT: 'qc.unit', ACCOUNT: 'qc.account', FINAL: 'qc.final' } as const;

const qualityRoutes: FastifyPluginAsync = async (app) => {
  /* ── QC reviews ──────────────────────────────────────────────────────── */
  app.get('/qc-reviews', {
    preHandler: [app.authenticate, app.requirePermissions('qc.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(paginationSchema, req.query);
    const { level, verdict, deliverableId, proposalId, projectId } = req.query as Record<string, string | undefined>;
    const where = {
      organizationId: actor.organizationId,
      ...(level ? { level } : {}), ...(verdict ? { verdict } : {}),
      ...(deliverableId ? { deliverableId } : {}), ...(proposalId ? { proposalId } : {}),
      ...(projectId ? { deliverable: { projectId } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.qcReview.findMany({
        where,
        include: {
          reviewer: { select: { id: true, fullName: true } },
          deliverable: { select: { id: true, code: true, name: true, projectId: true } },
          proposal: { select: { id: true, code: true, title: true } },
        },
        orderBy: { reviewedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      prisma.qcReview.count({ where }),
    ]);
    return page(items, total, q);
  });

  /**
   * Record a QC review. The level determines which permission is required, so a unit
   * cannot sign off its own Account QC and vice versa (Doc_H §9).
   * A FAILED verdict raises the corresponding revision automatically when a deliverable is in play.
   */
  app.post('/qc-reviews', {
    preHandler: [app.authenticate, app.requirePermissions('qc.read')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createQcReviewSchema, req.body);

    const needed = LEVEL_PERMISSION[input.level];
    if (!actor.permissions.includes(needed)) {
      throw forbidden(`ثبت QC سطح «${input.level}» نیازمند دسترسی «${needed}» است.`);
    }
    if (!input.deliverableId && !input.proposalId && !input.workOrderId && !input.taskId) {
      throw badRequest('QC_TARGET_REQUIRED', 'موضوع کنترل کیفیت مشخص نشده است.');
    }

    // Roadmap #38: the annotations this review carries — open, on this deliverable, not yet carried by another review.
    const carried = input.annotationIds.length ? await prisma.annotation.findMany({
      where: { id: { in: input.annotationIds }, organizationId: actor.organizationId },
      include: { document: { select: { fileName: true } } }, orderBy: [{ createdAt: 'asc' }],
    }) : [];
    if (carried.length !== input.annotationIds.length || carried.some((a) => a.deliverableId !== input.deliverableId || a.status !== 'OPEN' || a.qcReviewId)) {
      throw badRequest('QC_ANNOTATIONS', 'یادداشت‌ها باید باز، از همین خروجی و ثبت‌نشده در بررسی دیگری باشند.');
    }
    const placed = carried.map((a) => ({ ...a, fileName: a.document.fileName }));
    const findings = input.verdict === 'FAILED' && placed.length ? composeCorrection(input.findings, placed) : input.findings ?? null;

    const result = await prisma.$transaction(async (tx) => {
      const review = await tx.qcReview.create({
        data: {
          organizationId: actor.organizationId,
          code: await nextCode(tx, 'qcReview'),
          level: input.level,
          deliverableId: input.deliverableId ?? null,
          workOrderId: input.workOrderId ?? null,
          proposalId: input.proposalId ?? null,
          taskId: input.taskId ?? null,
          checklist: input.checklist as object,
          verdict: input.verdict,
          findings,
          reviewerId: actor.id,
        },
      });
      if (carried.length) await tx.annotation.updateMany({ where: { id: { in: carried.map((a) => a.id) } }, data: { qcReviewId: review.id } });

      // Doc_H §10: a failed QC must produce a revision carrying its reason.
      let revision = null;
      if (input.verdict === 'FAILED' && input.deliverableId) {
        const deliverable = await tx.deliverable.findFirst({
          where: { id: input.deliverableId, organizationId: actor.organizationId },
        });
        if (deliverable) {
          revision = await tx.revision.create({
            data: {
              organizationId: actor.organizationId,
              code: await nextCode(tx, 'revision'),
              deliverableId: deliverable.id,
              qcReviewId: review.id,
              reason: input.level === 'UNIT' ? 'QUALITY_BELOW_STANDARD' : 'BRIEF_MISMATCH',
              requiredCorrection: findings ?? 'اصلاح مطابق یافته‌های QC',
              responsibleDepartmentCode: deliverable.departmentCode,
              dueDate: new Date(Date.now() + 2 * 86_400_000),
              requestedById: actor.id,
            },
          });
          // Each annotation is a line of the correction, and stays linked to it to be resolved.
          if (carried.length) await tx.annotation.updateMany({ where: { id: { in: carried.map((a) => a.id) } }, data: { revisionId: revision.id } });
          /**
           * The deliverable's move goes through the engine, not an inline UPDATE. Previously
           * this wrote REVISION_REQUIRED from any state and left no StateTransition row, so the
           * change was invisible in the deliverable's own history — a gap in the single source
           * of truth Doc_H §7 requires.
           *
           * Only levels 2 and 3 move it. A failed level-1 QC is internal to the unit, which has
           * not handed the output to Account yet (Doc_H §9), so putting the deliverable into an
           * Account-facing state would misreport where the work actually is; the revision alone
           * records the finding.
           */
          if (input.level !== 'UNIT') {
            await transitionWithin(tx, {
              entity: 'deliverable',
              id: deliverable.id,
              action: 'qc_reject',
              reason: findings ?? `عدم تأیید در QC — ${review.code}`,
              actor: {
                id: actor.id, organizationId: actor.organizationId, permissions: actor.permissions,
                ipAddress: actor.ipAddress, userAgent: actor.userAgent, requestId: actor.requestId,
              },
            });
          }
        }
      }

      // Doc_H §15: a passing Final QC satisfies one of the eight closure conditions.
      if (input.verdict === 'PASSED' && input.level === 'FINAL' && input.deliverableId) {
        const d = await tx.deliverable.findFirst({
          where: { id: input.deliverableId, organizationId: actor.organizationId },
        });
        if (d) {
          await tx.closureChecklist.upsert({
            where: { projectId: d.projectId },
            create: { projectId: d.projectId, finalQcDone: true, updatedById: actor.id },
            update: { finalQcDone: true, updatedById: actor.id },
          });
        }
      }

      return { review, revision };
    });

    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE',
      entityType: 'qcReview', entityId: result.review.id, after: result.review,
      reason: input.findings ?? null, ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(result);
  });

  /* ── Revisions ───────────────────────────────────────────────────────── */
  registerCrud(app, {
    path: 'revisions', model: 'revision', workflowEntity: 'revision', codeScope: 'revision',
    permissions: { read: 'revision.read', write: 'revision.create' },
    createSchema: createRevisionSchema, updateSchema: createRevisionSchema.partial(),
    sortable: ['createdAt', 'dueDate'], searchable: ['requiredCorrection'],
    filter: (req) => {
      const { state, unit, projectId, assigneeId } = req.query as Record<string, string | undefined>;
      return {
        ...(state ? { state } : {}), ...(unit ? { responsibleDepartmentCode: unit } : {}),
        ...(assigneeId ? { assigneeId } : {}),
        ...(projectId ? { deliverable: { projectId } } : {}),
      };
    },
    listInclude: {
      deliverable: { select: { id: true, code: true, name: true, projectId: true } },
      assignee: { select: { id: true, fullName: true } },
    },
    detailInclude: {
      deliverable: true, qcReview: true, assignee: { select: { id: true, fullName: true } },
    },
    toCreate: (input, actor) => ({ ...input, requestedById: actor.id }),
  });

  /* ── Change requests (Doc_H §8) ──────────────────────────────────────── */
  registerCrud(app, {
    path: 'change-requests', model: 'changeRequest', workflowEntity: 'changeRequest', codeScope: 'changeRequest',
    permissions: { read: 'change.read', write: 'change.create' },
    createSchema: createChangeRequestSchema, updateSchema: createChangeRequestSchema.partial(),
    sortable: ['createdAt', 'requestedDate'], searchable: ['title', 'requestedChange'],
    filter: (req) => {
      const { state, projectId, scope } = req.query as Record<string, string | undefined>;
      return {
        ...(state ? { state } : {}), ...(projectId ? { projectId } : {}),
        ...(scope ? { scopeVerdict: scope } : {}),
      };
    },
    listInclude: { project: { select: { id: true, code: true, name: true } } },
    detailInclude: {
      project: { include: { company: { select: { legalName: true } } } },
      amendments: true,
    },
    toCreate: (input, actor) => ({ ...input, createdById: actor.id }),
  });

  /** Doc_H §I — decide whether the request falls inside the contracted scope. */
  app.post('/change-requests/:id/scope-review', {
    preHandler: [app.authenticate, app.requirePermissions('change.scope_review')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(scopeReviewSchema, req.body);
    const cr = await prisma.changeRequest.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!cr) throw notFound('درخواست تغییر');
    if (!['SUBMITTED', 'SCOPE_REVIEW'].includes(cr.state)) {
      throw badRequest('WRONG_STATE', 'بررسی Scope فقط در مرحله بررسی Scope ممکن است.');
    }
    const updated = await prisma.changeRequest.update({
      where: { id },
      data: {
        scopeVerdict: input.verdict, scopeRationale: input.rationale,
        scopeReviewedById: actor.id, scopeReviewedAt: new Date(),
      },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
      entityType: 'changeRequest', entityId: id,
      before: { scopeVerdict: cr.scopeVerdict }, after: { scopeVerdict: input.verdict },
      reason: input.rationale, ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return updated;
  });

  /** Doc_H §8 — record the six mandatory impact dimensions before the customer is asked. */
  app.post('/change-requests/:id/impact', {
    preHandler: [app.authenticate, app.requirePermissions('change.commercial_review')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(commercialImpactSchema, req.body);
    const cr = await prisma.changeRequest.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!cr) throw notFound('درخواست تغییر');
    if (cr.scopeVerdict !== 'OUT_OF_SCOPE') {
      throw new GovernanceError(
        'Doc_H §8 — کنترل تغییرات',
        'بررسی اثر تجاری فقط برای تغییرات خارج از Scope انجام می‌شود. ابتدا بررسی Scope را ثبت کنید.',
      );
    }
    return prisma.changeRequest.update({
      where: { id },
      data: {
        timeImpactDays: input.timeImpactDays, costImpact: input.costImpact,
        resourceImpact: input.resourceImpact, scopeImpact: input.scopeImpact,
        qualityImpact: input.qualityImpact, contractImpact: input.contractImpact,
        proposedPrice: input.proposedPrice ?? null,
        impactAssessedById: actor.id, impactAssessedAt: new Date(),
      },
    });
  });

  /** The QC console: everything currently awaiting a quality decision, per level. */
  app.get('/qc/queue', {
    preHandler: [app.authenticate, app.requirePermissions('qc.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const [awaitingUnit, awaitingAccount, awaitingFinal, openRevisions] = await Promise.all([
      prisma.deliverable.findMany({
        where: { organizationId: actor.organizationId, state: 'SUBMITTED' },
        include: { project: { select: { id: true, code: true, name: true } } },
      }),
      prisma.deliverable.findMany({
        where: { organizationId: actor.organizationId, state: 'IN_QC' },
        include: { project: { select: { id: true, code: true, name: true } } },
      }),
      prisma.proposal.findMany({
        where: { organizationId: actor.organizationId, state: 'FINAL_QC' },
        include: { brief: { select: { title: true } } },
      }),
      prisma.revision.findMany({
        where: { organizationId: actor.organizationId, state: { notIn: ['APPROVED', 'REJECTED'] } },
        include: {
          deliverable: { select: { id: true, code: true, name: true, projectId: true } },
          assignee: { select: { id: true, fullName: true } },
        },
        orderBy: { dueDate: 'asc' },
      }),
    ]);
    return {
      unit: awaitingUnit.map((d) => ({ ...d, availableTransitions: allowedFor('deliverable', d.state, actor.permissions) })),
      account: awaitingAccount.map((d) => ({ ...d, availableTransitions: allowedFor('deliverable', d.state, actor.permissions) })),
      final: awaitingFinal.map((p) => ({ ...p, availableTransitions: allowedFor('proposal', p.state, actor.permissions) })),
      revisions: openRevisions.map((r) => ({ ...r, availableTransitions: allowedFor('revision', r.state, actor.permissions) })),
      counts: {
        unit: awaitingUnit.length, account: awaitingAccount.length,
        final: awaitingFinal.length, revisions: openRevisions.length,
        overdueRevisions: openRevisions.filter((r) => r.dueDate < new Date()).length,
      },
    };
  });

  /**
   * QC stage zero, on demand (roadmap #22): the unit checks its handover before making it, and
   * Account re-checks after a file changes. Run outside any transition, so the result — a FAIL
   * included — is kept on the deliverable for whoever looks next.
   */
  app.post('/deliverables/:id/stage-zero', {
    preHandler: [app.authenticate, app.requirePermissions('deliverable.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const d = await prisma.deliverable.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true } });
    if (!d) throw notFound('خروجی');
    const result = await stageZero(prisma, actor.organizationId, id);
    await prisma.deliverable.update({
      where: { id },
      data: { stageZeroVerdict: result.verdict, stageZeroAt: new Date(), stageZeroFindings: result as unknown as object },
    });
    return result;
  });
};

export default qualityRoutes;
