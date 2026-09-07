import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, get, login, move, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * Governance enforcement — the Doc_H rules that must be structurally impossible to bypass.
 * These are the tests that distinguish a governed platform from a CRUD app.
 */
let tokens: Record<string, string>;

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
