import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call, closeApp, get, login, post, patch, move, expectOk, upload, tinyPdf, zipOf, directLead, partnerLead } from './helpers.js';
import { prisma } from '../src/db.js';
import { addBusinessHours, businessHoursBetween, DEFAULT_CALENDAR, hoursPerDay } from '../src/lib/business-calendar.js';
import { tickSlaClocks, startSla, stopSla, pauseSla, resumeSla, loadCalendar, resetCalendarCache } from '../src/sla/engine.js';
import { predictClocks, notifyPredictedBreaches } from '../src/sla/predict.js';
import {
  ALL_FORMS, ALL_PERMISSIONS, DEPARTMENT_CODES, FORM_BY_CODE, MODULES, ROLE_CODES, SLA_POLICIES, WORKFLOWS,
} from '@hiva/contracts';
import {
  STATE_LABELS, REVISION_REASON_LABELS, REVISION_REASONS, stateLabelFa,
  QC_LEVELS, QC_RESULTS, FORM_SUBMISSION_STATES, SLA_STATES, SEVERITY_LEVELS,
  PRIORITY_LEVELS, SCOPE_VERDICTS, AUTHORIZATION_BASES, SUPPLIER_KINDS, INVOICE_KINDS,
} from '@hiva/contracts';

let T: Record<string, string>;

beforeAll(async () => {
  T = {
    admin: await login('admin@hiva.local'),
    sales: await login('sales@hiva.local'),
    accountManager: await login('account.manager@hiva.local'),
    creative: await login('creative@hiva.local'),
    designer: await login('designer@hiva.local'),
    deputy: await login('deputy@hiva.local'),
    ceo: await login('ceo@hiva.local'),
    pmo: await login('pmo@hiva.local'),
  };
});
afterAll(async () => { await closeApp(); });

describe('Doc_H catalogue completeness', () => {
  it('carries all 130 forms from «دسته‌بندی فرم‌های ارتباطی» with no gaps in numbering', async () => {
    expect(ALL_FORMS.length).toBe(130);
    const numbers = ALL_FORMS.map((f) => f.no).sort((a, b) => a - b);
    expect(numbers[0]).toBe(1);
    expect(numbers[129]).toBe(130);
    expect(new Set(numbers).size).toBe(130);
    expect(new Set(ALL_FORMS.map((f) => f.code)).size).toBe(130);
  });

  it('covers all fourteen Doc_H categories A–N', () => {
    const categories = new Set(ALL_FORMS.map((f) => f.category));
    for (const c of 'ABCDEFGHIJKLMN') expect(categories.has(c), `category ${c}`).toBe(true);
  });

  it('gives every form the full Doc_H contract: sender, receiver, approver and next process', () => {
    for (const form of ALL_FORMS) {
      expect(form.senderDepts.length, form.code).toBeGreaterThan(0);
      expect(form.receiverDepts.length, form.code).toBeGreaterThan(0);
      expect(form.approverRoles.length, form.code).toBeGreaterThan(0);
      expect(form.fields.length, form.code).toBeGreaterThan(0);
    }
  });

  it('persists every form definition to the database', async () => {
    expect(await prisma.formDefinition.count()).toBe(130);
  });

  it('references only SLA policies that exist', async () => {
    const codes = new Set(SLA_POLICIES.map((p) => p.code));
    for (const form of ALL_FORMS) {
      if (form.slaCode) expect(codes.has(form.slaCode), `${form.code} → ${form.slaCode}`).toBe(true);
    }
    for (const wf of Object.values(WORKFLOWS)) {
      for (const t of wf.transitions) {
        if (t.startsSla) expect(codes.has(t.startsSla), `${wf.entity}.${t.action}`).toBe(true);
        for (const s of t.stopsSla ?? []) expect(codes.has(s), `${wf.entity}.${t.action}`).toBe(true);
      }
    }
  });

  it('references only permissions that exist', () => {
    const perms = new Set<string>(ALL_PERMISSIONS);
    for (const wf of Object.values(WORKFLOWS)) {
      for (const t of wf.transitions) {
        if (t.permission) expect(perms.has(t.permission), `${wf.entity}.${t.action}`).toBe(true);
      }
    }
  });

  it('declares no unreachable state and no dangling target', () => {
    for (const [entity, wf] of Object.entries(WORKFLOWS)) {
      const states = new Set(wf.states);
      const reachable = new Set<string>([wf.initial]);
      for (const t of wf.transitions) {
        expect(states.has(t.to), `${entity}: unknown target ${t.to}`).toBe(true);
        for (const f of t.from) expect(states.has(f), `${entity}: unknown source ${f}`).toBe(true);
        reachable.add(t.to);
      }
      for (const s of wf.states) {
        expect(reachable.has(s), `${entity}: state ${s} is unreachable`).toBe(true);
      }
    }
  });
});

describe('Form engine', () => {
  it('exposes the catalogue grouped by category with per-user submit rights', async () => {
    const res = expectOk(await get('/forms/definitions', T.accountManager), 'definitions');
    expect(res.definitions.length).toBe(130);
    expect(res.categories.length).toBe(14);
    // Account may originate the Account-owned forms but not, say, the unit-internal ones.
    const briefControl = res.definitions.find((d: any) => d.code === 'B09_BRIEF_CONTROL');
    expect(briefControl.canSubmit).toBe(true);
    const taskAcceptance = res.definitions.find((d: any) => d.code === 'D27_TASK_ACCEPTANCE');
    expect(taskAcceptance.canSubmit).toBe(false);
  });

  it('enforces the sender department declared by Doc_H', async () => {
    const res = await post('/forms/submissions', T.designer, {
      formCode: 'A01_LEAD',
      data: { name: 'x', companyName: 'y', ...directLead() },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('فروش');
  });

  it('validates required fields against the form schema', async () => {
    const res = await post('/forms/submissions', T.sales, {
      formCode: 'A01_LEAD', data: { name: 'بدون شرکت' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FORM_VALIDATION_ERROR');
    const paths = res.body.error.details.issues.map((i: any) => i.path);
    expect(paths).toContain('companyName');
    expect(paths).toContain('source');
  });

  it('creates the bound domain record when a form declares a binding', async () => {
    const submission = expectOk(await post('/forms/submissions', T.sales, {
      formCode: 'A01_LEAD',
      data: {
        name: 'سرنخ از طریق فرم', companyName: 'شرکت آزمون فرم',
        ...directLead('CAMPAIGN'), estimatedValue: 750_000_000, need: 'برندینگ',
      },
    }), 'submit lead form');

    expect(submission.boundEntity).toBe('lead');
    expect(submission.boundEntityId).toBeTruthy();
    const lead = await prisma.lead.findUnique({ where: { id: submission.boundEntityId } });
    expect(lead!.companyName).toBe('شرکت آزمون فرم');
    expect(lead!.code).toMatch(/^LEAD-\d{6}$/);
  });

  it('starts the SLA clock the form declares', async () => {
    const submission = expectOk(await post('/forms/submissions', T.sales, {
      formCode: 'A01_LEAD',
      data: { name: 'سرنخ SLA', companyName: 'شرکت SLA', ...directLead() },
    }), 'submit');
    const clock = await prisma.slaClock.findFirst({
      where: { entityType: 'formSubmission', entityId: submission.id },
      include: { policy: true },
    });
    expect(clock).not.toBeNull();
    expect(clock!.policy.code).toBe('SLA_LEAD_CREATE');
    expect(clock!.dueAt.getTime()).toBeGreaterThan(clock!.startedAt.getTime());
  });

  it('routes to approvers and refuses self-approval', async () => {
    const submission = expectOk(await post('/forms/submissions', T.sales, {
      formCode: 'A01_LEAD',
      data: { name: 'سرنخ تأیید', companyName: 'شرکت تأیید', ...partnerLead() },
    }), 'submit');
    expect(submission.state).toBe('PENDING_APPROVAL');

    const selfApprove = await post(`/forms/submissions/${submission.id}/decision`, T.sales, {
      decision: 'APPROVE',
    });
    expect(selfApprove.status).toBe(403);

    const salesManager = await login('sales.manager@hiva.local');
    const approved = expectOk(
      await post(`/forms/submissions/${submission.id}/decision`, salesManager, { decision: 'APPROVE' }),
      'approve',
    );
    expect(approved.state).toBe('APPROVED');

    const clock = await prisma.slaClock.findFirst({
      where: { entityType: 'formSubmission', entityId: submission.id },
    });
    expect(['MET', 'BREACHED']).toContain(clock!.state);
  });

  it('requires a reason to reject or return a form', async () => {
    const submission = expectOk(await post('/forms/submissions', T.sales, {
      formCode: 'A01_LEAD',
      data: { name: 'سرنخ رد', companyName: 'شرکت رد', ...directLead() },
    }), 'submit');
    const salesManager = await login('sales.manager@hiva.local');
    const noReason = await post(`/forms/submissions/${submission.id}/decision`, salesManager, {
      decision: 'REJECT',
    });
    expect(noReason.status).toBe(400);
    const withReason = expectOk(
      await post(`/forms/submissions/${submission.id}/decision`, salesManager, {
        decision: 'REJECT', comment: 'اطلاعات کافی نیست',
      }),
      'reject',
    );
    expect(withReason.state).toBe('REJECTED');
  });

  it('stores a draft without running its binding or starting its SLA', async () => {
    const before = await prisma.lead.count();
    const draft = expectOk(await post('/forms/submissions', T.sales, {
      formCode: 'A01_LEAD', data: { name: 'پیش‌نویس' }, asDraft: true,
    }), 'draft');
    expect(draft.state).toBe('DRAFT');
    expect(draft.boundEntityId).toBeNull();
    expect(await prisma.lead.count()).toBe(before);
  });

  it('shows an approver their pending inbox', async () => {
    const salesManager = await login('sales.manager@hiva.local');
    const inbox = expectOk(
      await get('/forms/submissions', salesManager, { awaitingMe: 'true' }),
      'inbox',
    );
    expect(Array.isArray(inbox.items)).toBe(true);
  });
});

describe('Form definition versioning', () => {
  const CODE = 'B10_BRIEF_COMPLETION';

  /**
   * A definition's schema is data, and data changes. Every submission — and every PDF built
   * from one — used to render under the schema as it stood today. A submission now pins the
   * version it was filled under, and the definition is free to move on.
   */
  it('pins a submission to the version it was filled under, and keeps it there when the form changes', async () => {
    const { publishDefinition } = await import('../src/forms/versions.js');
    const { buildDocument } = await import('../src/pdf/index.js');
    const { verifyAccessToken } = await import('../src/auth/tokens.js');

    const brief = await prisma.brief.findFirstOrThrow({ where: { state: 'UNDER_REVIEW' } });
    const def = await prisma.formDefinition.findFirstOrThrow({ where: { code: CODE } });
    const original = FORM_BY_CODE.get(CODE)!;
    const originalLabel = original.fields.find((f) => f.key === 'addedInformation')!.labelFa;
    const data = { briefId: brief.id, addedInformation: 'اطلاعات تکمیلی نسخهٔ اول' };

    const first = expectOk(await post('/forms/submissions', T.sales, { formCode: CODE, data }), 'submit under v1');
    expect(first.definitionVersion).toBe(def.version);

    // The form changes: one field is reworded and one is added.
    const reworded = {
      ...original,
      fields: [
        ...original.fields.map((f) => (f.key === 'addedInformation' ? { ...f, labelFa: 'توضیحات تکمیلی (بازنویسی‌شده)' } : f)),
        { key: 'attachmentsNote', type: 'text', labelFa: 'یادداشت پیوست', labelEn: 'Attachments note', required: false },
      ],
    } as typeof original;
    const published = await publishDefinition(prisma, { organizationId: def.organizationId, form: reworded, note: 'test: reword + add' });
    expect(published).toEqual({ version: def.version + 1, changed: true });
    // Publishing the same schema again is a no-op — the seed relies on this.
    expect((await publishDefinition(prisma, { organizationId: def.organizationId, form: reworded })).changed).toBe(false);
    expect((await prisma.formDefinition.findFirstOrThrow({ where: { code: CODE } })).version).toBe(def.version + 1);

    // The earlier submission still reads as it was filled in.
    const old = expectOk(await get(`/forms/submissions/${first.id}`, T.sales), 'old submission');
    expect(old.definitionVersion).toBe(def.version);
    expect(old.schema.find((f: any) => f.key === 'addedInformation').labelFa).toBe(originalLabel);
    expect(old.schema.some((f: any) => f.key === 'attachmentsNote')).toBe(false);

    // A new one is filled under the new version.
    const second = expectOk(await post('/forms/submissions', T.sales, { formCode: CODE, data }), 'submit under v2');
    expect(second.definitionVersion).toBe(def.version + 1);
    const fresh = expectOk(await get(`/forms/submissions/${second.id}`, T.sales), 'new submission');
    expect(fresh.schema.find((f: any) => f.key === 'addedInformation').labelFa).toBe('توضیحات تکمیلی (بازنویسی‌شده)');
    expect(fresh.schema.some((f: any) => f.key === 'attachmentsNote')).toBe(true);

    const versions = expectOk(await get(`/forms/definitions/${CODE}/versions`, T.sales), 'versions');
    expect(versions.current).toBe(def.version + 1);
    expect(versions.versions.map((v: any) => [v.version, v.submissions])).toEqual([[def.version + 1, 1], [def.version, 1]]);
    expect(versions.versions[0].note).toBe('test: reword + add');

    // And the archived document keeps the wording the person actually answered.
    const user = await verifyAccessToken(T.sales);
    const oldPdf = await buildDocument('form-submission', first.id, def.organizationId, user);
    expect(oldPdf.html).toContain(originalLabel);
    expect(oldPdf.html).not.toContain('توضیحات تکمیلی (بازنویسی‌شده)');
    const newPdf = await buildDocument('form-submission', second.id, def.organizationId, user);
    expect(newPdf.html).toContain('توضیحات تکمیلی (بازنویسی‌شده)');
  });

  it('gives every seeded definition a version row that matches its current schema', async () => {
    const definitions = await prisma.formDefinition.findMany({ include: { versions: true } });
    expect(definitions.length).toBe(ALL_FORMS.length);
    for (const d of definitions) {
      const current = d.versions.find((v) => v.version === d.version);
      expect(current, `${d.code} has no row for version ${d.version}`).toBeTruthy();
      expect(JSON.stringify(current!.schema)).toBe(JSON.stringify(d.schema));
    }
  });
});

describe('My work — one queue', () => {
  /**
   * A person's work used to live in five lists. One queue, every item carrying what the person
   * may do to it, ordered by how soon its clock runs out.
   */
  it('gathers what sits with the person, with the transitions they may perform', async () => {
    const creative = expectOk(await get('/me/work', T.creative), 'creative queue');
    const seededOrder = creative.items.find((i: any) => i.kind === 'workOrder' && i.state === 'IN_PROGRESS');
    expect(seededOrder).toBeTruthy();
    expect(seededOrder.projectCode).toMatch(/^PRJ-/);
    expect(seededOrder.href).toBe(`/work-orders/${seededOrder.entityId}`);
    expect(seededOrder.availableTransitions.map((t: any) => t.action)).toContain('submit');
    expect(creative.kinds.workOrder).toBe('سفارش کار');
    expect(creative.counts.workOrder).toBeGreaterThanOrEqual(1);

    const designer = expectOk(await get('/me/work', T.designer), 'designer queue');
    const task = designer.items.find((i: any) => i.kind === 'task');
    expect(task).toBeTruthy();
    expect(task.availableTransitions.length).toBeGreaterThan(0);
    // Nothing that is not theirs.
    expect(designer.items.every((i: any) => i.kind === 'task' || i.kind === 'revision')).toBe(true);
  });

  it('routes a clarification request to whoever may issue orders, and a form to its approvers', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const creative = await prisma.user.findFirstOrThrow({ where: { email: 'creative@hiva.local' } });
    const wo = expectOk(await post('/work-orders', T.accountManager, {
      projectId: project.id, proposalId: project.proposalId, targetDepartmentCode: 'CR', title: 'سفارش صف کاری',
      scopeOfWork: 'طراحی', brief: 'بریف', expectedOutput: 'فایل', outputFormat: 'PDF',
      deadline: new Date(Date.now() + 10 * 86_400_000).toISOString(), ownerId: creative.id, budget: 1, priority: 'NORMAL',
    }), 'create');
    expectOk(await move('workOrder', wo.id, 'issue', T.accountManager), 'issue');

    // With the owner, carrying its 4-working-hour acceptance clock.
    const mine = expectOk(await get('/me/work', T.creative), 'creative');
    const issued = mine.items.find((i: any) => i.entityId === wo.id);
    expect(issued).toMatchObject({ kind: 'workOrder', state: 'ISSUED' });
    expect(issued.sla).toMatchObject({ policyCode: 'SLA_TASK_ACCEPTANCE', budgetHours: 4 });
    expect(issued.availableTransitions.map((t: any) => t.action)).toContain('accept');

    expectOk(await move('workOrder', wo.id, 'request_clarification', T.creative, 'ابعاد مشخص نیست'), 'clarify?');
    const account = expectOk(await get('/me/work', T.accountManager), 'account');
    const asking = account.items.find((i: any) => i.entityId === wo.id);
    expect(asking).toMatchObject({ kind: 'clarification', state: 'CLARIFICATION_REQUESTED' });
    expect(asking.title).toContain('ابعاد مشخص نیست');
    expect(asking.availableTransitions.map((t: any) => t.action)).toContain('clarify');
    // and no longer with the unit while it waits
    const meanwhile = expectOk(await get('/me/work', T.creative), 'creative again');
    expect(meanwhile.items.some((i: any) => i.entityId === wo.id)).toBe(false);

    // A form awaiting approval reaches its approver role, not its submitter.
    const brief = await prisma.brief.findFirstOrThrow({ where: { state: 'UNDER_REVIEW' } });
    const form = expectOk(await post('/forms/submissions', T.sales, {
      formCode: 'B10_BRIEF_COMPLETION', data: { briefId: brief.id, addedInformation: 'x' },
    }), 'submit form');
    const approver = expectOk(await get('/me/work', T.accountManager), 'approver');
    expect(approver.items.find((i: any) => i.entityId === form.id)).toMatchObject({ kind: 'formApproval', href: '/forms' });
    const submitter = expectOk(await get('/me/work', T.sales), 'submitter');
    expect(submitter.items.some((i: any) => i.entityId === form.id)).toBe(false);
  });

  it('puts a breached clock first, then whatever runs out soonest, then the rest', async () => {
    const designer = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const policy = await prisma.slaPolicy.findFirstOrThrow({ where: { code: 'SLA_REVISION' } });
    const mk = (title: string, due: number) => prisma.task.create({
      data: {
        organizationId: project.organizationId, code: `TSK-Q-${title}-${Date.now()}`, projectId: project.id,
        title, departmentCode: 'CR', assigneeId: designer.id, priority: 'NORMAL', state: 'ASSIGNED',
        sourceType: 'ORDER_FORM', sourceRef: 'x', createdById: designer.id, dueDate: new Date(Date.now() + due * 86_400_000),
      },
    });
    const [late, soon, calm] = await Promise.all([mk('late', 30), mk('soon', 30), mk('calm', 1)]);
    await prisma.slaClock.create({ data: {
      organizationId: project.organizationId, policyId: policy.id, entityType: 'task', entityId: late.id,
      startedAt: new Date(Date.now() - 5 * 86_400_000), dueAt: new Date(Date.now() - 86_400_000), state: 'BREACHED', ownerId: designer.id,
    } });
    await prisma.slaClock.create({ data: {
      organizationId: project.organizationId, policyId: policy.id, entityType: 'task', entityId: soon.id,
      startedAt: new Date(), dueAt: new Date(Date.now() + 2 * 3_600_000), state: 'RUNNING', ownerId: designer.id,
    } });

    const queue = expectOk(await get('/me/work', T.designer), 'designer');
    const order = queue.items.map((i: any) => i.entityId);
    expect(order.indexOf(late.id)).toBeLessThan(order.indexOf(soon.id));
    expect(order.indexOf(soon.id)).toBeLessThan(order.indexOf(calm.id));
    expect(queue.items[0].sla.state).toBe('BREACHED');
    expect(queue.breached).toBeGreaterThanOrEqual(1);
  });
});

describe('Supplier 360', () => {
  /**
   * Doc_H §5 asks for a freelancer database and performance management. The rows existed —
   * suppliers, evaluations, outsource requests — and nothing aggregated them.
   */
  async function supplierWithHistory(name: string) {
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const supplier = expectOk(await post('/suppliers', T.creative, {
      name, kind: 'FREELANCER', departmentCode: 'CR', specialty: 'تصویرسازی', dayRate: 18_000_000,
    }), 'create supplier');

    const req = expectOk(await post('/outsource-requests', T.creative, {
      projectId: project.id, kind: 'FREELANCER', supplierId: supplier.id, scopeOfWork: 'تصویرسازی ۶ فریم',
      estimatedCost: 90_000_000, neededBy: new Date(Date.now() + 14 * 86_400_000).toISOString(), justification: 'ظرفیت داخلی پر است',
    }), 'request');
    expectOk(await move('outsourceRequest', req.id, 'submit', T.creative), 'submit');
    expectOk(await move('outsourceRequest', req.id, 'approve', T.deputy), 'approve');
    expectOk(await move('outsourceRequest', req.id, 'fulfil', T.creative), 'fulfil');

    expectOk(await post('/forms/submissions', T.creative, {
      formCode: 'D33_SUPPLIER_EVALUATION',
      data: { supplierId: supplier.id, projectId: project.id, quality: '5', timeliness: '4', communication: '5', costValue: '4', wouldReuse: 'YES', comments: 'دقیق و خوش‌قول' },
    }), 'evaluate');
    return { supplier, project, req };
  }

  it('aggregates evaluations, fulfilment and load into one profile', async () => {
    const { supplier, req } = await supplierWithHistory('نگار تصویرگر');
    const p = expectOk(await get(`/suppliers/${supplier.id}/360`, T.creative), '360');
    expect(p.supplier.name).toBe('نگار تصویرگر');
    expect(p.evaluations).toMatchObject({ count: 1, quality: 5, timeliness: 4, overall: 4.5, reuseRate: 100 });
    expect(p.evaluations.latest[0]).toMatchObject({ overall: 4.5, comments: 'دقیق و خوش‌قول' });
    expect(p.evaluations.latest[0].evaluatedBy).toBeTruthy();
    expect(p.requests).toMatchObject({ total: 1, fulfilled: 1, onTimeRate: 100, open: 0, averageCost: 90_000_000, projects: 1 });
    expect(p.requests.byState).toEqual({ FULFILLED: 1 });
    expect(p.timeline.map((t: any) => t.kind)).toEqual(['EVALUATION', 'REQUEST']);
    expect(p.timeline[1].code).toBe(req.code);
  });

  it('measures on-time fulfilment from the FULFILLED transition, against neededBy', async () => {
    const { supplier, req } = await supplierWithHistory('دیرکرد');
    // Move the deadline into the past: the fulfilment that happened just now is now late.
    await prisma.outsourceRequest.update({ where: { id: req.id }, data: { neededBy: new Date(Date.now() - 86_400_000) } });
    const p = expectOk(await get(`/suppliers/${supplier.id}/360`, T.creative), '360');
    expect(p.requests.onTimeRate).toBe(0);
  });

  it('ranks suggestions by evidence, and an unknown supplier by availability alone', async () => {
    const { suggestionScore } = await import('../src/routes/resources.js');
    const { supplier: proven } = await supplierWithHistory('اثبات‌شده');
    const unknown = expectOk(await post('/suppliers', T.creative, { name: 'تازه‌وارد', kind: 'FREELANCER', departmentCode: 'CR' }), 'unknown');

    const ranked = expectOk(await get('/suppliers/suggest', T.creative, { departmentCode: 'CR', kind: 'FREELANCER', limit: '20' }), 'suggest');
    const ids = ranked.map((r: any) => r.supplier.id);
    expect(ids.indexOf(proven.id)).toBeLessThan(ids.indexOf(unknown.id));
    const provenRow = ranked.find((r: any) => r.supplier.id === proven.id);
    const unknownRow = ranked.find((r: any) => r.supplier.id === unknown.id);
    expect(provenRow.score).toBeGreaterThan(unknownRow.score);
    expect(unknownRow.score).toBe(10);   // nothing but a free calendar

    // The weights: a perfect record scores 100; two open requests cost four points.
    expect(suggestionScore({
      evaluations: { count: 1, quality: 5, timeliness: 5, communication: 5, costValue: 5, overall: 5, reuseRate: 100, latest: [] },
      requests: { total: 1, byState: {}, fulfilled: 1, onTimeRate: 100, open: 0, averageCost: null, projects: 1 },
      timeline: [],
    })).toBe(100);
    expect(suggestionScore({
      evaluations: { count: 0, quality: null, timeliness: null, communication: null, costValue: null, overall: null, reuseRate: null, latest: [] },
      requests: { total: 2, byState: {}, fulfilled: 0, onTimeRate: null, open: 2, averageCost: null, projects: 1 },
      timeline: [],
    })).toBe(6);
  });
});

describe('Budget against actual, per work order', () => {
  /**
   * A project overrun is the sum of unit overruns, and the project figure moves too late to
   * act on. Each declaration is checked against its own order's budget as it lands.
   */
  async function orderWithBudget(budget: number) {
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const creative = await prisma.user.findFirstOrThrow({ where: { email: 'creative@hiva.local' } });
    const wo = expectOk(await post('/work-orders', T.accountManager, {
      projectId: project.id, proposalId: project.proposalId, targetDepartmentCode: 'CR', title: 'سفارش با بودجه',
      scopeOfWork: 'طراحی', brief: 'بریف', expectedOutput: 'فایل', outputFormat: 'PDF',
      deadline: new Date(Date.now() + 10 * 86_400_000).toISOString(), ownerId: creative.id, budget, priority: 'NORMAL',
    }), 'create');
    return { project, wo, creative, accountOwnerId: project.accountOwnerId };
  }
  const declare = (id: string, internal: number, external = 0) =>
    post(`/work-orders/${id}/cost`, T.creative, {
      departmentCode: 'CR', internalCost: internal, externalCost: external,
      items: [{ description: 'کار', quantity: 1, unitCost: internal + external }],
    });

  it('warns the account owner and the declarer the moment an order nears or crosses its budget', async () => {
    const { wo, accountOwnerId } = await orderWithBudget(100_000_000);
    const before = await prisma.notification.count({ where: { userId: accountOwnerId!, kind: 'BUDGET_OVERRUN' } });

    const first = expectOk(await declare(wo.id, 50_000_000), 'first');
    expect(first.budget).toMatchObject({ status: 'UNDER', budget: 100_000_000, declared: 50_000_000, notified: [] });

    const second = expectOk(await declare(wo.id, 40_000_000, 5_000_000), 'second');   // 95%
    expect(second.budget).toMatchObject({ status: 'NEAR', declared: 95_000_000 });
    expect(second.budget.notified).toContain(accountOwnerId);
    const near = await prisma.notification.findFirst({ where: { userId: accountOwnerId!, kind: 'BUDGET_OVERRUN' }, orderBy: { createdAt: 'desc' } });
    expect(near!.severity).toBe('WARNING');
    expect(near!.title).toContain('نزدیک به سقف بودجه');

    const third = expectOk(await declare(wo.id, 20_000_000), 'third');               // 115%
    expect(third.budget.status).toBe('OVER');
    const over = await prisma.notification.findFirst({ where: { userId: accountOwnerId!, kind: 'BUDGET_OVERRUN' }, orderBy: { createdAt: 'desc' } });
    expect(over!.severity).toBe('CRITICAL');
    expect(over!.title).toContain('عبور از بودجه');
    expect(over!.entityId).toBe(wo.id);
    expect(await prisma.notification.count({ where: { userId: accountOwnerId!, kind: 'BUDGET_OVERRUN' } })).toBe(before + 2);
  });

  it('reports every order of the project against its budget, rolled up per unit', async () => {
    const { project, wo } = await orderWithBudget(80_000_000);
    expectOk(await declare(wo.id, 90_000_000), 'over');
    const report = expectOk(await get(`/projects/${project.id}/budget`, T.accountManager), 'budget');

    const row = report.workOrders.find((w: any) => w.workOrderId === wo.id);
    expect(row).toMatchObject({ code: wo.code, departmentCode: 'CR', budget: 80_000_000, declared: 90_000_000, variance: -10_000_000, variancePercent: 12.5, status: 'OVER', declarations: 1 });
    const cr = report.units.find((u: any) => u.departmentCode === 'CR');
    expect(cr.orders).toBeGreaterThanOrEqual(1);
    expect(cr.declared).toBeGreaterThanOrEqual(90_000_000);
    expect(report.project.allocated).toBeGreaterThanOrEqual(80_000_000);
    expect(report.project.declared).toBeGreaterThanOrEqual(90_000_000);
    expect(report.thresholds.near).toBe(0.9);
    // Doc_H §12: Sales never sees cost.
    expect((await get(`/projects/${project.id}/budget`, T.sales)).status).toBe(403);
  });

  it('classifies without a budget honestly', async () => {
    const { statusOf } = await import('../src/reports/budget.js');
    expect(statusOf(null, 5)).toBe('NO_BUDGET');
    expect(statusOf(0, 0)).toBe('NO_BUDGET');
    expect(statusOf(100, 89.99)).toBe('UNDER');
    expect(statusOf(100, 90)).toBe('NEAR');
    expect(statusOf(100, 100)).toBe('NEAR');
    expect(statusOf(100, 100.01)).toBe('OVER');
  });
});

describe('Bulk import and export, per form', () => {
  const CODE = 'B10_BRIEF_COMPLETION';   // briefId (entityRef), addedInformation (textarea), one more

  it('parses CSV the way spreadsheets write it', async () => {
    const { parseCsv, toCsv } = await import('../src/forms/bulk.js');
    const text = '﻿a,b,c\r\n"x, y","she said ""hi""","multi\nline"\r\n1,,3\r\n';
    expect(parseCsv(text)).toEqual([['a', 'b', 'c'], ['x, y', 'she said "hi"', 'multi\nline'], ['1', '', '3']]);
    // Round trip, including the BOM Excel needs for Persian.
    const csv = toCsv([['کلید', 'مقدار'], ['نام', 'شرکت، با ویرگول'], ['فهرست', ['a', 'b']]]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(parseCsv(csv)).toEqual([['کلید', 'مقدار'], ['نام', 'شرکت، با ویرگول'], ['فهرست', 'a|b']]);
  });

  it('generates a template from the schema, with the words a person needs', async () => {
    const t = expectOk(await get(`/forms/definitions/${CODE}/template`, T.sales), 'template');
    expect(t.code).toBe(CODE);
    const brief = t.columns.find((c: any) => c.key === 'briefId');
    expect(brief).toMatchObject({ type: 'entityRef', required: true });
    expect(brief.hintFa).toContain('کد رکورد');
    expect(t.columns.some((c: any) => c.type === 'attachment')).toBe(false);

    const res = await call('GET', `/forms/definitions/${CODE}/template.csv`, { token: T.sales });
    expect(res.status).toBe(200);
    const lines = String(res.body).replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(lines[0]!.split(',')).toContain('briefId');
    expect(lines[1]).toContain(brief.labelFa);   // second row: the labels
  });

  it('previews every row — resolving references by code, reporting each problem, writing nothing', async () => {
    const brief = await prisma.brief.findFirstOrThrow({ where: { state: 'UNDER_REVIEW' } });
    const before = await prisma.formSubmission.count();
    const csv = [
      'briefId,addedInformation',
      `${brief.code},اطلاعات ردیف یک`,            // by code — resolved
      `${brief.id},اطلاعات ردیف دو`,              // by id — as is
      `BRF-999999,اطلاعات ردیف سه`,               // unknown code
      `${brief.code},`,                            // required field missing
    ].join('\n');
    const p = expectOk(await post(`/forms/definitions/${CODE}/import`, T.sales, { csv, mode: 'preview' }), 'preview');
    expect(p).toMatchObject({ mode: 'preview', total: 4, valid: 2, invalid: 2 });
    expect(p.rows[0]).toMatchObject({ index: 1, ok: true });
    expect(p.rows[0].data.briefId).toBe(brief.id);
    expect(p.rows[2].ok).toBe(false);
    expect(p.rows[2].issues[0].message).toContain('BRF-999999');
    expect(p.rows[3].ok).toBe(false);
    expect(p.rows[3].issues[0].message).toContain('الزامی');
    expect(await prisma.formSubmission.count()).toBe(before);
  });

  it('imports the valid rows through the form engine, as drafts by default, and exports them back', async () => {
    const brief = await prisma.brief.findFirstOrThrow({ where: { state: 'UNDER_REVIEW' } });
    const csv = [
      'briefId,addedInformation',
      `${brief.code},وارد شده از اکسل ۱`,
      `${brief.code},"وارد شده، از اکسل ۲"`,
      `BRF-999999,ردیف خراب`,
    ].join('\n');
    const r = expectOk(await post(`/forms/definitions/${CODE}/import`, T.sales, { csv, mode: 'draft' }), 'import');
    expect(r).toMatchObject({ mode: 'draft', total: 3, created: 2, failed: 1 });
    expect(r.rows[0].code).toMatch(/^FRM-/);
    const made = await prisma.formSubmission.findMany({ where: { id: { in: r.rows.filter((x: any) => x.ok).map((x: any) => x.id) } } });
    expect(made.every((m) => m.state === 'DRAFT')).toBe(true);
    expect(made.every((m) => m.definitionVersion >= 1)).toBe(true);
    const audited = await prisma.auditEvent.findFirst({ where: { action: 'BULK_IMPORT' }, orderBy: { createdAt: 'desc' } });
    expect(audited?.after).toMatchObject({ form: CODE, created: 2, failed: 1 });

    // Submit mode goes through approvals like a hand-filled form would.
    const s = expectOk(await post(`/forms/definitions/${CODE}/import`, T.sales, { rows: [{ briefId: brief.code, addedInformation: 'ثبت مستقیم' }], mode: 'submit' }), 'submit');
    expect(s.created).toBe(1);
    expect((await prisma.formSubmission.findUniqueOrThrow({ where: { id: s.rows[0].id } })).state).toBe('PENDING_APPROVAL');

    const out = await call('GET', `/forms/definitions/${CODE}/export.csv`, { token: T.sales });
    expect(out.status).toBe(200);
    const text = String(out.body);
    expect(text).toContain('code,state,definitionVersion,submittedAt,submittedBy,briefId,addedInformation');
    expect(text).toContain('وارد شده از اکسل ۱');
    // A Persian comma is not a delimiter, so the exporter rightly leaves it unquoted.
    expect(text).toContain('وارد شده، از اکسل ۲');
    expect(text).not.toContain('"وارد شده، از اکسل ۲"');
    expect(text).not.toContain('ردیف خراب');
  });

  it('refuses a mode it does not know and an empty request', async () => {
    expect((await post(`/forms/definitions/${CODE}/import`, T.sales, { rows: [], mode: 'yolo' })).status).toBe(400);
    expect((await post(`/forms/definitions/${CODE}/import`, T.sales, { mode: 'preview' })).status).toBe(400);
    expect((await post(`/forms/definitions/NOPE/import`, T.sales, { rows: [] })).status).toBe(404);
  });
});

describe('Calendars per unit and per person', () => {
  /**
   * One calendar for everyone was the model. A production unit that works Thursdays, a
   * freelancer with their own hours, and someone on leave all had their deadlines computed
   * from hours they do not keep. Inheritance is organisation → department → person.
   */
  const wed17 = new Date(2026, 8, 2, 17, 0, 0);   // Wednesday 2026-09-02, 17:00 — end of the default week

  it('lets a unit keep its own working days, and a person their own hours', async () => {
    const org = await prisma.organization.findFirstOrThrow();
    const designer = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });

    // Creative works Thursdays too.
    expectOk(await patch('/departments/CR/calendar', T.admin, { workingDays: [6, 0, 1, 2, 3, 4] }), 'unit calendar');
    const unit = expectOk(await get('/calendar/effective', T.admin, { departmentCode: 'CR' }), 'unit');
    expect(unit.workingDays).toEqual([6, 0, 1, 2, 3, 4]);
    expect(unit.startHour).toBe(9);                       // inherited from the organisation

    // The designer, in Creative, starts at 11.
    expectOk(await patch(`/users/${designer.id}/calendar`, T.admin, { workStartHour: 11 }), 'person calendar');
    const person = expectOk(await get('/calendar/effective', T.admin, { userId: designer.id }), 'person');
    expect(person.workingDays).toEqual([6, 0, 1, 2, 3, 4]);   // from the unit
    expect(person.startHour).toBe(11);                        // their own
    expect(person.endHour).toBe(org.workEndHour);             // inherited

    // Four working hours from Wednesday 17:00: the organisation's week ends now, so Saturday;
    // Creative's continues on Thursday.
    resetCalendarCache();
    const orgCal = await loadCalendar(org.id);
    const unitCal = await loadCalendar(org.id, { departmentCode: 'CR' });
    expect(addBusinessHours(wed17, 4, orgCal).getDay()).toBe(6);    // Saturday
    expect(addBusinessHours(wed17, 4, unitCal).getDay()).toBe(4);   // Thursday

    // Clearing the override inherits again.
    expectOk(await patch('/departments/CR/calendar', T.admin, { workingDays: null }), 'clear');
    expect(expectOk(await get('/calendar/effective', T.admin, { departmentCode: 'CR' }), 'cleared').workingDays).toEqual(org.workingDays);
    expect((await patch('/departments/CR/calendar', T.admin, { workingDays: [9] })).status).toBe(400);
    expect((await patch('/departments/CR/calendar', T.admin, { workStartHour: 18, workEndHour: 9 })).status).toBe(400);
    expect((await patch('/departments/CR/calendar', T.sales, { workingDays: [1] })).status).toBe(403);
  });

  it('gives a person on leave no working hours, so a clock they own stops consuming its budget', async () => {
    const org = await prisma.organization.findFirstOrThrow();
    const strategy = await prisma.user.findFirstOrThrow({ where: { email: 'strategy@hiva.local' } });
    // Away Saturday to Monday, 5–7 September 2026.
    const leave = expectOk(await post(`/users/${strategy.id}/leaves`, T.admin, { from: '2026-09-05', to: '2026-09-07', kind: 'VACATION', note: 'سفر' }), 'leave');
    expect(leave.kind).toBe('VACATION');
    const mine = expectOk(await get(`/users/${strategy.id}/leaves`, T.admin), 'list');
    expect(mine.some((l: any) => l.id === leave.id)).toBe(true);

    resetCalendarCache();
    const cal = await loadCalendar(org.id, { userId: strategy.id });
    expect(cal.holidays.has('2026-09-05')).toBe(true);
    expect(cal.holidays.has('2026-09-07')).toBe(true);
    expect(cal.holidays.has('2026-09-08')).toBe(false);

    // Four working hours from Wednesday 17:00: normally Saturday 13:00; with Sat–Mon away,
    // Tuesday 13:00. The organisation's own calendar is unchanged.
    const due = addBusinessHours(wed17, 4, cal);
    expect(due.getDay()).toBe(2);
    expect(due.getHours()).toBe(13);
    expect(addBusinessHours(wed17, 4, await loadCalendar(org.id)).getDay()).toBe(6);

    // And the same for a real clock: started while the owner is away, due after they return.
    const policy = await prisma.slaPolicy.findFirstOrThrow({ where: { code: 'SLA_ACCOUNT_QC' } });
    const clock = await prisma.slaClock.create({ data: {
      organizationId: org.id, policyId: policy.id, entityType: 'test', entityId: `leave-${Date.now()}`,
      startedAt: new Date(2026, 8, 5, 10, 0, 0), dueAt: new Date(2026, 8, 9, 17, 0, 0), state: 'RUNNING', ownerId: strategy.id,
    } });
    await tickSlaClocks(new Date(2026, 8, 7, 16, 0, 0));   // Monday, still on leave: nothing consumed
    expect((await prisma.slaClock.findUniqueOrThrow({ where: { id: clock.id } })).state).toBe('RUNNING');

    expectOk(await call('DELETE', `/users/${strategy.id}/leaves/${leave.id}`, { token: T.admin }), 'delete');
    resetCalendarCache();
    expect((await loadCalendar(org.id, { userId: strategy.id })).holidays.has('2026-09-05')).toBe(false);
    expect((await post(`/users/${strategy.id}/leaves`, T.admin, { from: '2026-09-10', to: '2026-09-01' })).status).toBe(400);
    expect((await get(`/users/${strategy.id}/leaves`, T.sales)).status).toBe(403);
  });

  it('caches per scope, not per organisation', async () => {
    const org = await prisma.organization.findFirstOrThrow();
    const designer = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    resetCalendarCache();
    const a = await loadCalendar(org.id);
    const b = await loadCalendar(org.id, { userId: designer.id });
    expect(a).not.toBe(b);
    expect(await loadCalendar(org.id, { userId: designer.id })).toBe(b);   // second read is the cached one
  });
});

describe('Time logging and cost accuracy', () => {
  /**
   * cost_declarations held what the units declared; nothing measured what it took. Hours are
   * the other side of the Doc_H "cost accuracy" KPI, and they become money through a rate.
   */
  async function orderWithTask(budget: number, estimate: number) {
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const creative = await prisma.user.findFirstOrThrow({ where: { email: 'creative@hiva.local' } });
    const designer = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const wo = expectOk(await post('/work-orders', T.accountManager, {
      projectId: project.id, proposalId: project.proposalId, targetDepartmentCode: 'CR', title: 'سفارش با زمان',
      scopeOfWork: 'طراحی', brief: 'بریف', expectedOutput: 'فایل', outputFormat: 'PDF',
      deadline: new Date(Date.now() + 10 * 86_400_000).toISOString(), ownerId: creative.id, budget, priority: 'NORMAL',
    }), 'wo');
    const task = await prisma.task.create({ data: {
      organizationId: project.organizationId, code: `TSK-T-${Date.now()}`, projectId: project.id, workOrderId: wo.id,
      title: 'طراحی', departmentCode: 'CR', assigneeId: designer.id, priority: 'NORMAL', state: 'IN_PROGRESS',
      sourceType: 'ORDER_FORM', sourceRef: wo.code, createdById: creative.id, estimateHours: estimate,
    } });
    return { wo, task, designer, creative };
  }

  it('logs hours on a task and keeps actualHours as their sum', async () => {
    const { task, designer } = await orderWithTask(1, 10);
    const a = expectOk(await post(`/tasks/${task.id}/time`, T.designer, { hours: 3.5, workedOn: '2026-09-20', note: 'وایرفریم' }), 'log');
    expect(a.actualHours).toBe(3.5);
    const b = expectOk(await post(`/tasks/${task.id}/time`, T.designer, { hours: 4 }), 'log 2');
    expect(b.actualHours).toBe(7.5);
    expect(Number((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).actualHours)).toBe(7.5);
    const listed = expectOk(await get(`/tasks/${task.id}/time`, T.creative), 'list');
    expect(listed.entries).toHaveLength(2);
    expect(listed.entries[0].user.id).toBe(designer.id);
    expect(listed.entries.find((e: any) => e.note === 'وایرفریم')).toBeTruthy();

    // Only the assignee, or task.write; only sane numbers.
    expect((await post(`/tasks/${task.id}/time`, T.sales, { hours: 1 })).status).toBe(403);
    expect((await post(`/tasks/${task.id}/time`, T.designer, { hours: 0 })).status).toBe(400);
    expect((await post(`/tasks/${task.id}/time`, T.designer, { hours: 30 })).status).toBe(400);
    expectOk(await call('DELETE', `/tasks/${task.id}/time/${a.entry.id}`, { token: T.designer }), 'delete');
    expect(Number((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).actualHours)).toBe(4);
  });

  it('takes one number with the submission — the least that closes the loop', async () => {
    const { task } = await orderWithTask(1, 6);
    expectOk(await post(`/workflow/task/${task.id}/transitions`, T.designer, { action: 'submit', payload: { hours: 8 } }), 'submit with hours');
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: { timeEntries: true } });
    expect(after.state).toBe('SUBMITTED');
    expect(Number(after.actualHours)).toBe(8);
    expect(after.timeEntries[0]!.note).toBe('ثبت هنگام تحویل');
  });

  it('turns declared cost against the hours, per unit and per order, and says what it could not price', async () => {
    const { wo, task, designer, creative } = await orderWithTask(100_000_000, 10);
    // The unit declares 40M; the designer logs 20h at 1.5M/h = 30M; the creative manager logs 4h with no rate.
    expectOk(await patch('/departments/CR/rate', T.admin, { hourlyCost: 1_000_000 }), 'unit rate');
    expectOk(await patch(`/users/${designer.id}/rate`, T.admin, { hourlyCost: 1_500_000 }), 'person rate');
    expectOk(await patch(`/users/${creative.id}/rate`, T.admin, { hourlyCost: null }), 'clear');
    expectOk(await post(`/work-orders/${wo.id}/cost`, T.creative, { departmentCode: 'CR', internalCost: 40_000_000, externalCost: 0, items: [{ description: 'x', quantity: 1, unitCost: 40_000_000 }] }), 'declare');
    expectOk(await post(`/tasks/${task.id}/time`, T.designer, { hours: 20 }), 'designer hours');

    const r = expectOk(await get('/reports/cost-accuracy', T.accountManager), 'report');
    const row = r.workOrders.find((w: any) => w.workOrderId === wo.id);
    expect(row).toMatchObject({ departmentCode: 'CR', declared: 40_000_000, hours: 20, actualCost: 30_000_000, ratio: 0.75, unpricedHours: 0 });
    expect(row.estimateErrorPercent).toBe(100);           // estimated 10, took 20
    const cr = r.units.find((u: any) => u.departmentCode === 'CR');
    expect(cr.declared).toBeGreaterThanOrEqual(40_000_000);
    expect(cr.actualCost).toBeGreaterThanOrEqual(30_000_000);

    // A person with no rate of their own uses the unit's; clear the unit's and the hours are unpriced.
    expectOk(await post(`/tasks/${task.id}/time`, T.creative, { hours: 4, userId: creative.id }), 'manager hours');
    const withUnitRate = expectOk(await get('/reports/cost-accuracy', T.accountManager), 'report 2');
    expect(withUnitRate.workOrders.find((w: any) => w.workOrderId === wo.id)).toMatchObject({ hours: 24, actualCost: 34_000_000, unpricedHours: 0 });
    expectOk(await patch('/departments/CR/rate', T.admin, { hourlyCost: null }), 'clear unit rate');
    const unpriced = expectOk(await get('/reports/cost-accuracy', T.accountManager), 'report 3');
    expect(unpriced.workOrders.find((w: any) => w.workOrderId === wo.id)).toMatchObject({ actualCost: 30_000_000, unpricedHours: 4 });
    // Doc_H §12: Sales never sees cost.
    expect((await get('/reports/cost-accuracy', T.sales)).status).toBe(403);
  });
});

describe('Critical path and schedule', () => {
  /**
   * The value is the float: "three days late and it does not matter" against "a day late and
   * the whole project moves". A chain A→B→C beside a short D: the chain is critical, D floats.
   */
  // The plan starts next Saturday 09:00 and ends the Wednesday after at 17:00: five working
  // days, in the future, so "now" does not intrude on the arithmetic.
  const nextSaturday = () => { const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7)); d.setHours(9, 0, 0, 0); return d; };
  const START = nextSaturday();
  const dayAt = (offset: number, hour: number) => { const d = new Date(START); d.setDate(d.getDate() + offset); d.setHours(hour, 0, 0, 0); return d; };
  async function project() {
    const org = await prisma.organization.findFirstOrThrow();
    const company = await prisma.company.findFirstOrThrow();
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const p = await prisma.project.create({ data: {
      organizationId: org.id, code: `PRJ-CPM-${Date.now()}`, name: 'پروژهٔ مسیر بحرانی', companyId: company.id, accountOwnerId: pmo.id,
      objective: 'x', state: 'ACTIVE', plannedStart: START, plannedEnd: dayAt(4, 17),
    } });
    // Unassigned on purpose: the schedule runs on the assignee's calendar, and the calendar tests
    // above give the designer their own hours. The organisation's calendar is the fixture here.
    const mk = (title: string, estimate: number | null, due?: Date) => prisma.task.create({ data: {
      organizationId: org.id, code: `TSK-${title}-${Date.now()}`, projectId: p.id, title, departmentCode: 'CR', assigneeId: null,
      priority: 'NORMAL', state: 'ASSIGNED', sourceType: 'ORDER_FORM', sourceRef: 'x', createdById: pmo.id, estimateHours: estimate, dueDate: due ?? null,
    } });
    return { p, mk };
  }

  it('finds the chain that sets the finish, and gives the rest their float', async () => {
    const { p, mk } = await project();
    const a = await mk('A', 8); const b = await mk('B', 16); const c = await mk('C', 8); const d = await mk('D', 4);
    expectOk(await post(`/tasks/${b.id}/dependencies`, T.pmo, { prerequisiteId: a.id }), 'B after A');
    expectOk(await post(`/tasks/${c.id}/dependencies`, T.pmo, { prerequisiteId: b.id }), 'C after B');
    // A loop is refused before it exists.
    expect((await post(`/tasks/${a.id}/dependencies`, T.pmo, { prerequisiteId: c.id })).body.error.code).toBe('CYCLE');
    expect((await post(`/tasks/${a.id}/dependencies`, T.pmo, { prerequisiteId: a.id })).body.error.code).toBe('SELF_DEPENDENCY');

    const s = expectOk(await get(`/projects/${p.id}/schedule`, T.pmo), 'schedule');
    const by = Object.fromEntries(s.tasks.map((t: any) => [t.taskId, t]));
    expect(by[a.id].critical).toBe(true);
    expect(by[b.id].critical).toBe(true);
    expect(by[c.id].critical).toBe(true);
    expect(by[d.id].critical).toBe(false);
    expect(by[d.id].floatHours).toBeGreaterThan(20);           // 32h of chain, 4h of work
    expect(s.criticalPath.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(by[b.id].prerequisites).toEqual([a.id]);
    // B cannot start before A finishes.
    expect(new Date(by[b.id].earliestStart).getTime()).toBeGreaterThanOrEqual(new Date(by[a.id].earliestFinish).getTime());
    // The chain is four working days; the project is planned for five: slack, not slip.
    expect(s.slipHours).toBeLessThan(0);
    expect(s.cycles).toEqual([]);
  });

  it('projects a slip when the chain outgrows the plan, flags tasks that miss their own due date, and marks assumed estimates', async () => {
    const { p, mk } = await project();
    const a = await mk('A', 24); const b = await mk('B', 24, dayAt(2, 17)); const c = await mk('C', null);
    expectOk(await post(`/tasks/${b.id}/dependencies`, T.pmo, { prerequisiteId: a.id }), 'B after A');
    expectOk(await post(`/tasks/${c.id}/dependencies`, T.pmo, { prerequisiteId: b.id }), 'C after B');
    const s = expectOk(await get(`/projects/${p.id}/schedule`, T.pmo), 'schedule');
    const by = Object.fromEntries(s.tasks.map((t: any) => [t.taskId, t]));
    expect(s.slipHours).toBeGreaterThan(0);                     // 56h of chain into a 40h plan
    expect(by[b.id].missesDueDate).toBe(true);                  // B ends after Monday 17:00
    expect(by[c.id]).toMatchObject({ estimateAssumed: true, estimateHours: 8 });
    expectOk(await call('DELETE', `/tasks/${c.id}/dependencies/${b.id}`, { token: T.pmo }), 'unlink');
    const after = expectOk(await get(`/projects/${p.id}/schedule`, T.pmo), 'schedule again');
    expect(Object.fromEntries(after.tasks.map((t: any) => [t.taskId, t]))[c.id].prerequisites).toEqual([]);
  });

  it('walks working hours backwards exactly', async () => {
    const { subtractBusinessHours } = await import('../src/reports/schedule.js');
    const end = new Date(2026, 8, 9, 13, 0, 0);                 // Wednesday 13:00
    const start = subtractBusinessHours(end, 12, DEFAULT_CALENDAR);
    expect(businessHoursBetween(start, end, DEFAULT_CALENDAR)).toBeCloseTo(12, 2);
    expect(addBusinessHours(start, 12, DEFAULT_CALENDAR).getTime()).toBeLessThanOrEqual(end.getTime() + 1000);
  });
});

describe('Conditional approval routing', () => {
  /**
   * Doc_H fixes who must approve each form; real authority is conditional — "a contract above
   * this figure goes through Legal", "a price below cost needs the CEO". The rules are data on
   * the definition, evaluated against the values actually submitted, and every rule carries the
   * sentence it was written in so the extra approver is never a mystery.
   */
  const PRICING = 'F47_PRICING';
  const CONTRACT = 'F50_CONTRACT_SCALE';

  async function proposal() {
    return prisma.proposal.findFirstOrThrow();
  }

  it('adds the approver the values call for, and says which rule did it', async () => {
    const p = await proposal();
    // Sold above cost with a healthy margin: nobody beyond the form's own approvers.
    const healthy = expectOk(await post('/forms/submissions', T.accountManager, {
      formCode: PRICING,
      data: { proposalId: p.id, totalCost: 100_000_000, salePrice: 150_000_000, marginPercent: 33, rationale: 'قیمت استاندارد' },
    }), 'healthy pricing');
    expect(healthy.requiredRoles.sort()).toEqual(['CEO', 'DEPUTY']);
    expect(healthy.routedBy).toEqual([]);

    // Sold below cost: the CEO is added, and the submission carries the reason.
    const belowCost = expectOk(await post('/forms/submissions', T.accountManager, {
      formCode: PRICING,
      data: { proposalId: p.id, totalCost: 200_000_000, salePrice: 150_000_000, marginPercent: 12, rationale: 'ورود به مشتری راهبردی' },
    }), 'below cost');
    expect(belowCost.requiredRoles).toContain('CEO');
    const ids = belowCost.routedBy.map((m: any) => m.id);
    expect(ids).toContain('pricing.below-cost');
    expect(ids).toContain('pricing.thin-margin');          // 12 % is under the default floor too
    expect(belowCost.routedBy[0].whenFa).toContain('قیمت فروش کمتر از قیمت تمام‌شده');

    const stored = await prisma.formSubmission.findUniqueOrThrow({ where: { id: belowCost.id } });
    expect(stored.requiredRoles).toContain('CEO');
    expect((stored.routing as any).matched).toHaveLength(2);
  });

  it('answers the same question before the form is sent as it does after', async () => {
    const p = await proposal();
    const big = expectOk(await call('POST', `/forms/definitions/${CONTRACT}/routing/preview`, {
      token: T.accountManager,
      payload: { data: { proposalId: p.id, contractValue: 9_000_000_000, scaleBand: 'XL' } },
    }), 'preview large');
    expect(big.roles).toContain('LEGAL_MANAGER');
    expect(big.matched.map((m: any) => m.id).sort()).toEqual(['contract.large-band', 'contract.large-value']);
    expect(big.rolesFa).toContain('مدیر حقوقی');
    // Rules that did not fire are returned too — a threshold should be visible before it is hit.
    const small = expectOk(await call('POST', `/forms/definitions/${CONTRACT}/routing/preview`, {
      token: T.accountManager,
      payload: { data: { proposalId: p.id, contractValue: 100_000_000, scaleBand: 'S' } },
    }), 'preview small');
    expect(small.matched).toEqual([]);
    expect(small.unmatched).toHaveLength(2);
    expect(small.roles).toEqual(small.baseRoles);

    // And the real submission agrees with the preview.
    const submitted = expectOk(await post('/forms/submissions', T.accountManager, {
      formCode: CONTRACT,
      data: { proposalId: p.id, contractValue: 9_000_000_000, scaleBand: 'XL', notes: 'قرارداد سالانه' },
    }), 'submit large');
    expect(submitted.requiredRoles.sort()).toEqual(big.roles.sort());
  });

  it('lets the added approver decide, and refuses someone the rules did not name', async () => {
    const p = await proposal();
    const submitted = expectOk(await post('/forms/submissions', T.accountManager, {
      formCode: PRICING,
      data: { proposalId: p.id, totalCost: 300_000_000, salePrice: 250_000_000, marginPercent: 8, rationale: 'تخفیف استثنایی' },
    }), 'below cost');
    expect(submitted.state).toBe('PENDING_APPROVAL');

    // A unit manager was never in this form's approver set, by rule or by Doc_H.
    expect((await post(`/forms/submissions/${submitted.id}/decision`, T.creative, { decision: 'APPROVE' })).status).toBe(403);
    const decided = expectOk(await post(`/forms/submissions/${submitted.id}/decision`, T.ceo, { decision: 'APPROVE', comment: 'به‌خاطر رابطهٔ بلندمدت تأیید شد' }), 'ceo approves');
    expect(decided.state).toBe('APPROVED');
  });

  it('versions a rule change, so a form already filed keeps the rules it was judged under', async () => {
    const p = await proposal();
    const before = await prisma.formDefinition.findFirstOrThrow({ where: { code: CONTRACT } });
    const filed = expectOk(await post('/forms/submissions', T.accountManager, {
      formCode: CONTRACT,
      data: { proposalId: p.id, contractValue: 1_000_000_000, scaleBand: 'M', notes: 'پیش از تغییر قاعده' },
    }), 'filed under the old rules');
    expect(filed.requiredRoles).not.toContain('LEGAL_MANAGER');

    // The organisation drops its threshold to a tenth of what it was.
    const put = expectOk(await call('PUT', `/forms/definitions/${CONTRACT}/routing`, {
      token: T.admin,
      payload: {
        note: 'سخت‌گیرانه‌تر شد',
        rules: [{
          id: 'contract.large-value', whenFa: 'مبلغ قرارداد بیش از ۵۰۰٬۰۰۰٬۰۰۰ ریال باشد',
          when: { field: 'contractValue', op: 'gt', value: 500_000_000 },
          addApprovers: ['LEGAL_MANAGER'],
        }],
      },
    }), 'tighten');
    expect(put.version).toBe(before.version + 1);

    // The same value now routes through Legal; the form already filed is untouched.
    const after = expectOk(await post('/forms/submissions', T.accountManager, {
      formCode: CONTRACT,
      data: { proposalId: p.id, contractValue: 1_000_000_000, scaleBand: 'M', notes: 'پس از تغییر قاعده' },
    }), 'filed under the new rules');
    expect(after.requiredRoles).toContain('LEGAL_MANAGER');
    const untouched = await prisma.formSubmission.findUniqueOrThrow({ where: { id: filed.id } });
    expect(untouched.requiredRoles).not.toContain('LEGAL_MANAGER');
    expect(untouched.definitionVersion).toBe(before.version);

    // Rules are validated, and only an administrator may change them.
    expect((await call('PUT', `/forms/definitions/${CONTRACT}/routing`, { token: T.sales, payload: { rules: [] } })).status).toBe(403);
    expect((await call('PUT', `/forms/definitions/${CONTRACT}/routing`, {
      token: T.admin, payload: { rules: [{ id: 'x!', whenFa: 'بدون شناسهٔ معتبر', when: { field: 'a', op: 'gt', value: 1 } }] },
    })).status).toBe(400);
    expect((await call('PUT', `/forms/definitions/${CONTRACT}/routing`, {
      token: T.admin,
      payload: { rules: [
        { id: 'dup', whenFa: 'قاعدهٔ نخست', when: { field: 'contractValue', op: 'gt', value: 1 } },
        { id: 'dup', whenFa: 'قاعدهٔ دوم با همان شناسه', when: { field: 'contractValue', op: 'gt', value: 2 } },
      ] },
    })).body.error.code).toBe('DUPLICATE_RULE_ID');
  });
});

describe('Organisational memory', () => {
  /**
   * Doc_H's whole closure ritual exists so the next project is better than the last, and
   * nobody reads last year's closure forms because finding the relevant one means remembering
   * it exists. This is the index that answers "what have we done before that looks like this",
   * and it says out loud which embedder produced its numbers.
   */
  const memory = () => import('../src/memory/index.js');
  const embed = () => import('../src/memory/embed.js');

  it('normalises Persian so two spellings of one word meet, and embeds deterministically', async () => {
    const { normalisePersian, localEmbed, cosine, tokenise } = await embed();
    // Arabic ي/ك, ZWNJ and Arabic-Indic digits are all the same word to a reader.
    expect(normalisePersian('مي‌شود ٤ كمپين')).toBe('می شود 4 کمپین');
    expect(normalisePersian('طراحیِ بَرند')).toBe('طراحی برند');
    expect(tokenise('این یک کمپین برای برند است')).toEqual(['کمپین', 'برند']);

    const a = localEmbed('کمپین دیجیتال برای برند صنایع غذایی');
    const again = localEmbed('کمپین دیجیتال برای برند صنایع غذایی');
    expect(a).toEqual(again);                                   // a persisted index needs stability
    expect(Math.sqrt(a.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1, 6);   // unit length: dot = cosine

    const near = localEmbed('کمپین دیجیتال برند غذایی');
    const far = localEmbed('قرارداد حقوقی و الحاقیه مالیاتی');
    expect(cosine(a, near)).toBeGreaterThan(cosine(a, far));
  });

  it('indexes what the organisation knows, and re-embeds only what changed', async () => {
    const { reindexMemory } = await memory();
    const org = await prisma.organization.findFirstOrThrow();
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });

    const lesson = await prisma.lessonLearned.create({ data: {
      organizationId: org.id, projectId: project.id, title: 'تدوین ویدئو در فصل پرکار',
      category: 'PRODUCTION', situation: 'ظرفیت تدوین در دی و بهمن پر بود و تحویل عقب افتاد.',
      lesson: 'برای پروژه‌های ویدئویی فصل پرکار، ظرفیت تدوین باید از قبل رزرو شود.',
      recommendation: 'در برآورد زمان تدوین، دو هفته حاشیه بگذارید.', recordedById: pmo.id,
    } });

    const first = await reindexMemory(org.id);
    expect(first.indexed).toBeGreaterThan(0);
    const row = await prisma.memoryDocument.findFirstOrThrow({ where: { entityType: 'lessonLearned', entityId: lesson.id } });
    expect(row.dims).toBeGreaterThan(0);
    expect(row.vector.length).toBe(row.dims);
    expect(row.searchText).toContain('تدوین');

    // Nothing changed: a second pass embeds nothing.
    const second = await reindexMemory(org.id);
    expect(second.indexed).toBe(0);
    expect(second.scanned).toBe(first.scanned);

    // A record that disappears stops being remembered.
    await prisma.lessonLearned.delete({ where: { id: lesson.id } });
    const third = await reindexMemory(org.id);
    expect(third.removed).toBeGreaterThan(0);
    expect(await prisma.memoryDocument.findFirst({ where: { entityId: lesson.id } })).toBeNull();
  });

  it('finds the lesson by what it is about, and refuses to search what the caller may not read', async () => {
    const { reindexMemory, searchMemory } = await memory();
    const org = await prisma.organization.findFirstOrThrow();
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    await prisma.lessonLearned.create({ data: {
      organizationId: org.id, projectId: project.id, title: 'استراتژی مشتریان صنایع غذایی',
      category: 'STRATEGY', situation: 'برای دو مشتری صنایع غذایی کمپین محتوایی اجرا شد.',
      lesson: 'در صنایع غذایی، محتوای دستور پخت بیشترین تعامل را می‌گیرد.',
      recommendation: 'برای برندهای غذایی از ابتدا محتوای دستور پخت پیشنهاد دهید.', recordedById: pmo.id,
    } });
    await reindexMemory(org.id);

    const found = await searchMemory(org.id, 'برای مشتری صنایع غذایی چه استراتژی‌هایی داده‌ایم؟', {
      permissions: ['project.read', 'brief.read', 'proposal.read', 'report.read'],
    });
    expect(found.hits.length).toBeGreaterThan(0);
    expect(found.hits[0]!.titleFa).toContain('صنایع غذایی');
    expect(found.hits[0]!.kindFa).toBe('درس آموخته');
    expect(found.hits[0]!.snippetFa).toContain('غذایی');
    // Both halves of the score are shown, so a keyword hit cannot pose as understanding.
    expect(found.hits[0]!.semantic).toBeGreaterThanOrEqual(0);
    expect(found.hits[0]!.lexical).toBeGreaterThanOrEqual(0);
    expect(found.hits[0]!.score).toBeGreaterThan(0);

    // A caller without project.read never sees lessons, whatever they search for.
    const blind = await searchMemory(org.id, 'صنایع غذایی', { permissions: ['crm.lead.read'] });
    expect(blind.hits).toEqual([]);
    expect(blind.candidates).toBe(0);
  });

  it('serves the search and the status over the API, and says which embedder answered', async () => {
    const res = expectOk(await get('/memory/search', T.pmo, { q: 'صنایع غذایی', limit: '5' }), 'search');
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.usedService).toBe(false);                       // no service configured in tests
    expect(res.basisFa).toContain('سرویس embedding پیکربندی نشده');
    expect(res.kinds.map((k: any) => k.key)).toContain('lessonLearned');

    const status = expectOk(await get('/memory/status', T.pmo), 'status');
    expect(status.total).toBeGreaterThan(0);
    expect(status.serviceConfigured).toBe(false);
    expect(status.byKind.find((k: any) => k.key === 'lessonLearned').count).toBeGreaterThan(0);

    // Reindexing is an administrator's button, not everyone's.
    expect((await post('/memory/reindex', T.pmo, {})).status).toBe(403);
    expect(expectOk(await post('/memory/reindex', T.admin, {}), 'reindex').scanned).toBeGreaterThan(0);
  });
});

describe('Meeting to minutes to tasks', () => {
  /**
   * Doc_H §6: no verbal task is valid. The minutes forms collected action items and stored them
   * as JSON that never became tasks, so decisions stayed verbal. These tests pin down the path
   * from notes to a draft a person corrects, to tasks sourced to the meeting — and the refusals
   * that keep that record honest.
   */
  const ex = () => import('../src/meetings/extract.js');
  const HELD = new Date(2026, 8, 22, 10, 0, 0);            // Tuesday 22 Sept 2026 = ۳۱ شهریور ۱۴۰۵
  const people = [
    { id: 'u1', fullName: 'بهراد مهرنیا', departmentCode: 'CR' },
    { id: 'u2', fullName: 'سپیده آذر', departmentCode: 'CR' },
    { id: 'u3', fullName: 'آرش نیک‌بین', departmentCode: 'ST' },
    { id: 'u4', fullName: 'آرش رحیمی', departmentCode: 'ME' },
  ];

  it('reads Persian dates the way the calendar on the wall does', async () => {
    const { jalaliToDate, parseDue } = await ex();
    const persian = (d: Date) => new Intl.DateTimeFormat('en-u-ca-persian', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(d);
    // Round-trips through the platform's own Persian calendar, leap years included.
    for (const [y, m, d] of [[1405, 7, 1], [1404, 1, 1], [1403, 12, 30], [1405, 12, 29]] as const) {
      expect(persian(jalaliToDate(y, m, d)!)).toBe(`${m}/${d}/${y} AP`);
    }
    expect(jalaliToDate(1404, 12, 30)).toBeNull();          // 1404 is not a leap year
    const due = (t: string) => parseDue(t, HELD)?.date;
    expect(due('تا شنبه')!.getDay()).toBe(6);
    expect(due('ظرف ۳ روز')!.getDate()).toBe(25);
    expect(due('تا پایان هفته')!.getDay()).toBe(3);        // the Iranian working week ends on Wednesday
    expect(persian(due('تا ۱۲ مهر')!)).toBe('7/12/1405 AP');
    expect(persian(due('مهلت ۱۴۰۵/۰۷/۱۵')!)).toBe('7/15/1405 AP');
    expect(due('بدون تاریخ')).toBeUndefined();
  });

  it('drafts decisions and actions from notes, and never guesses an owner it cannot be sure of', async () => {
    const { draftMinutes } = await ex();
    const notes = `- قرار شد لحن محتوا رسمی‌تر شود.
- اقدام: مهرنیا نسخهٔ دوم کی‌ویژوال را تا شنبه آماده کند.
- سپیده آذر پلن تولید ویدئو را ظرف ۳ روز بفرستد.
- آرش گزارش رقبا را تا ۱۲ مهر تهیه کند.
- مسئول: واحد رسانه — پلن رسانه را هفتهٔ آینده ارسال کند.
- باید بودجه دوباره بررسی شود.`;
    const d = draftMinutes(notes, HELD, people);
    expect(d.decisions.map((x) => x.text)).toEqual(['قرار شد لحن محتوا رسمی‌تر شود.']);
    expect(d.actions).toHaveLength(4);

    const [kv, video, rivals, media] = d.actions;
    expect(kv).toMatchObject({ title: 'نسخهٔ دوم کی‌ویژوال را آماده کند.', assigneeId: 'u1', departmentCode: 'CR', confidence: 'HIGH' });
    expect(video).toMatchObject({ title: 'پلن تولید ویدئو را بفرستد.', assigneeId: 'u2', confidence: 'HIGH' });
    // Two people are called Arash: both are offered, neither is picked, and «گزارش» stays whole.
    expect(rivals!.assigneeId).toBeNull();
    expect(rivals!.ownerRaw).toBe('آرش');
    expect(rivals!.candidates.map((c) => c.id).sort()).toEqual(['u3', 'u4']);
    expect(rivals!.title).toContain('گزارش رقبا');
    expect(media).toMatchObject({ ownerRaw: 'واحد رسانه', departmentCode: 'ME', title: 'پلن رسانه را ارسال کند.' });
    // A commitment with nobody and no date is exactly how a decision stays verbal: it is flagged.
    expect(d.unresolvedFa).toEqual(['باید بودجه دوباره بررسی شود.']);
  });

  it('turns confirmed actions into tasks sourced to the meeting, with the acceptance clock running', async () => {
    const o = await prisma.organization.findFirstOrThrow();
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const designer = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const meeting = expectOk(await post('/meetings', T.accountManager, {
      projectId: project.id, kind: 'INTERNAL', subject: 'بازبینی کمپین پاییز', heldAt: HELD.toISOString(), attendees: 'تیم خلاقیت و اکانت',
    }), 'meeting');

    const draft = expectOk(await post(`/meetings/${meeting.id}/draft-minutes`, T.accountManager, {
      notes: `قرار شد لحن رسمی‌تر شود.\nاقدام: ${designer.fullName} نسخهٔ دوم کی‌ویژوال را تا شنبه آماده کند.`,
    }), 'draft');
    expect(draft.canCreateTasks).toBe(true);
    expect(draft.actions[0].assigneeId).toBe(designer.id);
    // Drafting writes nothing.
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).minutesRecordedAt).toBeNull();

    const recorded = expectOk(await post(`/meetings/${meeting.id}/minutes`, T.accountManager, {
      decisions: draft.decisions.map((x: any) => x.text).join('\n'),
      source: 'یادداشت‌های جلسه',
      actions: [
        { title: draft.actions[0].title, assigneeId: designer.id, dueDate: draft.actions[0].dueDate, createTask: true },
        { title: 'پیگیری تأیید مشتری', departmentCode: 'A', createTask: true },
        { title: 'یادآوری در جلسهٔ بعد', createTask: false },
      ],
    }), 'minutes');
    expect(recorded.tasks).toHaveLength(2);

    const task = await prisma.task.findUniqueOrThrow({ where: { id: recorded.tasks[0].id } });
    expect(task.sourceType).toBe('MEETING_MINUTES');          // Doc_H §6: traceable to the minutes
    expect(task.sourceRef).toBe(meeting.code);
    expect(task.state).toBe('ASSIGNED');
    expect(task.departmentCode).toBe('CR');                  // from the owner's unit
    const clock = await prisma.slaClock.findFirst({ where: { entityType: 'task', entityId: task.id, policy: { code: 'SLA_TASK_ACCEPTANCE' } } });
    expect(clock?.ownerId).toBe(designer.id);
    const unowned = await prisma.task.findUniqueOrThrow({ where: { id: recorded.tasks[1].id } });
    expect(unowned.state).toBe('CREATED');
    // The owner is told, in the app, before the acceptance clock can surprise them.
    const told = await prisma.notification.findFirst({ where: { userId: designer.id, kind: 'MEETING_ACTION_ASSIGNED', entityId: task.id } });
    expect(told?.title).toContain(meeting.code);

    const m = await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(m.minutesRecordedAt).not.toBeNull();
    expect(m.minutesSource).toBe('یادداشت‌های جلسه');
    const actions = m.actions as any[];
    expect(actions).toHaveLength(3);                         // every action is in the minutes...
    expect(actions.filter((a) => a.taskId)).toHaveLength(2); // ...and each one that became a task says which
    expect(actions[2].taskId).toBeNull();
  });

  it('refuses minutes that would make a task nobody can trace or own', async () => {
    const orphan = expectOk(await post('/meetings', T.accountManager, {
      kind: 'INTERNAL', subject: 'جلسهٔ بدون پروژه', heldAt: HELD.toISOString(), attendees: 'تیم',
    }), 'orphan');
    const noProject = await post(`/meetings/${orphan.id}/minutes`, T.accountManager, {
      decisions: '', actions: [{ title: 'کاری', departmentCode: 'CR', createTask: true }],
    });
    expect(noProject.body.error.code).toBe('MEETING_HAS_NO_PROJECT');
    // Without tasks, the minutes are still worth keeping.
    expectOk(await post(`/meetings/${orphan.id}/minutes`, T.accountManager, {
      decisions: 'تصمیمی ثبت شد', actions: [{ title: 'کاری', createTask: false }],
    }), 'minutes only');

    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const m = expectOk(await post('/meetings', T.accountManager, {
      projectId: project.id, kind: 'INTERNAL', subject: 'جلسه', heldAt: HELD.toISOString(), attendees: 'تیم',
    }), 'meeting');
    const incomplete = await post(`/meetings/${m.id}/minutes`, T.accountManager, {
      decisions: '', actions: [{ title: 'کاری بدون مسئول و واحد', createTask: true }],
    });
    expect(incomplete.body.error.code).toBe('INVALID_ACTIONS');
    expect(incomplete.body.error.details.problems.join(' ')).toContain('اقدام ۱ («کاری بدون مسئول و واحد»): واحد مسئول مشخص نیست');
    // Nothing half-written: no tasks, no minutes.
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).minutesRecordedAt).toBeNull();

    // A meeting left without minutes past two days is a data-quality finding until they exist.
    const stale = expectOk(await post('/meetings', T.accountManager, {
      projectId: project.id, kind: 'INTERNAL', subject: 'جلسهٔ فراموش‌شده',
      heldAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), attendees: 'تیم',
    }), 'stale meeting');
    const finding = async () => (expectOk(await get('/reports/data-quality', T.deputy), 'data quality') as any)
      .findings.find((f: any) => f.key === 'meetingsWithoutMinutes');
    expect((await finding())?.samples.map((x: any) => x.code)).toContain(stale.code);
    expectOk(await post(`/meetings/${stale.id}/minutes`, T.accountManager, { decisions: 'ثبت شد', actions: [] }), 'late minutes');
    expect(((await finding())?.samples ?? []).map((x: any) => x.code)).not.toContain(stale.code);
  });

  it('says plainly when it cannot hear a recording, and passes one to a configured service', async () => {
    const { env } = await import('../src/env.js');
    const { transcribe } = await import('../src/meetings/transcribe.js');
    const original = { url: env.TRANSCRIPTION_URL };
    await expect(transcribe(Buffer.from('audio'), 'm.webm', 'audio/webm')).rejects.toMatchObject({ code: 'TRANSCRIPTION_NOT_CONFIGURED', statusCode: 501 });

    // A stand-in for a whisper server: the in-repo half of the adapter, exercised end to end.
    const http = await import('node:http');
    const seen: { contentType?: string; body?: string } = {};
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.contentType = req.headers['content-type']; seen.body = Buffer.concat(chunks).toString('latin1');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ text: 'قرار شد کمپین از ۱۵ مهر شروع شود.' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    (env as any).TRANSCRIPTION_URL = `http://127.0.0.1:${port}/v1/audio/transcriptions`;
    try {
      const out = await transcribe(Buffer.from('fake-audio-bytes'), 'meeting.webm', 'audio/webm');
      expect(out.text).toContain('۱۵ مهر');
      expect(seen.contentType).toContain('multipart/form-data');
      expect(seen.body).toContain('name="language"');
      expect(seen.body).toContain('fa');
      expect(seen.body).toContain('fake-audio-bytes');
    } finally {
      (env as any).TRANSCRIPTION_URL = original.url;
      server.close();
    }
  });
});

describe('Anomalies on the audit trail', () => {
  /**
   * The audit trail was always complete and inspectable, and nobody inspected it until after the
   * fact. These tests pin down each detector against a fixed moment — a Wednesday night — and,
   * as carefully, the cases that must NOT alert: a person whose normal day is heavy, and a role
   * whose work is the whole organisation.
   */
  const anomalies = () => import('../src/security/anomalies.js');
  const NOW = new Date(2026, 8, 2, 23, 30, 0);            // Wednesday 2 Sept 2026, 23:30 — after hours
  const at = (daysBack: number, hour: number, minute = 0) => {
    const d = new Date(NOW); d.setDate(d.getDate() - daysBack); d.setHours(hour, minute, 0, 0); return d;
  };
  let seq = 0;

  async function person(role: string, deptCode = 'CR') {
    const org = await prisma.organization.findFirstOrThrow();
    const r = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const dept = await prisma.department.findFirstOrThrow({ where: { code: deptCode } });
    const template = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    seq++;
    return prisma.user.create({ data: {
      organizationId: org.id, departmentId: dept.id, email: `anomaly.${role.toLowerCase()}.${Date.now()}.${seq}@hiva.local`,
      fullName: `کاربر آزمون ${seq}`, passwordHash: template.passwordHash, roles: { create: { roleId: r.id } },
    } });
  }
  async function events(actorId: string | null, action: string, times: Date[], extra: Record<string, unknown> = {}) {
    const org = await prisma.organization.findFirstOrThrow();
    await prisma.auditEvent.createMany({ data: times.map((createdAt) => ({
      organizationId: org.id, actorId, action, entityType: 'document', createdAt, ipAddress: '10.0.0.7', ...extra,
    })) });
  }
  const org = () => prisma.organization.findFirstOrThrow();

  it('raises exports at night for someone who never works at night, and names both numbers', async () => {
    const { detectAnomalies } = await anomalies();
    const u = await person('UNIT_MEMBER');
    await events(u.id, 'EXPORT', Array.from({ length: 12 }, (_, i) => at(0, 22, i * 4)));
    const found = (await detectAnomalies(prisma, (await org()).id, { now: NOW })).filter((a) => a.actorId === u.id);
    const night = found.find((a) => a.kind === 'OFF_HOURS_EXPORT')!;
    expect(night).toBeTruthy();
    expect((night.evidence as any).count).toBe(12);
    expect((night.evidence as any).usualOffHoursPerDay).toBe(0);
    expect(night.messageFa).toContain('بیرون از ساعت کاری');
    expect((night.evidence as any).eventIds).toHaveLength(12);   // the case, event by event
  });

  it('judges a surge against the person’s own usual day, not a single global number', async () => {
    const { detectAnomalies } = await anomalies();
    // Someone whose normal working day is ten downloads...
    const heavy = await person('FINANCE_SPECIALIST', 'FI');
    for (let d = 1; d <= 30; d++) await events(heavy.id, 'FILE_DOWNLOAD', Array.from({ length: 10 }, (_, i) => at(d, 10, i)));
    await events(heavy.id, 'FILE_DOWNLOAD', Array.from({ length: 40 }, (_, i) => at(0, 11, i)));
    // ...and someone whose normal day is none.
    const quiet = await person('UNIT_MEMBER');
    await events(quiet.id, 'FILE_DOWNLOAD', Array.from({ length: 30 }, (_, i) => at(0, 11, i)));

    const found = await detectAnomalies(prisma, (await org()).id, { now: NOW });
    // Forty is four times the heavy user's day: under five times, so not a surge for them.
    expect(found.some((a) => a.kind === 'DOWNLOAD_SURGE' && a.actorId === heavy.id)).toBe(false);
    const surge = found.find((a) => a.kind === 'DOWNLOAD_SURGE' && a.actorId === quiet.id)!;
    expect(surge).toBeTruthy();
    expect((surge.evidence as any).usualPerDay).toBe(0);
    expect(surge.messageFa).toContain('روز معمولِ همین فرد');
  });

  it('tells a role that is missing something from someone trying doors', async () => {
    const { detectAnomalies } = await anomalies();
    const stuck = await person('UNIT_MEMBER');
    await events(stuck.id, 'PERMISSION_DENIED', Array.from({ length: 12 }, (_, i) => at(0, 10, i)), { entityType: 'authorization', reason: 'missing: supplier.write' });
    const prober = await person('UNIT_MEMBER');
    const perms = ['finance.read', 'contract.read', 'admin.users', 'pricing.set_price', 'report.executive'];
    await events(prober.id, 'PERMISSION_DENIED', Array.from({ length: 15 }, (_, i) => at(0, 10, i)), { entityType: 'authorization' });
    const rows = await prisma.auditEvent.findMany({ where: { actorId: prober.id, action: 'PERMISSION_DENIED' }, select: { id: true } });
    for (const [i, r] of rows.entries()) await prisma.auditEvent.update({ where: { id: r.id }, data: { reason: `missing: ${perms[i % perms.length]}` } });

    const found = await detectAnomalies(prisma, (await org()).id, { now: NOW });
    const role = found.find((a) => a.kind === 'DENIAL_SURGE' && a.actorId === stuck.id)!;
    const doors = found.find((a) => a.kind === 'DENIAL_SURGE' && a.actorId === prober.id)!;
    expect(role.severity).toBe('MEDIUM');
    expect(role.messageFa).toContain('supplier.write');
    expect(role.messageFa).toContain('نقش');
    expect(doors.severity).toBe('HIGH');
    expect((doors.evidence as any).distinctPermissions).toBe(5);
    expect(doors.messageFa).toContain('آزمودن');
  });

  it('flags one address trying many accounts, and a reused session as critical', async () => {
    const { detectAnomalies } = await anomalies();
    const victims = await Promise.all([person('UNIT_MEMBER'), person('UNIT_MEMBER'), person('UNIT_MEMBER'), person('UNIT_MEMBER')]);
    const o = await org();
    await prisma.auditEvent.createMany({ data: victims.map((v, i) => ({
      organizationId: o.id, actorId: v.id, action: 'LOGIN_FAILED', entityType: 'user', entityId: v.id,
      createdAt: at(0, 23, 5 + i), ipAddress: '203.0.113.9', reason: 'bad password',
    })) });
    const stolen = victims[0]!;
    await prisma.auditEvent.create({ data: {
      organizationId: o.id, actorId: null, action: 'REFRESH_TOKEN_REUSE', entityType: 'user', entityId: stolen.id,
      createdAt: at(0, 23, 20), ipAddress: '198.51.100.4',
    } });

    const found = await detectAnomalies(prisma, o.id, { now: NOW });
    const stuffing = found.find((a) => a.kind === 'LOGIN_FAILURES' && a.ipAddress === '203.0.113.9')!;
    expect(stuffing.severity).toBe('HIGH');
    expect((stuffing.evidence as any).accounts).toBe(4);
    const reuse = found.find((a) => a.kind === 'TOKEN_REUSE' && a.actorId === stolen.id)!;
    expect(reuse.severity).toBe('CRITICAL');
  });

  it('notices reaching into other people’s projects — but not for a role whose work is every project', async () => {
    const { detectAnomalies } = await anomalies();
    const o = await org();
    const company = await prisma.company.findFirstOrThrow();
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const outsider = await person('UNIT_MEMBER', 'ST');
    const executive = await person('CEO', 'M');
    const projects = await Promise.all([1, 2, 3].map((i) => prisma.project.create({ data: {
      organizationId: o.id, code: `PRJ-FOREIGN-${Date.now()}-${i}`, name: `پروژهٔ دیگران ${i}`,
      companyId: company.id, accountOwnerId: pmo.id, state: 'ACTIVE',
    } })));
    for (const who of [outsider, executive]) {
      await prisma.auditEvent.createMany({ data: projects.map((p, i) => ({
        organizationId: o.id, actorId: who.id, action: 'EXPORT', entityType: 'project', entityId: p.id,
        createdAt: at(0, 11, i), ipAddress: '10.0.0.8',
      })) });
    }
    const found = await detectAnomalies(prisma, o.id, { now: NOW });
    const reach = found.find((a) => a.kind === 'OUT_OF_SCOPE_ACCESS' && a.actorId === outsider.id)!;
    expect(reach).toBeTruthy();
    expect((reach.evidence as any).distinct).toBe(3);
    expect(found.some((a) => a.kind === 'OUT_OF_SCOPE_ACCESS' && a.actorId === executive.id)).toBe(false);
  });

  it('keeps one alert per case across rescans, tells administrators once, and wants a reason to dismiss', async () => {
    const { scanOrganization } = await import('../src/security/scan.js');
    const o = await org();
    const first = await scanOrganization(o.id, { now: NOW });
    expect(first.created).toBeGreaterThan(0);
    expect(first.notified).toBeGreaterThan(0);                  // HIGH and CRITICAL reach administrators
    const again = await scanOrganization(o.id, { now: NOW });
    expect(again.created).toBe(0);                             // the same cases, updated not repeated
    expect(again.updated).toBe(first.created);
    expect(again.notified).toBe(0);

    const list = expectOk(await get('/security/alerts', T.admin), 'alerts');
    expect(list.alerts.length).toBeGreaterThan(0);
    const alert = list.alerts.find((a: any) => a.kind === 'DENIAL_SURGE');
    expect(alert.kindFa).toBe('جهش دسترسی‌های ردشده');
    expect(alert.actor.fullName).toBeTruthy();

    expect((await post(`/security/alerts/${alert.id}/review`, T.admin, { status: 'DISMISSED' })).body.error.code).toBe('REASON_REQUIRED');
    const reviewed = expectOk(await post(`/security/alerts/${alert.id}/review`, T.admin, { status: 'DISMISSED', note: 'نقش این فرد اصلاح شد' }), 'dismiss');
    expect(reviewed.status).toBe('DISMISSED');
    // A dismissed alert stays dismissed when the next scan updates its evidence.
    await scanOrganization(o.id, { now: NOW });
    expect((await prisma.securityAlert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe('DISMISSED');

    // Nobody closes the case about themselves.
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' } });
    const aboutAdmin = await prisma.securityAlert.create({ data: {
      organizationId: o.id, kind: 'DOWNLOAD_SURGE', severity: 'MEDIUM', actorId: admin.id,
      windowStart: NOW, windowEnd: NOW, evidence: {}, messageFa: 'آزمون', fingerprint: `SELF:${Date.now()}`,
    } });
    expect((await post(`/security/alerts/${aboutAdmin.id}/review`, T.admin, { status: 'DISMISSED', note: 'مشکلی نیست' })).body.error.code).toBe('SELF_REVIEW');

    // The trail's own readers only.
    expect((await get('/security/alerts', T.designer)).status).toBe(403);
    expect((await post('/security/scan', T.pmo)).status).toBe(403);
  });
});

describe('QC stage zero', () => {
  /**
   * A good share of what the Account desk sends back is not a judgement: the PDF that was asked
   * for is not there, an image is the wrong size, a draft went up. These tests pin down the
   * mechanical checks at the unit's handover, and the line between what may block (objective)
   * and what may only warn (plausible).
   */
  const sz = () => import('../src/quality/stage-zero.js');

  /** A real PNG header: 8-byte signature, IHDR chunk with width and height. */
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    b.writeUInt8(8, 24); b.writeUInt8(2, 25);
    return b;
  };

  async function orderAndDeliverable(outputFormat: string, expectedOutput = 'خروجی نهایی') {
    const org = await prisma.organization.findFirstOrThrow();
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const wo = await prisma.workOrder.create({ data: {
      organizationId: org.id, code: `WO-SZ-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, projectId: project.id,
      targetDepartmentCode: 'CR', title: 'بنر کمپین', scopeOfWork: 'طراحی بنر', brief: 'بریف',
      expectedOutput, outputFormat, deadline: new Date(Date.now() + 10 * 86_400_000), ownerId: pmo.id, state: 'IN_PROGRESS',
    } });
    const d = await prisma.deliverable.create({ data: {
      organizationId: org.id, code: `DLV-SZ-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, projectId: project.id,
      workOrderId: wo.id, name: 'بنر کمپین', departmentCode: 'CR', state: 'IN_PROGRESS',
    } });
    return { wo, d, project };
  }

  it('reads what an order asks for without mistaking one word for another', async () => {
    const { requestedFormats, requestedDimensions, requestedCounts } = await sz();
    expect(requestedFormats('PDF + فایل باز')).toEqual(['pdf', 'open']);
    // «مورد» is not «ورد», «تصویربرداری» is not «تصویر», and presenting is not a slide deck.
    expect(requestedFormats('در هر مورد گزارش کامل')).toEqual([]);
    expect(requestedFormats('تصویربرداری کمپین')).toEqual([]);
    expect(requestedFormats('ارائه به مشتری')).toEqual([]);
    expect(requestedDimensions('۱۲ پوستر ۱۰۸۰×۱۹۲۰')).toEqual([{ width: 1080, height: 1920 }]);
    expect(requestedCounts('۳ ویدئو و ۱۲ پوستر').map((c) => c.count)).toEqual([3, 12]);
  });

  it('holds back a handover missing what the order named, and lets it through once it is there', async () => {
    const { d } = await orderAndDeliverable('PDF + فایل باز');
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });

    // Nothing attached, though the order asked for a PDF and an open file.
    const empty = await move('deliverable', d.id, 'submit', T.creative);
    expect(empty.status).toBe(422);
    expect(empty.body.error.message).toContain('هیچ فایلی پیوست نشده');

    // The PDF alone is not enough: the open file is missing too.
    expectOk(await upload(T.creative, { name: 'banner.pdf', type: 'application/pdf', content: tinyPdf() }, { projectId: project.id, deliverableId: d.id }), 'pdf');
    const halfway = await move('deliverable', d.id, 'submit', T.creative);
    expect(halfway.status).toBe(422);
    expect(halfway.body.error.message).toContain('فایل باز');
    // The refusal is on the record, reasons and all, though the handover did not happen.
    const blocked = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: d.id, action: 'TRANSITION_BLOCKED' }, orderBy: { createdAt: 'desc' },
    });
    expect((blocked.after as any).guard).toBe('deliverable.passesStageZero');
    expect((blocked.after as any).messageFa).toContain('فایل باز');

    // Source formats are outside the upload allow-list, so an open file arrives as an archive —
    // and stage zero looks inside it rather than demanding something nobody can upload.
    expectOk(await upload(T.creative, {
      name: 'banner-source.zip', type: 'application/zip',
      content: zipOf([{ name: 'banner/banner.psd', content: '8BPS layered source' }, { name: 'banner/fonts.txt', content: 'Vazirmatn' }]),
    }, { projectId: project.id, deliverableId: d.id }), 'source');
    expectOk(await move('deliverable', d.id, 'submit', T.creative), 'submit');
    const passed = await prisma.deliverable.findUniqueOrThrow({ where: { id: d.id } });
    expect(passed.stageZeroVerdict).toBe('PASS');
    expect(passed.stageZeroAt).not.toBeNull();
    const recorded = passed.stageZeroFindings as any;
    expect(recorded.archived.map((a: any) => a.name)).toContain('banner.psd');
  });

  it('measures image pixels against the dimensions the order spelled out', async () => {
    const { stageZero } = await sz();
    const org = await prisma.organization.findFirstOrThrow();
    const { d, project } = await orderAndDeliverable('بنر PNG با ابعاد ۱۰۸۰×۱۹۲۰');

    expectOk(await upload(T.creative, { name: 'story.png', type: 'image/png', content: png(1080, 1080) }, { projectId: project.id, deliverableId: d.id }), 'square');
    const wrong = await stageZero(prisma, org.id, d.id);
    expect(wrong.verdict).toBe('FAIL');
    const dim = wrong.findings.find((f) => f.check === 'dimensions')!;
    expect(dim.messageFa).toContain('1080×1080');
    expect(dim.messageFa).toContain('1080×1920');
    expect(wrong.files[0]).toMatchObject({ width: 1080, height: 1080 });

    // Replace it with the right size: no dimension finding left.
    await prisma.document.updateMany({ where: { deliverableId: d.id }, data: { deletedAt: new Date() } });
    expectOk(await upload(T.creative, { name: 'story-final.png', type: 'image/png', content: png(1080, 1920) }, { projectId: project.id, deliverableId: d.id }), 'tall');
    const right = await stageZero(prisma, org.id, d.id);
    expect(right.findings.some((f) => f.check === 'dimensions')).toBe(false);
    // And it says what it did not look at, so a pass is never mistaken for a review.
    expect(right.notCheckedFa.join(' ')).toContain('بازبین انسانی');
  });

  it('never changes a record when asked "why can\'t I?", and keeps an on-demand check, FAIL included', async () => {
    const { d, project } = await orderAndDeliverable('PDF');
    // Preflight runs the guard on a read; the rule lab replays guards against history. Neither may write.
    const pre = expectOk(await get(`/workflow/deliverable/${d.id}/preflight`, T.creative), 'preflight');
    const submit = pre.transitions.find((t: any) => t.action === 'submit');
    expect(submit.checks.find((c: any) => c.guard === 'deliverable.passesStageZero').ok).toBe(false);
    expect((await prisma.deliverable.findUniqueOrThrow({ where: { id: d.id } })).stageZeroVerdict).toBeNull();

    // The unit's own "check now" is kept, failures and all, for whoever looks next.
    const checked = expectOk(await post(`/deliverables/${d.id}/stage-zero`, T.creative), 'check now');
    expect(checked.verdict).toBe('FAIL');
    expect((await prisma.deliverable.findUniqueOrThrow({ where: { id: d.id } })).stageZeroVerdict).toBe('FAIL');

    // An archive that cannot be read makes a missing format uncertain — a warning, never a failure.
    expectOk(await upload(T.creative, { name: 'bundle.zip', type: 'application/zip', content: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not really a zip')]) }, { projectId: project.id, deliverableId: d.id }), 'broken zip');
    const opaque = expectOk(await post(`/deliverables/${d.id}/stage-zero`, T.creative), 'opaque');
    expect(opaque.findings.find((f: any) => f.check === 'format').severity).toBe('WARN');
    expect(opaque.notCheckedFa.join(' ')).toContain('bundle.zip');
  });

  it('only warns on what it cannot be sure of, and a warning never blocks', async () => {
    const { stageZero } = await sz();
    const org = await prisma.organization.findFirstOrThrow();
    const { d, project } = await orderAndDeliverable('PDF', '۳ پوستر نهایی');
    expectOk(await upload(T.creative, { name: 'poster-draft-v0.pdf', type: 'application/pdf', content: tinyPdf() }, { projectId: project.id, deliverableId: d.id }), 'draft');

    const res = await stageZero(prisma, org.id, d.id);
    expect(res.verdict).toBe('WARN');
    expect(res.findings.find((f) => f.check === 'draft')!.severity).toBe('WARN');
    // The order counted three posters and there are none as images: plausible, not certain.
    expect(res.findings.find((f) => f.check === 'count')!.severity).toBe('WARN');
    expect(res.findings.every((f) => f.severity !== 'FAIL')).toBe(true);
    expectOk(await move('deliverable', d.id, 'submit', T.creative), 'warnings do not block');
  });
});

describe('The estimation assistant', () => {
  /**
   * A unit declares what a work order will cost before anyone knows, and the declaration becomes
   * the price. These tests pin down the comparison that should have happened at that moment:
   * similar finished orders in the same unit, what they were declared at, what the logged hours
   * say they really cost, how long they took — and a warning to the unit manager when a figure
   * sits below all of it.
   */
  const DEPT = 'ME';
  let seq = 0;
  /** A media unit member: the person who actually declares a media order's cost. */
  let M = '';
  async function mediaMember() {
    if (M) return M;
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'UNIT_MEMBER' } });
    const dept = await prisma.department.findFirstOrThrow({ where: { code: DEPT } });
    const template = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const email = `media.member.${Date.now()}@hiva.local`;
    await prisma.user.create({ data: {
      organizationId: template.organizationId, departmentId: dept.id, email, fullName: 'کارشناس رسانه',
      passwordHash: template.passwordHash, roles: { create: { roleId: role.id } },
    } });
    M = await login(email);
    return M;
  }

  async function order(input: {
    title: string; scope: string; format: string; budget: number; state?: string;
    declared?: number; hours?: number; days?: number;
  }) {
    const org = await prisma.organization.findFirstOrThrow();
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const worker = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const accepted = new Date(2026, 7, 1, 9, 0, 0);                        // a Saturday morning
    const submitted = input.days ? new Date(accepted.getTime() + input.days * 1.4 * 86_400_000) : null;
    seq++;
    const wo = await prisma.workOrder.create({ data: {
      organizationId: org.id, code: `WO-EST-${Date.now()}-${seq}`, projectId: project.id,
      targetDepartmentCode: DEPT, title: input.title, scopeOfWork: input.scope, brief: 'بریف',
      expectedOutput: input.scope, outputFormat: input.format, deadline: new Date(Date.now() + 30 * 86_400_000),
      ownerId: pmo.id, budget: input.budget, state: input.state ?? 'COMPLETED',
      acceptedAt: accepted, submittedAt: submitted,
    } });
    if (input.declared) {
      await prisma.costDeclaration.create({ data: {
        organizationId: org.id, workOrderId: wo.id, departmentCode: DEPT,
        internalCost: input.declared, externalCost: 0, declaredById: pmo.id,
      } });
    }
    if (input.hours) {
      const task = await prisma.task.create({ data: {
        organizationId: org.id, projectId: project.id, workOrderId: wo.id, code: `TSK-EST-${Date.now()}-${seq}`,
        title: input.title, departmentCode: DEPT, priority: 'NORMAL', state: 'CLOSED',
        sourceType: 'ORDER_FORM', sourceRef: wo.code, createdById: pmo.id, assigneeId: worker.id,
      } });
      await prisma.timeEntry.create({ data: {
        organizationId: org.id, taskId: task.id, userId: worker.id, hours: input.hours, workedOn: accepted,
      } });
    }
    return wo;
  }

  it('compares a proposed figure with what similar finished orders actually cost and took', async () => {
    // The worker's time is priced, so logged hours become money.
    const worker = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    await prisma.user.update({ where: { id: worker.id }, data: { hourlyCost: 1_000_000 } });

    // Four finished media-buying orders: declared around 40M, each really took ~50 hours (= 50M).
    for (const [declared, hours] of [[40e6, 48], [42e6, 52], [38e6, 50], [44e6, 55]] as const) {
      await order({
        title: 'خرید رسانه دیجیتال کمپین', scope: 'برنامه‌ریزی و خرید رسانه دیجیتال برای کمپین فصلی',
        format: 'پلن رسانه و گزارش', budget: 50e6, declared, hours, days: 6,
      });
    }
    // One unrelated order in the same unit that should not dominate the comparison.
    await order({ title: 'مشاوره حقوقی قرارداد', scope: 'بازبینی متن قرارداد با ناشر', format: 'نامه', budget: 5e6, declared: 3e6, hours: 3, days: 1 });

    const target = await order({
      title: 'خرید رسانه دیجیتال کمپین تازه', scope: 'برنامه‌ریزی و خرید رسانه دیجیتال برای کمپین', format: 'پلن رسانه',
      budget: 55e6, state: 'ACCEPTED',
    });

    const res = expectOk(await get(`/work-orders/${target.id}/estimate`, await mediaMember(), { proposedCost: '28000000' }), 'estimate');
    expect(res.basis).toBe('SIMILAR');
    expect(res.summary.count).toBeGreaterThanOrEqual(3);
    // The closest comparable is a media-buying order, not the legal one.
    expect(res.comparables[0].title).toContain('خرید رسانه');
    expect(res.comparables[0].whyFa.join(' ')).toContain('همان نوع خروجی');
    // Actual cost comes from logged hours at the person's rate: ~50M against ~40M declared.
    expect(res.summary.actual.median).toBeGreaterThanOrEqual(48e6);
    expect(res.summary.declared.median).toBeLessThanOrEqual(44e6);
    expect(res.summary.overrunRatio).toBeGreaterThan(1.1);
    expect(res.summary.workingDays.median).toBeGreaterThan(0);
    // 28M is below three-quarters of what similar orders really cost.
    expect(res.verdict.band).toBe('LOW');
    expect(res.verdict.ratioToMedian).toBeLessThan(0.7);
    expect(res.verdict.messageFa).toContain('برآورد شما');
    expect(res.verdict.messageFa).toContain('واقعاً هزینه برده‌اند');

    // A figure inside the usual range is said to be so.
    const fair = expectOk(await get(`/work-orders/${target.id}/estimate`, await mediaMember(), { proposedCost: '50000000' }), 'fair');
    expect(fair.verdict.band).toBe('WITHIN');
  });

  it('warns the unit manager when a declaration lands below history, and keeps the declaration', async () => {
    const target = await prisma.workOrder.findFirstOrThrow({ where: { title: 'خرید رسانه دیجیتال کمپین تازه' } });
    const managerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'UNIT_MANAGER' } });
    const dept = await prisma.department.findFirstOrThrow({ where: { code: DEPT } });
    const template = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const manager = await prisma.user.create({ data: {
      organizationId: template.organizationId, departmentId: dept.id, email: `media.manager.${Date.now()}@hiva.local`,
      fullName: 'مدیر رسانه', passwordHash: template.passwordHash,
      roles: { create: { roleId: managerRole.id } },
    } });

    const declared = expectOk(await post(`/work-orders/${target.id}/cost`, await mediaMember(), {
      departmentCode: DEPT, internalCost: 25_000_000, externalCost: 0, items: [],
    }), 'declare');
    expect(declared.id).toBeTruthy();                       // advisory: the declaration stands
    expect(declared.estimate.verdict.band).toBe('LOW');

    const note = await prisma.notification.findFirst({ where: { userId: manager.id, kind: 'ESTIMATE_BELOW_HISTORY' } });
    expect(note).not.toBeNull();
    expect(note!.body).toContain('برآورد شما');
  });

  it('says there is nothing to compare against rather than inventing a range, and guards the figures', async () => {
    const org = await prisma.organization.findFirstOrThrow();
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const lonely = await prisma.workOrder.create({ data: {
      organizationId: org.id, code: `WO-LONE-${Date.now()}`, projectId: project.id, targetDepartmentCode: 'LG',
      title: 'نخستین سفارش حقوقی', scopeOfWork: 'تنظیم قرارداد', brief: 'بریف', expectedOutput: 'قرارداد',
      outputFormat: 'سند', deadline: new Date(Date.now() + 10 * 86_400_000), ownerId: pmo.id, state: 'ACCEPTED',
    } });
    const res = expectOk(await get(`/work-orders/${lonely.id}/estimate`, T.ceo, { proposedCost: '10000000' }), 'no history');
    expect(res.basis).toBe('NONE');
    expect(res.summary.count).toBe(0);
    expect(res.summary.actual).toBeNull();
    expect(res.verdict.ratioToMedian).toBeNull();
    expect(res.verdict.messageFa).toContain('سابقهٔ کافی');
    expect(res.noteFa).toContain('سفارش تمام‌شده‌ای ندارد');

    // Other orders' costs are pricing data: no pricing permission, no comparison.
    expect((await get(`/work-orders/${lonely.id}/estimate`, T.pmo)).status).toBe(403);
    // And a unit sees its own history, not another unit's: a Creative member on a Legal order.
    expect((await get(`/work-orders/${lonely.id}/estimate`, T.designer)).body.error.message).toContain('واحد دیگر');
    // Those who set prices see every unit.
    expect((await get(`/work-orders/${lonely.id}/estimate`, T.accountManager)).status).toBe(200);
  });
});

describe('Brief quality, not just completeness', () => {
  /**
   * briefCompleteness asks whether six fields are filled, so «افزایش فروش» and three precise
   * paragraphs both scored 100. Doc_H's cycle 1 — the brief sent back to Sales — is mostly vague
   * briefs, not empty ones. These tests pin down the difference, and the fact that every
   * deduction quotes what it objects to.
   */
  const quality = () => import('../src/briefs/quality.js');
  const inAMonth = new Date(Date.now() + 30 * 86_400_000);

  const vagueBrief = {
    businessObjective: 'افزایش فروش', targetAudience: 'عموم مردم', scope: 'کمپین تبلیغاتی جذاب',
    expectedDeliverables: 'محتوای مناسب', successCriteria: 'موفقیت کمپین', constraints: '',
    budgetRange: 1_000_000_000, desiredDeadline: inAMonth,
  };
  const preciseBrief = {
    businessObjective: 'افزایش ۲۰ درصدی فروش آنلاین محصولات لبنی کم‌چرب در سه ماه نخست سال، با تمرکز بر خرید تکراری از اپلیکیشن فروشگاه',
    targetAudience: 'زنان ۲۵ تا ۴۰ سالهٔ ساکن تهران و کرج، مادران شاغل که خرید خانه را آنلاین انجام می‌دهند',
    scope: 'طراحی ایده کمپین، تولید ۳ ویدئوی کوتاه، طراحی ۱۲ پست شبکه اجتماعی، خرید رسانه دیجیتال، گزارش هفتگی عملکرد به تیم فروش',
    expectedDeliverables: '۳ ویدئوی ۳۰ ثانیه‌ای، ۱۲ پست و ۱۲ استوری، ۱ صفحهٔ فرود، گزارش پایانی کمپین',
    successCriteria: 'نرخ تبدیل اپلیکیشن ۳ درصد، ۵۰ هزار نصب تازه و افزایش ۲۰ درصدی فروش آنلاین',
    constraints: 'بودجهٔ رسانه سقف دارد؛ رعایت هویت بصری و راهنمای برند الزامی است',
    budgetRange: 3_000_000_000, desiredDeadline: inAMonth,
  };

  it('tells a precise brief from a vague one that is just as complete', async () => {
    const { scoreBrief } = await quality();
    const { briefCompleteness } = await import('../src/workflow/guards.js');
    // Both are 100% complete — the old measure could not tell them apart.
    expect(briefCompleteness(vagueBrief).score).toBe(100);
    expect(briefCompleteness(preciseBrief).score).toBe(100);

    const vague = scoreBrief(vagueBrief);
    const precise = scoreBrief(preciseBrief);
    expect(precise.score).toBeGreaterThan(vague.score + 30);
    expect(precise.band).toBe('STRONG');
    // Numbers typed in Persian digits are numbers: «۳ ویدئو، ۱۲ پست» is a counted list.
    expect(precise.fields.find((f) => f.key === 'expectedDeliverables')!.findingsFa).toEqual([]);
    expect(precise.fields.every((f) => f.findingsFa.length === 0)).toBe(true);
    expect(['WEAK', 'ADEQUATE']).toContain(vague.band);
    expect(vague.band).not.toBe('STRONG');
  });

  it('says exactly what is wrong, field by field, and what to fix first', async () => {
    const { scoreBrief } = await quality();
    const q = scoreBrief(vagueBrief);
    const field = (k: string) => q.fields.find((f) => f.key === k)!;

    expect(field('businessObjective').findingsFa.join(' ')).toContain('عدد ندارد');
    expect(field('targetAudience').findingsFa.join(' ')).toContain('«همه» مخاطب نیست');
    // Vague phrases are quoted back rather than silently penalised.
    expect(field('scope').findingsFa.join(' ')).toContain('«جذاب»');
    expect(field('expectedDeliverables').findingsFa.join(' ')).toContain('«مناسب»');
    expect(field('successCriteria').findingsFa.join(' ')).toContain('شاخص');
    expect(q.fixFirst).not.toBeNull();
    expect(q.fixFirst!.lostPoints).toBeGreaterThan(0);

    // A deadline already gone is its own finding, not just a missing one.
    const late = scoreBrief({ ...preciseBrief, desiredDeadline: new Date(Date.now() - 86_400_000) });
    expect(late.fields.find((f) => f.key === 'desiredDeadline')!.findingsFa.join(' ')).toContain('گذشته');
    // And an empty required field makes the band INCOMPLETE whatever else is good.
    expect(scoreBrief({ ...preciseBrief, scope: '' }).band).toBe('INCOMPLETE');
  });

  it('serves the quality with the organisation’s own history beside it, and stores the score', async () => {
    const brief = await prisma.brief.findFirstOrThrow({ where: { deletedAt: null } });
    const res = expectOk(await get(`/briefs/${brief.id}/quality`, T.accountManager), 'quality');
    expect(res.quality.score).toBeGreaterThanOrEqual(0);
    expect(res.quality.fields.length).toBe(8);
    expect(res.completeness.score).toBeGreaterThanOrEqual(0);
    expect(res.benchmark.returnRateByBand).toHaveLength(4);
    // With too few won deals the page is told so, rather than shown a meaningless average.
    expect(typeof res.benchmark.enoughHistory).toBe('boolean');
    expect(res.benchmark.noteFa).toBeTruthy();

    const stored = await prisma.brief.findUniqueOrThrow({ where: { id: brief.id } });
    expect(stored.qualityScore).toBe(res.quality.score);
    expect(stored.qualityBand).toBe(res.quality.band);

    const report = expectOk(await get('/reports/brief-quality', T.ceo), 'report');
    expect(report.briefs).toBeGreaterThan(0);
  });
});

describe('Lessons at the start of a project', () => {
  /**
   * Doc_H §15 has made lessons learned mandatory for years, and the closing checklist asks for
   * them. What nobody does is read last year's, because finding the relevant one means
   * remembering it exists. These tests are about the two halves of the fix: the right lesson
   * arriving without being asked for, and a record of what the team did with it.
   */
  const memory = () => import('../src/memory/index.js');

  async function seedLesson(input: { projectId: string; title: string; situation: string; lesson: string; recommendation: string }) {
    const org = await prisma.organization.findFirstOrThrow();
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    return prisma.lessonLearned.create({ data: {
      organizationId: org.id, projectId: input.projectId, title: input.title, category: 'DELIVERY',
      situation: input.situation, lesson: input.lesson, recommendation: input.recommendation, recordedById: pmo.id,
    } });
  }

  it('brings the client’s own past lesson to a new project, and says why it is there', async () => {
    const { reindexMemory } = await memory();
    const org = await prisma.organization.findFirstOrThrow();
    const company = await prisma.company.findFirstOrThrow();
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });

    // A finished project for this client, with a lesson worth carrying forward.
    const past = await prisma.project.create({ data: {
      organizationId: org.id, code: `PRJ-PAST-${Date.now()}`, name: 'کمپین سال گذشتهٔ همین مشتری',
      companyId: company.id, accountOwnerId: pmo.id, state: 'CLOSED',
      objective: 'کمپین ویدئویی برای معرفی محصول تازه',
    } });
    const lesson = await seedLesson({
      projectId: past.id,
      title: 'تدوین ویدئو دیرتر از برآورد تمام می‌شود',
      situation: 'در کمپین ویدئویی سال گذشته، تدوین دو هفته بیشتر از برآورد طول کشید.',
      lesson: 'برآورد تدوین ویدئو برای این مشتری همیشه خوش‌بینانه بوده است.',
      recommendation: 'برای تدوین ویدئو دو هفته حاشیه بگذارید و ظرفیت را از قبل رزرو کنید.',
    });
    // And an unrelated lesson from a different client, which should not win.
    const otherCompany = await prisma.company.create({ data: {
      organizationId: org.id, legalName: 'شرکت نامرتبط', industry: 'OTHER',
      salesOwnerId: pmo.id, accountOwnerId: pmo.id,
    } });
    const unrelated = await prisma.project.create({ data: {
      organizationId: org.id, code: `PRJ-OTHER-${Date.now()}`, name: 'پروژهٔ حقوقی نامرتبط',
      companyId: otherCompany.id, accountOwnerId: pmo.id, state: 'CLOSED', objective: 'تنظیم قرارداد و الحاقیه',
    } });
    await seedLesson({
      projectId: unrelated.id, title: 'الحاقیهٔ قرارداد را زودتر امضا بگیرید',
      situation: 'امضای الحاقیه دیر شد.', lesson: 'امضای الحاقیه زمان‌بر است.',
      recommendation: 'امضای الحاقیه را از ابتدای کار شروع کنید.',
    });

    const fresh = await prisma.project.create({ data: {
      organizationId: org.id, code: `PRJ-NEW-${Date.now()}`, name: 'کمپین ویدئویی تازه',
      companyId: company.id, accountOwnerId: pmo.id, state: 'ACTIVE',
      objective: 'کمپین ویدئویی برای معرفی محصول جدید با تدوین سنگین',
    } });
    await reindexMemory(org.id);

    const res = expectOk(await get(`/projects/${fresh.id}/lessons`, T.pmo), 'lessons');
    expect(res.lessons.length).toBeGreaterThan(0);
    const top = res.lessons[0];
    expect(top.lessonId).toBe(lesson.id);
    expect(top.fromProject.name).toBe('کمپین سال گذشتهٔ همین مشتری');
    expect(top.recommendation).toContain('دو هفته حاشیه');
    // The reasons are shown, not just a ranking.
    expect(top.whyFa.join(' ')).toContain('همین مشتری');
    expect(res.reviewed).toBe(0);
    // A project never learns from itself.
    expect(res.lessons.some((l: any) => l.fromProject?.id === fresh.id)).toBe(false);
  });

  it('records what the project did with a lesson, and will not take “not relevant” without a reason', async () => {
    const org = await prisma.organization.findFirstOrThrow();
    const company = await prisma.company.findFirstOrThrow();
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const { reindexMemory } = await import('../src/memory/index.js');

    const past = await prisma.project.create({ data: {
      organizationId: org.id, code: `PRJ-P2-${Date.now()}`, name: 'پروژهٔ پیشین رسانه',
      companyId: company.id, accountOwnerId: pmo.id, state: 'CLOSED', objective: 'خرید رسانه و اجرای کمپین',
    } });
    const lesson = await seedLesson({
      projectId: past.id, title: 'تأیید رسانه را زودتر بگیرید',
      situation: 'تأیید پلن رسانه سه روز طول کشید.', lesson: 'تأیید رسانه گلوگاه است.',
      recommendation: 'پلن رسانه را یک هفته زودتر بفرستید.',
    });
    const fresh = await prisma.project.create({ data: {
      organizationId: org.id, code: `PRJ-N2-${Date.now()}`, name: 'کمپین رسانه‌ای تازه',
      companyId: company.id, accountOwnerId: pmo.id, state: 'ACTIVE', objective: 'خرید رسانه و اجرای کمپین فصلی',
    } });
    await reindexMemory(org.id);

    // Setting a lesson aside is a judgement; a judgement with no reason teaches nobody.
    expect((await post(`/projects/${fresh.id}/lessons/${lesson.id}/review`, T.pmo, { decision: 'NOT_RELEVANT' })).body.error.code).toBe('REASON_REQUIRED');
    expect((await post(`/projects/${fresh.id}/lessons/${lesson.id}/review`, T.pmo, { decision: 'SEEN' })).body.error.code).toBe('INVALID_DECISION');
    // And it is a planner's call, not everyone's.
    expect((await post(`/projects/${fresh.id}/lessons/${lesson.id}/review`, T.designer, { decision: 'APPLIED' })).status).toBe(403);

    const applied = expectOk(await post(`/projects/${fresh.id}/lessons/${lesson.id}/review`, T.pmo, {
      decision: 'APPLIED', note: 'پلن رسانه را در هفتهٔ اول می‌فرستیم.',
    }), 'apply');
    expect(applied.decision).toBe('APPLIED');

    // Reviewed lessons leave the list, and are counted instead.
    const after = expectOk(await get(`/projects/${fresh.id}/lessons`, T.pmo), 'after review');
    expect(after.lessons.some((l: any) => l.lessonId === lesson.id)).toBe(false);
    expect(after.reviewed).toBe(1);
    const withReviewed = expectOk(await get(`/projects/${fresh.id}/lessons`, T.pmo, { includeReviewed: 'true' }), 'with reviewed');
    const seen = withReviewed.lessons.find((l: any) => l.lessonId === lesson.id);
    expect(seen.review.decision).toBe('APPLIED');
    expect(seen.review.note).toContain('هفتهٔ اول');

    // The decision is on the project's own record, as an event about it.
    const history = expectOk(await get(`/history/project/${fresh.id}`, T.pmo), 'history');
    expect(history.events.some((e: any) => e.action === 'LESSON_REVIEWED')).toBe(true);
  });
});

describe('Forms filled offline', () => {
  /**
   * Production is on set and Media is at the client's office; the D and E forms are filled
   * exactly where the signal is worst. A queued form is retried over a link that may drop after
   * the server has already written it, so the device's own key decides identity: the first
   * write wins and every retry gets that same submission back.
   */
  it('files a replayed submission once, and hands back the one it already has', async () => {
    const brief = await prisma.brief.findFirstOrThrow();
    const clientKey = `field-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      formCode: 'B10_BRIEF_COMPLETION', clientKey,
      data: { briefId: brief.id, addedInformation: 'در محل فیلم‌برداری پر شد' },
    };

    const first = await post('/forms/submissions', T.sales, body);
    expect(first.status).toBe(201);
    expect(first.body.clientKey).toBe(clientKey);

    // The phone never saw the answer and sent it again.
    const replay = await post('/forms/submissions', T.sales, body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.duplicateOf).toBe(first.body.code);

    const rows = await prisma.formSubmission.findMany({ where: { clientKey } });
    expect(rows).toHaveLength(1);

    // A different key is a different form, even with identical data.
    const second = await post('/forms/submissions', T.sales, { ...body, clientKey: `${clientKey}-b` });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it('still refuses a queued form the rules do not allow, rather than letting the queue smuggle it in', async () => {
    // A closed project cannot take new work — and a form filled before it closed is no exception.
    const closed = await prisma.project.findFirst({ where: { state: 'CLOSED' } });
    if (!closed) return;
    const refused = await post('/forms/submissions', T.designer, {
      formCode: 'D34_UNIT_OUTPUT_DELIVERY', clientKey: `late-${Date.now()}`,
      data: { projectId: closed.id },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error.message).toBeTruthy();       // a Persian reason the queue can show
  });
});

describe('The form designer', () => {
  /**
   * ADR-004 said adding a form is a data change, not a code change — but a programmer still had
   * to write TypeScript, which made every new customer a development project. The designer
   * writes the same FieldDef shape through the API, with two rules: what the process depends on
   * cannot be removed, and every change mints a version so filed submissions keep their fields.
   */
  const CODE = 'B11_BRIEF_ANALYSIS';

  it('adds a field, versions the change, and leaves the forms already filed alone', async () => {
    const before = await prisma.formDefinition.findFirstOrThrow({ where: { code: CODE } });
    const original = (before.schema as unknown as any[]);
    const brief = await prisma.brief.findFirstOrThrow();

    const design = expectOk(await get(`/forms/definitions/${CODE}/design`, T.admin), 'design');
    expect(design.fields).toHaveLength(original.length);
    expect(design.protectedKeys.length).toBeGreaterThan(0);
    expect(design.customizedAt).toBeNull();

    const fields = [...original, {
      key: 'clientBudgetBand', labelFa: 'بازهٔ بودجهٔ مشتری', labelEn: 'Client budget band',
      type: 'select', required: false, helpFa: 'برای گزارش‌های داخلی',
      options: [{ value: 'S', labelFa: 'کمتر از یک میلیارد' }, { value: 'L', labelFa: 'بیش از یک میلیارد' }],
    }];
    const saved = expectOk(await call('PUT', `/forms/definitions/${CODE}/design`, {
      token: T.admin, payload: { fields, note: 'افزودن بازهٔ بودجه' },
    }), 'save design');
    expect(saved.version).toBe(before.version + 1);

    // The new field is offered, and validated, on the next submission.
    const filled = expectOk(await post('/forms/submissions', T.accountManager, {
      formCode: CODE,
      data: {
        briefId: brief.id, interpretedNeed: 'نیاز مشتری', proposedApproach: 'رویکرد پیشنهادی',
        unitsInvolved: ['ST', 'CR'], clientBudgetBand: 'L',
      },
    }), 'submit under the new version');
    expect(filled.definitionVersion).toBe(saved.version);
    expect((await prisma.formSubmission.findUniqueOrThrow({ where: { id: filled.id } })).data).toMatchObject({ clientBudgetBand: 'L' });

    // A submission filed under the old version still renders its own fields.
    const old = await prisma.formSubmission.findFirst({ where: { definitionId: before.id, definitionVersion: before.version } });
    if (old) {
      const detail = expectOk(await get(`/forms/submissions/${old.id}`, T.admin), 'old submission');
      expect(detail.schema.map((f: any) => f.key)).not.toContain('clientBudgetBand');
    }
  });

  it('refuses a design that would break the process, and says everything wrong at once', async () => {
    const def = await prisma.formDefinition.findFirstOrThrow({ where: { code: 'C20_ORDER_STRATEGY' } });
    const fields = (def.schema as unknown as any[]);
    // Doc_H §C: the nine elements of an order form. Dropping the deadline is not a design choice.
    const withoutDeadline = fields.filter((f) => f.key !== 'deadline');
    const refused = await call('PUT', `/forms/definitions/C20_ORDER_STRATEGY/design`, {
      token: T.admin, payload: { fields: withoutDeadline },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_FORM_DESIGN');
    expect(refused.body.error.details.problems.join(' ')).toContain('Deadline');

    // Several problems come back together rather than one per attempt.
    const messy = expectOk(await post(`/forms/definitions/C20_ORDER_STRATEGY/design/validate`, T.admin, {
      fields: [
        ...fields,
        { key: 'ownerName', labelFa: 'نام مسئول', labelEn: 'Owner name', type: 'select', options: [] },
        { key: 'ownerName', labelFa: 'تکراری', labelEn: 'Duplicate', type: 'text' },
        { key: 'extra', labelFa: 'وابسته به فیلد ناموجود', labelEn: 'Dangling', type: 'text', visibleWhen: { field: 'nope', equals: ['x'] } },
      ],
    }), 'validate');
    expect(messy.ok).toBe(false);
    expect(messy.problems.length).toBeGreaterThanOrEqual(3);
    expect(messy.problems.join(' ')).toContain('تکراری');
    expect(messy.problems.join(' ')).toContain('گزینه');

    // And only an administrator may design at all.
    expect((await call('PUT', `/forms/definitions/${CODE}/design`, { token: T.sales, payload: { fields } })).status).toBe(403);
  });

  it('lets an organisation add a form of its own, and keeps the catalogue out of it', async () => {
    const { publishDefinition } = await import('../src/forms/versions.js');
    const org = await prisma.organization.findFirstOrThrow();
    const code = `X_EQUIPMENT_${Date.now()}`;
    const created = expectOk(await post('/forms/definitions', T.admin, {
      code, nameFa: 'فرم تحویل تجهیزات', nameEn: 'Equipment handover', category: 'D', module: 'TRAFFIC_TASK',
      senderDepts: ['CR'], receiverDepts: ['OP'], approverRoles: ['UNIT_MANAGER'],
      fields: [
        { key: 'item', labelFa: 'تجهیزات', labelEn: 'Item', type: 'text', required: true },
        { key: 'handedTo', labelFa: 'تحویل‌گیرنده', labelEn: 'Handed to', type: 'user', required: true },
        { key: 'returnBy', labelFa: 'بازگشت تا', labelEn: 'Return by', type: 'date' },
      ],
    }), 'create form');
    expect(created.isCustom).toBe(true);
    expect(created.no).toBeGreaterThanOrEqual(1000);

    // It behaves like any other form: it is offered, filled, validated and approved.
    const designer = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const missing = await post('/forms/submissions', T.designer, { formCode: code, data: { item: 'دوربین' } });
    expect(missing.status).toBe(400);
    const filed = expectOk(await post('/forms/submissions', T.designer, {
      formCode: code, data: { item: 'دوربین سونی', handedTo: designer.id, returnBy: '2026-12-01' },
    }), 'submit custom form');
    expect(filed.state).toBe('PENDING_APPROVAL');
    expect(expectOk(await post(`/forms/submissions/${filed.id}/decision`, T.creative, { decision: 'APPROVE' }), 'approve').state).toBe('APPROVED');

    // A re-seed of the catalogue leaves an edited definition alone rather than overwriting it.
    const edited = await prisma.formDefinition.findFirstOrThrow({ where: { code: CODE } });
    expect(edited.customizedAt).not.toBeNull();
    const shipped = FORM_BY_CODE.get(CODE)!;
    const again = await publishDefinition(prisma, { organizationId: org.id, form: shipped, note: 'seed' });
    expect(again.skippedCustomised).toBe(true);
    const after = await prisma.formDefinition.findFirstOrThrow({ where: { code: CODE } });
    expect((after.schema as unknown as any[]).some((f) => f.key === 'clientBudgetBand')).toBe(true);
    expect(after.version).toBe(edited.version);
  });
});

describe('Approval chains and quorum', () => {
  /**
   * Doc_H's resource-request form says «تأیید مدیر واحد و مدیریت» — two approvals, in order.
   * One approverRoles list could not say that: whoever clicked first ended the form. A chain
   * says who decides at each step and how many of them, and a conditional stage attaches a
   * legal review to the large contracts without bothering the small ones.
   */
  const OUTSOURCE = 'D31_OUTSOURCE_REQUEST';
  const CONTRACT = 'F50_CONTRACT_SCALE';

  async function outsourceRequest(estimatedCost: number) {
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    return expectOk(await post('/forms/submissions', T.designer, {
      formCode: OUTSOURCE,
      data: {
        projectId: project.id, kind: 'OUTSOURCE', supplierName: 'استودیو نمونه',
        scopeOfWork: 'تدوین ویدئو', estimatedCost, neededBy: '2026-11-01', justification: 'ظرفیت داخلی پر است',
      },
    }), 'outsource request');
  }

  it('walks the stages in order, and will not let a later approver jump the queue', async () => {
    const sub = await outsourceRequest(100_000_000);
    expect(sub.state).toBe('PENDING_APPROVAL');
    expect(sub.stages.map((s: any) => s.id)).toEqual(['unit', 'management']);   // the CEO stage is conditional
    expect(sub.stages[0].labelFa).toBe('تأیید مدیر واحد');

    // Management is in the chain, but not yet: the unit manager decides first.
    const early = await post(`/forms/submissions/${sub.id}/decision`, T.deputy, { decision: 'APPROVE' });
    expect(early.status).toBe(403);
    expect(early.body.error.message).toContain('تأیید مدیر واحد');

    const first = expectOk(await post(`/forms/submissions/${sub.id}/decision`, T.creative, { decision: 'APPROVE' }), 'unit manager');
    expect(first.state).toBe('PENDING_APPROVAL');        // one stage down, not done
    expect(first.stageCleared).toBe(true);
    expect(first.nextStageFa).toBe('تأیید مدیریت');
    const mid = await prisma.formSubmission.findUniqueOrThrow({ where: { id: sub.id } });
    expect(mid.currentStage).toBe(1);
    expect(mid.currentRoles).toEqual(['DEPUTY']);
    expect(mid.decidedAt).toBeNull();                    // not decided while it is still climbing

    const second = expectOk(await post(`/forms/submissions/${sub.id}/decision`, T.deputy, { decision: 'APPROVE' }), 'management');
    expect(second.state).toBe('APPROVED');
    const done = await prisma.formSubmission.findUniqueOrThrow({ where: { id: sub.id }, include: { approvals: true } });
    expect(done.currentRoles).toEqual([]);
    expect(done.decidedAt).not.toBeNull();
    // Each approval records the stage it satisfied, so the trail reads as a chain.
    expect(done.approvals.map((a) => a.stage).sort()).toEqual(['management', 'unit']);
  });

  it('adds a stage only when the values call for it, and a rejection ends the chain wherever it stands', async () => {
    const costly = await outsourceRequest(900_000_000);
    expect(costly.stages.map((s: any) => s.id)).toEqual(['unit', 'management', 'ceo']);
    expect(costly.requiredRoles).toContain('CEO');        // the routing rule agrees with the stage

    expectOk(await post(`/forms/submissions/${costly.id}/decision`, T.creative, { decision: 'APPROVE' }), 'unit');
    const rejected = expectOk(await post(`/forms/submissions/${costly.id}/decision`, T.deputy, { decision: 'REJECT', comment: 'بودجه امسال اجازه نمی‌دهد' }), 'management rejects');
    expect(rejected.state).toBe('REJECTED');
    // No further stage is waiting for anyone.
    const after = await prisma.formSubmission.findUniqueOrThrow({ where: { id: costly.id } });
    expect(after.currentRoles).toEqual([]);
    expect((await post(`/forms/submissions/${costly.id}/decision`, T.ceo, { decision: 'APPROVE' })).status).toBe(400);
  });

  it('counts people rather than clicks when a stage asks for a quorum', async () => {
    const p = await prisma.proposal.findFirstOrThrow();
    // Two of the three managers must agree before this contract moves.
    expectOk(await call('PUT', `/forms/definitions/${CONTRACT}/chain`, {
      token: T.admin,
      payload: {
        note: 'حد نصاب دو از سه',
        stages: [{ id: 'board', labelFa: 'هیئت مدیره — دو تأیید از سه', roles: ['DEPUTY', 'CEO', 'FINANCE_MANAGER'], quorum: 2 }],
      },
    }), 'set quorum');

    const sub = expectOk(await post('/forms/submissions', T.accountManager, {
      formCode: CONTRACT,
      data: { proposalId: p.id, contractValue: 2_000_000_000, scaleBand: 'M', notes: 'قرارداد سالانه' },
    }), 'submit');
    expect(sub.stages).toHaveLength(2);                   // the quorum stage, plus Legal routed in
    expect(sub.stages[0].quorum).toBe(2);

    const one = expectOk(await post(`/forms/submissions/${sub.id}/decision`, T.deputy, { decision: 'APPROVE' }), 'first approval');
    expect(one.state).toBe('PENDING_APPROVAL');
    expect(one.stageCleared).toBe(false);
    // The same person cannot make up the numbers alone.
    expect((await post(`/forms/submissions/${sub.id}/decision`, T.deputy, { decision: 'APPROVE' })).body.error.code).toBe('ALREADY_APPROVED');

    const two = expectOk(await post(`/forms/submissions/${sub.id}/decision`, T.ceo, { decision: 'APPROVE' }), 'second approval');
    expect(two.stageCleared).toBe(true);
    expect(two.state).toBe('PENDING_APPROVAL');           // Legal still has to look at it
    const stored = await prisma.formSubmission.findUniqueOrThrow({ where: { id: sub.id } });
    expect((stored.stages as any)[0].approvedBy).toHaveLength(2);
    expect(stored.currentRoles).toEqual(['LEGAL_MANAGER']);
  });

  it('leaves a form with no chain exactly as it was', async () => {
    const brief = await prisma.brief.findFirstOrThrow({ where: { state: 'UNDER_REVIEW' } });
    const sub = expectOk(await post('/forms/submissions', T.sales, {
      formCode: 'B10_BRIEF_COMPLETION',
      data: { briefId: brief.id, addedInformation: 'اطلاعات تکمیلی' },
    }), 'no chain');
    expect(sub.stages).toHaveLength(1);
    expect(sub.stages[0].id).toBe('approval');
    expect(sub.stages[0].quorum).toBe(1);
    const decided = expectOk(await post(`/forms/submissions/${sub.id}/decision`, T.accountManager, { decision: 'APPROVE' }), 'single approval');
    expect(decided.state).toBe('APPROVED');
  });
});

describe('SLA breach prediction', () => {
  /**
   * `warnAt` fires three-quarters of the way through the budget — it tells a person they were
   * late. The clocks already hold how long this policy really takes in this unit, so the same
   * question can be answered at the start: of the past clocks still open at this point, how
   * many went on to breach. History of misses should read as risk long before the threshold.
   */
  const H = 3_600_000;
  // A fixed working week inside the default calendar: Saturday 2026-09-05 onwards.
  const sat = (h: number) => new Date(2026, 8, 5, h, 0, 0);

  async function policyWith(code: string, hours: number) {
    const org = await prisma.organization.findFirstOrThrow();
    const p = await prisma.slaPolicy.upsert({
      where: { organizationId_code: { organizationId: org.id, code } }, update: { hours },
      create: { organizationId: org.id, code, labelFa: `سیاست آزمایشی ${code}`, labelEn: code, hours, warnAt: 0.75 },
    });
    return { p, org };
  }

  /** A clock that ran for `hours` of working time and stopped — one observation. */
  async function finished(policyId: string, organizationId: string, ownerId: string, hours: number, tag: string, budget = 8) {
    const startedAt = sat(9);
    return prisma.slaClock.create({ data: {
      organizationId, policyId, entityType: 'test', entityId: `pred-${tag}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt, dueAt: addBusinessHours(startedAt, budget, DEFAULT_CALENDAR), ownerId,
      stoppedAt: addBusinessHours(startedAt, hours, DEFAULT_CALENDAR),
      state: hours > budget ? 'BREACHED' : 'MET',
    } });
  }

  it('calls a clock likely to breach while the fixed threshold is still silent, and shows its working', async () => {
    const { p: policy, org } = await policyWith(`SLA_PRED_${Date.now()}`, 8);
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    // Ten past clocks of this policy in this unit: eight of them ran past the 8-hour budget.
    for (let i = 0; i < 8; i++) await finished(policy.id, org.id, owner.id, 14, `over${i}`);
    for (let i = 0; i < 2; i++) await finished(policy.id, org.id, owner.id, 5, `under${i}`);

    const startedAt = sat(9);
    const open = await prisma.slaClock.create({ data: {
      organizationId: org.id, policyId: policy.id, entityType: 'test', entityId: `pred-open-${Date.now()}`,
      startedAt, dueAt: addBusinessHours(startedAt, 8, DEFAULT_CALENDAR), ownerId: owner.id, state: 'RUNNING',
    } });

    // Two working hours in: a quarter of the budget spent, so warnAt (0.75) is nowhere near.
    const now = new Date(startedAt.getTime() + 2 * H);
    const [prediction] = await predictClocks(prisma, org.id, [open.id], { now });
    expect(prediction!.ratio).toBeLessThan(0.75);
    expect(prediction!.probability).toBeGreaterThan(0.6);
    expect(prediction!.risk === 'LIKELY' || prediction!.risk === 'CRITICAL').toBe(true);
    expect(prediction!.beatsWarnAt).toBe(true);
    expect(prediction!.basis.source).toBe('POLICY_AND_UNIT');
    expect(prediction!.basis.samples).toBe(10);
    expect(prediction!.basis.survivors).toBe(10);          // all ten were still open at 2 hours
    // The reasons are the working, not decoration: the count, the share, and the median.
    expect(prediction!.becauseFa.join(' ')).toContain('واحد CR');
    expect(prediction!.becauseFa.join(' ')).toContain('آستانهٔ هشدار ثابت خاموش است');
    expect(prediction!.basis.medianHours).toBeGreaterThan(8);
    expect(prediction!.expectedOverrunHours).toBeGreaterThan(0);
    expect(new Date(prediction!.expectedFinish!).getTime()).toBeGreaterThan(now.getTime());
  });

  it('conditions on how far the clock has already run, and says when it has no history to go on', async () => {
    const { p: policy, org } = await policyWith(`SLA_PRED2_${Date.now()}`, 10);
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'strategy@hiva.local' } });
    // Nine finished in 4 hours, three took 20. At the start, three in twelve went over.
    for (let i = 0; i < 9; i++) await finished(policy.id, org.id, owner.id, 4, `fast${i}`, 10);
    for (let i = 0; i < 3; i++) await finished(policy.id, org.id, owner.id, 20, `slow${i}`, 10);

    const startedAt = sat(9);
    const open = await prisma.slaClock.create({ data: {
      organizationId: org.id, policyId: policy.id, entityType: 'test', entityId: `pred2-open-${Date.now()}`,
      startedAt, dueAt: addBusinessHours(startedAt, 10, DEFAULT_CALENDAR), ownerId: owner.id, state: 'RUNNING',
    } });

    const atStart = (await predictClocks(prisma, org.id, [open.id], { now: new Date(startedAt.getTime() + 1 * H) }))[0]!;
    expect(atStart.basis.survivors).toBe(12);
    expect(atStart.probability).toBeLessThan(0.4);           // three in twelve, plus the load factor

    // Six working hours in, the fast ones are already out of the comparison: everyone still
    // running at this point had gone long. The same clock, the same rules, a different answer.
    const later = (await predictClocks(prisma, org.id, [open.id], { now: new Date(startedAt.getTime() + 6 * H) }))[0]!;
    expect(later.basis.survivors).toBe(3);
    expect(later.probability).toBeGreaterThan(atStart.probability);
    expect(later.risk).toBe('CRITICAL');

    // A policy nobody has ever finished says so rather than inventing a number.
    const { p: fresh } = await policyWith(`SLA_PRED3_${Date.now()}`, 6);
    const bare = await prisma.slaClock.create({ data: {
      organizationId: org.id, policyId: fresh.id, entityType: 'test', entityId: `pred3-${Date.now()}`,
      startedAt, dueAt: addBusinessHours(startedAt, 6, DEFAULT_CALENDAR), ownerId: owner.id, state: 'RUNNING',
    } });
    const guess = (await predictClocks(prisma, org.id, [bare.id], { now: new Date(startedAt.getTime() + 3 * H) }))[0]!;
    expect(guess.basis.source).toBe('NONE');
    expect(guess.basis.samples).toBe(0);
    expect(guess.becauseFa.join(' ')).toContain('سابقهٔ کافی');
  });

  it('tells the owner once, and serves the same ranking over the API', async () => {
    const { p: policy, org } = await policyWith(`SLA_PRED4_${Date.now()}`, 8);
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    for (let i = 0; i < 10; i++) await finished(policy.id, org.id, owner.id, 16, `bad${i}`);
    const startedAt = sat(9);
    const open = await prisma.slaClock.create({ data: {
      organizationId: org.id, policyId: policy.id, entityType: 'test', entityId: `pred4-open-${Date.now()}`,
      startedAt, dueAt: addBusinessHours(startedAt, 8, DEFAULT_CALENDAR), ownerId: owner.id, state: 'RUNNING',
    } });

    const sent: string[] = [];
    const now = new Date(startedAt.getTime() + 2 * H);
    const first = await notifyPredictedBreaches(now, async (p) => { sent.push(p.clockId); });
    expect(sent).toContain(open.id);
    expect(first.notified).toBeGreaterThan(0);
    const stamped = await prisma.slaClock.findUniqueOrThrow({ where: { id: open.id } });
    expect(stamped.riskNotifiedAt).not.toBeNull();
    expect(Number(stamped.riskProbability)).toBeGreaterThan(0.7);

    // A probability that wobbles around the line must not produce a stream of messages.
    sent.length = 0;
    await notifyPredictedBreaches(new Date(now.getTime() + H), async (p) => { sent.push(p.clockId); });
    expect(sent).not.toContain(open.id);

    const res = expectOk(await get('/sla-clocks/predictions', T.pmo, { minProbability: '0.5' }), 'predictions');
    const row = res.predictions.find((p: any) => p.clockId === open.id);
    expect(row.probability).toBeGreaterThan(0.7);
    expect(row.policyCode).toBe(policy.code);
    expect(res.counts.total).toBeGreaterThan(0);
    // Ranked by probability, worst first.
    const ps = res.predictions.map((p: any) => p.probability);
    expect([...ps].sort((a: number, b: number) => b - a)).toEqual(ps);
  });
});

describe('Capacity-aware assignment', () => {
  /**
   * weeklyCapacityHours and the allocations table both existed and nothing read them where it
   * counts: the moment work is handed to a person. Two people in one unit, one already loaded,
   * and the suggestion has to put the free one first — and say why, in words a unit manager
   * can argue with.
   */
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  async function person(name: string, opts: { weeklyCapacityHours?: number } = {}) {
    const org = await prisma.organization.findFirstOrThrow();
    const dept = await prisma.department.findFirstOrThrow({ where: { code: 'CR' } });
    const template = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    return prisma.user.create({ data: {
      organizationId: org.id, departmentId: dept.id, email: `${name}.${Date.now()}@hiva.local`,
      fullName: name, passwordHash: template.passwordHash, jobTitle: 'طراح',
      weeklyCapacityHours: opts.weeklyCapacityHours ?? 40,
    } });
  }

  /** One project to hang the fixtures' tasks on; every task needs one. */
  async function holder() {
    const org = await prisma.organization.findFirstOrThrow();
    const company = await prisma.company.findFirstOrThrow();
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const project = await prisma.project.findFirst({ where: { code: { startsWith: 'PRJ-CAP-' } } }) ?? await prisma.project.create({ data: {
      organizationId: org.id, code: 'PRJ-CAP-1', name: 'پروژهٔ ظرفیت', companyId: company.id, accountOwnerId: pmo.id,
      objective: 'x', state: 'ACTIVE',
    } });
    return { org, pmo, project };
  }

  async function load(userId: string, hours: number, due: Date) {
    const { org, pmo, project } = await holder();
    return prisma.task.create({ data: {
      organizationId: org.id, projectId: project.id, code: `TSK-CAP-${Math.random().toString(36).slice(2, 9)}`, title: 'کار جاری',
      departmentCode: 'CR', assigneeId: userId, priority: 'NORMAL', state: 'IN_PROGRESS',
      sourceType: 'ORDER_FORM', sourceRef: 'x', createdById: pmo.id, estimateHours: hours, dueDate: due,
    } });
  }

  it('ranks the person with room above the person without, and gives the reasons in words', async () => {
    const free = await person('آزاد یکم');
    const busy = await person('پرکار یکم');
    await load(busy.id, 60, inDays(9));          // more than a fortnight's capacity, already held
    resetCalendarCache();

    const res = expectOk(await get('/tasks/suggest-assignee', T.pmo, { unit: 'CR', hours: '16', by: inDays(10).toISOString(), limit: '50' }), 'suggest');
    const ids = res.candidates.map((c: any) => c.load.userId);
    expect(ids).toContain(free.id);
    expect(ids.indexOf(free.id)).toBeLessThan(ids.indexOf(busy.id));

    const f = res.candidates.find((c: any) => c.load.userId === free.id);
    const b = res.candidates.find((c: any) => c.load.userId === busy.id);
    expect(f.fits).toBe(true);
    expect(f.warningsFa).toEqual([]);
    expect(f.reasonsFa.join(' ')).toContain('ساعت ظرفیت آزاد');
    expect(f.load.committedHours).toBe(0);
    expect(f.score).toBeGreaterThan(b.score);

    // The loaded one is not hidden — they are ranked last and carry the warning.
    expect(b.load.taskHours).toBe(60);
    expect(b.fits).toBe(false);
    expect(b.utilisationAfter).toBeGreaterThan(100);
    expect(b.warningsFa.join(' ')).toContain('ظرفیت می‌رساند');
    expect(b.missesDueDate).toBe(true);
    // Nothing is refused: this is advice, and both people are returned.
    expect(res.hours).toBe(16);
  });

  it('counts only what is left of a task, and takes leave out of the capacity', async () => {
    const worker = await person('نیمه‌کاره');
    const t = await load(worker.id, 20, inDays(9));
    await prisma.task.update({ where: { id: t.id }, data: { actualHours: 15 } });   // 5 hours left, not 20
    resetCalendarCache();

    const before = expectOk(await get('/tasks/suggest-assignee', T.pmo, { unit: 'CR', hours: '8', limit: '50' }), 'before');
    const b = before.candidates.find((c: any) => c.load.userId === worker.id);
    expect(b.load.taskHours).toBe(5);
    expect(b.load.leaveHours).toBe(0);

    // A week away, starting tomorrow: their calendar loses those days, and so does their capacity.
    expectOk(await post(`/users/${worker.id}/leaves`, T.admin, { from: iso(inDays(1)), to: iso(inDays(7)), kind: 'VACATION' }), 'leave');
    resetCalendarCache();
    const after = expectOk(await get('/tasks/suggest-assignee', T.pmo, { unit: 'CR', hours: '8', limit: '50' }), 'after');
    const a = after.candidates.find((c: any) => c.load.userId === worker.id);
    expect(a.load.leaveHours).toBeGreaterThan(0);
    expect(a.load.capacityHours).toBeLessThan(b.load.capacityHours);
    expect(a.reasonsFa.join(' ')).toContain('مرخصی');
    // The traffic board reads the same arithmetic, so it cannot disagree with the suggestion.
    const traffic = expectOk(await get('/traffic', T.pmo, { unit: 'CR' }), 'traffic');
    const row = traffic.rows.find((r: any) => r.user.id === worker.id);
    expect(row.leaveHours).toBeGreaterThan(0);
    expect(traffic.summary.onLeave).toBeGreaterThan(0);
  });

  it('will not dispatch a task to nobody, and hands the acceptance clock to the person named', async () => {
    const { org, pmo, project } = await holder();
    const taker = await person('گیرندهٔ وظیفه');
    const task = await prisma.task.create({ data: {
      organizationId: org.id, projectId: project.id, code: `TSK-ASG-${Date.now()}`, title: 'وظیفهٔ بدون مسئول', departmentCode: 'CR',
      priority: 'NORMAL', state: 'CREATED', sourceType: 'ORDER_FORM', sourceRef: 'x', createdById: pmo.id, estimateHours: 8,
    } });

    expect((await move('task', task.id, 'assign', T.pmo)).body.error.code).toBe('ASSIGNEE_REQUIRED');
    expect((await move('task', task.id, 'assign', T.pmo, undefined, { assigneeId: org.id })).body.error.code).toBe('ASSIGNEE_INVALID');

    const done = expectOk(await move('task', task.id, 'assign', T.pmo, undefined, { assigneeId: taker.id }), 'assign');
    expect(done.toState).toBe('ASSIGNED');
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.assigneeId).toBe(taker.id);
    // Doc_H RACI #7/#8: dispatch starts the acceptance clock, and it belongs to the person named.
    const clock = await prisma.slaClock.findFirstOrThrow({ where: { entityType: 'task', entityId: task.id, policy: { code: 'SLA_TASK_ACCEPTANCE' } } });
    expect(clock.ownerId).toBe(taker.id);

    // And the suggestion knows about the new work without being told.
    resetCalendarCache();
    const res = expectOk(await get('/tasks/suggest-assignee', T.pmo, { taskId: task.id, limit: '50' }), 'by task');
    expect(res.task.code).toBe(after.code);
    expect(res.hours).toBe(8);                                  // read off the task's own estimate
    const t = res.candidates.find((c: any) => c.load.userId === taker.id);
    expect(t.load.taskHours).toBe(8);
    expect(t.load.openTasks).toBe(1);
  });
});

describe('Probabilistic delivery forecast', () => {
  /**
   * One plannedEnd is a promise nobody can keep. The ratios of finished tasks are the
   * distribution, the dependency chain the structure, a few thousand runs the forecast.
   */
  async function projectWithHistory(ratios: number[], dept = 'CR') {
    const org = await prisma.organization.findFirstOrThrow();
    const company = await prisma.company.findFirstOrThrow();
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const history = await prisma.project.create({ data: { organizationId: org.id, code: `PRJ-H-${Date.now()}`, name: 'گذشته', companyId: company.id, accountOwnerId: pmo.id, objective: 'x', state: 'CLOSED' } });
    // Finished tasks whose actual/estimate ratios are exactly the list given.
    for (const [i, r] of ratios.entries()) {
      await prisma.task.create({ data: {
        organizationId: org.id, code: `TSK-H-${i}-${Date.now()}`, projectId: history.id, title: `h${i}`, departmentCode: dept, priority: 'NORMAL', state: 'CLOSED',
        sourceType: 'ORDER_FORM', sourceRef: 'x', createdById: pmo.id, estimateHours: 10, actualHours: 10 * r,
      } });
    }
    const start = new Date(); const plannedEnd = new Date(start.getTime() + 14 * 86_400_000);
    const p = await prisma.project.create({ data: { organizationId: org.id, code: `PRJ-F-${Date.now()}`, name: 'آینده', companyId: company.id, accountOwnerId: pmo.id, objective: 'x', state: 'ACTIVE', plannedStart: start, plannedEnd } });
    const mk = (title: string, estimate: number) => prisma.task.create({ data: {
      organizationId: org.id, code: `TSK-F-${title}-${Date.now()}`, projectId: p.id, title, departmentCode: dept, priority: 'NORMAL', state: 'ASSIGNED',
      sourceType: 'ORDER_FORM', sourceRef: 'x', createdById: pmo.id, estimateHours: estimate,
    } });
    return { p, mk };
  }

  it('turns the history into percentiles, reproducibly, and says where the ratios came from', async () => {
    // Eight CR tasks that took exactly their estimate, and two that took double.
    const { p, mk } = await projectWithHistory([1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
    const a = await mk('A', 16); const b = await mk('B', 16);
    expectOk(await post(`/tasks/${b.id}/dependencies`, T.pmo, { prerequisiteId: a.id }), 'B after A');

    const f = expectOk(await get(`/projects/${p.id}/forecast`, T.pmo, { runs: '1000', seed: '42' }), 'forecast');
    expect(f).toMatchObject({ runs: 1000, seed: 42, openTasks: 2, deterministicHours: 32 });
    expect(f.percentiles.p50Hours).toBeLessThanOrEqual(f.percentiles.p85Hours);
    expect(f.percentiles.p85Hours).toBeLessThanOrEqual(f.percentiles.p95Hours);
    // The chain is 32h at ratio 1; with a 20% chance each task doubles, the tail reaches 64.
    expect(f.percentiles.p50Hours).toBe(32);
    expect(f.percentiles.p95Hours).toBeGreaterThan(32);
    expect(f.percentiles.p95Hours).toBeLessThanOrEqual(64);
    expect(f.samples[0]).toMatchObject({ departmentCode: 'CR', source: 'department', count: 10 });
    expect(new Date(f.percentiles.p50).getTime()).toBeLessThanOrEqual(new Date(f.percentiles.p85).getTime());
    expect(f.histogram.reduce((s: number, h: any) => s + h.runs, 0)).toBe(1000);
    // Two weeks of plan against at most 64 working hours of chain: on time in every run.
    expect(f.probabilityOnTime).toBe(1);

    const again = expectOk(await get(`/projects/${p.id}/forecast`, T.pmo, { runs: '1000', seed: '42' }), 'same seed');
    expect(again.percentiles.p95Hours).toBe(f.percentiles.p95Hours);
    const other = expectOk(await get(`/projects/${p.id}/forecast`, T.pmo, { runs: '1000', seed: '7' }), 'other seed');
    expect(other.percentiles.p50Hours).toBe(32);   // the median is robust to the seed here
  });

  it('gets less sure as the plan tightens, and falls back to a default distribution with no history', async () => {
    const { p, mk } = await projectWithHistory([1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5], 'ME');
    const a = await mk('A', 40); const b = await mk('B', 40);
    expectOk(await post(`/tasks/${b.id}/dependencies`, T.pmo, { prerequisiteId: a.id }), 'chain');
    // 80h of chain at ratio 1.5 = 120 working hours = 15 working days; the plan gives 14 calendar days.
    const loose = expectOk(await get(`/projects/${p.id}/forecast`, T.pmo, { runs: '500', seed: '1' }), 'loose');
    expect(loose.percentiles.p50Hours).toBe(120);
    expect(loose.probabilityOnTime).toBe(0);
    await prisma.project.update({ where: { id: p.id }, data: { plannedEnd: new Date(Date.now() + 60 * 86_400_000) } });
    const wide = expectOk(await get(`/projects/${p.id}/forecast`, T.pmo, { runs: '500', seed: '1' }), 'wide');
    expect(wide.probabilityOnTime).toBe(1);

    // A department with no history borrows the organisation's; an organisation with none uses the default.
    const dm = await mk('DM', 8);
    await prisma.task.update({ where: { id: dm.id }, data: { departmentCode: 'DM' } });
    const mixed = expectOk(await get(`/projects/${p.id}/forecast`, T.pmo, { runs: '200', seed: '1' }), 'mixed');
    expect(mixed.samples.some((s: any) => s.source === 'department' && s.departmentCode === 'ME')).toBe(true);
    expect(mixed.samples.some((s: any) => s.source !== 'department')).toBe(true);
  });
});

describe('Business calendar', () => {
  const cal = DEFAULT_CALENDAR;

  it('adds working hours inside a working day', () => {
    // Sunday 2026-09-06 10:00 → +4h = 14:00 the same day.
    const start = new Date(2026, 8, 6, 10, 0, 0);
    expect(start.getDay()).toBe(0);
    const due = addBusinessHours(start, 4, cal);
    expect(due.getDate()).toBe(6);
    expect(due.getHours()).toBe(14);
  });

  it('rolls over to the next working day when hours run out', () => {
    // Sunday 16:00 + 4h. One productive hour remains today (the window closes at 17:00, not
    // 18:00 — the last hour is the break), so three carry over and it lands Monday 12:00.
    // This previously expected 11:00, which assumed a nine-hour productive day.
    const start = new Date(2026, 8, 6, 16, 0, 0);
    const due = addBusinessHours(start, 4, cal);
    expect(due.getDay()).toBe(1);
    expect(due.getHours()).toBe(12);
  });

  it('skips the Iranian weekend (Thursday and Friday)', () => {
    // Wednesday 2026-09-09 16:00 + 4h must skip Thu/Fri and land on Saturday.
    const wednesday = new Date(2026, 8, 9, 16, 0, 0);
    expect(wednesday.getDay()).toBe(3);
    const due = addBusinessHours(wednesday, 4, cal);
    expect(due.getDay()).toBe(6);
  });

  it('counts only working time between two instants', () => {
    const from = new Date(2026, 8, 6, 9, 0, 0);   // Sunday 09:00
    const to = new Date(2026, 8, 7, 12, 0, 0);    // Monday 12:00
    // 8 productive hours on Sunday (09:00–17:00) + 3 on Monday morning. This previously
    // expected 12, counting the break hour as working time.
    expect(businessHoursBetween(from, to, cal)).toBeCloseTo(11, 1);
  });

  it('excludes a non-working weekend entirely', () => {
    const thursday = new Date(2026, 8, 10, 9, 0, 0);
    const friday = new Date(2026, 8, 11, 18, 0, 0);
    expect(businessHoursBetween(thursday, friday, cal)).toBe(0);
  });
});

describe('SLA engine', () => {
  it('flags an overdue clock as BREACHED and notifies its owner', async () => {
    const project = await prisma.project.findFirst();
    const user = await prisma.user.findFirst({ where: { email: 'designer@hiva.local' } });
    const policy = await prisma.slaPolicy.findFirst({ where: { code: 'SLA_ACCOUNT_QC' } });

    const clock = await prisma.slaClock.create({
      data: {
        organizationId: project!.organizationId,
        policyId: policy!.id,
        entityType: 'test', entityId: `breach-${Date.now()}`,
        startedAt: new Date(Date.now() - 3 * 86_400_000),
        dueAt: new Date(Date.now() - 86_400_000),
        ownerId: user!.id, state: 'RUNNING',
      },
    });

    const before = await prisma.notification.count({ where: { userId: user!.id, kind: 'SLA_BREACH' } });
    await tickSlaClocks();

    const after = await prisma.slaClock.findUnique({ where: { id: clock.id } });
    expect(after!.state).toBe('BREACHED');
    expect(after!.breachedAt).not.toBeNull();
    const notified = await prisma.notification.count({ where: { userId: user!.id, kind: 'SLA_BREACH' } });
    expect(notified).toBeGreaterThan(before);
  });

  it('flags a clock past its warning threshold as AT_RISK', async () => {
    const project = await prisma.project.findFirst();
    const policy = await prisma.slaPolicy.findFirst({ where: { code: 'SLA_ACCOUNT_QC' } });
    // Fixed dates, and `now` passed in: the clock is read in working hours, so a run that
    // happened to fall on a Thursday used to measure the weekend as elapsed time.
    const startedAt = new Date(2026, 8, 5, 9, 0, 0);   // Saturday 09:00
    const clock = await prisma.slaClock.create({
      data: {
        organizationId: project!.organizationId, policyId: policy!.id,
        entityType: 'test', entityId: `atrisk-${Date.now()}`,
        startedAt,
        dueAt: addBusinessHours(startedAt, Number(policy!.hours), DEFAULT_CALENDAR),
        state: 'RUNNING',
      },
    });
    // Saturday 15:00 — six of the eight working hours consumed, past the 0.75 threshold.
    await tickSlaClocks(new Date(2026, 8, 5, 15, 0, 0));
    const after = await prisma.slaClock.findUnique({ where: { id: clock.id } });
    expect(after!.state).toBe('AT_RISK');
  });

  it('marks a clock MET when stopped before its due time', async () => {
    const project = await prisma.project.findFirst();
    const entityId = `met-${Date.now()}`;
    await startSla(prisma, {
      organizationId: project!.organizationId,
      policyCode: 'SLA_ACCOUNT_QC', entityType: 'test', entityId,
    });
    await stopSla(prisma, ['SLA_ACCOUNT_QC'], 'test', entityId);
    const clock = await prisma.slaClock.findFirst({ where: { entityType: 'test', entityId } });
    expect(clock!.state).toBe('MET');
    expect(clock!.stoppedAt).not.toBeNull();
  });

  it('does not start a second clock for a policy already running on the same entity', async () => {
    const project = await prisma.project.findFirst();
    const entityId = `dup-${Date.now()}`;
    await startSla(prisma, {
      organizationId: project!.organizationId, policyCode: 'SLA_PRICING',
      entityType: 'test', entityId,
    });
    await startSla(prisma, {
      organizationId: project!.organizationId, policyCode: 'SLA_PRICING',
      entityType: 'test', entityId,
    });
    expect(await prisma.slaClock.count({ where: { entityType: 'test', entityId } })).toBe(1);
  });

  it('reports SLA compliance per policy', async () => {
    const report = expectOk(await get('/reports/sla', T.deputy), 'sla report');
    expect(report.overall.total).toBeGreaterThan(0);
    expect(Array.isArray(report.byPolicy)).toBe(true);
  });
});

describe('SLA pauses', () => {
  const cal = DEFAULT_CALENDAR;
  // Saturday 2026-09-05 is a working day in the default calendar; productive hours 09:00–17:00.
  const sat = (h: number) => new Date(2026, 8, 5, h, 0, 0);
  const sun = (h: number) => new Date(2026, 8, 6, h, 0, 0);

  async function openClock(suffix: string, startedAt: Date) {
    const project = await prisma.project.findFirst();
    const policy = await prisma.slaPolicy.findFirstOrThrow({ where: { code: 'SLA_ACCOUNT_QC' } });
    return prisma.slaClock.create({
      data: {
        organizationId: project!.organizationId, policyId: policy.id,
        entityType: 'test', entityId: `pause-${suffix}-${Date.now()}`,
        startedAt, dueAt: addBusinessHours(startedAt, Number(policy.hours), cal), state: 'RUNNING',
      },
    });
  }

  it('credits the paused working hours back to the deadline on resume', async () => {
    const clock = await openClock('credit', sat(9));           // due Saturday 17:00
    await pauseSla(prisma, {
      entityType: 'test', entityId: clock.entityId, kind: 'WAITING_ON_CLIENT',
      reason: 'منتظر تأیید فایل‌های مشتری', actorId: null, at: sat(11),
    });
    const paused = await prisma.slaClock.findUniqueOrThrow({ where: { id: clock.id }, include: { pauses: true } });
    expect(paused.state).toBe('PAUSED');
    expect(paused.pauses).toHaveLength(1);
    expect(paused.pauses[0]!.kind).toBe('WAITING_ON_CLIENT');
    expect(paused.pauses[0]!.resumedAt).toBeNull();

    await resumeSla(prisma, 'test', clock.entityId, null, undefined, sun(11));
    const resumed = await prisma.slaClock.findUniqueOrThrow({ where: { id: clock.id }, include: { pauses: true } });
    // Saturday 11→17 is six working hours, Sunday 9→11 two more.
    const pausedHours = businessHoursBetween(sat(11), sun(11), cal);
    expect(pausedHours).toBe(8);
    expect(Number(resumed.pausedHours)).toBe(8);
    expect(resumed.pausedSeconds).toBe(24 * 3600);
    expect(resumed.state).toBe('RUNNING');
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.dueAt).toEqual(addBusinessHours(clock.dueAt, 8, cal));
    expect(Number(resumed.pauses[0]!.businessHours)).toBe(8);
    expect(resumed.pauses[0]!.resumedAt).toEqual(sun(11));
  });

  it('measures the warning threshold on hours actually under the owner’s control', async () => {
    const clock = await openClock('warn', sat(9));
    await pauseSla(prisma, {
      entityType: 'test', entityId: clock.entityId, kind: 'WAITING_ON_SUPPLIER',
      reason: 'منتظر نمونه چاپ', actorId: null, at: sat(11),
    });
    await resumeSla(prisma, 'test', clock.entityId, null, undefined, sun(11));

    // Sunday 12:00: eleven working hours have elapsed, eight of them paused. Three of eight
    // consumed — nowhere near the 0.75 threshold. Before pauses this read as 11/8.
    await tickSlaClocks(sun(12));
    expect((await prisma.slaClock.findUniqueOrThrow({ where: { id: clock.id } })).state).toBe('RUNNING');

    // Sunday 16:00: seven of eight consumed. Now it should warn.
    await tickSlaClocks(sun(16));
    expect((await prisma.slaClock.findUniqueOrThrow({ where: { id: clock.id } })).state).toBe('AT_RISK');
  });

  it('never breaches a paused clock, however long the wait', async () => {
    const clock = await openClock('nobreach', sat(9));
    await pauseSla(prisma, {
      entityType: 'test', entityId: clock.entityId, kind: 'WAITING_ON_CLIENT',
      reason: 'مشتری در سفر است', actorId: null, at: sat(11),
    });
    await tickSlaClocks(new Date(2026, 8, 20, 12, 0, 0));    // two weeks past the original due
    expect((await prisma.slaClock.findUniqueOrThrow({ where: { id: clock.id } })).state).toBe('PAUSED');
  });

  it('judges a clock stopped while paused after crediting the wait', async () => {
    const clock = await openClock('stop', sat(9));            // due Saturday 17:00
    await pauseSla(prisma, {
      entityType: 'test', entityId: clock.entityId, kind: 'WAITING_ON_CLIENT',
      reason: 'منتظر پاسخ', actorId: null, at: sat(11),
    });
    // Sunday 12:00 is past the original deadline; with the pause credited it is not.
    await stopSla(prisma, ['SLA_ACCOUNT_QC'], 'test', clock.entityId, sun(12));
    const stopped = await prisma.slaClock.findUniqueOrThrow({ where: { id: clock.id }, include: { pauses: true } });
    expect(stopped.state).toBe('MET');
    expect(stopped.pauses[0]!.resumedAt).toEqual(sun(12));
    expect(Number(stopped.pausedHours)).toBeGreaterThan(0);
  });

  it('does not open a second clock for a policy whose clock is paused', async () => {
    const clock = await openClock('twin', sat(9));
    await pauseSla(prisma, {
      entityType: 'test', entityId: clock.entityId, kind: 'INTERNAL_DEPENDENCY',
      reason: 'منتظر خروجی واحد دیگر', actorId: null,
    });
    await startSla(prisma, {
      organizationId: clock.organizationId, policyCode: 'SLA_ACCOUNT_QC',
      entityType: 'test', entityId: clock.entityId,
    });
    expect(await prisma.slaClock.count({ where: { entityType: 'test', entityId: clock.entityId } })).toBe(1);
  });

  /**
   * The one pause the state machines declare. A unit that asks for clarification is waiting on
   * Account; timing its acceptance deadline through that wait blamed the wrong party.
   */
  it('pauses the acceptance clock while a work order awaits clarification, and resumes it after', async () => {
    // A work order needs the project's proposal: any active project would do only while the first one the database returns has one.
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE', proposalId: { not: null } }, orderBy: { code: 'asc' } });
    const creative = await prisma.user.findFirstOrThrow({ where: { email: 'creative@hiva.local' } });
    const wo = expectOk(await post('/work-orders', T.accountManager, {
      projectId: project.id, proposalId: project.proposalId,
      targetDepartmentCode: 'CR', title: 'سفارش با ابهام',
      scopeOfWork: 'طراحی', brief: 'بریف', expectedOutput: 'فایل',
      outputFormat: 'PDF', deadline: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      ownerId: creative.id, budget: 100_000_000, priority: 'NORMAL',
    }), 'create work order');

    expectOk(await move('workOrder', wo.id, 'issue', T.accountManager), 'issue');
    const running = await prisma.slaClock.findFirstOrThrow({
      where: { entityType: 'workOrder', entityId: wo.id, policy: { code: 'SLA_TASK_ACCEPTANCE' } },
    });
    expect(running.state).toBe('RUNNING');

    expectOk(await move('workOrder', wo.id, 'request_clarification', T.creative, 'ابعاد خروجی مشخص نیست'), 'clarify?');
    const paused = await prisma.slaClock.findUniqueOrThrow({ where: { id: running.id }, include: { pauses: true } });
    expect(paused.state).toBe('PAUSED');
    expect(paused.pauses[0]!.kind).toBe('TRANSITION');
    expect(paused.pauses[0]!.reason).toContain('request_clarification');
    // and the clarification has its own clock, on Account
    const clarification = await prisma.slaClock.findFirst({
      where: { entityType: 'workOrder', entityId: wo.id, policy: { code: 'SLA_CLARIFICATION' } },
    });
    expect(clarification?.state).toBe('RUNNING');

    expectOk(await move('workOrder', wo.id, 'clarify', T.accountManager), 'clarify');
    const resumed = await prisma.slaClock.findUniqueOrThrow({ where: { id: running.id }, include: { pauses: true } });
    expect(resumed.state).toBe('RUNNING');
    expect(resumed.pauses[0]!.resumedAt).not.toBeNull();
  });

  it('exposes pause and resume to the clock owner and to traffic management, and to no one else', async () => {
    const project = await prisma.project.findFirst();
    const policy = await prisma.slaPolicy.findFirstOrThrow({ where: { code: 'SLA_ACCOUNT_QC' } });
    const designer = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const clock = await prisma.slaClock.create({
      data: {
        organizationId: project!.organizationId, policyId: policy.id,
        entityType: 'test', entityId: `api-${Date.now()}`, ownerId: designer.id,
        startedAt: new Date(), dueAt: addBusinessHours(new Date(), 8, cal), state: 'RUNNING',
      },
    });
    const url = `/sla-clocks/${clock.id}/pause`;
    const body = { kind: 'WAITING_ON_CLIENT', reason: 'منتظر مشتری' };

    // Sales is neither the owner nor traffic management.
    expect((await post(url, T.sales, body)).status).toBe(403);
    // Validation comes before anything is written.
    expect((await post(url, T.designer, { kind: 'TRANSITION', reason: 'x' })).status).toBe(400);
    expect((await post(url, T.designer, { kind: 'WAITING_ON_CLIENT' })).status).toBe(400);
    expect((await post(url, T.designer, { kind: 'NOT_A_KIND', reason: 'x' })).status).toBe(400);

    const paused = expectOk(await post(url, T.designer, body), 'owner pauses');
    expect(paused.state).toBe('PAUSED');
    expect((await post(url, T.designer, body)).status).toBe(400);            // already paused

    const audited = await prisma.auditEvent.findFirst({
      where: { action: 'SLA_PAUSE', entityId: clock.entityId }, orderBy: { createdAt: 'desc' },
    });
    expect((audited?.after as { reason?: string })?.reason).toBe('منتظر مشتری');

    // Account Manager holds traffic.manage and is not the owner.
    const resumed = expectOk(await post(`/sla-clocks/${clock.id}/resume`, T.accountManager), 'traffic resumes');
    expect(resumed.state).toBe('RUNNING');
    expect((await post(`/sla-clocks/${clock.id}/resume`, T.accountManager)).status).toBe(400);

    const listed = expectOk(await get('/sla-clocks', T.accountManager, { entityId: clock.entityId }), 'list');
    expect(listed[0]).toMatchObject({ budgetHours: 8 });
    expect(listed[0].controlledHours).toBeLessThanOrEqual(listed[0].elapsedHours);
    expect(listed[0].pauses).toHaveLength(1);
  });

  it('reports time waiting on others separately from time under our control', async () => {
    const report = expectOk(await get('/reports/sla', T.deputy), 'sla report');
    expect(report.overall).toHaveProperty('paused');
    expect(report.overall.waitingHoursByKind.WAITING_ON_CLIENT).toBeGreaterThan(0);
    const qc = report.byPolicy.find((r: { code: string }) => r.code === 'SLA_ACCOUNT_QC');
    expect(qc.avgControlledHours).toBeLessThanOrEqual(qc.avgElapsedHours);
  });
});

describe('AI governance', () => {
  it('reports the subsystem disabled but keeps the rule engine available', async () => {
    const status = expectOk(await get('/ai/status', T.accountManager), 'ai status');
    expect(status.enabled).toBe(false);
    expect(status.ruleEngineAlwaysAvailable).toBe(true);
    expect(status.capabilities.length).toBeGreaterThan(0);
  });

  it('returns deterministic, grounded findings with no model configured', async () => {
    const brief = await prisma.brief.findFirst({ where: { completenessScore: { lt: 100 } } });
    const res = expectOk(await post('/ai/ask', T.accountManager, {
      capability: 'BRIEF_ANALYSIS', entityId: brief!.id,
    }), 'ai ask');

    expect(res.modelUsed).toBe(false);
    expect(res.narrative).toBeNull();
    expect(res.disabledReason).toContain('مدل زبانی پیکربندی نشده');
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.grounding[0].entity).toBe('brief');
  });

  it('refuses a capability the caller lacks the underlying data permission for', async () => {
    const company = await prisma.company.findFirst();
    const res = await post('/ai/ask', T.designer, {
      capability: 'CUSTOMER_HEALTH', entityId: company!.id,
    });
    expect(res.status).toBe(403);
  });

  it('writes every AI call to the governance log', async () => {
    const before = await prisma.aiInteraction.count();
    const project = await prisma.project.findFirst();
    await post('/ai/ask', T.accountManager, { capability: 'PROJECT_SUMMARY', entityId: project!.id });
    expect(await prisma.aiInteraction.count()).toBeGreaterThan(before);

    const log = expectOk(await get('/ai/interactions', T.admin), 'ai log');
    expect(log.items[0].userId).toBeTruthy();
    expect(log.items[0].capability).toBeTruthy();
  });

  it('detects a Rule 13 violation as a critical finding', async () => {
    const project = await prisma.project.findFirst({ where: { state: 'ACTIVE' } });
    // Temporarily strip the authorization to simulate the violation.
    const auths = await prisma.executionAuthorization.findMany({ where: { projectId: project!.id } });
    await prisma.executionAuthorization.updateMany({
      where: { projectId: project!.id }, data: { revokedAt: new Date() },
    });
    await prisma.executionAuthorization.deleteMany({ where: { projectId: project!.id } });

    const res = expectOk(await post('/ai/ask', T.accountManager, {
      capability: 'RISK_DETECTION', entityId: project!.id,
    }), 'risk detection');
    const critical = res.findings.filter((f: any) => f.severity === 'CRITICAL');
    expect(critical.some((f: any) => f.labelFa.includes('۱۳'))).toBe(true);

    for (const a of auths) {
      await prisma.executionAuthorization.create({
        data: {
          projectId: a.projectId, basis: a.basis, contractId: a.contractId,
          invoiceId: a.invoiceId, referenceDocument: a.referenceDocument,
          notes: a.notes, authorizedById: a.authorizedById, authorizedAt: a.authorizedAt,
        },
      });
    }
  });
});

describe('Business calendar — the break hour', () => {
  /**
   * The Iranian working week: Saturday–Wednesday, 09:00–18:00 with one break hour, so eight
   * productive hours a day. Both functions used to measure the full nine-hour span.
   */
  const cal = { ...DEFAULT_CALENDAR, holidays: new Set<string>() };
  // 2026-09-05 is a Saturday, the first working day of the Iranian week.
  const sat = (h: number, m = 0) => new Date(2026, 8, 5, h, m, 0, 0);
  const wed = (h: number, m = 0) => new Date(2026, 8, 9, h, m, 0, 0);
  const fmt = (d: Date) =>
    `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

  it('treats a working day as eight productive hours, not nine', () => {
    expect(hoursPerDay(cal)).toBe(8);
    // One full working day from the start of Saturday lands at the next working morning —
    // previously this returned Saturday 17:00, still the same day.
    expect(fmt(addBusinessHours(sat(9), 8, cal))).toBe('Sun 09:00');
  });

  it('carries the remainder across the Thursday–Friday weekend', () => {
    // Two hours left on Wednesday (15:00–17:00), two more on the next working day.
    expect(fmt(addBusinessHours(wed(15), 4, cal))).toBe('Sat 11:00');
    // Starting after the productive window, the whole budget lands on Saturday.
    expect(fmt(addBusinessHours(wed(17), 4, cal))).toBe('Sat 13:00');
  });

  it('measures elapsed working hours over the same weekend', () => {
    // Wednesday 15:00 → Saturday 11:00 is two working days apart on the clock but four
    // working hours of actual capacity.
    expect(businessHoursBetween(wed(15), new Date(2026, 8, 12, 11), cal)).toBeCloseTo(4, 5);
    // Thursday and Friday contribute nothing.
    expect(businessHoursBetween(wed(17), new Date(2026, 8, 11, 12), cal)).toBeCloseTo(0, 5);
  });

  it('round-trips: adding N working hours then measuring them returns N', () => {
    for (const hours of [0.5, 2, 4, 8, 12, 20, 40, 56]) {
      const to = addBusinessHours(sat(9), hours, cal);
      expect(businessHoursBetween(sat(9), to, cal), `${hours}h`).toBeCloseTo(hours, 5);
    }
  });

  it('skips a declared holiday', () => {
    const withHoliday = { ...cal, holidays: new Set(['2026-09-06']) }; // the Sunday
    // Eight hours from Saturday 09:00 would land Sunday; the holiday pushes it to Monday.
    expect(fmt(addBusinessHours(sat(9), 8, withHoliday))).toBe('Mon 09:00');
    // Saturday 09:00 → Monday 17:00 spans three calendar days but only two working ones:
    // 8 hours each, with the Sunday holiday contributing nothing. Without it, 24.
    const span = [sat(9), new Date(2026, 8, 7, 17)] as const;
    expect(businessHoursBetween(...span, withHoliday)).toBeCloseTo(16, 5);
    expect(businessHoursBetween(...span, cal)).toBeCloseTo(24, 5);
  });

  it('agrees with the durations the SLA catalogue declares', () => {
    // Every policy is a whole number of 8-hour days or a sub-day figure; a "1 working day"
    // policy must come due on the next working morning, matching its Doc_H docRef.
    const oneDay = SLA_POLICIES.find((p) => p.code === 'SLA_BRIEF_REVIEW')!;
    expect(oneDay.hours).toBe(8);
    expect(fmt(addBusinessHours(sat(9), oneDay.hours, cal))).toBe('Sun 09:00');

    const fourHour = SLA_POLICIES.find((p) => p.code === 'SLA_TASK_ACCEPTANCE')!;
    expect(fourHour.hours).toBe(4);
    expect(fmt(addBusinessHours(sat(9), fourHour.hours, cal))).toBe('Sat 13:00');
  });
});

describe('SLA warnings are measured in working hours', () => {
  /**
   * The AT_RISK ratio used to be wall-clock, so a clock opened before the weekend was flagged
   * during the weekend having consumed no working time at all.
   */
  it('does not flag a clock as at-risk across the weekend', async () => {
    const org = await prisma.organization.findFirstOrThrow();
    const policy = await prisma.slaPolicy.findFirstOrThrow({ where: { code: 'SLA_TASK_ACCEPTANCE' } });
    const startedAt = new Date(2026, 8, 9, 17, 0, 0); // Wednesday, after hours
    const clock = await prisma.slaClock.create({
      data: {
        organizationId: org.id, policyId: policy.id,
        entityType: 'task', entityId: 'weekend-probe',
        startedAt, dueAt: new Date(2026, 8, 12, 13, 0, 0), state: 'RUNNING',
      },
    });
    try {
      // Thursday noon: 19 wall-clock hours in, zero working hours consumed.
      await tickSlaClocks(new Date(2026, 8, 10, 12, 0, 0));
      const midWeekend = await prisma.slaClock.findUniqueOrThrow({ where: { id: clock.id } });
      expect(midWeekend.state).toBe('RUNNING');

      // Saturday 12:00: three of the four working hours are gone, past the 0.75 threshold.
      await tickSlaClocks(new Date(2026, 8, 12, 12, 0, 0));
      const afterWork = await prisma.slaClock.findUniqueOrThrow({ where: { id: clock.id } });
      expect(afterWork.state).toBe('AT_RISK');
    } finally {
      await prisma.slaClock.delete({ where: { id: clock.id } });
    }
  });
});

describe('Executive report', () => {
  it('requires report.executive', async () => {
    // A unit specialist holds report.read but not report.executive.
    expect((await get('/reports/executive', T.designer)).status).toBe(403);
    expect((await get('/reports/executive', T.ceo)).status).toBe(200);
  });

  /** The finance block is not merely hidden without finance.read — it is never computed. */
  it('returns a null finance block to a caller without finance.read', async () => {
    const withFinance = await get('/reports/executive', T.ceo);
    expect(withFinance.body.finance).not.toBeNull();
    expect(withFinance.body.finance).toHaveProperty('grossMargin');

    const withoutFinance = await get('/reports/executive', T.pmo);
    expect(withoutFinance.status).toBe(200);
    expect(withoutFinance.body.finance).toBeNull();
    // Everything else still arrives.
    expect(withoutFinance.body.projects).toHaveProperty('total');
    expect(Array.isArray(withoutFinance.body.projectHealth)).toBe(true);
  });

  it('keeps the aggregate consistent with the rows it summarises', async () => {
    const res = await get('/reports/executive', T.ceo);
    const org = (await prisma.organization.findFirstOrThrow()).id;

    const [projects, openTasks, companies] = await Promise.all([
      prisma.project.count({ where: { organizationId: org, deletedAt: null } }),
      prisma.task.count({
        where: { organizationId: org, state: { notIn: ['APPROVED', 'CLOSED', 'CANCELLED'] } },
      }),
      prisma.company.count({ where: { organizationId: org, deletedAt: null } }),
    ]);
    expect(res.body.projects.total).toBe(projects);
    expect(res.body.delivery.openTasks).toBe(openTasks);
    expect(res.body.customers.total).toBe(companies);
    // projectHealth covers exactly the projects that are neither closed nor cancelled.
    const live = await prisma.project.count({
      where: { organizationId: org, deletedAt: null, state: { notIn: ['CLOSED', 'CANCELLED'] } },
    });
    expect(res.body.projectHealth).toHaveLength(live);
  });
});

describe('Persian labels', () => {
  /**
   * The highest-value test in the set: it fails the moment a new state is declared without a
   * label, which is how a raw code like PENDING_AUTHORIZATION reaches a Persian-speaking user.
   * The table used to exist twice — STATE_META in the SPA and STATE_FA in the PDF layer — and
   * the two had drifted, so a value could render in Persian in one and as a code in the other.
   */
  it('labels every state declared by every workflow', () => {
    const missing: string[] = [];
    for (const [entity, def] of Object.entries(WORKFLOWS)) {
      for (const state of def.states) {
        if (!STATE_LABELS[state]) missing.push(`${entity}.${state}`);
      }
    }
    expect(missing, `states without a Persian label: ${missing.join(', ')}`).toEqual([]);
  });

  it('labels the vocabularies outside the workflows too', () => {
    const vocabularies: Record<string, readonly string[]> = {
      qcLevel: QC_LEVELS,
      qcResult: QC_RESULTS,
      formSubmission: FORM_SUBMISSION_STATES,
      sla: SLA_STATES,
      severity: SEVERITY_LEVELS,
      priority: PRIORITY_LEVELS,
      scope: SCOPE_VERDICTS,
      authorizationBasis: AUTHORIZATION_BASES,
      supplierKind: SUPPLIER_KINDS,
      invoiceKind: INVOICE_KINDS,
    };
    const missing: string[] = [];
    for (const [name, values] of Object.entries(vocabularies)) {
      for (const v of values) if (!STATE_LABELS[v]) missing.push(`${name}.${v}`);
    }
    expect(missing, `values without a Persian label: ${missing.join(', ')}`).toEqual([]);
  });

  it('labels every Doc_H revision reason', () => {
    const missing = REVISION_REASONS.filter((r) => !REVISION_REASON_LABELS[r]);
    expect(missing).toEqual([]);
  });

  it('falls back to the raw value rather than rendering blank', () => {
    expect(stateLabelFa('A_STATE_NOBODY_DECLARED')).toBe('A_STATE_NOBODY_DECLARED');
    expect(stateLabelFa(null)).toBe('—');
    expect(stateLabelFa('ACTIVE')).toBe('در حال اجرا');
  });
});

describe('Every guard a workflow names exists and can be shown on a checklist', () => {
  it('has an implementation and a positive label for each declared guard', async () => {
    const { GUARDS, GUARD_LABELS } = await import('../src/workflow/guards.js');
    const declared = new Set(Object.values(WORKFLOWS).flatMap((w) => w.transitions.flatMap((t) => t.guards ?? [])));
    for (const g of declared) {
      expect(GUARDS[g], `guard ${g} is declared but not implemented`).toBeTypeOf('function');
      expect(GUARD_LABELS[g], `guard ${g} has no checklist label`).toBeTruthy();
    }
    for (const g of Object.keys(GUARDS)) {
      expect(GUARD_LABELS[g], `guard ${g} has no checklist label`).toBeTruthy();
    }
  });
});

describe('Catalogue sizes the documentation quotes', () => {
  /**
   * The docs cite these numbers, and a number maintained by hand drifts. This is the source of
   * truth they point at: changing a catalogue fails here first, which is the prompt to update
   * whatever prose quotes it.
   */
  it('matches the figures in README and docs/', () => {
    expect(ALL_PERMISSIONS, 'permissions').toHaveLength(133);
    expect(ROLE_CODES, 'roles').toHaveLength(16);
    expect(ALL_FORMS, 'Doc_H forms').toHaveLength(130);
    expect(SLA_POLICIES, 'SLA policies').toHaveLength(31);
    expect(Object.keys(WORKFLOWS), 'state machines').toHaveLength(16);
    expect(MODULES, 'ERP modules').toHaveLength(10);
    expect(DEPARTMENT_CODES, 'organisational units').toHaveLength(10);
  });

  it('keeps the structural-form count the architecture doc quotes', () => {
    // docs/architecture.md and ADR-006 both cite this: a form with a `binding` drives a
    // first-class domain entity rather than being stored as generic form data.
    expect(ALL_FORMS.filter((f) => f.binding)).toHaveLength(73);
  });

  it('keeps every Doc_H form number present exactly once', () => {
    const numbers = ALL_FORMS.map((f) => f.no).sort((a, b) => a - b);
    expect(numbers[0]).toBe(1);
    expect(numbers[numbers.length - 1]).toBe(130);
    expect(new Set(numbers).size, 'duplicate form numbers').toBe(130);
  });

  it('declares a transition count the workflow docs can rely on', () => {
    const total = Object.values(WORKFLOWS).reduce((n, d) => n + d.transitions.length, 0);
    expect(total).toBe(127);
    // Every one carries a permission — the claim docs/architecture.md makes about the engine.
    const open = Object.values(WORKFLOWS).flatMap((d) => d.transitions).filter((t) => !t.permission);
    expect(open, 'transitions without a permission').toEqual([]);
  });
});
