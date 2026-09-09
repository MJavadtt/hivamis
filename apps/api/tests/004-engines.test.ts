import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, get, login, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { addBusinessHours, businessHoursBetween, DEFAULT_CALENDAR, hoursPerDay } from '../src/lib/business-calendar.js';
import { tickSlaClocks, startSla, stopSla } from '../src/sla/engine.js';
import { ALL_FORMS, SLA_POLICIES, WORKFLOWS, ALL_PERMISSIONS } from '@hiva/contracts';

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
      data: { name: 'x', companyName: 'y', source: 'INBOUND' },
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
        source: 'CAMPAIGN', estimatedValue: 750_000_000, need: 'برندینگ',
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
      data: { name: 'سرنخ SLA', companyName: 'شرکت SLA', source: 'INBOUND' },
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
      data: { name: 'سرنخ تأیید', companyName: 'شرکت تأیید', source: 'REFERRAL' },
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
      data: { name: 'سرنخ رد', companyName: 'شرکت رد', source: 'OUTBOUND' },
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
    const user = await prisma.user.findUnique({ where: { email: 'designer@hiva.local' } });
    const policy = await prisma.slaPolicy.findUnique({ where: { code: 'SLA_ACCOUNT_QC' } });

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
    const policy = await prisma.slaPolicy.findUnique({ where: { code: 'SLA_ACCOUNT_QC' } });
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
