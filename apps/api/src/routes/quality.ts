import type { FastifyPluginAsync } from 'fastify';
import {
  createQcReviewSchema, createRevisionSchema, createChangeRequestSchema,
  scopeReviewSchema, commercialImpactSchema, paginationSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { narrowed, reachFor } from '../auth/visibility.js';
import { registerCrud } from '../lib/crud.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { badRequest, forbidden, notFound, GovernanceError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';
import { allowedFor } from '../workflow/engine.js';
import { transitionWithin } from '../workflow/engine.js';
import { stageZero } from '../quality/stage-zero.js';
import { composeCorrection } from '../annotations/service.js';
import { over, QUEUE_CAP } from '../lib/limits.js';
import { assertOwnReferences } from '../lib/scope.js';
import { isSystemAdmin } from '../auth/grants.js';

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
    const where = narrowed('qcReview', await reachFor(req, actor), {
      organizationId: actor.organizationId,
      ...(level ? { level } : {}), ...(verdict ? { verdict } : {}),
      ...(deliverableId ? { deliverableId } : {}), ...(proposalId ? { proposalId } : {}),
      ...(projectId ? { deliverable: { projectId } } : {}),
    });
    const [items, total] = await Promise.all([
      prisma.qcReview.findMany({
        where,
        include: {
          reviewer: { select: { id: true, fullName: true } },
          deliverable: { select: { id: true, code: true, name: true, projectId: true } },
          proposal: { select: { id: true, code: true, title: true } },
          // The photos taken at the review (roadmap #49).
          documents: { where: { deletedAt: null }, select: { id: true, fileName: true, mimeType: true }, orderBy: { createdAt: 'asc' } },
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
    // Every id the request names must be the caller's organisation's (audit SEC-12).
    await assertOwnReferences('qcReview', input, actor.organizationId);

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
    if (cr.scopeVerdict !== 'OUT_OF_SCOPE' && !isSystemAdmin(actor)) {
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
    // The unit's last level-1 review, with the photos taken at it (roadmap #49): Account sees what
    // the unit checked, and on what, before opening a file.
    const unitReview = {
      where: { level: 'UNIT' }, orderBy: { reviewedAt: 'desc' as const }, take: 1,
      select: {
        id: true, code: true, verdict: true, findings: true, reviewedAt: true,
        reviewer: { select: { fullName: true } },
        documents: { where: { deletedAt: null }, select: { id: true, fileName: true, mimeType: true }, orderBy: { createdAt: 'asc' as const } },
      },
    };
    // The lists capped, oldest first (audit PERF-4); the counts counted, so they stay true when a list is cut.
    const org = actor.organizationId;
    // ADR-127: the queue of what this person sees.
    const reach = await reachFor(req, actor);
    const unitWhere = narrowed('deliverable', reach, { organizationId: org, state: 'SUBMITTED' });
    const accountWhere = narrowed('deliverable', reach, { organizationId: org, state: 'IN_QC' });
    const finalWhere = narrowed('proposal', reach, { organizationId: org, state: 'FINAL_QC' });
    const revisionWhere = narrowed('revision', reach, { organizationId: org, state: { notIn: ['APPROVED', 'REJECTED'] } });
    const [awaitingUnit, awaitingAccount, awaitingFinal, openRevisions, counted] = await Promise.all([
      prisma.deliverable.findMany({
        where: unitWhere, include: { project: { select: { id: true, code: true, name: true } }, qcReviews: unitReview },
        orderBy: { submittedAt: 'asc' }, take: over(QUEUE_CAP),
      }),
      prisma.deliverable.findMany({
        where: accountWhere, include: { project: { select: { id: true, code: true, name: true } }, qcReviews: unitReview },
        orderBy: { submittedAt: 'asc' }, take: over(QUEUE_CAP),
      }),
      prisma.proposal.findMany({ where: finalWhere, include: { brief: { select: { title: true } } }, orderBy: { createdAt: 'asc' }, take: over(QUEUE_CAP) }),
      prisma.revision.findMany({
        where: revisionWhere,
        include: {
          deliverable: { select: { id: true, code: true, name: true, projectId: true } },
          assignee: { select: { id: true, fullName: true } },
        },
        orderBy: { dueDate: 'asc' }, take: over(QUEUE_CAP),
      }),
      Promise.all([
        prisma.deliverable.count({ where: unitWhere }), prisma.deliverable.count({ where: accountWhere }),
        prisma.proposal.count({ where: finalWhere }), prisma.revision.count({ where: revisionWhere }),
        prisma.revision.count({ where: { ...revisionWhere, dueDate: { lt: new Date() } } }),
      ]),
    ]);
    const [unitN, accountN, finalN, revisionsN, overdueN] = counted;
    const cut = <T>(rows: T[]) => rows.slice(0, QUEUE_CAP);
    return {
      unit: cut(awaitingUnit).map((d) => ({ ...d, availableTransitions: allowedFor('deliverable', d.state, actor.permissions) })),
      account: cut(awaitingAccount).map((d) => ({ ...d, availableTransitions: allowedFor('deliverable', d.state, actor.permissions) })),
      final: cut(awaitingFinal).map((p) => ({ ...p, availableTransitions: allowedFor('proposal', p.state, actor.permissions) })),
      revisions: cut(openRevisions).map((r) => ({ ...r, availableTransitions: allowedFor('revision', r.state, actor.permissions) })),
      counts: { unit: unitN, account: accountN, final: finalN, revisions: revisionsN, overdueRevisions: overdueN },
      truncated: [awaitingUnit, awaitingAccount, awaitingFinal, openRevisions].some((rows) => rows.length > QUEUE_CAP),
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
