import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, get, login, move, patch, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * End-to-end business scenarios — the 100-step Doc_H lifecycle
 * («الگوریتم جامع مسیر مشتری تا پایان پروژه») driven through the real API.
 * State carries forward between tests, so the file runs as one continuous story.
 */
let T: Record<string, string>;
const ctx: Record<string, string> = {};

const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(async () => {
  T = {
    ceo: await login('ceo@hiva.local'),
    deputy: await login('deputy@hiva.local'),
    salesManager: await login('sales.manager@hiva.local'),
    sales: await login('sales@hiva.local'),
    accountManager: await login('account.manager@hiva.local'),
    account: await login('account@hiva.local'),
    creative: await login('creative@hiva.local'),
    designer: await login('designer@hiva.local'),
    strategy: await login('strategy@hiva.local'),
    finance: await login('finance@hiva.local'),
    legal: await login('legal@hiva.local'),
    pmo: await login('pmo@hiva.local'),
  };
  const me = (t: string) => get('/auth/me', t).then((r) => r.body.id as string);
  ctx.accountManagerId = await me(T.accountManager);
  ctx.creativeId = await me(T.creative);
  ctx.designerId = await me(T.designer);
  ctx.strategyId = await me(T.strategy);
});

afterAll(async () => { await closeApp(); });

/* ═══════ Scenario 1 — Lead → Opportunity → Brief → Account ═══════ */
describe('Scenario 1 — acquisition: Lead → Opportunity → Brief → Account', () => {
  it('Sales registers and qualifies a lead', async () => {
    const lead = expectOk(await post('/leads', T.sales, {
      name: 'سرنخ کمپین نوروزی', companyName: 'گروه صنعتی سپهر',
      contactName: 'واحد بازاریابی', phone: '021-44556677',
      source: 'REFERRAL', estimatedValue: 5_000_000_000,
      need: 'کمپین نوروزی برند',
    }), 'create lead');
    ctx.leadId = lead.id;
    expect(lead.state).toBe('NEW');
    expect(lead.code).toMatch(/^LEAD-\d{6}$/);

    expectOk(await move('lead', lead.id, 'contact', T.sales), 'contact');
    const qualified = expectOk(await move('lead', lead.id, 'qualify', T.sales), 'qualify');
    expect(qualified.toState).toBe('QUALIFIED');
  });

  it('converts the lead to an opportunity, creating the customer record', async () => {
    const opp = expectOk(await post(`/leads/${ctx.leadId}/convert`, T.sales, {
      title: 'کمپین نوروزی سپهر', estimatedValue: 5_000_000_000,
    }), 'convert lead');
    ctx.opportunityId = opp.id;
    ctx.companyId = opp.companyId;
    expect(opp.code).toMatch(/^OPP-\d{6}$/);

    const lead = await prisma.lead.findUnique({ where: { id: ctx.leadId } });
    expect(lead!.state).toBe('CONVERTED');
  });

  it('Sales prepares a complete brief and submits it to Account', async () => {
    expectOk(await move('opportunity', ctx.opportunityId, 'qualify', T.sales), 'qualify opp');
    expectOk(await move('opportunity', ctx.opportunityId, 'request_brief', T.sales), 'request brief');

    const brief = expectOk(await post('/briefs', T.sales, {
      opportunityId: ctx.opportunityId,
      title: 'بریف کمپین نوروزی سپهر',
      businessObjective: 'افزایش فروش فصلی و آگاهی از برند',
      targetAudience: 'خانواده‌های شهری ۲۵ تا ۵۰ سال',
      scope: 'استراتژی، کانسپت خلاق، تولید تیزر، برنامه رسانه‌ای',
      expectedDeliverables: 'سند استراتژی، کی‌ویژوال، تیزر ۳۰ ثانیه، مدیاپلن',
      budgetRange: 4_800_000_000,
      desiredDeadline: soon(60),
      unitsNeeded: ['ST', 'CR', 'ME'],
      successCriteria: 'رشد ۲۰٪ فروش نوروزی',
    }), 'create brief');
    ctx.briefId = brief.id;

    expectOk(await post(`/briefs/${brief.id}/recalculate`, T.sales), 'recalculate');
    expectOk(await move('brief', brief.id, 'submit', T.sales), 'submit brief');
    const reviewed = expectOk(await move('brief', brief.id, 'start_review', T.accountManager), 'start review');
    expect(reviewed.toState).toBe('UNDER_REVIEW');
  });

  it('starts the Doc_H brief-acknowledgement SLA clock on submission', async () => {
    const clocks = await prisma.slaClock.findMany({
      where: { entityType: 'brief', entityId: ctx.briefId }, include: { policy: true },
    });
    expect(clocks.length).toBeGreaterThan(0);
    expect(clocks.map((c) => c.policy.code)).toContain('SLA_BRIEF_ACK');
    // The ack clock is stopped by start_review; the review clock takes over.
    const ack = clocks.find((c) => c.policy.code === 'SLA_BRIEF_ACK');
    expect(['MET', 'BREACHED']).toContain(ack!.state);
  });
});

/* ═══════ Scenario 2 — incomplete brief returns to Sales ═══════ */
describe('Scenario 2 — incomplete brief is returned to Sales and completed', () => {
  it('blocks approval of an incomplete brief and returns it', async () => {
    const opp = expectOk(await post('/opportunities', T.sales, {
      title: 'فرصت با بریف ناقص', companyId: ctx.companyId, estimatedValue: 800_000_000,
    }), 'create opp');
    const brief = expectOk(await post('/briefs', T.sales, {
      opportunityId: opp.id, title: 'بریف ناقص',
      businessObjective: 'هدف اولیه', // scope / deliverables / budget / deadline deliberately absent
    }), 'create incomplete brief');
    ctx.incompleteBriefId = brief.id;

    expectOk(await move('brief', brief.id, 'submit', T.sales), 'submit');
    expectOk(await move('brief', brief.id, 'start_review', T.accountManager), 'review');

    const blocked = await move('brief', brief.id, 'approve', T.accountManager);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.missing).toContain('Scope درخواستی');

    const returned = expectOk(
      await move('brief', brief.id, 'return_incomplete', T.accountManager, 'Scope، خروجی‌ها، بودجه و زمان‌بندی مشخص نیست'),
      'return incomplete',
    );
    expect(returned.toState).toBe('RETURNED_INCOMPLETE');
    expect(returned.record.returnCount).toBe(1);
  });

  it('accepts the brief once Sales completes the missing fields', async () => {
    expectOk(await patch(`/briefs/${ctx.incompleteBriefId}`, T.sales, {
      scope: 'طراحی هویت بصری',
      expectedDeliverables: 'لوگو، گاید برند',
      budgetRange: 700_000_000,
      desiredDeadline: soon(45),
      targetAudience: 'کسب‌وکارهای کوچک',
    }), 'complete brief');
    expectOk(await post(`/briefs/${ctx.incompleteBriefId}/recalculate`, T.sales), 'recalc');
    expectOk(await move('brief', ctx.incompleteBriefId, 'submit', T.sales), 'resubmit');
    expectOk(await move('brief', ctx.incompleteBriefId, 'start_review', T.accountManager), 'review');
    const approved = expectOk(await move('brief', ctx.incompleteBriefId, 'approve', T.accountManager), 'approve');
    expect(approved.toState).toBe('APPROVED');
  });
});

/* ═══════ Scenario 3 — Brief → Proposal → unit orders → execution ═══════ */
describe('Scenario 3 — Account converts the brief into work orders', () => {
  it('approves the main brief and opens a proposal', async () => {
    const approved = expectOk(await move('brief', ctx.briefId, 'approve', T.accountManager), 'approve brief');
    expect(approved.toState).toBe('APPROVED');

    const proposal = expectOk(await post('/proposals', T.accountManager, {
      briefId: ctx.briefId,
      title: 'پروپوزال کمپین نوروزی سپهر',
      executiveSummary: 'کمپین یکپارچه نوروزی',
      approach: 'استراتژی + خلاقیت + رسانه',
    }), 'create proposal');
    ctx.proposalId = proposal.id;
    expect(proposal.state).toBe('DRAFT');
  });

  it('issues a work order to each execution unit with the nine mandatory elements', async () => {
    const project = expectOk(await post('/projects', T.accountManager, {
      name: 'کمپین نوروزی سپهر', companyId: ctx.companyId,
      briefId: ctx.briefId, proposalId: ctx.proposalId,
      accountOwnerId: ctx.accountManagerId,
      objective: 'اجرای کمپین نوروزی',
      inScope: 'استراتژی، خلاقیت، رسانه',
      outOfScope: 'رویداد حضوری و BTL',
      plannedStart: soon(1), plannedEnd: soon(60), plannedBudget: 3_200_000_000,
    }), 'create project');
    ctx.projectId = project.id;

    const orders: Record<string, string> = {};
    for (const [unit, owner, title] of [
      ['ST', ctx.strategyId, 'تدوین استراتژی کمپین'],
      ['CR', ctx.creativeId, 'کانسپت خلاق و کی‌ویژوال'],
    ] as const) {
      const wo = expectOk(await post('/work-orders', T.accountManager, {
        projectId: ctx.projectId, proposalId: ctx.proposalId,
        targetDepartmentCode: unit, title,
        scopeOfWork: title, brief: 'مطابق بریف تأییدشده',
        expectedOutput: 'سند نهایی مطابق استاندارد هیوا',
        outputFormat: 'PDF', deadline: soon(20),
        ownerId: owner, budget: 900_000_000, priority: 'HIGH',
      }), `create WO ${unit}`);
      orders[unit] = wo.id;
    }
    ctx.woStrategy = orders.ST;
    ctx.woCreative = orders.CR;

    expectOk(await move('proposal', ctx.proposalId, 'dispatch_orders', T.accountManager), 'dispatch');
  });

  it('refuses to issue a work order missing a mandatory element', async () => {
    const res = await post('/work-orders', T.accountManager, {
      projectId: ctx.projectId, targetDepartmentCode: 'ME', title: 'سفارش ناقص',
      scopeOfWork: 'x', brief: 'y', expectedOutput: 'z',
      outputFormat: '', deadline: soon(10), ownerId: ctx.creativeId,
    });
    expect(res.status).toBe(400);
  });

  it('the unit accepts the order within the 4-hour acceptance SLA', async () => {
    expectOk(await move('workOrder', ctx.woStrategy, 'issue', T.accountManager), 'issue ST');
    expectOk(await move('workOrder', ctx.woCreative, 'issue', T.accountManager), 'issue CR');

    const clock = await prisma.slaClock.findFirst({
      where: { entityType: 'workOrder', entityId: ctx.woStrategy }, include: { policy: true },
    });
    expect(clock?.policy.code).toBe('SLA_TASK_ACCEPTANCE');

    expectOk(await move('workOrder', ctx.woStrategy, 'accept', T.strategy), 'accept ST');
    expectOk(await move('workOrder', ctx.woCreative, 'accept', T.creative), 'accept CR');

    const stopped = await prisma.slaClock.findFirst({
      where: { entityType: 'workOrder', entityId: ctx.woStrategy },
    });
    expect(stopped!.state).toBe('MET');
  });

  it('creates deliverables and tasks traceable to the order form', async () => {
    for (const [unit, woId, name, key] of [
      ['ST', ctx.woStrategy, 'سند استراتژی کمپین', 'delivStrategy'],
      ['CR', ctx.woCreative, 'کی‌ویژوال کمپین', 'delivCreative'],
    ] as const) {
      const deliverable = expectOk(await post('/deliverables', T.accountManager, {
        projectId: ctx.projectId, proposalId: ctx.proposalId,
        name, departmentCode: unit, format: 'PDF', dueDate: soon(18),
      }), `deliverable ${unit}`);
      ctx[key] = deliverable.id;

      const wo = await prisma.workOrder.findUnique({ where: { id: woId } });
      await prisma.deliverable.update({ where: { id: deliverable.id }, data: { workOrderId: woId } });

      const task = expectOk(await post('/tasks', T.accountManager, {
        projectId: ctx.projectId, workOrderId: woId, deliverableId: deliverable.id,
        title: name, departmentCode: unit,
        assigneeId: unit === 'CR' ? ctx.designerId : ctx.strategyId,
        dueDate: soon(15), estimateHours: 32, priority: 'HIGH',
        sourceType: 'ORDER_FORM', sourceRef: wo!.code,
      }), `task ${unit}`);
      ctx[`task${unit}`] = task.id;
      expect(task.sourceRef).toBe(wo!.code);
    }
  });
});

/* ═══════ Scenario 4 — QC rejection → revision → QC approval ═══════ */
describe('Scenario 4 — QC rejection raises a revision, rework passes QC', () => {
  it('runs the creative task to submission', async () => {
    expectOk(await move('workOrder', ctx.woCreative, 'start', T.creative), 'start WO');
    expectOk(await move('task', ctx.taskCR, 'accept', T.designer), 'accept task');
    expectOk(await move('task', ctx.taskCR, 'start', T.designer), 'start task');
    expectOk(await move('task', ctx.taskCR, 'submit', T.designer), 'submit task');
    expectOk(await move('deliverable', ctx.delivCreative, 'start', T.creative), 'start deliverable');
    expectOk(await move('deliverable', ctx.delivCreative, 'submit', T.creative), 'submit deliverable');
  });

  it('records a level-1 unit QC pass', async () => {
    const qc = expectOk(await post('/qc-reviews', T.creative, {
      level: 'UNIT', deliverableId: ctx.delivCreative, verdict: 'PASSED',
      checklist: { matchesBrief: true, technicallySound: true, brandCompliant: true },
    }), 'unit QC');
    expect(qc.review.level).toBe('UNIT');
    expect(qc.revision).toBeNull();
  });

  it('a failed Account QC automatically raises a revision carrying its reason', async () => {
    expectOk(await move('deliverable', ctx.delivCreative, 'send_to_qc', T.accountManager), 'to QC');
    const result = expectOk(await post('/qc-reviews', T.accountManager, {
      level: 'ACCOUNT', deliverableId: ctx.delivCreative, verdict: 'FAILED',
      checklist: { matchesBrief: false, matchesScope: true },
      findings: 'کی‌ویژوال با لحن برند در بریف هم‌راستا نیست',
    }), 'account QC fail');

    expect(result.review.verdict).toBe('FAILED');
    expect(result.revision).not.toBeNull();
    expect(result.revision.reason).toBe('BRIEF_MISMATCH');
    expect(result.revision.requiredCorrection).toContain('کی‌ویژوال');
    ctx.revisionId = result.revision.id;

    const deliverable = await prisma.deliverable.findUnique({ where: { id: ctx.delivCreative } });
    expect(deliverable!.state).toBe('REVISION_REQUIRED');
  });

  it('runs the revision loop through to an approved deliverable', async () => {
    await prisma.revision.update({
      where: { id: ctx.revisionId }, data: { assigneeId: ctx.designerId },
    });
    expectOk(await move('revision', ctx.revisionId, 'assign', T.accountManager), 'assign revision');
    expectOk(await move('revision', ctx.revisionId, 'start', T.designer), 'start revision');
    expectOk(await move('revision', ctx.revisionId, 'submit', T.designer), 'submit revision');
    expectOk(await move('revision', ctx.revisionId, 'send_to_qc', T.accountManager), 'revision to QC');
    const approved = expectOk(await move('revision', ctx.revisionId, 'approve', T.accountManager), 'approve revision');
    expect(approved.toState).toBe('APPROVED');

    expectOk(await move('deliverable', ctx.delivCreative, 'submit', T.creative), 'resubmit');
    expectOk(await move('deliverable', ctx.delivCreative, 'send_to_qc', T.accountManager), 'to QC again');
    expectOk(await post('/qc-reviews', T.accountManager, {
      level: 'ACCOUNT', deliverableId: ctx.delivCreative, verdict: 'PASSED',
      checklist: { matchesBrief: true, matchesScope: true, matchesKickoff: true, deliverablesComplete: true },
    }), 'account QC pass');
    const ok = expectOk(await move('deliverable', ctx.delivCreative, 'qc_approve', T.accountManager), 'qc approve');
    expect(ok.toState).toBe('APPROVED');
  });
});

/* ═══════ Scenario 5 & 6 — pricing, Final QC, client feedback loops ═══════ */
describe('Scenario 5/6 — pricing gate, Final QC and the client feedback loop', () => {
  it('blocks integration until every unit output is in', async () => {
    const blocked = await move('proposal', ctx.proposalId, 'integrate', T.accountManager);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.pending.length).toBeGreaterThan(0);
  });

  it('completes the strategy stream, then integration succeeds', async () => {
    expectOk(await move('workOrder', ctx.woStrategy, 'start', T.strategy), 'start ST');
    expectOk(await move('task', ctx.taskST, 'accept', T.strategy), 'accept');
    expectOk(await move('task', ctx.taskST, 'start', T.strategy), 'start');
    expectOk(await move('task', ctx.taskST, 'submit', T.strategy), 'submit');
    expectOk(await move('deliverable', ctx.delivStrategy, 'start', T.strategy), 'start deliv');
    expectOk(await move('deliverable', ctx.delivStrategy, 'submit', T.strategy), 'submit deliv');
    expectOk(await post('/qc-reviews', T.strategy, {
      level: 'UNIT', deliverableId: ctx.delivStrategy, verdict: 'PASSED', checklist: { matchesBrief: true },
    }), 'unit QC ST');

    // Doc_H §12 — cost must be declared before the order can be submitted.
    for (const [woId, unit, token, cost] of [
      [ctx.woStrategy, 'ST', T.strategy, 850_000_000],
      [ctx.woCreative, 'CR', T.creative, 1_400_000_000],
    ] as const) {
      expectOk(await post(`/work-orders/${woId}/cost`, token, {
        departmentCode: unit, internalCost: cost * 0.7, externalCost: cost * 0.3,
        items: [{ description: 'اجرای تخصصی', quantity: 1, unitCost: cost }],
      }), `cost ${unit}`);
    }

    expectOk(await move('workOrder', ctx.woStrategy, 'submit', T.strategy), 'submit ST');
    expectOk(await move('workOrder', ctx.woCreative, 'submit', T.creative), 'submit CR');
    const integrated = expectOk(await move('proposal', ctx.proposalId, 'integrate', T.accountManager), 'integrate');
    expect(integrated.toState).toBe('INTEGRATION');
  });

  it('denies the execution unit any ability to set the sale price', async () => {
    const res = await post(`/proposals/${ctx.proposalId}/pricing`, T.creative, {
      salePrice: 9_999_999, rationale: 'تلاش واحد اجرایی',
    });
    expect(res.status).toBe(403);
  });

  it('Account prices it and management approves — two different people', async () => {
    expectOk(await move('proposal', ctx.proposalId, 'send_to_pricing', T.accountManager), 'to pricing');
    const priced = expectOk(await post(`/proposals/${ctx.proposalId}/pricing`, T.accountManager, {
      salePrice: 3_400_000_000, paymentTerms: '۴۰/۳۰/۳۰',
      contractScaleBand: 'M', rationale: 'حاشیه سود هدف ۳۳٪',
    }), 'set price');
    expect(Number(priced.salePrice)).toBe(3_400_000_000);
    expect(Number(priced.marginPercent)).toBeGreaterThan(0);
    expect(priced.pricingApprovedAt).toBeNull();

    const approved = expectOk(await post(`/proposals/${ctx.proposalId}/pricing/approve`, T.deputy), 'approve price');
    expect(approved.pricingApprovedAt).not.toBeNull();
  });

  it('blocks proposal approval before Final QC, then allows it after', async () => {
    expectOk(await move('proposal', ctx.proposalId, 'send_to_final_qc', T.accountManager), 'to final QC');
    const blocked = await move('proposal', ctx.proposalId, 'approve', T.accountManager);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.rule).toContain('QC سطح ۳');

    expectOk(await post('/qc-reviews', T.accountManager, {
      level: 'FINAL', proposalId: ctx.proposalId, verdict: 'PASSED',
      checklist: { proposalComplete: true, pricingReviewed: true, qualityAcceptable: true, clientReady: true },
    }), 'final QC');
    const ok = expectOk(await move('proposal', ctx.proposalId, 'approve', T.accountManager), 'approve proposal');
    expect(ok.toState).toBe('APPROVED');
  });

  it('hands the proposal to Sales, who presents it and records a revision request', async () => {
    expectOk(await move('proposal', ctx.proposalId, 'deliver_to_sales', T.accountManager), 'deliver');
    expectOk(await move('proposal', ctx.proposalId, 'present', T.sales), 'present');
    const revision = expectOk(
      await move('proposal', ctx.proposalId, 'client_request_revision', T.sales, 'مشتری تخفیف و تغییر ترکیب رسانه خواست'),
      'client revision',
    );
    expect(revision.toState).toBe('CLIENT_REVISION_REQUESTED');
    expect(revision.record.revisionCount).toBe(1);
  });

  it('reworks the proposal, snapshotting the superseded version', async () => {
    const reworked = expectOk(await move('proposal', ctx.proposalId, 'rework', T.accountManager), 'rework');
    expect(reworked.toState).toBe('INTEGRATION');
    expect(reworked.record.version).toBe(2);
    const versions = await prisma.proposalVersion.findMany({ where: { proposalId: ctx.proposalId } });
    expect(versions.length).toBe(1);
  });

  it('re-runs pricing and Final QC, then the client approves', async () => {
    expectOk(await move('proposal', ctx.proposalId, 'send_to_pricing', T.accountManager), 'pricing again');
    expectOk(await post(`/proposals/${ctx.proposalId}/pricing`, T.accountManager, {
      salePrice: 3_150_000_000, rationale: 'اعمال تخفیف توافق‌شده',
    }), 'reprice');
    expectOk(await post(`/proposals/${ctx.proposalId}/pricing/approve`, T.deputy), 'approve price');
    expectOk(await move('proposal', ctx.proposalId, 'send_to_final_qc', T.accountManager), 'final QC');
    expectOk(await post('/qc-reviews', T.accountManager, {
      level: 'FINAL', proposalId: ctx.proposalId, verdict: 'PASSED', checklist: { clientReady: true },
    }), 'final QC pass');
    expectOk(await move('proposal', ctx.proposalId, 'approve', T.accountManager), 'approve');
    expectOk(await move('proposal', ctx.proposalId, 'deliver_to_sales', T.accountManager), 'deliver');
    expectOk(await move('proposal', ctx.proposalId, 'present', T.sales), 'present');
    const won = expectOk(await move('proposal', ctx.proposalId, 'client_approve', T.sales), 'client approve');
    expect(won.toState).toBe('CLIENT_APPROVED');
  });
});

/* ═══════ Scenario 7 — contract → authorization → project start ═══════ */
describe('Scenario 7 — contract, authorization and project start', () => {
  it('drafts, reviews and registers the contract', async () => {
    const contract = expectOk(await post('/contracts', T.accountManager, {
      companyId: ctx.companyId, proposalId: ctx.proposalId, projectId: ctx.projectId,
      title: 'قرارداد کمپین نوروزی سپهر', contractValue: 3_150_000_000,
      startDate: soon(2), endDate: soon(70),
      scopeSummary: 'مطابق پروپوزال نسخه ۲', paymentTerms: '۴۰/۳۰/۳۰',
    }), 'create contract');
    ctx.contractId = contract.id;

    expectOk(await move('contract', contract.id, 'start_drafting', T.legal), 'draft');
    expectOk(await move('contract', contract.id, 'send_to_legal', T.legal), 'to legal');
    expectOk(await move('contract', contract.id, 'approve', T.legal), 'approve');
    expectOk(await move('contract', contract.id, 'send_for_signature', T.legal), 'to signature');
    expectOk(await move('contract', contract.id, 'sign', T.legal), 'sign');
    const registered = expectOk(
      await move('contract', contract.id, 'register', T.legal, undefined, { contractNumber: 'HV-TEST-001' }),
      'register',
    );
    expect(registered.toState).toBe('REGISTERED');
  });

  it('blocks activation before authorization, then permits it after', async () => {
    expectOk(await move('project', ctx.projectId, 'request_authorization', T.accountManager), 'request auth');

    const blocked = await move('project', ctx.projectId, 'authorize', T.deputy);
    expect(blocked.status).toBe(422);

    expectOk(await post(`/projects/${ctx.projectId}/authorize`, T.deputy, {
      basis: 'CONTRACT', contractId: ctx.contractId, referenceDocument: 'HV-TEST-001',
    }), 'record authorization');

    const authorized = expectOk(await move('project', ctx.projectId, 'authorize', T.deputy), 'authorize');
    expect(authorized.toState).toBe('AUTHORIZED');
  });

  it('requires a schedule and RACI before the project can go active', async () => {
    expectOk(await move('project', ctx.projectId, 'start_planning', T.accountManager), 'planning');

    const noRaci = await move('project', ctx.projectId, 'activate', T.accountManager);
    expect(noRaci.status).toBe(422);
    expect(noRaci.body.error.details.rule).toContain('RACI');

    expectOk(await post(`/projects/${ctx.projectId}/raci`, T.accountManager, {
      entries: [
        { activity: 'مدیریت پروژه و ارتباط با مشتری', departmentCode: 'A', raciRole: 'A' },
        { activity: 'تدوین استراتژی', departmentCode: 'ST', raciRole: 'R' },
        { activity: 'تولید خلاق', departmentCode: 'CR', raciRole: 'R' },
        { activity: 'کنترل ظرفیت', departmentCode: 'OP', raciRole: 'C' },
      ],
    }), 'set RACI');
    expectOk(await post(`/projects/${ctx.projectId}/milestones`, T.accountManager, {
      name: 'تأیید کی‌ویژوال', dueDate: soon(20),
    }), 'milestone');

    const active = expectOk(await move('project', ctx.projectId, 'activate', T.accountManager), 'activate');
    expect(active.toState).toBe('ACTIVE');
  });
});

/* ═══════ Scenarios 8, 9, 10 — change control ═══════ */
describe('Scenarios 8/9/10 — in-scope and out-of-scope change control', () => {
  it('an in-scope change is approved without a commercial gate', async () => {
    const cr = expectOk(await post('/change-requests', T.accountManager, {
      projectId: ctx.projectId, title: 'تغییر رنگ در کی‌ویژوال',
      requestedChange: 'اصلاح پالت رنگی مطابق راهنمای برند',
      requestedBy: 'CLIENT', requestedDate: new Date().toISOString(),
    }), 'create in-scope CR');

    expectOk(await move('changeRequest', cr.id, 'start_scope_review', T.accountManager), 'scope review');
    expectOk(await post(`/change-requests/${cr.id}/scope-review`, T.accountManager, {
      verdict: 'IN_SCOPE', rationale: 'در محدوده تولید خلاق قرارداد است',
    }), 'verdict');
    const approved = expectOk(await move('changeRequest', cr.id, 'approve_in_scope', T.accountManager), 'approve');
    expect(approved.toState).toBe('APPROVED');
    expectOk(await move('changeRequest', cr.id, 'implement', T.accountManager), 'implement');
  });

  it('an out-of-scope change runs the full commercial → customer → amendment chain', async () => {
    const cr = expectOk(await post('/change-requests', T.accountManager, {
      projectId: ctx.projectId, title: 'افزودن کمپین دیجیتال',
      requestedChange: 'مشتری اجرای کمپین performance را نیز می‌خواهد',
      requestedBy: 'CLIENT', requestedDate: new Date().toISOString(), priority: 'HIGH',
    }), 'create CR');
    ctx.changeRequestId = cr.id;

    expectOk(await move('changeRequest', cr.id, 'start_scope_review', T.accountManager), 'scope review');
    expectOk(await post(`/change-requests/${cr.id}/scope-review`, T.accountManager, {
      verdict: 'OUT_OF_SCOPE', rationale: 'کمپین دیجیتال در Scope قرارداد نیست',
    }), 'verdict');
    expectOk(await move('changeRequest', cr.id, 'start_commercial_review', T.accountManager), 'commercial');

    const premature = await move('changeRequest', cr.id, 'send_to_customer', T.accountManager);
    expect(premature.status).toBe(422);

    expectOk(await post(`/change-requests/${cr.id}/impact`, T.accountManager, {
      timeImpactDays: 14, costImpact: 600_000_000,
      resourceImpact: 'نیاز به ۲ نفر از واحد دیجیتال',
      scopeImpact: 'افزودن کمپین performance به Deliverableها',
      qualityImpact: 'بدون اثر منفی',
      contractImpact: 'نیاز به الحاقیه قرارداد',
      proposedPrice: 900_000_000,
    }), 'impact');

    expectOk(await move('changeRequest', cr.id, 'send_to_customer', T.accountManager), 'to customer');
    expectOk(await move('changeRequest', cr.id, 'customer_approve', T.accountManager), 'customer approve');

    const amendment = expectOk(await post(`/contracts/${ctx.contractId}/amendments`, T.legal, {
      changeRequestId: cr.id, amendmentNumber: 'AM-001',
      effectiveDate: new Date().toISOString(),
      changes: 'افزودن کمپین دیجیتال به Scope',
      valueDelta: 900_000_000, durationDeltaDays: 14,
    }), 'amendment');
    expect(Number(amendment.valueDelta)).toBe(900_000_000);

    const contract = await prisma.contract.findUnique({ where: { id: ctx.contractId } });
    expect(Number(contract!.contractValue)).toBe(3_150_000_000 + 900_000_000);

    expectOk(await move('changeRequest', cr.id, 'implement', T.accountManager), 'implement');
    expectOk(await move('changeRequest', cr.id, 'close', T.accountManager), 'close');
  });
});

/* ═══════ Scenario 11 — delay → risk → escalation ═══════ */
describe('Scenario 11 — delay produces a risk and surfaces in reporting', () => {
  it('records a blocked task, a risk and an issue', async () => {
    expectOk(await move('task', ctx.taskST, 'send_to_qc', T.strategy), 'to QC');
    expectOk(await move('task', ctx.taskST, 'qc_reject', T.accountManager, 'خروجی نیاز به تکمیل دارد'), 'reject');

    const risk = expectOk(await post('/risks', T.accountManager, {
      projectId: ctx.projectId, title: 'ریسک تأخیر در تأیید مشتری',
      description: 'کمیته برند مشتری جلسات دوهفته‌ای دارد',
      probability: 'HIGH', impact: 'HIGH',
      mitigation: 'تعیین مهلت قراردادی برای تأیید',
      ownerId: ctx.accountManagerId,
    }), 'create risk');
    expect(risk.code).toMatch(/^RSK-\d{6}$/);

    expectOk(await post('/issues', T.accountManager, {
      projectId: ctx.projectId, title: 'کمبود ظرفیت واحد خلاقیت',
      description: 'دو پروژه هم‌زمان', severity: 'HIGH', ownerId: ctx.accountManagerId,
    }), 'create issue');
  });

  it('surfaces the delay in Project 360 and the executive dashboard', async () => {
    await prisma.task.updateMany({
      where: { projectId: ctx.projectId },
      data: { dueDate: new Date(Date.now() - 3 * 86_400_000) },
    });
    const view = expectOk(await get(`/projects/${ctx.projectId}/360`, T.accountManager), 'project 360');
    expect(view.metrics.overdueTasks).toBeGreaterThan(0);
    expect(view.metrics.openRisks).toBeGreaterThan(0);
    expect(view.metrics.openIssues).toBeGreaterThan(0);

    const exec = expectOk(await get('/reports/executive', T.deputy), 'executive');
    expect(exec.delivery.overdueTasks).toBeGreaterThan(0);
    expect(exec.governance.openRisks).toBeGreaterThan(0);
  });
});

/* ═══════ Scenario 12 — delivery → settlement → closure ═══════ */
describe('Scenario 12 — final delivery, settlement and eight-condition closure', () => {
  it('delivers accepted deliverables to the client', async () => {
    expectOk(await move('deliverable', ctx.delivCreative, 'deliver', T.accountManager), 'deliver CR');
    expectOk(await move('deliverable', ctx.delivCreative, 'client_accept', T.accountManager), 'accept CR');

    expectOk(await move('deliverable', ctx.delivStrategy, 'send_to_qc', T.accountManager), 'ST to QC');
    expectOk(await post('/qc-reviews', T.accountManager, {
      level: 'ACCOUNT', deliverableId: ctx.delivStrategy, verdict: 'PASSED',
      checklist: { matchesBrief: true, matchesScope: true },
    }), 'ST QC');
    expectOk(await move('deliverable', ctx.delivStrategy, 'qc_approve', T.accountManager), 'ST approve');
    expectOk(await move('deliverable', ctx.delivStrategy, 'deliver', T.accountManager), 'ST deliver');
    expectOk(await move('deliverable', ctx.delivStrategy, 'client_accept', T.accountManager), 'ST accept');
  });

  it('invoices, receives payment and settles the project', async () => {
    const invoice = expectOk(await post('/invoices', T.finance, {
      kind: 'INVOICE', companyId: ctx.companyId, projectId: ctx.projectId,
      contractId: ctx.contractId, number: `F-TEST-${Date.now()}`,
      issueDate: new Date().toISOString(), dueDate: soon(30), taxPercent: 10,
      lines: [{ description: 'کمپین نوروزی — کل قرارداد', quantity: 1, unitPrice: 4_050_000_000 }],
    }), 'create invoice');
    expect(Number(invoice.total)).toBe(4_050_000_000 * 1.1);

    expectOk(await post('/payments', T.finance, {
      invoiceId: invoice.id, projectId: ctx.projectId, direction: 'IN',
      amount: Number(invoice.total), occurredAt: new Date().toISOString(), method: 'TRANSFER',
    }), 'payment');

    const paid = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(paid!.state).toBe('PAID');

    const settlement = expectOk(await post(`/projects/${ctx.projectId}/settle`, T.finance, {
      notes: 'تسویه کامل',
    }), 'settle');
    expect(settlement.status).toBe('FULLY_SETTLED');
  });

  it('reports project profitability from declared costs', async () => {
    const fin = expectOk(await get(`/projects/${ctx.projectId}/finance`, T.finance), 'finance');
    expect(fin.actualCost).toBe(850_000_000 + 1_400_000_000);
    expect(fin.revenue).toBe(4_050_000_000);
    expect(fin.margin).toBe(4_050_000_000 - 2_250_000_000);
    expect(fin.marginPercent).toBeGreaterThan(40);
    expect(fin.costByUnit.ST).toBe(850_000_000);
    expect(fin.costByUnit.CR).toBe(1_400_000_000);
  });

  it('blocks closure until all eight conditions hold, then closes', async () => {
    expectOk(await move('project', ctx.projectId, 'complete', T.accountManager), 'complete');
    expectOk(await move('project', ctx.projectId, 'start_closure', T.accountManager), 'start closure');

    const blocked = await move('project', ctx.projectId, 'close', T.accountManager);
    expect(blocked.status).toBe(422);

    expectOk(await post('/feedbacks', T.accountManager, {
      projectId: ctx.projectId, csat: 5, nps: 9,
      qualityRating: 5, timelinessRating: 4, communicationRating: 5,
      positives: 'کیفیت خلاقیت عالی بود', futureNeeds: 'کمپین تابستان',
    }), 'feedback');
    expectOk(await post('/lessons-learned', T.pmo, {
      projectId: ctx.projectId, title: 'تثبیت زودهنگام کی‌ویژوال',
      category: 'PROCESS', situation: 'یک دور اصلاحیه به دلیل عدم تطابق با بریف',
      lesson: 'تأیید لحن برند باید پیش از تولید انجام شود',
      recommendation: 'افزودن گیت «تأیید لحن» به Kick-off',
    }), 'lessons');
    expectOk(await patch(`/projects/${ctx.projectId}/closure`, T.accountManager, {
      allDeliverablesDelivered: true, finalQcDone: true,
      clientApprovalRecorded: true, closureReportDone: true,
    }), 'checklist');

    const status = expectOk(await get(`/projects/${ctx.projectId}/closure`, T.accountManager), 'closure status');
    expect(status.complete).toBe(true);

    const closed = expectOk(await move('project', ctx.projectId, 'close', T.accountManager), 'close');
    expect(closed.toState).toBe('CLOSED');
  });
});

/* ═══════ Scenario 13 — retention → new opportunity ═══════ */
describe('Scenario 13 — feedback leads to a new opportunity (cross-sell)', () => {
  it('updates customer health from the recorded feedback', async () => {
    const company = await prisma.company.findUnique({ where: { id: ctx.companyId } });
    expect(company!.healthScore).toBeGreaterThanOrEqual(90);
  });

  it('Account raises a cross-sell opportunity that restarts the cycle', async () => {
    const opp = expectOk(await post('/opportunities', T.salesManager, {
      title: 'کمپین تابستان سپهر — Cross-sell', companyId: ctx.companyId,
      estimatedValue: 2_800_000_000, description: 'برخاسته از بازخورد پروژه نوروزی',
    }), 'new opportunity');
    expect(opp.state).toBe('NEW');

    const view = expectOk(await get(`/companies/${ctx.companyId}/360`, T.accountManager), 'customer 360');
    expect(view.metrics.closedProjects).toBeGreaterThan(0);
    expect(view.metrics.openOpportunities).toBeGreaterThan(0);
    expect(view.metrics.avgCsat).toBe(5);
    expect(view.finance.totals.received).toBeGreaterThan(0);
  });
});
