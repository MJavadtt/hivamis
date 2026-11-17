import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ROLE_PERMISSIONS, SYSTEM_ADMIN_PERMISSIONS } from '@hiva/contracts';
import { app, closeApp, get, login, patch, post, expectOk, upload, tinyPdf, directLead } from './helpers.js';
import { prisma } from '../src/db.js';
import { run } from '../src/cli.js';

/**
 * The owner (2026-11-17; ADR-134): every account colleague may edit anything; a form's files are
 * attached while it is filled in; every colleague may write notes on every record, with files or
 * instead of them.
 */
let T: Record<string, string>;
const del = async (url: string, token: string) => {
  const res = await (await app()).inject({ method: 'DELETE', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, body: res.json() };
};
const pdf = () => ({ name: 'note.pdf', type: 'application/pdf', content: tinyPdf('note') });

beforeAll(async () => {
  await app();
  T = {
    sales: await login('sales@hiva.local'), account: await login('account@hiva.local'), designer: await login('designer@hiva.local'),
    admin: await login('admin@hiva.local'), salesManager: await login('sales.manager@hiva.local'),
  };
});
afterAll(closeApp);

describe('Account colleagues edit anything (ADR-134)', () => {
  it('an account executive edits every record it sees, and sees them all — creating, approving and signing stay each role\'s own', () => {
    const exec = ROLE_PERMISSIONS.ACCOUNT_EXEC;
    for (const p of ['record.edit_all', 'record.see_all', 'crm.lead.read', 'crm.company.read', 'task.read', 'project.read']) expect(exec, p).toContain(p);
    // Doc_H's separation of duties (Rules 2 and 9).
    for (const p of ['crm.lead.write', 'crm.lead.convert', 'qc.final', 'finance.settle', 'contract.sign', ...SYSTEM_ADMIN_PERMISSIONS]) expect(exec, p).not.toContain(p);
    expect(ROLE_PERMISSIONS.ACCOUNT_MANAGER).toContain('record.edit_all');
  });

  it('edits every field of a colleague\'s client, as the system administrator can', async () => {
    const c = expectOk(await post('/companies', T.salesManager, { legalName: 'شرکت ویرایش اکانت' }), 'company');
    const out = expectOk(await patch(`/companies/${c.id}`, T.account, { legalName: 'شرکت ویرایش‌شده', nationalId: '10101010101' }), 'edit');
    expect(out).toMatchObject({ legalName: 'شرکت ویرایش‌شده', nationalId: '10101010101' });
  });

  it('edits a lead though it may not register one', async () => {
    const lead = expectOk(await post('/leads', T.sales, { name: 'سرنخ برای اکانت', companyName: 'شرکت', ...directLead() }), 'lead');
    expect((await post('/leads', T.account, { name: 'ثبت اکانت', companyName: 'شرکت', ...directLead() })).status).toBe(403);
    expect(expectOk(await patch(`/leads/${lead.id}`, T.account, { companyName: 'شرکت درست‌شده' }), 'edit lead').companyName).toBe('شرکت درست‌شده');
    expect((await patch(`/leads/${lead.id}`, T.designer, { companyName: 'نه' })).status).toBe(403);
  });

  it('a saved permission set gains the new defaults by command, as a new version, nothing taken away', async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' } });
    await prisma.roleGrant.create({ data: { organizationId: admin.organizationId, roleCode: 'ACCOUNT_EXEC', permissions: ['task.read', 'chat.use', 'form.read'], grantedById: admin.id } });
    const dry = await run(['roles:add-defaults', '--role', 'ACCOUNT_EXEC', '--as', 'admin@hiva.local']) as { dryRun: boolean; adding: string[] };
    expect(dry.dryRun).toBe(true);
    expect(dry.adding).toContain('record.edit_all');
    const done = await run(['roles:add-defaults', '--role', 'ACCOUNT_EXEC', '--as', 'admin@hiva.local', '--commit']) as { added: string[] };
    expect(done.added).toContain('record.edit_all');
    const live = await prisma.roleGrant.findFirstOrThrow({ where: { organizationId: admin.organizationId, roleCode: 'ACCOUNT_EXEC', supersededAt: null } });
    expect(live.permissions).toEqual(expect.arrayContaining(['task.read', 'chat.use', 'form.read', 'record.edit_all', 'record.see_all', 'crm.lead.read']));
    await expect(run(['roles:add-defaults', '--role', 'ACCOUNT_EXEC', '--as', 'sales@hiva.local'])).rejects.toMatchObject({ code: 'NOT_SYSTEM_ADMIN' });
  });
});

describe('Notes on every record, for every colleague (ADR-134)', () => {
  it('a note, a note with a file, and a file\'s own place — read by whoever sees the record, taken back by its writer', async () => {
    const lead = expectOk(await post('/leads', T.sales, { name: 'سرنخ یادداشت', companyName: 'شرکت یادداشت', ...directLead() }), 'lead');
    const target = { recordType: 'lead', recordId: lead.id };
    const plain = expectOk(await post('/notes', T.sales, { ...target, body: 'مشتری فردا تماس می‌گیرد' }), 'note');
    const file = expectOk(await upload(T.sales, pdf(), target), 'file');
    const withFile = expectOk(await post('/notes', T.sales, { ...target, body: '', documentIds: [file.id] }), 'file note');
    expect((await post('/notes', T.sales, { ...target, body: '' })).status).toBe(400);

    const notes = expectOk(await get('/notes', T.salesManager, target), 'list');
    expect(notes.map((n: any) => n.id)).toEqual([withFile.id, plain.id]);
    expect(notes[0].documents.map((d: any) => d.id)).toEqual([file.id]);
    expect(notes[0].mayDelete).toBe(false);
    // The manager writes too; a colleague who does not see the lead does neither.
    expectOk(await post('/notes', T.salesManager, { ...target, body: 'پیگیری شود' }), 'manager note');
    expect((await get('/notes', T.designer, target)).status).toBe(404);
    expect((await post('/notes', T.designer, { ...target, body: 'x' })).status).toBe(404);

    expect((await del(`/notes/${plain.id}`, T.salesManager)).status).toBe(403);
    expectOk(await del(`/notes/${plain.id}`, T.sales), 'take back');
    expect(await prisma.comment.findUnique({ where: { id: plain.id } })).toBeNull();
    // Its file stays on the lead.
    expect(await prisma.document.findUnique({ where: { id: file.id } })).not.toBeNull();
  });

  it('on a client and a project by their own columns, and refused for a file not one\'s own', async () => {
    const org = (await prisma.user.findFirstOrThrow({ where: { email: 'account@hiva.local' } })).organizationId;
    const project = await prisma.project.findFirstOrThrow({ where: { organizationId: org } });
    expectOk(await post('/notes', T.account, { projectId: project.id, body: 'جلسهٔ شروع پروژه هماهنگ شد' }), 'project note');
    expect((expectOk(await get('/notes', T.account, { projectId: project.id }), 'project notes') as unknown[]).length).toBeGreaterThan(0);
    const other = expectOk(await upload(T.salesManager, pdf(), {}), 'someone else\'s file');
    expect((await post('/notes', T.account, { projectId: project.id, body: 'x', documentIds: [other.id] })).status).toBe(400);
    expect((await get('/notes', T.account, {})).status).toBe(400);
  });

  it('goes with its record when the record is deleted for good', async () => {
    const lead = expectOk(await post('/leads', T.sales, { name: 'سرنخ رفتنی', companyName: 'شرکت', ...directLead() }), 'lead');
    const n = expectOk(await post('/notes', T.sales, { recordType: 'lead', recordId: lead.id, body: 'یادداشت' }), 'note');
    expectOk(await del(`/records/lead/${lead.id}`, T.salesManager), 'delete');
    expect(await prisma.comment.findUnique({ where: { id: n.id } })).toBeNull();
  });
});

describe('A form\'s files, attached while it is filled in (ADR-134)', () => {
  it('go up before the form is saved and belong to it once it is', async () => {
    const file = expectOk(await upload(T.sales, pdf(), {}), 'file');
    const s = expectOk(await post('/forms/submissions', T.sales, {
      formCode: 'A01_LEAD', data: { name: 'سرنخ با پیوست فرم', companyName: 'شرکت پیوست', phone: '۰۹۳۵ ۲۲۲ ۹۹۸۸', source: 'DIRECT', sourceChannel: 'PHONE', attachments: [file.id] },
    }), 'form');
    expect((await prisma.document.findUniqueOrThrow({ where: { id: file.id } })).submissionId).toBe(s.id);
    const listed = expectOk(await get('/documents', T.sales, { submissionId: s.id }), 'files');
    expect(listed.map((d: any) => d.id)).toEqual([file.id]);
    // Another's file, named in a form, is not taken.
    const theirs = expectOk(await upload(T.salesManager, pdf(), {}), 'theirs');
    const s2 = expectOk(await post('/forms/submissions', T.sales, {
      formCode: 'A01_LEAD', data: { name: 'سرنخ دوم', companyName: 'شرکت', phone: '۰۹۳۵ ۲۲۲ ۹۹۷۷', source: 'DIRECT', sourceChannel: 'PHONE', attachments: [theirs.id] },
    }), 'form 2');
    expect((await prisma.document.findUniqueOrThrow({ where: { id: theirs.id } })).submissionId).toBeNull();
    expect(s2.id).toBeTruthy();
  });
});
