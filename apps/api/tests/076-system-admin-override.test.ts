import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, expectOk, get, login, move, patch, post } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * The owner's instruction (2026-10-28): "as system administrator I must be able to step into everything,
 * without any rule — make a project without the steps before it, and do every task on its own, past any
 * process." The system administrator in their own right goes past every rule of the process: the
 * workflow's guards and mandatory reasons, a state reached directly, a project made without its brief or
 * form, the rules a route checks itself. Nobody else does — and every one of these stays on the record.
 */
describe('The system administrator above the process (owner’s instruction, 2026-10-28)', () => {
  let T: Record<string, string>;
  let ids: Record<string, string>;
  beforeAll(async () => {
    T = { admin: await login('admin@hiva.local'), ceo: await login('ceo@hiva.local'), account: await login('account.manager@hiva.local'), pmo: await login('pmo@hiva.local') };
    const users = await prisma.user.findMany({ where: { email: { in: ['admin@hiva.local', 'account.manager@hiva.local'] } }, select: { id: true, email: true } });
    ids = Object.fromEntries(users.map((u) => [u.email.split('@')[0]!, u.id]));
  });
  afterAll(closeApp);

  const newProject = async (token: string, name: string) => {
    const company = await prisma.company.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true } });
    return expectOk(await post('/projects', token, { name, companyId: company.id, accountOwnerId: ids['account.manager'] }), 'project');
  };

  it('makes a project directly, and moves it past every rule — the rules it passed named on the record', async () => {
    const p = await newProject(T.admin, 'پروژهٔ مستقیم مدیر سیستم');
    expect(p.state).toBe('DRAFT');
    expectOk(await move('project', p.id, 'request_authorization', T.admin), 'request');
    // No authorisation basis was ever recorded: the rule says no, and the system administrator goes on.
    const authorized = expectOk(await move('project', p.id, 'authorize', T.admin), 'authorize');
    expect(authorized.toState).toBe('AUTHORIZED');
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: p.id, action: 'STATE_TRANSITION', after: { path: ['state'], equals: 'AUTHORIZED' } } });
    expect((row.after as { overriddenBySystemAdministrator: { guard: string }[] }).overriddenBySystemAdministrator.map((g) => g.guard)).toContain('project.hasValidAuthorizationBasis');
    expect(await prisma.auditEvent.count({ where: { entityId: p.id, action: 'TRANSITION_BLOCKED' } })).toBe(0);
    // A move that asks for a reason goes without one.
    expectOk(await move('project', p.id, 'cancel', T.admin), 'cancel without a reason');
  });

  it('refuses the same to everyone else — the managing director included', async () => {
    const p = await newProject(T.ceo, 'پروژهٔ مدیرعامل');
    expectOk(await move('project', p.id, 'request_authorization', T.ceo), 'request');
    const refused = await move('project', p.id, 'authorize', T.ceo);
    expect(refused.status).toBe(422);
    expect(refused.body.error.details.guard).toBe('project.hasValidAuthorizationBasis');
    expect((await move('project', p.id, 'cancel', T.ceo)).body.error.code).toBe('REASON_REQUIRED');
    expect((await post(`/workflow/project/${p.id}/force`, T.ceo, { toState: 'ACTIVE' })).status).toBe(403);
  });

  it('puts a record straight into any state of its workflow, on the record, and stops a clock it leaves behind', async () => {
    const p = await newProject(T.admin, 'پروژهٔ پرش مستقیم');
    expectOk(await move('project', p.id, 'request_authorization', T.admin), 'request'); // starts an SLA clock
    const active = expectOk(await post(`/workflow/project/${p.id}/force`, T.admin, { toState: 'ACTIVE', reason: 'شروع فوری به دستور مدیریت' }), 'force');
    expect(active).toMatchObject({ fromState: 'PENDING_AUTHORIZATION', toState: 'ACTIVE', action: 'admin_force' });
    const history = expectOk(await get(`/workflow/project/${p.id}/history`, T.admin), 'history');
    expect(history.some((h: { action: string; toState: string }) => h.action === 'admin_force' && h.toState === 'ACTIVE')).toBe(true);
    expect(await prisma.auditEvent.count({ where: { entityId: p.id, action: 'STATE_FORCED', actorId: ids.admin } })).toBe(1);
    // From there the ordinary moves go on.
    expect(expectOk(await move('project', p.id, 'hold', T.admin), 'hold').toState).toBe('ON_HOLD');
    // Into a final state: whatever clock still ran is stopped.
    expectOk(await post(`/workflow/project/${p.id}/force`, T.admin, { toState: 'CLOSED' }), 'close');
    expect(await prisma.slaClock.count({ where: { entityType: 'project', entityId: p.id, state: { in: ['RUNNING', 'AT_RISK', 'PAUSED'] } } })).toBe(0);
    expect((await post(`/workflow/project/${p.id}/force`, T.admin, { toState: 'CLOSED' })).body.error.code).toBe('SAME_STATE');
    expect((await post(`/workflow/project/${p.id}/force`, T.admin, { toState: 'NOT_A_STATE' })).status).toBe(400);
  });

  it('goes past the rules a route checks itself, and the module’s own', async () => {
    // Doc_H §12: no sale price before the units declare their cost — the system administrator sets one anyway.
    const proposal = await prisma.proposal.findFirst({ where: { totalCost: null }, select: { id: true } });
    if (proposal) {
      expect((await post(`/proposals/${proposal.id}/pricing`, T.account, { salePrice: 1000, marginPercent: 10 })).status).toBe(422);
      expect((await post(`/proposals/${proposal.id}/pricing`, T.admin, { salePrice: 1000, marginPercent: 10 })).status).toBeLessThan(400);
    }
    // A deployment project's terms, locked by its contract, and a step not yet taken.
    const venue = expectOk(await post('/venues', T.pmo, { name: 'مکان آزمون اختیار مدیر', province: 'تهران', city: 'تهران', typeCode: 'MALL', address: 'آزمون', phone: '02199887766' }), 'venue');
    const sp = expectOk(await post('/site-projects', T.admin, { name: 'استقرار مدیر', venueId: venue.id }), 'site project');
    expectOk(await post(`/workflow/siteProject/${sp.id}/force`, T.admin, { toState: 'ACTIVE' }), 'straight to live');
    const fresh = await prisma.siteProject.findUniqueOrThrow({ where: { id: sp.id } });
    expect((await patch(`/site-projects/${sp.id}`, T.pmo, { version: fresh.version, rentAmount: '5' })).body.error.code).toBe('TERMS_LOCKED');
    expect(expectOk(await patch(`/site-projects/${sp.id}`, T.admin, { version: fresh.version, rentAmount: '5' }), 'admin edits terms').rentAmount).toBe('5');
    expectOk(await post(`/site-projects/${sp.id}/contracts`, T.admin, { amendment: { rentAmount: '7' } }), 'an amendment with no approved contract');
  });

  it('never while working in someone else’s account', async () => {
    const target = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' }, select: { id: true } });
    const session = expectOk(await post(`/users/${target.id}/act-as`, T.admin, { reason: 'بررسی کار همکار' }), 'act as');
    const p = await prisma.project.findFirstOrThrow({ where: { state: { notIn: ['CLOSED', 'CANCELLED'] } }, select: { id: true } });
    expect((await post(`/workflow/project/${p.id}/force`, session.accessToken, { toState: 'CLOSED' })).status).toBe(403);
  });
});
