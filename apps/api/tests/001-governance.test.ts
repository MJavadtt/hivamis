import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, get, login, move, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * Governance enforcement — the Doc_H rules that must be structurally impossible to bypass.
 * These are the tests that distinguish a governed platform from a CRUD app.
 */
let tokens: Record<string, string>;
const ORG = '00000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  tokens = {
    admin: await login('admin@hiva.local'),
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
});

afterAll(async () => { await closeApp(); });

describe('Rule 2 — Sales / Account separation', () => {
  it('denies Sales the ability to set a sale price', async () => {
    const proposal = await prisma.proposal.findFirst();
    const res = await post(`/proposals/${proposal!.id}/pricing`, tokens.sales, {
      salePrice: 1_000_000, rationale: 'تلاش غیرمجاز',
    });
    expect(res.status).toBe(403);
  });

  it('denies Sales the ability to authorize a project', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'PENDING_AUTHORIZATION' } });
    const res = await post(`/projects/${project!.id}/authorize`, tokens.sales, {
      basis: 'CONTRACT', referenceDocument: 'X',
    });
    expect(res.status).toBe(403);
  });

  it('denies Account the ability to approve its own pricing', async () => {
    const proposal = await prisma.proposal.findFirst({ where: { salePrice: { not: null } } });
    await prisma.proposal.update({
      where: { id: proposal!.id },
      data: { pricedById: (await prisma.user.findUnique({ where: { email: 'account.manager@hiva.local' } }))!.id },
    });
    const res = await post(`/proposals/${proposal!.id}/pricing/approve`, tokens.accountManager, {});
    expect(res.status).toBe(403);
  });

  it('gives Account no lead-acquisition permission and Sales no execution permission', async () => {
    const salesMe = expectOk(await get('/auth/me', tokens.sales), 'sales me');
    const accountMe = expectOk(await get('/auth/me', tokens.accountManager), 'account me');
    expect(salesMe.permissions).not.toContain('pricing.set_price');
    expect(salesMe.permissions).not.toContain('project.authorize');
    expect(salesMe.permissions).not.toContain('qc.account');
    expect(accountMe.permissions).not.toContain('crm.lead.convert');
    expect(accountMe.permissions).toContain('qc.account');
  });
});

describe('Rule 13 — no execution without authorization', () => {
  it('blocks activation of a project that has no authorization record', async () => {
    const company = await prisma.company.findFirst();
    const owner = await prisma.user.findUnique({ where: { email: 'account.manager@hiva.local' } });
    const project = expectOk(
      await post('/projects', tokens.accountManager, {
        name: 'پروژه تست بدون مجوز',
        companyId: company!.id,
        accountOwnerId: owner!.id,
        plannedStart: new Date().toISOString(),
        plannedEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      }),
      'create project',
    );

    expectOk(await move('project', project.id, 'request_authorization', tokens.accountManager), 'request auth');

    // Guard must reject: no ExecutionAuthorization exists.
    const res = await move('project', project.id, 'authorize', tokens.deputy);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GOVERNANCE_RULE_VIOLATION');
    expect(res.body.error.details.rule).toContain('§13');
  });

  it('rejects a CONTRACT basis pointing at an unsigned contract', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'PENDING_AUTHORIZATION' } });
    const company = await prisma.company.findFirst();
    const draft = await prisma.contract.create({
      data: {
        organizationId: project!.organizationId, code: `CNT-TEST-${Date.now()}`,
        companyId: company!.id, title: 'قرارداد پیش‌نویس', contractValue: 1_000_000,
        startDate: new Date(), endDate: new Date(Date.now() + 86_400_000),
        state: 'DRAFTING', createdById: project!.accountOwnerId,
      },
    });
    const res = await post(`/projects/${project!.id}/authorize`, tokens.deputy, {
      basis: 'CONTRACT', contractId: draft.id, referenceDocument: draft.code,
    });
    expect(res.status).toBe(422);
  });

  it('rejects an invoiced execution order with no invoice attached', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'PENDING_AUTHORIZATION' } });
    const res = await post(`/projects/${project!.id}/authorize`, tokens.deputy, {
      basis: 'INVOICED_EXECUTION_ORDER', referenceDocument: 'ORD-1',
    });
    expect(res.status).toBe(422);
  });
});

describe('Rule 10 — no revision without a recorded reason', () => {
  it('rejects a revision with an empty required correction', async () => {
    const deliverable = await prisma.deliverable.findFirst();
    const res = await post('/revisions', tokens.accountManager, {
      deliverableId: deliverable!.id,
      reason: 'BRIEF_MISMATCH',
      requiredCorrection: '',
      responsibleDepartmentCode: 'CR',
      dueDate: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a failed QC review that records no findings', async () => {
    const deliverable = await prisma.deliverable.findFirst();
    const res = await post('/qc-reviews', tokens.accountManager, {
      level: 'ACCOUNT', deliverableId: deliverable!.id, verdict: 'FAILED', checklist: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('Rule 9 — three-level QC with role separation', () => {
  it('denies a unit the ability to sign off Account QC', async () => {
    const deliverable = await prisma.deliverable.findFirst();
    const res = await post('/qc-reviews', tokens.designer, {
      level: 'ACCOUNT', deliverableId: deliverable!.id, verdict: 'PASSED', checklist: {},
    });
    expect(res.status).toBe(403);
  });

  it('denies Account the ability to sign off Final QC without the permission', async () => {
    const proposal = await prisma.proposal.findFirst();
    const res = await post('/qc-reviews', tokens.account, {
      level: 'FINAL', proposalId: proposal!.id, verdict: 'PASSED', checklist: {},
    });
    expect(res.status).toBe(403);
  });

  it('blocks delivery to the client without a passing Account QC', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    const deliverable = await prisma.deliverable.create({
      data: {
        organizationId: project!.organizationId, code: `DLV-TEST-${Date.now()}`,
        projectId: project!.id, name: 'خروجی تست تحویل', departmentCode: 'CR', state: 'APPROVED',
      },
    });
    const res = await move('deliverable', deliverable.id, 'deliver', tokens.accountManager);
    expect(res.status).toBe(422);
    expect(res.body.error.details.rule).toContain('QC سطح ۲');
  });
});

describe('Rule 8 — change control', () => {
  it('blocks the commercial review of a change whose scope has not been decided', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    const cr = expectOk(
      await post('/change-requests', tokens.accountManager, {
        projectId: project!.id, title: 'تغییر تست', requestedChange: 'شرح تغییر',
        requestedBy: 'CLIENT', requestedDate: new Date().toISOString(),
      }),
      'create change request',
    );
    expectOk(await move('changeRequest', cr.id, 'start_scope_review', tokens.accountManager), 'scope review');
    const res = await move('changeRequest', cr.id, 'start_commercial_review', tokens.accountManager);
    expect(res.status).toBe(422);
  });

  it('blocks sending an out-of-scope change to the customer before all six impacts are assessed', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    const cr = expectOk(
      await post('/change-requests', tokens.accountManager, {
        projectId: project!.id, title: 'تغییر خارج از Scope',
        requestedChange: 'افزودن خروجی جدید', requestedBy: 'CLIENT',
        requestedDate: new Date().toISOString(),
      }),
      'create CR',
    );
    expectOk(await move('changeRequest', cr.id, 'start_scope_review', tokens.accountManager), 'start scope');
    expectOk(
      await post(`/change-requests/${cr.id}/scope-review`, tokens.accountManager, {
        verdict: 'OUT_OF_SCOPE', rationale: 'در قرارداد ذکر نشده',
      }),
      'scope verdict',
    );
    expectOk(await move('changeRequest', cr.id, 'start_commercial_review', tokens.accountManager), 'commercial review');

    const res = await move('changeRequest', cr.id, 'send_to_customer', tokens.accountManager);
    expect(res.status).toBe(422);
    expect(res.body.error.details.missing.length).toBeGreaterThan(0);
  });

  it('blocks implementing an out-of-scope change the customer has not approved', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    const cr = await prisma.changeRequest.create({
      data: {
        organizationId: project!.organizationId, code: `CR-TEST-${Date.now()}`,
        projectId: project!.id, title: 'تغییر بدون تأیید مشتری',
        requestedChange: 'x', requestedBy: 'CLIENT', requestedDate: new Date(),
        state: 'APPROVED', scopeVerdict: 'OUT_OF_SCOPE',
        createdById: project!.accountOwnerId,
      },
    });
    const res = await move('changeRequest', cr.id, 'implement', tokens.accountManager);
    expect(res.status).toBe(422);
    expect(res.body.error.details.rule).toContain('§I');
  });
});

describe('Rule 15 — eight-condition project closure', () => {
  it('blocks closure until every condition is satisfied', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    await prisma.project.update({ where: { id: project!.id }, data: { state: 'PENDING_CLOSURE' } });
    await prisma.closureChecklist.upsert({
      where: { projectId: project!.id },
      create: { projectId: project!.id, allDeliverablesDelivered: true },
      update: { allDeliverablesDelivered: true, finalQcDone: false, clientApprovalRecorded: false },
    });

    const blocked = await move('project', project!.id, 'close', tokens.accountManager);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.missing.length).toBeGreaterThan(0);

    // Satisfy every condition, then the same call must succeed.
    await prisma.closureChecklist.update({
      where: { projectId: project!.id },
      data: {
        allDeliverablesDelivered: true, finalQcDone: true, clientApprovalRecorded: true,
        closureReportDone: true, financialStatusClear: true, feedbackRecorded: true,
        lessonsLearnedRecorded: true,
      },
    });
    const ok = await move('project', project!.id, 'close', tokens.accountManager);
    expect(ok.status).toBe(200);
    expect(ok.body.toState).toBe('CLOSED');

    await prisma.project.update({ where: { id: project!.id }, data: { state: 'ACTIVE', closedAt: null } });
  });
});

describe('Preflight — "why can’t I?" before the click', () => {
  /**
   * Enforcement stops at the first failing guard; a person deciding what to do next needs every
   * verdict at once, or they fix one thing, click, and discover the next.
   */
  it('reports every guard on every transition out of the current state, not just the first failure', async () => {
    const org = await prisma.organization.findFirstOrThrow();
    const company = await prisma.company.findFirstOrThrow();
    const pmo = await prisma.user.findUniqueOrThrow({ where: { email: 'pmo@hiva.local' } });
    // A project in PLANNING with none of activation's three prerequisites in place.
    const project = await prisma.project.create({
      data: {
        organizationId: org.id, code: `PRJ-PF-${Date.now()}`, name: 'پروژهٔ پیش‌بررسی',
        companyId: company.id, accountOwnerId: pmo.id, objective: 'x', state: 'PLANNING',
      },
    });

    const pf = expectOk(await get(`/workflow/project/${project.id}/preflight`, tokens.pmo), 'preflight');
    expect(pf.state).toBe('PLANNING');
    const activate = pf.transitions.find((t: any) => t.action === 'activate');
    expect(activate.checks.map((c: any) => c.guard)).toEqual(['project.isAuthorized', 'project.hasSchedule', 'project.hasRaci']);
    expect(activate.checks.every((c: any) => c.ok === false)).toBe(true);
    for (const c of activate.checks) {
      expect(c.labelFa).toBeTruthy();       // the positive statement, for the tick
      expect(c.messageFa).toBeTruthy();     // the explanation, for the cross
      expect(c.rule).toContain('Doc_H');
    }
    expect(activate.ready).toBe(false);

    // Fix one thing: the schedule. Exactly that check flips; the other two still stand.
    await prisma.project.update({
      where: { id: project.id },
      data: { plannedStart: new Date(), plannedEnd: new Date(Date.now() + 30 * 86_400_000) },
    });
    const again = expectOk(await get(`/workflow/project/${project.id}/preflight/activate`, tokens.pmo), 'preflight one');
    expect(again.action).toBe('activate');
    expect(again.checks.map((c: any) => [c.guard, c.ok])).toEqual([
      ['project.isAuthorized', false], ['project.hasSchedule', true], ['project.hasRaci', false],
    ]);
    expect(again.ready).toBe(false);
  });

  it('tells a reader what they could not do as well as what they could', async () => {
    const brief = await prisma.brief.findFirstOrThrow({ where: { state: 'UNDER_REVIEW' } });
    // Account holds brief.approve; the designer may read briefs but not decide them.
    const asAccount = expectOk(await get(`/workflow/brief/${brief.id}/preflight`, tokens.account), 'account');
    const approve = asAccount.transitions.find((t: any) => t.action === 'approve');
    expect(approve.permitted).toBe(true);
    expect(approve.checks[0]).toMatchObject({ guard: 'brief.isComplete', ok: false });
    expect(approve.checks[0].details).toBeTruthy();   // names the missing items
    expect(approve.ready).toBe(false);
    const sendBack = asAccount.transitions.find((t: any) => t.action === 'return_incomplete');
    expect(sendBack).toMatchObject({ ready: true, requiresReason: true, checks: [] });

    const asDesigner = expectOk(await get(`/workflow/brief/${brief.id}/preflight`, tokens.designer), 'designer');
    const cannot = asDesigner.transitions.find((t: any) => t.action === 'approve');
    expect(cannot).toMatchObject({ permitted: false, permission: 'brief.approve', ready: false });
  });

  it('answers a transition that does not exist from this state with the ones that do', async () => {
    const brief = await prisma.brief.findFirstOrThrow({ where: { state: 'UNDER_REVIEW' } });
    const res = await get(`/workflow/brief/${brief.id}/preflight/submit`, tokens.account);
    expect(res.status).toBe(409);
    expect(res.body.error.details.allowed).toContain('approve');
  });

  it('is read-only: a preflight writes nothing', async () => {
    const brief = await prisma.brief.findFirstOrThrow({ where: { state: 'UNDER_REVIEW' } });
    const [audits, transitions] = await Promise.all([prisma.auditEvent.count(), prisma.stateTransition.count()]);
    expectOk(await get(`/workflow/brief/${brief.id}/preflight`, tokens.account), 'preflight');
    expect(await prisma.auditEvent.count()).toBe(audits);
    expect(await prisma.stateTransition.count()).toBe(transitions);
    expect((await prisma.brief.findUniqueOrThrow({ where: { id: brief.id } })).state).toBe('UNDER_REVIEW');
  });
});

describe('Governed waivers', () => {
  /**
   * A blocked guard is otherwise a dead end, and a dead end moves the work outside the system
   * — losing the rule and the trace both. An exception must be possible, and it must be
   * expensive, visible and temporary.
   */
  const GUARD = 'project.hasValidAuthorizationBasis';
  async function blockedProject() {
    // A project awaiting authorisation with nothing to authorise it on.
    const org = await prisma.organization.findFirstOrThrow();
    const company = await prisma.company.findFirstOrThrow();
    const pmo = await prisma.user.findUniqueOrThrow({ where: { email: 'pmo@hiva.local' } });
    return prisma.project.create({
      data: { organizationId: org.id, code: `PRJ-WV-${Date.now()}`, name: 'پروژهٔ بدون مبنای مجوز', companyId: company.id, accountOwnerId: pmo.id, objective: 'x', state: 'PENDING_AUTHORIZATION' },
    });
  }

  it('lets the deputy set one guard aside for one record, once, with a reason — and records every step', async () => {
    const project = await blockedProject();
    const blocked = await move('project', project.id, 'authorize', tokens.deputy);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.rule).toContain('Doc_H §13');

    const waiver = expectOk(await post('/waivers', tokens.deputy, {
      entityType: 'project', entityId: project.id, guard: GUARD,
      reason: 'قرارداد امضا شده و در راه است؛ شروع بدون ثبت آن، با مسئولیت قائم‌مقام',
    }), 'grant');
    expect(waiver.guardLabelFa).toBeTruthy();
    expect(new Date(waiver.expiresAt).getTime() - Date.now()).toBeGreaterThan(6 * 86_400_000);

    // Preflight says the guard is set aside, and by whom.
    const pf = expectOk(await get(`/workflow/project/${project.id}/preflight/authorize`, tokens.deputy), 'preflight');
    const check = pf.checks.find((c: any) => c.guard === GUARD);
    expect(check.ok).toBe(true);
    expect(check.waived).toMatchObject({ id: waiver.id, reason: waiver.reason });
    expect(pf.ready).toBe(true);

    expectOk(await move('project', project.id, 'authorize', tokens.deputy), 'authorize on the waiver');
    const spent = await prisma.waiver.findUniqueOrThrow({ where: { id: waiver.id } });
    expect(spent.usedAt).not.toBeNull();
    expect(spent.usedAction).toBe('authorize');
    const audited = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'STATE_TRANSITION', entityId: project.id } });
    expect((audited.after as any).waived[0]).toMatchObject({ guard: GUARD, id: waiver.id });
    expect(await prisma.auditEvent.count({ where: { action: 'WAIVER_GRANTED', entityId: project.id } })).toBe(1);

    // Spent: listed as USED, and no longer revocable.
    const register = expectOk(await get('/waivers', tokens.deputy, { entityId: project.id }), 'register');
    expect(register[0]).toMatchObject({ status: 'USED', grantedByName: expect.any(String), usedByName: expect.any(String) });
    expect((await post(`/waivers/${waiver.id}/revoke`, tokens.deputy)).body.error.code).toBe('ALREADY_USED');
  });

  it('is only for the executive, only for a real guard on this entity, only with a real reason, only for days', async () => {
    const project = await blockedProject();
    const base = { entityType: 'project', entityId: project.id, guard: GUARD, reason: 'دلیل کافی برای ثبت در دفتر استثناها' };
    expect((await post('/waivers', tokens.accountManager, base)).status).toBe(403);
    expect((await post('/waivers', tokens.pmo, base)).status).toBe(403);
    expect((await post('/waivers', tokens.deputy, { ...base, guard: 'no.such.guard' })).body.error.code).toBe('UNKNOWN_GUARD');
    expect((await post('/waivers', tokens.deputy, { ...base, guard: 'brief.isComplete' })).body.error.code).toBe('GUARD_NOT_ON_ENTITY');
    expect((await post('/waivers', tokens.deputy, { ...base, action: 'close' })).body.error.code).toBe('ACTION_NOT_GUARDED');
    expect((await post('/waivers', tokens.deputy, { ...base, reason: 'کوتاه' })).body.error.code).toBe('REASON_REQUIRED');
    expect((await post('/waivers', tokens.deputy, { ...base, expiresAt: new Date(Date.now() + 40 * 86_400_000).toISOString() })).body.error.code).toBe('TOO_LONG');
    expect((await post('/waivers', tokens.deputy, { ...base, entityId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await post('/waivers', tokens.ceo, base)).status).toBe(201);
    expect((await post('/waivers', tokens.deputy, base)).body.error.code).toBe('WAIVER_EXISTS');
  });

  it('does nothing once expired or revoked, and shows in the registers while open', async () => {
    const project = await blockedProject();
    const org = await prisma.organization.findFirstOrThrow();
    const deputy = await prisma.user.findUniqueOrThrow({ where: { email: 'deputy@hiva.local' } });
    await prisma.waiver.create({ data: {
      organizationId: org.id, entityType: 'project', entityId: project.id, guard: GUARD, reason: 'منقضی‌شده در آزمون',
      grantedById: deputy.id, expiresAt: new Date(Date.now() - 60_000),
    } });
    expect((await move('project', project.id, 'authorize', tokens.deputy)).status).toBe(422);

    const live = expectOk(await post('/waivers', tokens.deputy, { entityType: 'project', entityId: project.id, guard: GUARD, reason: 'استثنای موقت برای آزمون لغو' }), 'grant');
    const quality = expectOk(await get('/reports/data-quality', tokens.deputy), 'data quality');
    const finding = quality.findings.find((f: any) => f.key === 'openWaivers');
    expect(finding.count).toBeGreaterThanOrEqual(1);
    expect(finding.samples.some((s: any) => s.id === live.id)).toBe(true);
    const executive = expectOk(await get('/reports/executive', tokens.deputy), 'executive');
    expect(executive.governance.waiversOpen).toBeGreaterThanOrEqual(1);

    expectOk(await post(`/waivers/${live.id}/revoke`, tokens.deputy), 'revoke');
    expect((await move('project', project.id, 'authorize', tokens.deputy)).status).toBe(422);
    expect(expectOk(await get('/waivers', tokens.deputy, { entityId: project.id, status: 'REVOKED' }), 'revoked').some((w: any) => w.id === live.id)).toBe(true);
  });
});

describe('Workflow engine integrity', () => {
  it('rejects an undeclared transition with the list of legal actions', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    const res = await move('project', project!.id, 'authorize', tokens.deputy);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect(Array.isArray(res.body.error.details.allowed)).toBe(true);
  });

  it('requires a reason where the transition declares one', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    const res = await move('project', project!.id, 'hold', tokens.accountManager);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REASON_REQUIRED');
  });

  it('records every transition in the state-transition log and the audit trail', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    expectOk(await move('project', project!.id, 'hold', tokens.accountManager, 'توقف برای تست'), 'hold');
    const [transitions, audits] = await Promise.all([
      prisma.stateTransition.findMany({ where: { entityType: 'project', entityId: project!.id } }),
      prisma.auditEvent.findMany({ where: { entityType: 'project', entityId: project!.id, action: 'STATE_TRANSITION' } }),
    ]);
    expect(transitions.some((t) => t.action === 'hold' && t.reason === 'توقف برای تست')).toBe(true);
    expect(audits.length).toBeGreaterThan(0);
    expectOk(await move('project', project!.id, 'resume', tokens.accountManager), 'resume');
  });
});

describe('Rule 6 — no valid verbal task', () => {
  it('refuses to create a task with no source document', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    const res = await post('/tasks', tokens.accountManager, {
      projectId: project!.id, title: 'وظیفه شفاهی', departmentCode: 'CR',
    });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.issues.map((i: any) => i.path);
    expect(paths).toContain('sourceType');
    expect(paths).toContain('sourceRef');
  });

  it('accepts a task that names one of the six authorised source documents', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    const wo = await prisma.workOrder.findFirst({ where: { projectId: project!.id } });
    const res = await post('/tasks', tokens.accountManager, {
      projectId: project!.id, title: 'وظیفه با سند مرجع', departmentCode: 'CR',
      sourceType: 'ORDER_FORM', sourceRef: wo!.code,
    });
    expect(res.status).toBe(201);
  });
});

describe('State is written only through the engine', () => {
  /**
   * ADR-002 rests on there being one write path. These cover the three routes that previously
   * wrote `state` directly, each of which skipped something the engine does.
   */

  it('refuses to convert a lead that has not been qualified', async () => {
    const lead = await prisma.lead.create({
      data: {
        organizationId: ORG, code: `LEAD-T${Date.now() % 100000}`,
        name: 'تست تبدیل', companyName: 'شرکت آزمایشی', source: 'INBOUND', state: 'NEW',
      },
    });
    const res = await post(`/leads/${lead.id}/convert`, tokens.sales, { title: 'فرصت آزمایشی' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
    // The engine reports what would have been legal from here.
    expect(res.body.error.details.allowed).toContain('contact');
    // Nothing was created on the way to the refusal.
    expect(await prisma.opportunity.count({ where: { leadId: lead.id } })).toBe(0);
    await prisma.lead.delete({ where: { id: lead.id } });
  });

  it('converts a qualified lead and records the move in its history', async () => {
    const lead = await prisma.lead.create({
      data: {
        organizationId: ORG, code: `LEAD-T${(Date.now() + 1) % 100000}`,
        name: 'تست تبدیل ۲', companyName: 'شرکت آزمایشی ۲', source: 'REFERRAL', state: 'QUALIFIED',
      },
    });
    const res = await post(`/leads/${lead.id}/convert`, tokens.sales, { title: 'فرصت معتبر' });
    expect(res.status).toBe(201);
    expect(res.body.leadId).toBe(lead.id);

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.state).toBe('CONVERTED');
    // The engine set companyId via the effect, so the lead points at what was created.
    expect(after.companyId).toBe(res.body.companyId);

    const moves = await prisma.stateTransition.findMany({
      where: { entityType: 'lead', entityId: lead.id },
    });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.fromState).toBe('QUALIFIED');
    expect(moves[0]!.toState).toBe('CONVERTED');
    expect(moves[0]!.actorId).not.toBeNull();
  });

  it('leaves a deliverable’s failed-QC move visible in its own history', async () => {
    const deliverable = await prisma.deliverable.findFirstOrThrow({
      where: { state: { in: ['SUBMITTED', 'IN_QC', 'APPROVED'] } },
    });
    // Put it where a level-2 QC legitimately happens.
    if (deliverable.state !== 'IN_QC') {
      await prisma.deliverable.update({ where: { id: deliverable.id }, data: { state: 'IN_QC' } });
    }
    const before = await prisma.stateTransition.count({
      where: { entityType: 'deliverable', entityId: deliverable.id },
    });

    const res = await post('/qc-reviews', tokens.accountManager, {
      level: 'ACCOUNT', deliverableId: deliverable.id, verdict: 'FAILED',
      checklist: { matchesBrief: false }, findings: 'مغایرت با بریف',
    });
    expect(res.status).toBe(201);

    const moves = await prisma.stateTransition.findMany({
      where: { entityType: 'deliverable', entityId: deliverable.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(moves.length).toBe(before + 1);
    expect(moves[0]!.toState).toBe('REVISION_REQUIRED');
    expect(moves[0]!.fromState).toBe('IN_QC');
    expect(moves[0]!.actorId).not.toBeNull();
    expect(moves[0]!.reason).toContain('بریف');
  });

  it('records the opportunity’s cascade when a brief is approved', async () => {
    // A dedicated opportunity in a known state. Reusing a shared one made this order-dependent:
    // once another test had already moved it to BRIEF_COMPLETED, cascadeState correctly
    // no-opped and no new row appeared.
    const company = await prisma.company.findFirstOrThrow({ where: { deletedAt: null } });
    const opportunity = await prisma.opportunity.create({
      data: {
        organizationId: ORG, code: `OPP-T${Date.now() % 100000}`,
        title: 'فرصت آزمایشی cascade', companyId: company.id,
        estimatedValue: 1_000_000_000, state: 'BRIEF_REQUESTED',
      },
    });
    const brief = await prisma.brief.create({
      data: {
        organizationId: ORG, code: `BRF-T${Date.now() % 100000}`,
        opportunityId: opportunity.id, title: 'بریف آزمایشی کامل',
        businessObjective: 'افزایش آگاهی از برند', targetAudience: 'مدیران کسب‌وکار',
        scope: 'کمپین دیجیتال', expectedDeliverables: 'کی‌ویژوال و پلن رسانه',
        budgetRange: 1_000_000_000, desiredDeadline: new Date(Date.now() + 30 * 86_400_000),
        state: 'UNDER_REVIEW',
      },
    });

    const before = await prisma.stateTransition.count({
      where: { entityType: 'opportunity', entityId: opportunity.id },
    });
    const res = await move('brief', brief.id, 'approve', tokens.accountManager);
    expect(res.status, JSON.stringify(res.body?.error ?? {})).toBe(200);

    const moves = await prisma.stateTransition.findMany({
      where: { entityType: 'opportunity', entityId: opportunity.id },
      orderBy: { createdAt: 'desc' },
    });
    // The cascade is no longer silent: the opportunity's own history shows why it moved.
    expect(moves.length).toBe(before + 1);
    expect(moves[0]!.toState).toBe('BRIEF_COMPLETED');
    expect(moves[0]!.action).toBe('brief_approved');
    expect(moves[0]!.actorId).not.toBeNull();
  });
});
