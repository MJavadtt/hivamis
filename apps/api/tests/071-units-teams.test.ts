import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call, closeApp, expectOk, get, login, patch, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { syncOrganization } from '../src/setup/reference.js';

/**
 * List 3, item 6 — the units the organisation runs. Doc_H's ten units stay what the process routes to;
 * the organisation renames them (and keeps the names through an upgrade), chooses each one's manager,
 * and divides a unit into teams: «split Creative» is Creative with «طراحی» and «ویدئو» inside it.
 */
describe('Units and teams', () => {
  let T: Record<string, string>;
  let id: Record<string, string>;
  let orgId: string;

  beforeAll(async () => {
    T = { admin: await login('admin@hiva.local'), designer: await login('designer@hiva.local') };
    const users = await prisma.user.findMany({ where: { email: { in: ['designer@hiva.local', 'creative@hiva.local', 'sales@hiva.local'] } }, select: { id: true, email: true, organizationId: true } });
    id = Object.fromEntries(users.map((u) => [u.email.split('@')[0]!, u.id]));
    orgId = users[0]!.organizationId;
  });
  afterAll(closeApp);

  it('renames a unit, keeps the name through an upgrade, and goes back to the code’s on request', async () => {
    expect((await patch('/departments/CR', T.designer, { nameFa: 'خلاقه' })).status).toBe(403);
    expectOk(await patch('/departments/CR', T.admin, { nameFa: 'خلاقه', nameEn: 'Creative studio' }), 'rename');
    await syncOrganization(prisma, orgId);
    let cr = await prisma.department.findFirstOrThrow({ where: { organizationId: orgId, code: 'CR' } });
    expect(cr).toMatchObject({ nameFa: 'خلاقه', nameEn: 'Creative studio', namesOwned: true });
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'department', entityId: cr.id }, orderBy: { createdAt: 'desc' } });
    expect(row.after).toMatchObject({ nameFa: 'خلاقه' });

    expectOk(await patch('/departments/CR', T.admin, { nameFa: null }), 'reset');
    cr = await prisma.department.findFirstOrThrow({ where: { organizationId: orgId, code: 'CR' } });
    expect(cr.namesOwned).toBe(false);
    expect(cr.nameFa).not.toBe('خلاقه');
  });

  it('chooses a unit’s manager from its own people', async () => {
    expect((await patch('/departments/CR', T.admin, { managerId: id.sales })).body.error.code).toBe('MANAGER_NOT_IN_UNIT');
    expectOk(await patch('/departments/CR', T.admin, { managerId: id.creative }), 'manager');
    const units = expectOk(await get('/departments', T.designer), 'units') as { code: string; manager: { fullName: string } | null }[];
    expect(units.find((u) => u.code === 'CR')!.manager?.fullName).toBe('سپیده آذر');
  });

  it('divides Creative into teams, puts people in them, and keeps each team inside its unit', async () => {
    const design = expectOk(await post('/teams', T.admin, { departmentCode: 'CR', nameFa: 'طراحی', nameEn: 'Design', leadId: id.designer, color: '#9333ea' }), 'team');
    expect((await post('/teams', T.admin, { departmentCode: 'CR', nameFa: 'طراحی' })).body.error.code).toBe('TEAM_EXISTS');
    expect((await post('/teams', T.admin, { departmentCode: 'CR', nameFa: 'ویدئو', leadId: id.sales })).body.error.code).toBe('LEAD_NOT_IN_UNIT');
    const video = expectOk(await post('/teams', T.admin, { departmentCode: 'CR', nameFa: 'ویدئو', nameEn: 'Video' }), 'video');
    expect((await post('/teams', T.designer, { departmentCode: 'CR', nameFa: 'عکاسی' })).status).toBe(403);

    // A designer in Design; a salesperson in nothing of Creative's.
    expectOk(await patch(`/users/${id.designer}`, T.admin, { teamId: design.id }), 'assign');
    expect((await patch(`/users/${id.sales}`, T.admin, { teamId: video.id })).body.error.code).toBe('TEAM_NOT_IN_UNIT');
    expect((await patch(`/users/${id.sales}`, T.admin, { teamId: '00000000-0000-4000-8000-000000000000' })).body.error.code).toBe('TEAM_NOT_IN_UNIT');
    // The database refuses it too, whatever writes it.
    await expect(prisma.user.update({ where: { id: id.sales }, data: { teamId: video.id } })).rejects.toThrow(/team must be an open team of their own unit/);

    const people = expectOk(await get('/people', T.designer, { q: 'بهراد' }), 'people') as { team: { nameFa: string } | null }[];
    expect(people[0]!.team?.nameFa).toBe('طراحی');
    const teams = expectOk(await get('/teams', T.designer), 'teams') as { nameFa: string; members: number; departmentCode: string; lead: { fullName: string } | null }[];
    expect(teams.find((t) => t.nameFa === 'طراحی')).toMatchObject({ members: 1, departmentCode: 'CR', lead: { fullName: 'بهراد مهرنیا' } });

    // Moving to another unit leaves the old unit's team behind.
    expectOk(await patch(`/users/${id.designer}`, T.admin, { departmentCode: 'ST' }), 'move');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: id.designer } })).teamId).toBeNull();
    expectOk(await patch(`/users/${id.designer}`, T.admin, { departmentCode: 'CR', teamId: design.id }), 'back');

    // Wound up: members released, the team hidden, its record kept.
    const wound = expectOk(await post(`/teams/${design.id}/archive`, T.admin), 'archive');
    expect(wound.membersReleased).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: id.designer } })).teamId).toBeNull();
    expect((expectOk(await get('/teams', T.admin), 'teams') as { id: string }[]).map((t) => t.id)).not.toContain(design.id);
    expect((expectOk(await call('GET', '/teams', { token: T.admin, query: { all: 'true' } }), 'all') as { id: string }[]).map((t) => t.id)).toContain(design.id);
    expect((await patch(`/users/${id.designer}`, T.admin, { teamId: design.id })).body.error.code).toBe('TEAM_NOT_IN_UNIT');
  });
});
