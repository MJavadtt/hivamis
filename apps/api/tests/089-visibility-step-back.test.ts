import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, closeApp, get, login, post, move, expectOk, directLead } from './helpers.js';
import { prisma } from '../src/db.js';
import { forgetReach } from '../src/auth/visibility.js';

/**
 * The owner (2026-11-14):
 * «هر کاربر باید وظایف، پروژه‌ها و موارد مربوط به خودش را صرفاً دسترسی داشته باشد، مدیر هر بخش برای
 * تمام نفرات بخش خودش و مدیران بالاتر برای همه را» (ADR-127), and
 * «کاربران درصورت اشتباه در هر مرحله باید بتوانند با تأیید مدیر خود به مرحلهٔ قبلی برگردند و ویرایش
 * انجام بدهند، مدیران نیاز به تأیید کسی ندارند» (ADR-128).
 */

let T: Record<string, string>;
let ids: Record<string, string>;

const lead = async (name: string) => expectOk(await post('/leads', T.sales, { name, companyName: `شرکت ${name}`, ...directLead() }), name) as { id: string };
const stateOf = async (id: string) => (await prisma.lead.findUniqueOrThrow({ where: { id } })).state;

beforeAll(async () => {
  await app();
  // A second colleague in the sales unit, with the same role as the first and nothing else.
  const first = await prisma.user.findFirstOrThrow({ where: { email: 'sales@hiva.local' }, include: { roles: true } });
  const peer = await prisma.user.upsert({
    where: { organizationId_email: { organizationId: first.organizationId, email: 'sales.peer@hiva.local' } },
    update: {},
    create: {
      organizationId: first.organizationId, departmentId: first.departmentId, email: 'sales.peer@hiva.local',
      fullName: 'همکار دوم فروش', passwordHash: first.passwordHash, roles: { create: first.roles.map((r) => ({ roleId: r.roleId })) },
    },
  });
  forgetReach();
  T = {
    sales: await login('sales@hiva.local'), peer: await login('sales.peer@hiva.local'),
    salesManager: await login('sales.manager@hiva.local'), ceo: await login('ceo@hiva.local'),
    designer: await login('designer@hiva.local'), creative: await login('creative@hiva.local'),
  };
  const manager = await prisma.user.findFirstOrThrow({ where: { email: 'sales.manager@hiva.local' } });
  ids = { sales: first.id, peer: peer.id, salesManager: manager.id };
});
afterAll(closeApp);

describe('Who sees a record (ADR-127)', () => {
  it('a colleague sees their own, not a peer\'s; their unit\'s manager and the managers above see it', async () => {
    const l = await lead('سرنخ دیدنی');
    expect((await get(`/leads/${l.id}`, T.sales)).status).toBe(200);
    expect((await get(`/leads/${l.id}`, T.peer)).status).toBe(404);
    const peerList = expectOk(await get('/leads', T.peer, { pageSize: '100' }), 'peer list');
    expect(JSON.stringify(peerList)).not.toContain(l.id);
    expect((await get(`/leads/${l.id}`, T.salesManager)).status).toBe(200);
    expect((await get(`/leads/${l.id}`, T.ceo)).status).toBe(200);
    // Nor is it found by search, or moved, by the one who may not see it.
    expect((await move('lead', l.id, 'contact', T.peer)).status).toBe(404);
  });

  it('a unit manager sees the tasks of their own unit\'s people, not another unit\'s', async () => {
    const designer = await prisma.user.findFirstOrThrow({ where: { email: 'designer@hiva.local' } });
    const project = await prisma.project.findFirstOrThrow({ where: { organizationId: designer.organizationId } });
    const task = await prisma.task.create({
      data: { organizationId: designer.organizationId, projectId: project.id, code: `T-VIS-${Date.now()}`, title: 'کار طراح برای دیدن', assigneeId: designer.id, departmentCode: 'CR', priority: 'NORMAL', state: 'IN_PROGRESS', sourceType: 'ORDER_FORM', sourceRef: 'test', createdById: designer.id },
    });
    expect((await get(`/tasks/${task.id}`, T.designer)).status).toBe(200);
    expect((await get(`/tasks/${task.id}`, T.creative)).status).toBe(200);
    expect((await get(`/tasks/${task.id}`, T.ceo)).status).toBe(200);
    expect([403, 404]).toContain((await get(`/tasks/${task.id}`, T.peer)).status);
  });
});

describe('Back one step to correct a mistake (ADR-128)', () => {
  it('a colleague asks; their unit\'s manager approves; the record goes back and the history says so', async () => {
    const l = await lead('سرنخ برگشتی');
    expectOk(await move('lead', l.id, 'contact', T.sales), 'contact');
    const info = expectOk(await get(`/workflow/lead/${l.id}/step-back`, T.sales), 'info');
    expect(info).toMatchObject({ state: 'CONTACTED', toState: 'NEW', direct: false, pending: null });

    expect((await post(`/workflow/lead/${l.id}/step-back`, T.sales, { reason: 'بد' })).status).toBe(400);
    const asked = expectOk(await post(`/workflow/lead/${l.id}/step-back`, T.sales, { reason: 'شمارهٔ تماس اشتباه ثبت شد' }), 'ask');
    expect(asked.applied).toBe(false);
    expect(asked.request).toMatchObject({ state: 'PENDING', fromState: 'CONTACTED', toState: 'NEW', approverId: ids.salesManager });
    expect(await stateOf(l.id)).toBe('CONTACTED');
    expect((await post(`/workflow/lead/${l.id}/step-back`, T.sales, { reason: 'دوباره همان درخواست' })).status).toBe(409);

    // It waits on the manager — not on a peer, and not on the one who asked.
    const awaiting = expectOk(await get('/step-backs', T.salesManager, { which: 'awaiting' }), 'awaiting');
    expect(awaiting.map((r: any) => r.id)).toContain(asked.request.id);
    expect(awaiting.find((r: any) => r.id === asked.request.id)).toMatchObject({ entityFa: expect.any(String), toStateFa: expect.any(String) });
    expect(expectOk(await get('/step-backs', T.peer, { which: 'awaiting' }), 'peer').map((r: any) => r.id)).not.toContain(asked.request.id);
    expect((await post(`/step-backs/${asked.request.id}/decide`, T.sales, { approve: true })).status).toBe(403);
    expect(await prisma.notification.count({ where: { userId: ids.salesManager, kind: 'STEP_BACK_REQUESTED', entityId: l.id } })).toBe(1);

    const decided = expectOk(await post(`/step-backs/${asked.request.id}/decide`, T.salesManager, { approve: true }), 'approve');
    expect(decided.applied).toBe(true);
    expect(await stateOf(l.id)).toBe('NEW');
    const back = await prisma.stateTransition.findFirstOrThrow({ where: { entityType: 'lead', entityId: l.id, action: 'step_back' } });
    expect(back).toMatchObject({ fromState: 'CONTACTED', toState: 'NEW' });
    expect(await prisma.notification.count({ where: { userId: ids.sales, kind: 'STEP_BACK_DECIDED', entityId: l.id } })).toBe(1);
    expect((await post(`/step-backs/${asked.request.id}/decide`, T.salesManager, { approve: false })).status).toBe(409);

    // Back where it was, the colleague edits it and moves on again.
    expectOk(await move('lead', l.id, 'contact', T.sales), 'contact again');
    expect(await stateOf(l.id)).toBe('CONTACTED');
  });

  it('a manager takes it back at once, with no one to ask', async () => {
    const l = await lead('سرنخ مدیر');
    expectOk(await move('lead', l.id, 'contact', T.sales), 'contact');
    expectOk(await move('lead', l.id, 'qualify', T.sales), 'qualify');
    expect(expectOk(await get(`/workflow/lead/${l.id}/step-back`, T.salesManager), 'info').direct).toBe(true);
    const r = expectOk(await post(`/workflow/lead/${l.id}/step-back`, T.salesManager, { reason: 'نیازسنجی کامل نبود' }), 'direct');
    expect(r).toMatchObject({ applied: true, fromState: 'QUALIFIED', toState: 'CONTACTED' });
    expect(await stateOf(l.id)).toBe('CONTACTED');
    // The CEO, above every unit, likewise.
    const again = expectOk(await post(`/workflow/lead/${l.id}/step-back`, T.ceo, { reason: 'هنوز تماسی برقرار نشده' }), 'ceo');
    expect(again).toMatchObject({ applied: true, fromState: 'CONTACTED', toState: 'NEW' });
    // A step back is not itself a step to go back to: from NEW there is nothing before.
    const info = expectOk(await get(`/workflow/lead/${l.id}/step-back`, T.salesManager), 'first state');
    expect(info.toState).toBeNull();
    expect((await post(`/workflow/lead/${l.id}/step-back`, T.salesManager, { reason: 'جایی برای برگشت نیست' })).status).toBe(409);
  });

  it('a refused request leaves the record where it was; a withdrawn one too', async () => {
    const l = await lead('سرنخ ردشده');
    expectOk(await move('lead', l.id, 'contact', T.sales), 'contact');
    const a = expectOk(await post(`/workflow/lead/${l.id}/step-back`, T.sales, { reason: 'اشتباه کلیک کردم' }), 'ask');
    expectOk(await post(`/step-backs/${a.request.id}/decide`, T.salesManager, { approve: false, note: 'درست بود' }), 'refuse');
    expect(await stateOf(l.id)).toBe('CONTACTED');
    expect((await prisma.stepBackRequest.findUniqueOrThrow({ where: { id: a.request.id } })).state).toBe('REJECTED');

    const b = expectOk(await post(`/workflow/lead/${l.id}/step-back`, T.sales, { reason: 'باز هم اشتباه شد' }), 'ask again');
    expect((await post(`/step-backs/${b.request.id}/withdraw`, T.peer, {})).status).not.toBe(200);
    expectOk(await post(`/step-backs/${b.request.id}/withdraw`, T.sales, {}), 'withdraw');
    expect((await prisma.stepBackRequest.findUniqueOrThrow({ where: { id: b.request.id } })).state).toBe('WITHDRAWN');
    expect(await stateOf(l.id)).toBe('CONTACTED');
    const mine = expectOk(await get('/step-backs', T.sales, { which: 'mine' }), 'mine');
    expect(mine.filter((r: any) => r.entityId === l.id).map((r: any) => r.state).sort()).toEqual(['REJECTED', 'WITHDRAWN']);
  });

  it('a request the record has moved past lapses instead of jumping it back', async () => {
    const l = await lead('سرنخ جلورفته');
    expectOk(await move('lead', l.id, 'contact', T.sales), 'contact');
    const a = expectOk(await post(`/workflow/lead/${l.id}/step-back`, T.sales, { reason: 'برگردد برای اصلاح' }), 'ask');
    expectOk(await move('lead', l.id, 'qualify', T.sales), 'moved on');
    expect((await post(`/step-backs/${a.request.id}/decide`, T.salesManager, { approve: true })).status).toBe(409);
    expect(await stateOf(l.id)).toBe('QUALIFIED');
  });
});
