import type { Tx } from '../db.js';
import { refuseDuplicate, resolveLeadSource } from '../crm/lead-sources.js';
import { nextCode } from '../lib/codes.js';
import { scoreBrief } from '../briefs/quality.js';
import { briefCompleteness } from '../workflow/guards.js';

export interface HandlerContext {
  tx: Tx;
  data: Record<string, any>;
  actorId: string;
  organizationId: string;
  departmentCode: string | null;
  projectId?: string | null;
  companyId?: string | null;
  opportunityId?: string | null;
}

export interface HandlerResult {
  entity: string;
  entityId: string;
}

const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const date = (v: unknown) => (v == null || v === '' ? null : new Date(String(v)));

/**
 * Typed bindings — the forms that create or drive a first-class domain record.
 * Forms without a handler are still fully functional: they are stored, routed to the
 * receiving department, approved and SLA-tracked by the generic engine.
 */
export const FORM_HANDLERS: Record<string, (c: HandlerContext) => Promise<HandlerResult>> = {
  lead: async ({ tx, data, actorId, organizationId }) => {
    // The same rules as the CRM's own form (Hivamis task 2): one mobile number is one lead unless
    // the person ticked that they mean it, and the source names who or what exactly.
    const phone = str(data.phone);
    if (phone) await refuseDuplicate(organizationId, phone, data.confirmDuplicate === true);
    const source = await resolveLeadSource(tx, organizationId, actorId, {
      source: str(data.source), sourceUserId: str(data.sourceUserId), sourceChannel: str(data.sourceChannel),
      sourceReferrerId: str(data.sourceReferrerId) ?? str(data.sourcePartnerId), sourcePartnerName: str(data.sourcePartnerName),
    });
    const lead = await tx.lead.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'lead'),
        name: String(data.name),
        companyName: String(data.companyName),
        contactName: str(data.contactName),
        phone,
        email: str(data.email),
        ...source,
        estimatedValue: num(data.estimatedValue),
        need: str(data.need),
        ownerId: actorId,
      },
    });
    return { entity: 'lead', entityId: lead.id };
  },

  opportunity: async ({ tx, data, actorId, organizationId }) => {
    const opp = await tx.opportunity.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'opportunity'),
        title: String(data.title ?? data.proposedService ?? 'فرصت جدید'),
        companyId: String(data.companyId),
        estimatedValue: num(data.estimatedValue) ?? 0,
        expectedCloseDate: date(data.expectedCloseDate),
        servicesNeeded: Array.isArray(data.servicesNeeded) ? data.servicesNeeded.map(String) : [],
        description: str(data.description ?? data.rationale),
        ownerId: actorId,
      },
    });
    return { entity: 'opportunity', entityId: opp.id };
  },

  company: async ({ tx, data, organizationId }) => {
    const company = await tx.company.create({
      data: {
        organizationId,
        legalName: String(data.legalName),
        brandName: str(data.brandName),
        industry: str(data.industry),
        nationalId: str(data.nationalId),
        economicCode: str(data.economicCode),
        website: str(data.website),
        phone: str(data.phone),
        address: str(data.address),
      },
    });
    return { entity: 'company', entityId: company.id };
  },

  brief: async ({ tx, data, actorId, organizationId }) => {
    const payload = {
      businessObjective: str(data.businessObjective),
      targetAudience: str(data.targetAudience),
      scope: str(data.scope),
      expectedDeliverables: str(data.expectedDeliverables),
      budgetRange: num(data.budgetRange),
      desiredDeadline: date(data.desiredDeadline),
    };
    const { score, missing } = briefCompleteness(payload);
    const brief = await tx.brief.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'brief'),
        opportunityId: String(data.opportunityId),
        title: String(data.title),
        ...payload,
        unitsNeeded: Array.isArray(data.unitsNeeded) ? data.unitsNeeded.map(String) : [],
        competitorContext: str(data.competitorContext),
        constraints: str(data.constraints),
        successCriteria: str(data.successCriteria),
        completenessScore: score,
        missingItems: missing,
        // Quality beside completeness (roadmap #25): filled is not the same as specific.
        ...(() => {
          const q = scoreBrief({ ...payload, competitorContext: data.competitorContext, constraints: data.constraints, successCriteria: data.successCriteria });
          return { qualityScore: q.score, qualityBand: q.band };
        })(),
        submittedById: actorId,
      },
    });
    return { entity: 'brief', entityId: brief.id };
  },

  /** Form B09 — records the Account completeness check and refreshes the brief's score. */
  briefReview: async ({ tx, data }) => {
    const briefId = String(data.briefId);
    const brief = await tx.brief.findUnique({ where: { id: briefId } });
    if (brief) {
      const { score, missing } = briefCompleteness(brief as unknown as Record<string, any>);
      await tx.brief.update({
        where: { id: briefId },
        data: { completenessScore: score, missingItems: missing, ...(() => { const q = scoreBrief(brief as unknown as Record<string, unknown>); return { qualityScore: q.score, qualityBand: q.band }; })() },
      });
    }
    return { entity: 'brief', entityId: briefId };
  },

  activity: async ({ tx, data, actorId, organizationId }) => {
    const a = await tx.activity.create({
      data: {
        organizationId,
        opportunityId: data.opportunityId ? String(data.opportunityId) : null,
        companyId: data.companyId ? String(data.companyId) : null,
        kind: String(data.kind),
        occurredAt: date(data.occurredAt) ?? new Date(),
        summary: String(data.summary),
        nextStep: str(data.nextStep),
        nextStepDue: date(data.nextStepDue),
        createdById: actorId,
      },
    });
    return { entity: 'activity', entityId: a.id };
  },

  handoff: async ({ tx, data, organizationId }) => {
    const h = await tx.handoff.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'handoff'),
        companyId: String(data.companyId),
        projectId: data.projectId ? String(data.projectId) : null,
        contractId: data.contractId ? String(data.contractId) : null,
        salesOwnerId: String(data.salesOwner),
        accountOwnerId: String(data.accountOwner),
        commitmentsMade: String(data.commitmentsMade),
        clientExpectations: String(data.clientExpectations),
        sensitivities: str(data.sensitivities),
        openItems: str(data.openItems),
        state: 'SUBMITTED',
      },
    });
    return { entity: 'handoff', entityId: h.id };
  },

  meeting: async ({ tx, data, actorId, organizationId, projectId }) => {
    const m = await tx.meeting.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'meeting'),
        projectId: data.projectId ? String(data.projectId) : projectId ?? null,
        companyId: data.companyId ? String(data.companyId) : null,
        kind: String(data.kind ?? 'INTERNAL'),
        subject: String(data.subject),
        heldAt: date(data.heldAt) ?? new Date(),
        attendees: String(data.attendees),
        agenda: str(data.agenda),
        decisions: str(data.decisions),
        actions: Array.isArray(data.actions) ? data.actions : [],
        minutesRecordedAt: new Date(),
        createdById: actorId,
      },
    });
    return { entity: 'meeting', entityId: m.id };
  },

  qcReview: async ({ tx, data, actorId, organizationId }) => {
    const level = data.proposalId ? 'FINAL' : data.deliverableId ? (data.__level ?? 'ACCOUNT') : 'UNIT';
    const checklist: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'boolean') checklist[k] = v;
    }
    const qc = await tx.qcReview.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'qcReview'),
        level: String(data.level ?? level),
        deliverableId: data.deliverableId ? String(data.deliverableId) : null,
        proposalId: data.proposalId ? String(data.proposalId) : null,
        workOrderId: data.workOrderId ? String(data.workOrderId) : null,
        checklist,
        verdict: String(data.verdict ?? 'PENDING'),
        findings: str(data.findings ?? data.details),
        reviewerId: actorId,
      },
    });
    return { entity: 'qcReview', entityId: qc.id };
  },

  revision: async ({ tx, data, actorId, organizationId, departmentCode }) => {
    const rev = await tx.revision.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'revision'),
        deliverableId: data.deliverableId ? String(data.deliverableId) : null,
        proposalId: data.proposalId ? String(data.proposalId) : null,
        reason: String(data.reason),
        requiredCorrection: String(data.requiredCorrection ?? data.scopeOfRevision),
        responsibleDepartmentCode: String(data.responsibleUnit ?? departmentCode ?? 'CR'),
        dueDate: date(data.dueDate) ?? new Date(Date.now() + 86_400_000),
        requestedById: actorId,
      },
    });
    return { entity: 'revision', entityId: rev.id };
  },

  costDeclaration: async ({ tx, data, actorId, organizationId, departmentCode }) => {
    const items = Array.isArray(data.costItems) ? data.costItems : Array.isArray(data.lines) ? data.lines : [];
    const computed = items.reduce(
      (sum: number, it: any) => sum + Number(it.quantity ?? 1) * Number(it.unitCost ?? it.cost ?? 0),
      0,
    );
    const cd = await tx.costDeclaration.create({
      data: {
        organizationId,
        proposalId: data.proposalId ? String(data.proposalId) : null,
        workOrderId: data.workOrderId ? String(data.workOrderId) : null,
        departmentCode: String(data.unit ?? departmentCode ?? 'CR'),
        internalCost: num(data.internalCost) ?? num(data.totalCost) ?? computed,
        externalCost: num(data.externalCost) ?? 0,
        items,
        assumptions: str(data.assumptions),
        declaredById: actorId,
      },
    });
    return { entity: 'costDeclaration', entityId: cd.id };
  },

  changeRequest: async ({ tx, data, actorId, organizationId }) => {
    const cr = await tx.changeRequest.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'changeRequest'),
        projectId: String(data.projectId),
        title: String(data.title),
        requestedChange: String(data.requestedChange),
        requestedBy: String(data.requestedBy ?? 'CLIENT'),
        requestedDate: date(data.requestedDate) ?? new Date(),
        priority: String(data.priority ?? 'NORMAL'),
        createdById: actorId,
      },
    });
    return { entity: 'changeRequest', entityId: cr.id };
  },

  executionAuthorization: async ({ tx, data, actorId }) => {
    const auth = await tx.executionAuthorization.create({
      data: {
        projectId: String(data.projectId),
        basis: String(data.basis ?? 'INVOICED_EXECUTION_ORDER'),
        contractId: data.contractId ? String(data.contractId) : null,
        invoiceId: data.invoiceId ? String(data.invoiceId) : null,
        referenceDocument: String(data.referenceDocument ?? data.invoiceId ?? '—'),
        notes: str(data.notes ?? data.justification),
        authorizedById: actorId,
      },
    });
    return { entity: 'executionAuthorization', entityId: auth.id };
  },

  risk: async ({ tx, data, actorId, organizationId }) => {
    const r = await tx.risk.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'risk'),
        projectId: String(data.projectId),
        title: String(data.title ?? data.kind ?? 'ریسک'),
        description: String(data.description),
        probability: String(data.probability ?? data.severity ?? 'MEDIUM'),
        impact: String(data.impact ?? data.severity ?? 'MEDIUM'),
        mitigation: str(data.mitigation ?? data.recoveryPlan),
        ownerId: data.owner ? String(data.owner) : actorId,
      },
    });
    return { entity: 'risk', entityId: r.id };
  },

  issue: async ({ tx, data, actorId, organizationId }) => {
    const i = await tx.issue.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'issue'),
        projectId: String(data.projectId),
        title: String(data.title),
        description: String(data.description),
        severity: String(data.severity ?? 'MEDIUM'),
        ownerId: data.owner ? String(data.owner) : actorId,
        targetResolution: date(data.targetResolution),
      },
    });
    return { entity: 'issue', entityId: i.id };
  },

  decision: async ({ tx, data, actorId, organizationId }) => {
    const d = await tx.decision.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'decision'),
        projectId: String(data.projectId),
        title: String(data.title),
        context: String(data.context),
        decision: String(data.decision),
        alternatives: str(data.alternatives),
        decidedById: data.decidedBy ? String(data.decidedBy) : actorId,
        decidedAt: date(data.decidedAt) ?? new Date(),
      },
    });
    return { entity: 'decision', entityId: d.id };
  },

  statusReport: async ({ tx, data, actorId, organizationId }) => {
    const r = await tx.statusReport.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'statusReport'),
        projectId: String(data.projectId),
        period: String(data.period),
        progress: String(data.progress),
        completed: str(data.completed),
        inProgress: str(data.inProgress),
        next: str(data.next),
        timelineStatus: str(data.timelineStatus),
        risks: str(data.risks),
        issues: str(data.issues),
        decisionsNeeded: str(data.decisionsNeeded),
        financialStatus: str(data.financialStatus),
        createdById: actorId,
      },
    });
    return { entity: 'statusReport', entityId: r.id };
  },

  feedback: async ({ tx, data, actorId, organizationId }) => {
    const fb = await tx.feedback.create({
      data: {
        organizationId,
        projectId: String(data.projectId),
        csat: Number(data.csat),
        nps: Number(data.nps),
        qualityRating: num(data.qualityRating),
        timelinessRating: num(data.timelinessRating),
        communicationRating: num(data.communicationRating),
        positives: str(data.positives ?? data.comments),
        improvements: str(data.improvements),
        futureNeeds: str(data.futureNeeds),
        recordedById: actorId,
      },
    });
    // Doc_H §15 — recording feedback satisfies one of the eight closure conditions.
    await tx.closureChecklist.upsert({
      where: { projectId: String(data.projectId) },
      create: { projectId: String(data.projectId), feedbackRecorded: true, updatedById: actorId },
      update: { feedbackRecorded: true, updatedById: actorId },
    });
    return { entity: 'feedback', entityId: fb.id };
  },

  lessonLearned: async ({ tx, data, actorId, organizationId }) => {
    const ll = await tx.lessonLearned.create({
      data: {
        organizationId,
        projectId: String(data.projectId),
        title: String(data.title),
        category: String(data.category),
        situation: String(data.situation),
        lesson: String(data.lesson),
        recommendation: String(data.recommendation),
        recordedById: actorId,
      },
    });
    await tx.closureChecklist.upsert({
      where: { projectId: String(data.projectId) },
      create: { projectId: String(data.projectId), lessonsLearnedRecorded: true, updatedById: actorId },
      update: { lessonsLearnedRecorded: true, updatedById: actorId },
    });
    return { entity: 'lessonLearned', entityId: ll.id };
  },

  closureChecklist: async ({ tx, data, actorId }) => {
    const projectId = String(data.projectId);
    const cl = await tx.closureChecklist.upsert({
      where: { projectId },
      create: {
        projectId,
        allDeliverablesDelivered: !!data.allDeliverablesDelivered,
        finalQcDone: !!data.finalQcDone,
        clientApprovalRecorded: !!data.clientApprovalRecorded,
        closureReportDone: !!data.closureReportDone,
        financialStatusClear: !!data.financialStatusClear,
        feedbackRecorded: !!data.feedbackRecorded,
        lessonsLearnedRecorded: !!data.lessonsLearnedRecorded,
        notes: str(data.notes),
        updatedById: actorId,
      },
      update: {
        allDeliverablesDelivered: !!data.allDeliverablesDelivered,
        finalQcDone: !!data.finalQcDone,
        clientApprovalRecorded: !!data.clientApprovalRecorded,
        closureReportDone: !!data.closureReportDone,
        financialStatusClear: !!data.financialStatusClear,
        feedbackRecorded: !!data.feedbackRecorded,
        lessonsLearnedRecorded: !!data.lessonsLearnedRecorded,
        notes: str(data.notes),
        updatedById: actorId,
      },
    });
    return { entity: 'closureChecklist', entityId: cl.id };
  },

  outsourceRequest: async ({ tx, data, actorId, organizationId }) => {
    const req = await tx.outsourceRequest.create({
      data: {
        organizationId,
        code: await nextCode(tx, 'outsourceRequest'),
        projectId: String(data.projectId),
        kind: String(data.kind ?? 'FREELANCER'),
        proposedSupplierName: str(data.supplierName),
        scopeOfWork: String(data.scopeOfWork),
        estimatedCost: num(data.estimatedCost) ?? 0,
        neededBy: date(data.neededBy) ?? new Date(Date.now() + 7 * 86_400_000),
        justification: String(data.justification),
        requestedById: actorId,
      },
    });
    return { entity: 'outsourceRequest', entityId: req.id };
  },

  supplierEvaluation: async ({ tx, data, actorId }) => {
    const supplierId = String(data.supplierId);
    const ev = await tx.supplierEvaluation.create({
      data: {
        supplierId,
        projectId: data.projectId ? String(data.projectId) : null,
        quality: Number(data.quality),
        timeliness: Number(data.timeliness),
        communication: Number(data.communication),
        costValue: Number(data.costValue),
        wouldReuse: String(data.wouldReuse) === 'YES' || data.wouldReuse === true,
        comments: str(data.comments),
        evaluatedById: actorId,
      },
    });
    const agg = await tx.supplierEvaluation.aggregate({
      where: { supplierId },
      _avg: { quality: true, timeliness: true, communication: true, costValue: true },
    });
    const avg =
      ((agg._avg.quality ?? 0) + (agg._avg.timeliness ?? 0) + (agg._avg.communication ?? 0) + (agg._avg.costValue ?? 0)) / 4;
    await tx.supplier.update({ where: { id: supplierId }, data: { averageRating: avg } });
    return { entity: 'supplierEvaluation', entityId: ev.id };
  },

  allocation: async ({ tx, data, actorId }) => {
    const a = await tx.allocation.create({
      data: {
        projectId: String(data.projectId),
        userId: String(data.userId),
        fromDate: date(data.fromDate)!,
        toDate: date(data.toDate)!,
        hoursPerDay: Number(data.hoursPerDay),
        notes: str(data.notes),
        createdById: actorId,
      },
    });
    return { entity: 'allocation', entityId: a.id };
  },

  /** Form L107 — client acceptance ticks a Doc_H §15 closure condition. */
  clientApproval: async ({ tx, data, actorId }) => {
    const deliverableId = String(data.deliverableId);
    const deliverable = await tx.deliverable.findUnique({ where: { id: deliverableId } });
    if (deliverable && String(data.verdict) === 'PASSED') {
      await tx.closureChecklist.upsert({
        where: { projectId: deliverable.projectId },
        create: { projectId: deliverable.projectId, clientApprovalRecorded: true, updatedById: actorId },
        update: { clientApprovalRecorded: true, updatedById: actorId },
      });
    }
    return { entity: 'deliverable', entityId: deliverableId };
  },

  taskAcceptance: async ({ tx, data }) => ({ entity: 'workOrder', entityId: String(data.workOrderId) }),
  deliverableSubmission: async ({ tx, data }) => ({
    entity: 'deliverable',
    entityId: String(data.deliverableId ?? data.workOrderId),
  }),
  clientFeedback: async ({ tx, data }) => ({ entity: 'proposal', entityId: String(data.proposalId) }),
};
