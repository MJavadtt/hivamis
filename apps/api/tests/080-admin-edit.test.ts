import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ROLE_PERMISSIONS, adminEditSchema, createProjectSchema, createTaskSchema } from '@hiva/contracts';
import { forgetGrants } from '../src/auth/grants.js';
import { closeApp, expectOk, login, patch, post } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * The owner (2026-10-30): "I still cannot change much in many sections — I cannot change a project's
 * account owner. I said that as system administrator I want to change every single part." The system
 * administrator edits every field a record was made with — those the ordinary edit locks afterwards
 * included — and what the process sets on it later; nobody else does, and every change is on the record.
 */
describe('The system administrator edits every part of a record (owner’s instruction, 2026-10-30)', () => {
  let T: Record<string, string>;
  let ids: Record<string, string>;
  let companies: { id: string }[];
  beforeAll(async () => {
    T = { admin: await login('admin@hiva.local'), account: await login('account.manager@hiva.local') };
    const users = await prisma.user.findMany({ where: { email: { in: ['admin@hiva.local', 'account.manager@hiva.local', 'pmo@hiva.local'] } }, select: { id: true, email: true } });
    ids = Object.fromEntries(users.map((u) => [u.email.split('@')[0]!, u.id]));
    companies = await prisma.company.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { legalName: 'asc' }, take: 2 });
  });
  afterAll(closeApp);

  const newProject = async (name: string) => expectOk(await post('/projects', T.admin, {
    name, companyId: companies[0]!.id, accountOwnerId: ids['account.manager'], plannedEnd: '2026-12-01',
  }), 'project');

  it('reads one edit shape: every field optional, a blank clearable, and the parts set later', () => {
    const shape = adminEditSchema('/projects', createProjectSchema).shape;
    expect(Object.keys(shape)).toEqual(expect.arrayContaining(['companyId', 'accountOwnerId', 'legacyRef', 'opportunityId', 'holdReason']));
    expect(adminEditSchema('/projects', createProjectSchema).safeParse({ plannedEnd: null }).success).toBe(true);
    // A field the record must have is never blank.
    expect(adminEditSchema('/projects', createProjectSchema).safeParse({ name: null }).success).toBe(false);
    expect(Object.keys(adminEditSchema('/tasks', createTaskSchema).shape)).toEqual(expect.arrayContaining(['projectId', 'sourceType', 'blockReason']));
  });

  it('changes a project’s account owner, its client, its code from the sheet — and clears a date', async () => {
    const p = await newProject('پروژهٔ ویرایش مدیر سیستم');
    const edited = expectOk(await patch(`/projects/${p.id}`, T.admin, {
      accountOwnerId: ids.pmo, companyId: companies[1]!.id, legacyRef: 'H1001-09', plannedEnd: null,
    }), 'edit');
    expect(edited).toMatchObject({ accountOwnerId: ids.pmo, companyId: companies[1]!.id, legacyRef: 'H1001-09', plannedEnd: null });
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: p.id, action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect(row.actorId).toBe(ids.admin);
    expect((row.before as { companyId: string }).companyId).toBe(companies[0]!.id);
  });

  it('moves a task to another project', async () => {
    const [a, b] = [await newProject('پروژهٔ یکم وظیفه'), await newProject('پروژهٔ دوم وظیفه')];
    const task = expectOk(await post('/tasks', T.admin, { projectId: a.id, title: 'وظیفهٔ جابه‌جا', departmentCode: 'CR', sourceType: 'TASK', sourceRef: 'آزمون' }), 'task');
    expect(expectOk(await patch(`/tasks/${task.id}`, T.admin, { projectId: b.id }), 'move').projectId).toBe(b.id);
  });

  // The owner (2026-11-17; ADR-134): «همکاران اکانت همگی امکان ویرایش هرچیزی را داشته باشند» — account
  // edits every part too (record.edit_all); a role without it keeps the ordinary edit.
  it('gives account every part as well; a role without record.edit_all keeps the ordinary edit', async () => {
    const p = await newProject('پروژهٔ ویرایش اکانت');
    const edited = expectOk(await patch(`/projects/${p.id}`, T.account, { companyId: companies[1]!.id, accountOwnerId: ids.pmo, legacyRef: 'H9-01' }), 'edit');
    expect(edited).toMatchObject({ companyId: companies[1]!.id, accountOwnerId: ids.pmo, legacyRef: 'H9-01' });

    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' } });
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const before = await prisma.roleGrant.findFirst({ where: { organizationId: admin.organizationId, roleCode: 'PMO_MANAGER', supersededAt: null } });
    await prisma.roleGrant.create({ data: { organizationId: admin.organizationId, roleCode: 'PMO_MANAGER', permissions: [...ROLE_PERMISSIONS.PMO_MANAGER, 'project.write'], grantedById: admin.id } });
    try {
      forgetGrants();
      const q = await newProject('پروژهٔ ویرایش عادی');
      const asPmo = await login(pmo.email);
      const ordinary = expectOk(await patch(`/projects/${q.id}`, asPmo, { companyId: companies[1]!.id, legacyRef: 'H9-02' }), 'ordinary');
      expect(ordinary).toMatchObject({ companyId: companies[0]!.id, legacyRef: null });
    } finally {
      await prisma.roleGrant.deleteMany({ where: { organizationId: admin.organizationId, roleCode: 'PMO_MANAGER', ...(before ? { createdAt: { gt: before.createdAt } } : {}) } });
      forgetGrants();
    }
  });

  it('still keeps the state for the workflow, and the record inside the organisation', async () => {
    const p = await newProject('پروژهٔ وضعیت');
    expect(expectOk(await patch(`/projects/${p.id}`, T.admin, { state: 'CLOSED' }), 'edit').state).toBe('DRAFT');
    const res = await patch(`/projects/${p.id}`, T.admin, { companyId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
