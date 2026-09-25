import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, get, login, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { normalisePersian } from '../src/memory/embed.js';
import { formatJalali } from '../src/lib/jalali.js';
import { parsePeriod, previousPeriod } from '../src/ask/periods.js';
import { parseQuestion, type Vocab } from '../src/ask/parse.js';
import { ask } from '../src/ask/answer.js';

let T: Record<string, string>;
beforeAll(async () => {
  T = {
    deputy: await login('deputy@hiva.local'),
    designer: await login('designer@hiva.local'),
    sales: await login('sales@hiva.local'),
    accountManager: await login('account.manager@hiva.local'),
  };
});
afterAll(async () => { await closeApp(); });

/* Friday ۱۴۰۵/۰۷/۰۳, mid-morning — fixed so the windows below do not depend on the day the suite runs. */
const NOW = new Date(2026, 8, 25, 10, 0, 0);
const period = (q: string) => parsePeriod(normalisePersian(q), NOW)!.period;

describe('Windows as people say them, on the Jalali calendar', () => {
  it('reads rolling, calendar and explicit windows, each labelled with its exact dates', () => {
    const three = period('سه ماه گذشته');
    expect(three.kind).toBe('ROLLING');
    expect(formatJalali(three.from!)).toBe('۱۴۰۵/۰۴/۰۳');
    expect(three.labelFa).toContain('۳ ماه گذشته (۱۴۰۵/۰۴/۰۳ تا ۱۴۰۵/۰۷/۰۳)');

    const last = period('ماه گذشته');
    expect(last).toMatchObject({ kind: 'MONTH', complete: true, labelFa: 'شهریور ۱۴۰۵' });
    expect(formatJalali(last.from!)).toBe('۱۴۰۵/۰۶/۰۱');
    expect(formatJalali(last.to!)).toBe('۱۴۰۵/۰۷/۰۱');

    expect(period('اسفند').labelFa).toBe('اسفند ۱۴۰۴');         // a month still ahead this year means last year's
    expect(period('مهر').labelFa).toBe('مهر ۱۴۰۵ (تا امروز)');
    expect(period('پارسال')).toMatchObject({ kind: 'YEAR', complete: true });
    expect(formatJalali(period('پارسال').from!)).toBe('۱۴۰۴/۰۱/۰۱');
    const q = period('فصل گذشته');
    expect([formatJalali(q.from!), formatJalali(q.to!)]).toEqual(['۱۴۰۵/۰۴/۰۱', '۱۴۰۵/۰۷/۰۱']);
    const r = period('از ۱۴۰۵/۰۱/۰۱ تا ۱۴۰۵/۰۱/۳۱');
    expect([formatJalali(r.from!), formatJalali(r.to!)]).toEqual(['۱۴۰۵/۰۱/۰۱', '۱۴۰۵/۰۲/۰۱']);
    expect(period('این هفته').from!.getDay()).toBe(6);             // the Iranian week starts on Saturday
    expect(period('از ابتدا').kind).toBe('ALL');
  });

  it('compares a whole month with the month before it, and a rolling window with the stretch before it', () => {
    expect(previousPeriod(period('ماه گذشته'), NOW)!.labelFa).toBe('مرداد ۱۴۰۵');
    const three = period('سه ماه گذشته');
    const before = previousPeriod(three, NOW)!;
    expect(before.to!.getTime()).toBe(three.from!.getTime());
    expect(three.to!.getTime() - three.from!.getTime()).toBe(before.to!.getTime() - before.from!.getTime());
  });
});

describe('A question becomes a plan — and says what it did not use', () => {
  const vocab: Vocab = {
    people: [
      { id: 'u-sepideh', fullName: 'سپیده آذر', departmentCode: 'CR' },
      { id: 'u-behrad', fullName: 'بهراد مهرنیا', departmentCode: 'CR' },
      { id: 'u-arash1', fullName: 'آرش نیک‌بین', departmentCode: 'ST' },
      { id: 'u-arash2', fullName: 'آرش کاظمی', departmentCode: 'ME' },
    ],
    companies: [
      { id: 'c-ayande', legalName: 'گروه صنعتی آینده‌سازان', brandName: null },
      { id: 'c-pars1', legalName: 'پارس نوین', brandName: null },
      { id: 'c-pars2', legalName: 'پارس گستر', brandName: null },
    ],
    projects: [{ id: 'p-16', code: 'PRJ-000016', name: 'بازطراحی هویت دیجیتال آینده‌سازان' }],
  };
  const parse = (q: string) => parseQuestion(q, NOW, vocab, 'u-me');

  it('reads the roadmap’s own example completely', () => {
    const p = parse('حاشیه سود پروژه‌های واحد رسانه در سه ماه گذشته چقدر بوده؟');
    expect(p.metrics).toEqual(['margin']);
    expect(p.filters).toEqual({ units: ['ME'] });
    expect(p.period.kind).toBe('ROLLING');
    expect(p.ignored).toEqual([]);
    expect(p.clarify).toBeNull();
  });

  it('splits and ranks: «کدام واحد بیشترین اصلاحیه»', () => {
    const p = parse('کدام واحد بیشترین اصلاحیه را در فصل گذشته داشته؟');
    expect(p).toMatchObject({ metrics: ['revisions'], groupBy: 'unit', sort: 'desc' });
    expect(p.period.kind).toBe('QUARTER');
  });

  it('claims full names before the words inside them: «سپیده آذر» is a person, not the month آذر', () => {
    const p = parse('نرخ به‌موقع سپیده آذر');
    expect(p.filters.personId).toBe('u-sepideh');
    expect(p.period.kind).toBe('ALL');
    // …and a project name is a project before «دیجیتال» can be a unit.
    const q = parse('ساعات کار بازطراحی هویت دیجیتال آینده‌سازان');
    expect(q.filters).toEqual({ projectId: 'p-16' });
  });

  it('knows «من» the owner from «به من بگو»', () => {
    expect(parse('ساعات ثبت‌شدهٔ من در این ماه').filters.personId).toBe('u-me');
    const p = parse('به من بگو اصلاحیه‌های واحد خلاقیت در شهریور چند تا بوده');
    expect(p.filters).toEqual({ units: ['CR'] });
    expect(p.ignored).toEqual([]);
  });

  it('asks rather than guesses: two metrics, two people with one name, two clients with one word', () => {
    expect(parse('اصلاحیه‌ها و مطالبات امسال').clarify).toMatchObject({ kind: 'metric' });
    const arash = parse('نرخ به‌موقع آرش');
    expect(arash.clarify).toMatchObject({ kind: 'person' });
    expect(arash.clarify!.options.map((o) => o.value).sort()).toEqual(['u-arash1', 'u-arash2']);
    const pars = parse('مطالبات پارس');
    expect(pars.clarify).toMatchObject({ kind: 'client' });
    expect(pars.ignored).toEqual([]);                          // used — to ask — not unused
    expect(parse('مطالبات آینده‌سازان').filters.companyId).toBe('c-ayande');
    expect(parse('ساعات کار PRJ-000099').clarify).toMatchObject({ kind: 'project', options: [] });
    expect(parse('ساعات کار PRJ-000016').filters.projectId).toBe('p-16');
  });

  it('reports the part of a question it could not apply instead of dropping it', () => {
    const p = parse('نرخ برد کمپین‌های تلویزیونی در امسال');
    expect(p.metrics).toEqual(['win_rate']);
    expect(p.ignored).toEqual(['کمپین', 'تلویزیونی']);
    // «فروش» inside «قیف فروش» is the metric, not the sales unit.
    expect(parse('ارزش قیف فروش').filters).toEqual({});
  });
});

/** The asker as the route builds it — for the many-question tests, which would trip the per-minute limit over HTTP. */
async function actorOf(email: string) {
  const u = await prisma.user.findFirstOrThrow({ where: { email }, include: { department: true, roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
  return {
    id: u.id, organizationId: u.organizationId, departmentCode: u.department?.code ?? null,
    permissions: [...new Set(u.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.code)))],
  };
}

describe('The same number as the dashboard', () => {
  const askPlan = async (_token: string, metric: string, filters: Record<string, unknown> = {}) =>
    ask(prisma, await actorOf('deputy@hiva.local'), { plan: { metric, filters } });

  beforeAll(async () => {
    // Enough variety that a wrong definition would show: an on-time, a late and an undated
    // finished task in one unit, a partly paid invoice, a met and a breached SLA, a feedback.
    const org = await prisma.organization.findFirstOrThrow();
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const author = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const day = 86_400_000;
    for (const [dueOffset, submittedOffset] of [[-2, -3], [-10, -5], [null, -1]] as const) {
      await prisma.task.create({
        data: {
          organizationId: org.id, code: await nextCode(prisma, 'task'), projectId: project.id, title: 'وظیفهٔ آزمون شاخص',
          departmentCode: 'CR', assigneeId: author.id, state: 'CLOSED', sourceType: 'WORK_ORDER', sourceRef: 'test', createdById: author.id,
          dueDate: dueOffset === null ? null : new Date(Date.now() + dueOffset * day), submittedAt: new Date(Date.now() + submittedOffset * day),
        },
      });
    }
    await prisma.invoice.create({
      data: {
        organizationId: org.id, code: await nextCode(prisma, 'invoice'), kind: 'FINAL', number: 'T-1', companyId: project.companyId,
        projectId: project.id, issueDate: new Date(), dueDate: new Date(Date.now() - day), subtotal: 1_000_000, total: 1_000_000,
        paidAmount: 400_000, state: 'ISSUED', createdById: author.id,
      },
    });
    const policy = await prisma.slaPolicy.findFirstOrThrow({ where: { code: 'SLA_TASK_ACCEPTANCE' } });
    for (const state of ['MET', 'BREACHED', 'MET']) {
      await prisma.slaClock.create({
        data: {
          organizationId: org.id, policyId: policy.id, entityType: 'task', entityId: project.id, ownerId: author.id, state,
          startedAt: new Date(Date.now() - 3 * day), dueAt: new Date(Date.now() - 2 * day),
          stoppedAt: state === 'MET' ? new Date(Date.now() - 2.5 * day) : null, breachedAt: state === 'BREACHED' ? new Date(Date.now() - 2 * day) : null,
        },
      });
    }
    await prisma.feedback.create({ data: { organizationId: org.id, projectId: project.id, csat: 3, nps: 6, recordedById: author.id } });
  });

  it('agrees with the units report, unit by unit', async () => {
    const units = expectOk(await get('/reports/units', T.deputy), 'units') as any[];
    for (const u of units) {
      expect((await askPlan(T.deputy, 'on_time_rate', { units: [u.unit] })).value, `on time ${u.unit}`).toBe(u.onTimeDeliveryRate);
      expect((await askPlan(T.deputy, 'revisions', { units: [u.unit] })).value, `revisions ${u.unit}`).toBe(u.revisionCount);
      expect((await askPlan(T.deputy, 'first_pass_yield', { units: [u.unit] })).value, `fpy ${u.unit}`).toBe(u.firstPassYield);
      expect((await askPlan(T.deputy, 'overdue_tasks', { units: [u.unit] })).value, `overdue ${u.unit}`).toBe(u.overdueTasks);
      expect((await askPlan(T.deputy, 'declared_cost', { units: [u.unit] })).value, `cost ${u.unit}`).toBe(u.declaredCost);
    }
    // The undated finished task counts as neither on time nor late — in both places.
    const cr = units.find((u) => u.unit === 'CR');
    expect(cr.onTimeDeliveryRate).not.toBeNull();
  });

  it('agrees with the control tower, the sales funnel and the SLA report', async () => {
    const exec = expectOk(await get('/reports/executive', T.deputy), 'executive');
    expect((await askPlan(T.deputy, 'on_time_rate')).value).toBe(exec.delivery.onTimeRate);
    expect((await askPlan(T.deputy, 'csat')).value).toBe(exec.customers.avgCsat);
    expect((await askPlan(T.deputy, 'invoiced')).value).toBe(exec.finance.invoiced);
    expect((await askPlan(T.deputy, 'outstanding')).value).toBe(exec.finance.outstanding);

    const sales = expectOk(await get('/reports/sales', T.deputy), 'sales');
    expect((await askPlan(T.deputy, 'win_rate')).value).toBe(sales.conversion.winRate);
    expect((await askPlan(T.deputy, 'pipeline_value')).value).toBe(sales.value.pipeline);

    const sla = expectOk(await get('/reports/sla', T.deputy), 'sla');
    expect((await askPlan(T.deputy, 'sla_compliance')).value).toBe(sla.overall.complianceRate);
  });
});

describe('Asking cannot widen what a person may see', () => {
  it('refuses a number whose fields the asker may not read — before computing it — and audits the refusal', async () => {
    const before = await prisma.auditEvent.count({ where: { action: 'PERMISSION_DENIED', entityType: 'report.ask' } });
    const r = expectOk(await post('/reports/ask', T.designer, { question: 'حاشیه سود پروژه‌های واحد رسانه در سه ماه گذشته چقدر بوده؟' }), 'margin as designer');
    expect(r.status).toBe('REFUSED');
    expect(r.refusal.permissions).toEqual(['finance.read']);
    expect(r.value).toBeUndefined();
    expect(r.refusal.messageFa).toContain('مشاهده اطلاعات مالی');
    const denied = await prisma.auditEvent.findFirst({ where: { action: 'PERMISSION_DENIED', entityType: 'report.ask' }, orderBy: { createdAt: 'desc' } });
    expect(await prisma.auditEvent.count({ where: { action: 'PERMISSION_DENIED', entityType: 'report.ask' } })).toBe(before + 1);
    expect(denied?.reason).toBe('missing: finance.read');         // the #26 detectors read exactly this
  });

  it('keeps individual performance to management, but lets anyone ask about themselves', async () => {
    const colleague = expectOk(await post('/reports/ask', T.designer, { question: 'نرخ به‌موقع سپیده آذر' }), 'colleague');
    expect(colleague.status).toBe('REFUSED');
    expect(colleague.refusal.messageFa).toContain('مدیریت');
    expect(expectOk(await post('/reports/ask', T.designer, { question: 'نرخ تحویل به موقع به تفکیک فرد' }), 'by person').status).toBe('REFUSED');
    const mine = expectOk(await post('/reports/ask', T.designer, { question: 'ساعات ثبت‌شدهٔ من در این ماه' }), 'mine');
    expect(mine.status).toBe('ANSWERED');
    expect(mine.understoodFa.join(' ')).toContain('بهراد مهرنیا');
    expect(expectOk(await post('/reports/ask', T.deputy, { question: 'نرخ به‌موقع سپیده آذر' }), 'deputy').status).toBe('ANSWERED');
  });

  it('keeps cost history to the asker’s own unit unless they price', async () => {
    const other = expectOk(await post('/reports/ask', T.designer, { question: 'هزینهٔ اعلام‌شدهٔ واحد رسانه' }), 'other unit');
    expect(other.status).toBe('REFUSED');
    const own = expectOk(await post('/reports/ask', T.designer, { question: 'هزینهٔ اعلام‌شده' }), 'own unit');
    expect(own.plan.filters.units).toEqual(['CR']);
    expect(own.caveatsFa.join(' ')).toContain('واحد خودتان');
    const all = expectOk(await post('/reports/ask', T.accountManager, { question: 'هزینهٔ اعلام‌شده به تفکیک واحد' }), 'pricer');
    expect(all.plan.filters.units).toBeUndefined();
  });

  it('shows the catalogue with what is locked and why, and ignores ids the asker could not have been offered', async () => {
    const cat = expectOk(await get('/reports/ask/catalog', T.designer), 'catalog');
    const margin = cat.metrics.find((m: any) => m.key === 'margin');
    expect(margin.allowed).toBe(false);
    expect(margin.lockedFa).toContain('مشاهده اطلاعات مالی');
    expect(cat.metrics.find((m: any) => m.key === 'revisions').allowed).toBe(true);
    // The designer cannot read clients, so a client id in a hand-made plan is not applied — and says so.
    const company = await prisma.company.findFirstOrThrow();
    const r = expectOk(await post('/reports/ask', T.designer, { plan: { metric: 'revisions', filters: { companyId: company.id } } }), 'foreign id');
    expect(r.plan.filters.companyId).toBeUndefined();
    expect(r.caveatsFa.join(' ')).toContain('فیلتر مشتری شناخته نشد');
  });
});

describe('An answer says what it understood, how it is defined and what it is made of', () => {
  it('answers the roadmap example over a closed project, with its definition, its records and what it left out', async () => {
    const org = await prisma.organization.findFirstOrThrow();
    const live = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } });
    const closed = await prisma.project.create({
      data: {
        organizationId: org.id, code: await nextCode(prisma, 'project'), name: 'کمپین پاییزهٔ آزمون', companyId: live.companyId,
        accountOwnerId: owner.id, state: 'CLOSED', contractValue: 1_000_000, closedAt: new Date(Date.now() - 20 * 86_400_000),
      },
    });
    const wo = await prisma.workOrder.create({
      data: {
        organizationId: org.id, code: await nextCode(prisma, 'workOrder'), projectId: closed.id, targetDepartmentCode: 'ME',
        title: 'خرید رسانه', scopeOfWork: '—', brief: '—', expectedOutput: '—', outputFormat: '—',
        deadline: new Date(), ownerId: owner.id, state: 'SUBMITTED',
      },
    });
    await prisma.costDeclaration.create({ data: { organizationId: org.id, workOrderId: wo.id, departmentCode: 'ME', internalCost: 500_000, externalCost: 200_000, declaredById: owner.id } });
    await prisma.workOrder.create({
      data: {
        organizationId: org.id, code: await nextCode(prisma, 'workOrder'), projectId: live.id, targetDepartmentCode: 'ME',
        title: 'رسانهٔ پروژهٔ جاری', scopeOfWork: '—', brief: '—', expectedOutput: '—', outputFormat: '—',
        deadline: new Date(), ownerId: owner.id, state: 'ISSUED',
      },
    });

    const r = expectOk(await post('/reports/ask', T.deputy, { question: 'حاشیه سود پروژه‌های واحد رسانه در سه ماه گذشته چقدر بوده؟' }), 'margin');
    expect(r.status).toBe('ANSWERED');
    expect(r.planner).toBe('RULES');
    expect(r.value).toBe(30);                                              // (1,000,000 − 700,000) ÷ 1,000,000
    expect(r.valueFa).toBe('۳۰٪');
    expect(r.understoodFa).toContain('پروژه‌هایی که واحد رسانه در آن‌ها سفارش کار داشته');
    expect(r.metric.definitionFa).toContain('بسته شده‌اند');
    expect(r.basis.items.map((i: any) => i.id)).toEqual([closed.id]);
    expect(r.basis.items[0].href).toBe(`/projects/${closed.id}`);
    expect(r.caveatsFa.join(' ')).toContain('پروژهٔ در جریان در این عدد نیست');
    expect(r.answerFa).toContain('۳۰٪');
    expect(r.secondaryFa).toContain('۳۰۰٬۰۰۰ ریال');

    // Compared with the stretch before, and split by month.
    const cmp = expectOk(await post('/reports/ask', T.deputy, { question: 'حاشیه سود سه ماه گذشته در مقایسه با دوره قبل ماه به ماه' }), 'compare');
    expect(cmp.previous.periodFa).toContain('دورهٔ هم‌طول قبل');
    expect(cmp.rows.length).toBeGreaterThan(0);
    expect(cmp.groupByFa).toBe('ماه');
  });

  it('refuses to invent: an unknown question gets the list of what can be asked, and is logged for the catalogue', async () => {
    const r = expectOk(await post('/reports/ask', T.deputy, { question: 'میزان محبوبیت برند ما در اینستاگرام' }), 'unknown');
    expect(r.status).toBe('NOT_UNDERSTOOD');
    expect(r.value).toBeUndefined();
    expect(r.suggestions.length).toBeGreaterThan(5);
    const logged = await prisma.aiInteraction.findFirst({ where: { capability: 'NL_REPORT', succeeded: false }, orderBy: { createdAt: 'desc' } });
    expect(logged?.promptSummary).toContain('اینستاگرام');
    expect(logged?.errorMessage).toBe('NOT_UNDERSTOOD');
  });

  it('uses a language model only to fill the same plan, and never beyond the asker’s reach', async () => {
    const actor = await actorOf('designer@hiva.local');
    const q = 'بچه‌ها چند بار کار را دوباره انجام دادند؟';
    const seen: string[][] = [];
    const planned = await ask(prisma, actor, { question: q }, {
      planner: async (_q, metrics) => { seen.push(metrics.map((m) => m.key)); return { metric: 'revisions', units: ['CR'] }; },
    });
    expect(planned.status).toBe('ANSWERED');
    expect(planned.planner).toBe('MODEL');
    expect(planned.caveatsFa.join(' ')).toContain('مدل زبانی');
    // The model is only ever offered the metrics this person may read.
    expect(seen[0]).not.toContain('margin');

    // A model that answers outside the list, or with a metric the person may not see, gains nothing.
    const invented = await ask(prisma, actor, { question: q }, { planner: async () => ({ metric: 'employee_happiness' }) });
    expect(invented.status).toBe('NOT_UNDERSTOOD');
    const reaching = await ask(prisma, actor, { question: q }, { planner: async () => ({ metric: 'margin' }) });
    expect(reaching.status).toBe('REFUSED');
    const broken = await ask(prisma, actor, { question: q }, { planner: async () => { throw new Error('timeout'); } });
    expect(broken.status).toBe('NOT_UNDERSTOOD');
  });
});
