import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminEditSchema, createProjectSchema, createTaskSchema } from '@hiva/contracts';
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

  it('leaves the ordinary edit as it was for everyone else: the client stays, the account owner moves', async () => {
    const p = await newProject('پروژهٔ ویرایش عادی');
    const edited = expectOk(await patch(`/projects/${p.id}`, T.account, { companyId: companies[1]!.id, accountOwnerId: ids.pmo, legacyRef: 'H9-01' }), 'edit');
    expect(edited).toMatchObject({ companyId: companies[0]!.id, accountOwnerId: ids.pmo, legacyRef: null });
  });

  it('still keeps the state for the workflow, and the record inside the organisation', async () => {
    const p = await newProject('پروژهٔ وضعیت');
    expect(expectOk(await patch(`/projects/${p.id}`, T.admin, { state: 'CLOSED' }), 'edit').state).toBe('DRAFT');
    const res = await patch(`/projects/${p.id}`, T.admin, { companyId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
