import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ALL_PERMISSIONS, OVERSIGHT_PERMISSIONS, ROLE_PERMISSIONS } from '@hiva/contracts';
import { call, closeApp, expectOk, get, login, put, refreshWith, signIn } from './helpers.js';
import { prisma } from '../src/db.js';
import { forgetGrants } from '../src/auth/grants.js';

/**
 * Who may do what (Hivamis task 6): the managing director, deputy, system administrator and account
 * manager hold the whole system; every other role holds what the system administrator grants — in
 * force at once, recorded with the administrator's name, and a new version of the rules.
 */
async function session(email: string) {
  const s = await signIn(email);
  return { accessToken: s.access, refreshToken: s.refresh };
}
async function refresh(refreshToken: string) {
  const r = await refreshWith(refreshToken);
  return { accessToken: r.body.accessToken as string, refreshToken: r.refresh! };
}

describe('Who may do what', () => {
  let T: Record<string, string>;
  beforeAll(async () => {
    T = { admin: await login('admin@hiva.local'), ceo: await login('ceo@hiva.local'), sales: await login('sales@hiva.local'), pmo: await login('pmo@hiva.local') };
  });
  afterAll(async () => { await closeApp(); });

  it('gives the managing director, deputy, system administrator and account manager the whole system — but oversight', async () => {
    for (const email of ['ceo', 'deputy', 'admin', 'account.manager']) {
      const me = expectOk(await get('/auth/me', await login(`${email}@hiva.local`)), email);
      // Reading others' conversations is nobody's by default (audit F-5).
      expect([...me.permissions].sort(), email).toEqual(ALL_PERMISSIONS.filter((p) => !OVERSIGHT_PERMISSIONS.includes(p)).sort());
    }
    const roles = expectOk(await get('/roles', T.sales), 'roles');
    expect(roles.filter((r: any) => r.fullAccess).map((r: any) => r.code).sort()).toEqual(['ACCOUNT_MANAGER', 'CEO', 'DEPUTY', 'SUPER_ADMIN']);
    const rep = roles.find((r: any) => r.code === 'SALES_REP');
    expect(rep).toMatchObject({ fullAccess: false, review: null, differsFromDefault: false, userCount: 1 });
    expect(rep.permissions.sort()).toEqual([...ROLE_PERMISSIONS.SALES_REP].sort());
  });

  it('lets only an administrator grant, never to the full-access roles, and only real permissions', async () => {
    expect((await put('/roles/SALES_REP/permissions', T.sales, { permissions: [] })).status).toBe(403);
    expect((await put('/roles/CEO/permissions', T.admin, { permissions: [] })).body.error.code).toBe('FULL_ACCESS_ROLE');
    expect((await put('/roles/SALES_REP/permissions', T.admin, { permissions: ['crm.lead.read', 'nonsense.do'] })).body.error.code).toBe('UNKNOWN_PERMISSION');
    expect((await put('/roles/NO_SUCH_ROLE/permissions', T.admin, { permissions: [] })).status).toBe(404);
    await expect(prisma.roleGrant.create({ data: { organizationId: 'x', roleCode: 'DEPUTY', permissions: [], grantedById: 'x' } })).rejects.toThrow();
  });

  it('takes a permission away at once — the next request with an older token is sent for a fresh one', async () => {
    const before = await session('sales@hiva.local');
    const lead = await prisma.lead.findFirstOrThrow({ where: { state: 'QUALIFIED' } });
    const without = ROLE_PERMISSIONS.SALES_REP.filter((p) => p !== 'crm.lead.convert');
    const granted = expectOk(await put('/roles/SALES_REP/permissions', T.admin, { permissions: [...without, 'report.executive'], note: 'تبدیل سرنخ با مدیر فروش' }), 'grant');
    expect(granted).toMatchObject({ added: ['report.executive'], removed: ['crm.lead.convert'] });

    const stale = await call('GET', '/auth/me', { token: before.accessToken });
    expect([stale.status, stale.body.error.code]).toEqual([401, 'GRANTS_CHANGED']);
    const fresh = await refresh(before.refreshToken);
    const me = expectOk(await get('/auth/me', fresh.accessToken), 'fresh me');
    expect(me.permissions).not.toContain('crm.lead.convert');
    expect(me.permissions).toContain('report.executive');
    expect((await call('POST', `/leads/${lead.id}/convert`, { token: fresh.accessToken, payload: { title: 'x' } })).status).toBe(403);

    // The seller's own old token is stale too; anyone else's is not.
    const rep = expectOk(await get('/roles', T.admin), 'roles').find((r: any) => r.code === 'SALES_REP');
    expect(rep).toMatchObject({ differsFromDefault: true, review: { note: 'تبدیل سرنخ با مدیر فروش', grantedBy: { fullName: 'مدیر سیستم' } } });
    const trail = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'role', entityId: 'SALES_REP', action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect(trail.after).toMatchObject({ added: ['report.executive'] });
  });

  it('makes each grant a version of the rules, and shows an organisation only its own grants', async () => {
    const diff = expectOk(await get('/rules/diff', T.admin, { kind: 'permissions' }), 'diff');
    expect(diff.changes).toEqual(expect.arrayContaining([
      'SALES_REP: دسترسی «report.executive» را مدیر سیستم داد',
      'SALES_REP: دسترسی «crm.lead.convert» را مدیر سیستم گرفت',
    ]));
    // Another organisation's grant, in the same installation, is not this one's to read.
    await prisma.roleGrant.create({ data: { organizationId: 'org-elsewhere', roleCode: 'VIEWER', permissions: ['report.read'], grantedById: 'someone' } });
    const { registerRuleSets } = await import('../src/workflow/rules.js');
    const v = await registerRuleSets(prisma, undefined, 'test: another organisation');
    const row = expectOk(await get(`/rules/versions/${v.permissions}`, T.admin), 'version');
    const orgs = Object.keys(row.snapshot['~organisations']);
    expect(orgs).toHaveLength(1);
    expect(orgs).not.toContain('org-elsewhere');
    const after = expectOk(await get('/rules/diff', T.admin, { kind: 'permissions' }), 'diff after');
    expect(after.changes).toEqual([]);
    await prisma.roleGrant.deleteMany({ where: { organizationId: 'org-elsewhere' } });
  });

  it('keeps who granted what as history, and returns a role to its default when asked', async () => {
    expectOk(await put('/roles/SALES_REP/permissions', T.admin, { permissions: ROLE_PERMISSIONS.SALES_REP }), 'back to default');
    const history = expectOk(await get('/roles/SALES_REP/grants', T.admin), 'history');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ supersededAt: null, grantedBy: { fullName: 'مدیر سیستم' } });
    expect(history[1].supersededAt).not.toBeNull();
    const rep = expectOk(await get('/roles', T.admin), 'roles').find((r: any) => r.code === 'SALES_REP');
    expect(rep).toMatchObject({ differsFromDefault: false, review: { grantedBy: { fullName: 'مدیر سیستم' } } });
    expect((await get('/roles/SALES_REP/grants', await login('sales@hiva.local'))).status).toBe(403);
    expect((await get('/roles', T.pmo)).status).toBe(200);
  });

  it('honours a delegation only for what the delegator’s role still grants', async () => {
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const sales = await prisma.user.findFirstOrThrow({ where: { email: 'sales@hiva.local' } });
    const pmoRole = await prisma.userRole.findFirstOrThrow({ where: { userId: pmo.id }, include: { role: true } });
    await prisma.delegation.create({ data: {
      organizationId: pmo.organizationId, fromUserId: pmo.id, toUserId: sales.id, permissions: ['rules.manage'], roles: [],
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 86_400_000), reason: 'آزمون واگذاری', createdById: pmo.id,
    } });
    const held = expectOk(await get('/auth/me', await login('sales@hiva.local')), 'delegate');
    expect(held.permissions).toContain('rules.manage');
    expectOk(await put(`/roles/${pmoRole.role.code}/permissions`, T.admin, { permissions: ROLE_PERMISSIONS[pmoRole.role.code as 'PMO_MANAGER'].filter((p) => p !== 'rules.manage') }), 'take from pmo');
    forgetGrants(pmo.organizationId);
    const lost = expectOk(await get('/auth/me', await login('sales@hiva.local')), 'delegate after');
    expect(lost.permissions).not.toContain('rules.manage');
  });
});
