import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, get, login, post, expectOk, directLead } from './helpers.js';
import { prisma } from '../src/db.js';
import { run } from '../src/cli.js';
import { KEEP_PEOPLE, WIPED_KEEPING_PEOPLE, freshStartKeepingPeople, planFreshStart } from '../src/setup/reset.js';

/**
 * The owner (2026-11-14; ADR-130): «کاربران (همکاران) را نگه‌دار، تمام اطلاعات مربوط به مشتریان و
 * پروژه‌ها را پاک کن، باید همه چیز را کاربران از اول خودشان وارد کنند» — and keep the suppliers and
 * the marketers and referring companies.
 */
describe('A fresh start that keeps every colleague (ADR-130)', () => {
  let orgId: string;
  const before: Record<string, number> = {};
  let avatarId: string;

  beforeAll(async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' } });
    orgId = admin.organizationId;
    await prisma.organization.update({ where: { id: orgId }, data: { slug: 'hiva' } });
    // What the work made, beside what the seed made: a lead, a supplier, a referrer, a photo.
    const token = await login('sales@hiva.local');
    expectOk(await post('/leads', token, { name: 'سرنخ پیش از شروع تازه', companyName: 'شرکت پیشین', ...directLead() }), 'lead');
    await prisma.supplier.create({ data: { organizationId: orgId, name: 'چاپخانهٔ آزمون', kind: 'PRINT' } });
    await prisma.leadReferrer.create({ data: { organizationId: orgId, kind: 'MARKETER', name: 'بازاریاب آزمون', createdById: admin.id } });
    await get('/invoice-sellers', await login('finance@hiva.local'));
    const avatar = await prisma.document.create({
      data: { organizationId: orgId, fileName: 'me.png', storedName: `avatar-${Date.now()}.png`, mimeType: 'image/png', sizeBytes: 10, uploadedById: admin.id },
    });
    avatarId = avatar.id;
    await prisma.user.update({ where: { id: admin.id }, data: { avatarDocumentId: avatar.id } });
    for (const m of ['user', 'userRole', 'department', 'role', 'supplier', 'leadReferrer', 'invoiceSeller', 'auditEvent', 'stateTransition', 'counter', 'session'] as const) {
      before[m] = await (prisma[m] as unknown as { count(a?: unknown): Promise<number> }).count();
    }
  });
  afterAll(closeApp);

  it('keeps the people, what the organisation is, the lists the owner named and the history; empties the work', () => {
    for (const m of ['User', 'UserRole', 'Session', 'Department', 'Role', 'Supplier', 'SupplierEvaluation', 'LeadReferrer', 'InvoiceSeller', 'AuditEvent', 'StateTransition', 'Counter']) expect(KEEP_PEOPLE.has(m), m).toBe(true);
    for (const m of ['Company', 'Contact', 'Lead', 'Opportunity', 'Brief', 'Proposal', 'Project', 'Task', 'Contract', 'Invoice', 'Payment', 'Document', 'Venue', 'SiteProject', 'ChatMessage', 'Notification', 'AiConversation', 'StepBackRequest']) {
      expect(WIPED_KEEPING_PEOPLE, m).toContain(m);
    }
  });

  it('says what it would delete, done by a system administrator alone', async () => {
    const plan = await planFreshStart(orgId, 'admin@hiva.local');
    expect(plan.records.Company).toBeGreaterThan(0);
    expect(plan.records.Lead).toBeGreaterThan(0);
    expect(plan.people).toBe(await prisma.user.count({ where: { organizationId: orgId, deletedAt: null } }));
    const dry = await run(['org:reset', '--slug', 'hiva', '--keep-people', '--as', 'admin@hiva.local']) as { dryRun: boolean };
    expect(dry.dryRun).toBe(true);
    expect(await prisma.company.count({ where: { organizationId: orgId } })).toBe(plan.records.Company);
    await expect(planFreshStart(orgId, 'ceo@hiva.local')).rejects.toMatchObject({ code: 'NOT_A_SYSTEM_ADMIN' });
  });

  it('starts the work anew: every colleague signs in as before, and finds nothing of the old work', async () => {
    const out = await freshStartKeepingPeople(orgId, 'admin@hiva.local');
    expect(out.deleted.Company).toBeGreaterThan(0);
    expect(await prisma.notification.count({ where: { user: { organizationId: orgId } } })).toBe(0);
    for (const m of ['company', 'contact', 'lead', 'opportunity', 'project', 'task', 'contract', 'invoice', 'document'] as const) {
      if (m === 'document') { expect(await prisma.document.count({ where: { organizationId: orgId } })).toBe(1); continue; }
      expect([m, await (prisma[m] as unknown as { count(a: unknown): Promise<number> }).count({ where: { organizationId: orgId } })]).toEqual([m, 0]);
    }
    for (const m of ['user', 'userRole', 'department', 'role', 'supplier', 'leadReferrer', 'invoiceSeller', 'stateTransition', 'counter', 'session'] as const) {
      expect([m, await (prisma[m] as unknown as { count(a?: unknown): Promise<number> }).count()]).toEqual([m, before[m]]);
    }
    // The history only grows: the fresh start is in it, by name.
    expect(await prisma.auditEvent.count()).toBe(before.auditEvent! + 1);
    expect(await prisma.auditEvent.findFirst({ where: { organizationId: orgId, action: 'ORGANIZATION_FRESH_START' } })).not.toBeNull();
    // A person's photo stays theirs.
    expect(await prisma.document.findUnique({ where: { id: avatarId } })).not.toBeNull();
    expect((await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' } })).avatarDocumentId).toBe(avatarId);

    // Everyone signs in with what they had, and their queue is empty.
    const sales = await login('sales@hiva.local');
    expect(expectOk(await get('/me/work', sales), 'work').items).toEqual([]);
    expect(expectOk(await get('/leads', sales), 'leads').items ?? []).toEqual([]);
    // And enters the work anew.
    expectOk(await post('/leads', sales, { name: 'نخستین سرنخ تازه', companyName: 'شرکت تازه', ...directLead() }), 'new lead');
  });
});
