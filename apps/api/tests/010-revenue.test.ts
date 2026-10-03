import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, get, login, patch, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { lastMonths, loadRevenueData, positionAt } from '../src/finance/revenue.js';

let T: Record<string, string>;
const DAY = 86_400_000;
const now = new Date();
// Four Jalali months, oldest first; `cur` is the one today is in.
const [m3, m2, m1, cur] = lastMonths(4, now);
const at = (m: { start: Date }, days: number) => new Date(m.start.getTime() + days * DAY + 10 * 3_600_000);

let org: string, companyId: string, ownerId: string, designerId: string;
let effort: string, t1: string, t2: string;

async function project(name: string, contractValue: number, data: Record<string, unknown> = {}) {
  return (await prisma.project.create({
    data: {
      organizationId: org, code: await nextCode(prisma, 'project'), name, companyId, accountOwnerId: ownerId,
      state: 'ACTIVE', contractValue, createdAt: at(m3!, 1), ...data,
    },
  })).id;
}
async function task(projectId: string, estimateHours: number | null) {
  return (await prisma.task.create({
    data: {
      organizationId: org, code: await nextCode(prisma, 'task'), projectId, title: 'کار شناسایی درآمد', departmentCode: 'CR',
      estimateHours, state: 'IN_PROGRESS', sourceType: 'WORK_ORDER', sourceRef: 'test', createdById: ownerId, createdAt: at(m3!, 2),
    },
  })).id;
}
const log = (taskId: string, hours: number, workedOn: Date) =>
  prisma.timeEntry.create({ data: { organizationId: org, taskId, userId: designerId, hours, workedOn } });

beforeAll(async () => {
  T = {
    finance: await login('finance@hiva.local'),
    designer: await login('designer@hiva.local'),
    accountManager: await login('account.manager@hiva.local'),
    pmo: await login('pmo@hiva.local'),
  };
  org = (await prisma.organization.findFirstOrThrow()).id;
  companyId = (await prisma.company.findFirstOrThrow()).id;
  ownerId = (await prisma.user.findFirstOrThrow({ where: { email: 'account.manager@hiva.local' } })).id;
  designerId = (await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } })).id;

  // A 1,000,000,000 job measured by effort: 10 + 30 hours estimated; 10 logged two months ago,
  // 10 last month; invoiced 700,000,000 last month — billed well ahead of the work.
  effort = await project('کمپین سنجش با ساعت', 1_000_000_000);
  t1 = await task(effort, 10);
  t2 = await task(effort, 30);
  await log(t1, 10, at(m2!, 3));
  await log(t2, 10, at(m1!, 3));
  await prisma.invoice.create({
    data: {
      organizationId: org, code: await nextCode(prisma, 'invoice'), kind: 'INVOICE', number: 'REV-1', companyId, projectId: effort,
      issueDate: at(m1!, 5), subtotal: 700_000_000, total: 700_000_000, state: 'ISSUED', createdById: ownerId,
    },
  });
});
afterAll(async () => { await closeApp(); });

describe('Revenue earned as the work is done', () => {
  it('measures effort as done ÷ (done + still to do), as it stood at any instant', async () => {
    const data = await loadRevenueData(prisma, org, [effort]);
    expect(positionAt(data, effort, m2!.start).recognised).toBe(0);
    expect(positionAt(data, effort, m1!.start)).toMatchObject({ progress: 0.25, recognised: 250_000_000 });
    const today = positionAt(data, effort, now);
    expect(today).toMatchObject({ progress: 0.5, recognised: 500_000_000, invoiced: 700_000_000, wip: -200_000_000 });
  });

  it('lets an overrun lower progress instead of pushing it past a hundred per cent', async () => {
    const p = await project('پروژهٔ با کار بیش از برآورد', 100_000_000);
    const a = await task(p, 10);
    await task(p, 10);
    await log(a, 25, at(m1!, 2));                                  // 25 hours on a 10-hour task
    const pos = positionAt(await loadRevenueData(prisma, org, [p]), p, now);
    expect(pos.progress).toBeCloseTo(25 / 35, 5);                   // 25 done, 10 still to do on the other
    expect(pos.progress).toBeLessThan(1);
  });

  it('shows the month by month earning, and billing ahead of it as deferred revenue', async () => {
    const r = expectOk(await get(`/projects/${effort}/revenue`, T.finance), 'project revenue');
    expect(r.method).toBe('EFFORT');
    const byPeriod = Object.fromEntries(r.months.map((m: any) => [m.period, m]));
    expect(byPeriod[m2!.period].recognised).toBe(250_000_000);
    expect(byPeriod[m1!.period]).toMatchObject({ recognised: 250_000_000, invoiced: 700_000_000 });
    expect(r.position.wip).toBe(-200_000_000);
  });

  it('earns a milestone project by the shares of what is done, and never more than all of it', async () => {
    const p = await project('پروژهٔ نقطهٔ عطفی', 400_000_000);
    const [a, b] = await Promise.all([
      prisma.milestone.create({ data: { projectId: p, name: 'طرح اولیه', dueDate: at(m1!, 1) } }),
      prisma.milestone.create({ data: { projectId: p, name: 'اجرای نهایی', dueDate: at(cur!, 1) } }),
    ]);
    const over = await patch(`/projects/${p}/revenue`, T.finance, { method: 'MILESTONE', shares: [{ milestoneId: a.id, revenueShare: 40 }, { milestoneId: b.id, revenueShare: 75 }] });
    expect(over.body.error.code).toBe('REVENUE_SHARES_OVER_100');
    expectOk(await patch(`/projects/${p}/revenue`, T.finance, { method: 'MILESTONE', shares: [{ milestoneId: a.id, revenueShare: 25 }, { milestoneId: b.id, revenueShare: 75 }] }), 'shares');
    expect((await patch(`/projects/${p}/milestones/${a.id}`, T.pmo, { completedAt: new Date(Date.now() + DAY).toISOString() })).body.error.code).toBe('COMPLETED_IN_FUTURE');
    expectOk(await patch(`/projects/${p}/milestones/${a.id}`, T.pmo, { completedAt: at(m1!, 4).toISOString() }), 'done');
    const r = expectOk(await get(`/projects/${p}/revenue`, T.finance), 'milestone revenue');
    expect(r.position).toMatchObject({ method: 'MILESTONE', progress: 0.25, recognised: 100_000_000 });
  });

  it('measures cost as incurred ÷ declared, pricing hours at the unit’s hourly cost', async () => {
    const p = await project('پروژهٔ سنجش با هزینه', 1_000_000_000, { revenueMethod: 'COST' });
    const t = await task(p, null);
    const cr = await prisma.department.findFirstOrThrow({ where: { code: 'CR' } });
    await prisma.department.update({ where: { id: cr.id }, data: { hourlyCost: 1_000_000 } });
    await log(t, 100, at(m1!, 6));                                                  // 100,000,000 labour
    await prisma.payment.create({ data: { organizationId: org, projectId: p, direction: 'OUT', amount: 100_000_000, occurredAt: at(m1!, 7), createdById: ownerId } });
    const wo = await prisma.workOrder.create({
      data: { organizationId: org, code: await nextCode(prisma, 'workOrder'), projectId: p, targetDepartmentCode: 'CR', title: 'تولید', scopeOfWork: '—', brief: '—', expectedOutput: '—', outputFormat: '—', deadline: now, ownerId, state: 'IN_PROGRESS' },
    });
    await prisma.costDeclaration.create({ data: { organizationId: org, workOrderId: wo.id, departmentCode: 'CR', internalCost: 300_000_000, externalCost: 100_000_000, declaredById: designerId } });
    const pos = positionAt(await loadRevenueData(prisma, org, [p]), p, now);
    expect(pos).toMatchObject({ method: 'COST', progress: 0.5, recognised: 500_000_000 });
    expect(pos.basis).toMatchObject({ labourCost: 100_000_000, externalCost: 100_000_000, declared: 400_000_000 });
  });

  it('recognises all of a closed project, and says why an unmeasurable one is not measured', async () => {
    const closed = await project('پروژهٔ بسته‌شده', 300_000_000, { state: 'CLOSED', closedAt: at(m1!, 10) });
    const blank = await project('پروژهٔ بی‌برآورد', 200_000_000);
    const data = await loadRevenueData(prisma, org, [closed, blank]);
    expect(positionAt(data, closed, now)).toMatchObject({ progress: 1, recognised: 300_000_000 });
    const b = positionAt(data, blank, now);
    expect(b.recognised).toBeNull();
    expect(b.reasonFa).toContain('برآورد');
  });
});

describe('Closing a month', () => {
  it('freezes a month, keeps it frozen, and lands a later correction in the next open month', async () => {
    expect((await post('/revenue/periods/close', T.designer, { period: m2!.period })).status).toBe(403);
    expect((await post('/revenue/periods/close', T.finance, { period: cur!.period })).body.error.code).toBe('PERIOD_NOT_ENDED');

    const first = expectOk(await post('/revenue/periods/close', T.finance, { period: m2!.period }), 'close m2');
    expect(first.entries.find((e: any) => e.projectId === effort).amount).toBe(250_000_000);
    expect((await post('/revenue/periods/close', T.finance, { period: m2!.period })).body.error.code).toBe('PERIOD_ALREADY_CLOSED');
    const early = await post('/revenue/periods/close', T.finance, { period: m3!.period });
    expect(early.body.error.code).toBe('PERIOD_OUT_OF_ORDER');
    expect(early.body.error.details.expected).toBe(m1!.period);

    // Five hours discovered late, dated inside the closed month.
    await log(t2, 5, at(m2!, 4));
    const r = expectOk(await get(`/projects/${effort}/revenue`, T.finance), 'after late entry');
    const byPeriod = Object.fromEntries(r.months.map((m: any) => [m.period, m]));
    expect(byPeriod[m2!.period]).toMatchObject({ closed: true, recognised: 250_000_000 });   // unchanged
    // 25 of 40 hours done by the end of last month: 625,000,000 to date, less the frozen 250,000,000.
    expect(byPeriod[m1!.period].recognised).toBe(375_000_000);

    const second = expectOk(await post('/revenue/periods/close', T.finance, { period: m1!.period }), 'close m1');
    expect(second.entries.find((e: any) => e.projectId === effort).amount).toBe(375_000_000);
    const entry = await prisma.revenueEntry.findUniqueOrThrow({ where: { projectId_period: { projectId: effort, period: m1!.period } } });
    expect(Number(entry.recognisedToDate)).toBe(625_000_000);
    expect(Number(entry.invoicedToDate)).toBe(700_000_000);
    expect(await prisma.auditEvent.count({ where: { action: 'REVENUE_PERIOD_CLOSED' } })).toBe(2);
  });

  it('reports earned against billed, month by month, with closed months read as they were closed', async () => {
    const r = expectOk(await get('/reports/revenue', T.finance, { months: '4' }), 'report');
    expect(r.months.map((m: any) => m.period)).toEqual([m3!.period, m2!.period, m1!.period, cur!.period]);
    expect(r.lastClosed).toBe(m1!.period);
    const last = r.months.find((m: any) => m.period === m1!.period);
    expect(last.closed).toBe(true);
    expect(last.invoiced).toBeGreaterThanOrEqual(700_000_000);
    expect(last.billingMargin - last.margin).toBe(last.invoiced - last.recognised);
    const row = r.projects.find((p: any) => p.id === effort);
    expect(row).toMatchObject({ methodFa: 'درصد پیشرفت بر پایهٔ ساعت کار', wip: -75_000_000 });   // 625 earned − 700 billed
    expect(r.wip.deferred).toBeGreaterThanOrEqual(75_000_000);
    expect((await get('/reports/revenue', T.designer)).status).toBe(403);
  });
});
