import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, closeApp, get, login, post, move, expectOk, directLead, createContact } from './helpers.js';
import { prisma } from '../src/db.js';
import { nameKey } from '../src/routes/data-review.js';
import { HISTORY_COLUMNS, removeUser } from '../src/auth/remove-user.js';

/**
 * ADR-136: one source of truth across the modules. Every assertion is against the database
 * the routes write to; nothing is mocked.
 */
let T: Record<string, string>;
let org: string;

beforeAll(async () => {
  await app();
  T = { sales: await login('sales@hiva.local'), salesManager: await login('sales.manager@hiva.local'), ceo: await login('ceo@hiva.local'), account: await login('account.manager@hiva.local') };
  org = (await prisma.user.findFirstOrThrow({ where: { email: 'ceo@hiva.local' } })).organizationId;
});
afterAll(closeApp);

const qualifiedLead = async (companyName: string) => {
  const lead = expectOk(await post('/leads', T.sales, { name: companyName, companyName, ...directLead() }), 'lead');
  expectOk(await move('lead', lead.id, 'contact', T.sales), 'contact');
  expectOk(await move('lead', lead.id, 'qualify', T.sales), 'qualify');
  return lead;
};

describe('A lead converts only with its client and opportunity', () => {
  it('the bare state move is refused; it left converted leads tied to no client on the server', async () => {
    const lead = await qualifiedLead('شرکت آزمون تبدیل');
    const bare = await move('lead', lead.id, 'convert', T.salesManager);
    expect(bare.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).state).toBe('QUALIFIED');

    const opp = expectOk(await post(`/leads/${lead.id}/convert`, T.salesManager, {}), 'convert');
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.state).toBe('CONVERTED');
    expect(after.companyId).toBe(opp.companyId);
  });
});

describe('Rejecting a deliverable always leaves a revision to work from', () => {
  it('the deliverable\'s own «QC rejected» button raises the revision it promises, once', async () => {
    const d = await prisma.deliverable.findFirstOrThrow({ where: { organizationId: org } });
    await prisma.deliverable.update({ where: { id: d.id }, data: { state: 'IN_QC' } });
    await prisma.revision.updateMany({ where: { deliverableId: d.id }, data: { state: 'APPROVED' } });
    expectOk(await move('deliverable', d.id, 'qc_reject', T.account, 'رنگ‌ها با راهنمای برند نمی‌خواند'), 'qc_reject');
    const open = await prisma.revision.findMany({ where: { deliverableId: d.id, state: { in: ['REQUESTED', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'IN_QC'] } } });
    expect(open).toHaveLength(1);
    expect(open[0]!.requiredCorrection).toBe('رنگ‌ها با راهنمای برند نمی‌خواند');
    expect(open[0]!.responsibleDepartmentCode).toBe(d.departmentCode);
  });
});

describe('Records point at each other by key, not by name', () => {
  it('the database refuses a unit manager who does not exist, and holds the eleven new links', async () => {
    const ghost = '00000000-0000-4000-8000-000000000999';
    const unit = await prisma.department.findFirstOrThrow({ where: { organizationId: org } });
    await expect(prisma.department.update({ where: { id: unit.id }, data: { managerId: ghost } })).rejects.toThrow();
    const fk = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = current_schema() AND conname IN ('departments_managerId_fkey','handoffs_companyId_fkey','handoffs_contractId_fkey','settlements_projectId_fkey','media_orders_workOrderId_fkey','metro_bookings_ownerId_fkey','signature_signers_contactId_fkey','execution_authorizations_contractId_fkey','execution_authorizations_invoiceId_fkey','supplier_evaluations_projectId_fkey','site_reminders_siteProjectId_fkey')`);
    expect(fk[0]!.n).toBe(11);
  });

  it('a unit\'s manager is history: removing them keeps their name there instead of leaving a dangling id', async () => {
    expect(HISTORY_COLUMNS.some((c) => c.model === 'Department' && c.field === 'managerId')).toBe(true);
    const unit = await prisma.department.findFirstOrThrow({ where: { organizationId: org } });
    const person = await prisma.user.create({ data: { organizationId: org, email: `unit-mgr-${Date.now()}@hiva.local`, fullName: 'مدیر موقت', passwordHash: 'x' } });
    await prisma.department.update({ where: { id: unit.id }, data: { managerId: person.id } });
    const out = await prisma.$transaction((tx) => removeUser(tx, person));
    expect(out).toBe('removed');
    expect((await prisma.department.findUniqueOrThrow({ where: { id: unit.id } })).managerId).toBe(person.id);
    const review = expectOk(await get('/data-review', T.ceo), 'review');
    expect(review.unitsWithoutManager.some((u: { id: string; reason: string }) => u.id === unit.id && u.reason === 'LEFT')).toBe(true);
  });
});

describe('One search across the system', () => {
  it('finds a lead by its phone typed in Persian digits, and a client\'s person by name, each with where it opens', async () => {
    const lead = expectOk(await post('/leads', T.sales, { name: 'سرنخ جستجوی سراسری', companyName: 'شرکت جستجو', ...directLead() }), 'lead');
    const fa = lead.phone.replace(/\d/g, (d: string) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
    const found = expectOk(await get('/search', T.sales, { q: fa }), 'search');
    const leads = found.groups.find((g: { type: string }) => g.type === 'lead');
    expect(leads?.items.some((i: { id: string; href: string }) => i.id === lead.id && i.href.startsWith('/leads?q='))).toBe(true);

    const company = await prisma.company.findFirstOrThrow({ where: { organizationId: org, deletedAt: null } });
    await createContact({ companyId: company.id, fullName: 'نگار جستجوپذیر', phone: '02188776655' });
    const people = expectOk(await get('/search', T.ceo, { q: 'جستجوپذیر' }), 'search');
    const contact = people.groups.find((g: { type: string }) => g.type === 'contact');
    expect(contact?.items[0]).toMatchObject({ title: 'نگار جستجوپذیر', href: `/companies/${company.id}` });
  });

  it('every list finds a record by its code, where the global search sends it', async () => {
    const lead = expectOk(await post('/leads', T.sales, { name: 'سرنخ با کد', companyName: 'شرکت کددار', ...directLead() }), 'lead');
    const list = expectOk(await get('/leads', T.sales, { q: lead.code }), 'list');
    expect(list.items.map((l: { id: string }) => l.id)).toEqual([lead.id]);
  });

  it('keeps to what the caller may read: a designer finds no leads or invoices', async () => {
    const designer = await login('designer@hiva.local');
    const found = expectOk(await get('/search', designer, { q: 'سرنخ' }), 'search');
    expect(found.groups.map((g: { type: string }) => g.type)).not.toContain('lead');
  });
});

describe('The client page holds all the client\'s dealings', () => {
  it('shows the leads it came as and its metro bookings', async () => {
    const lead = await qualifiedLead('شرکت نمای یکپارچه');
    const opp = expectOk(await post(`/leads/${lead.id}/convert`, T.salesManager, {}), 'convert');
    const c360 = expectOk(await get(`/companies/${opp.companyId}/360`, T.ceo), '360');
    expect(c360.services.leads.map((l: { id: string }) => l.id)).toContain(lead.id);
    expect(Array.isArray(c360.services.metroBookings)).toBe(true);
  });
});

describe('Data review flags; a person decides', () => {
  it('names that say the same thing are flagged together, and nothing is merged', async () => {
    expect(nameKey('شركت  هيوا')).toBe(nameKey('هیوا'));
    expect(nameKey('آلفا‌گستر')).toBe(nameKey('آلفاگستر'));
    const a = await prisma.company.create({ data: { organizationId: org, legalName: 'شرکت دوقلوی آزمون' } });
    const b = await prisma.company.create({ data: { organizationId: org, legalName: 'دوقلوي آزمون' } });
    const review = expectOk(await get('/data-review', T.ceo), 'review');
    const group = review.duplicateClients.find((g: { id: string }[]) => g.some((c) => c.id === a.id));
    expect(group.map((c: { id: string }) => c.id)).toContain(b.id);
    expect(await prisma.company.count({ where: { id: { in: [a.id, b.id] }, deletedAt: null } })).toBe(2);
  });

  it('a lead named like a client is offered the client; linking it is the person\'s act, and recorded', async () => {
    const company = await prisma.company.create({ data: { organizationId: org, legalName: 'شرکت پیوندپذیر' } });
    const lead = expectOk(await post('/leads', T.sales, { name: 'پیوندپذیر', companyName: 'پیوندپذیر', ...directLead() }), 'lead');
    const review = expectOk(await get('/data-review', T.ceo), 'review');
    const row = review.unlinkedLeads.find((l: { id: string }) => l.id === lead.id);
    expect(row.candidates.map((c: { id: string }) => c.id)).toContain(company.id);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).companyId).toBeNull();

    const designer = await login('designer@hiva.local');
    expect((await post(`/data-review/leads/${lead.id}/link`, designer, { companyId: company.id })).status).toBe(403);
    expectOk(await post(`/data-review/leads/${lead.id}/link`, T.sales, { companyId: company.id }), 'link');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).companyId).toBe(company.id);
    expect(await prisma.auditEvent.count({ where: { entityType: 'lead', entityId: lead.id, action: 'UPDATE', reason: { contains: 'بازبینی داده' } } })).toBe(1);
    expect((await post(`/data-review/leads/${lead.id}/link`, T.sales, { companyId: company.id })).status).toBe(409);
  });
});
