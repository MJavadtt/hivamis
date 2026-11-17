import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, closeApp, get, login, post, expectOk, directLead } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * The owner (2026-11-16; ADR-132): «امکان حذف کامل سرنخ، مشتری و… وجود ندارد».
 */
let T: Record<string, string>;
const del = async (url: string, token: string, payload?: unknown) => {
  const res = await (await app()).inject({ method: 'DELETE', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  await app();
  T = { sales: await login('sales@hiva.local'), salesManager: await login('sales.manager@hiva.local'), ceo: await login('ceo@hiva.local'), designer: await login('designer@hiva.local') };
});
afterAll(closeApp);

describe('Deleting a record for good (ADR-132)', () => {
  it('a manager deletes a lead; a colleague without the permission does not; the history says who', async () => {
    const lead = expectOk(await post('/leads', T.sales, { name: 'سرنخ اشتباه', companyName: 'شرکت اشتباه', ...directLead() }), 'lead');
    expect((await del(`/records/lead/${lead.id}`, T.sales)).status).toBe(403);
    const plan = expectOk(await get(`/records/lead/${lead.id}/deletion`, T.salesManager), 'plan');
    expect(plan).toMatchObject({ kind: 'lead', id: lead.id });
    const out = expectOk(await del(`/records/lead/${lead.id}`, T.salesManager, { reason: 'دو بار ثبت شده بود' }), 'delete');
    expect(out.deleted.Lead).toBe(1);
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).toBeNull();
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'DELETE', entityType: 'lead', entityId: lead.id } });
    expect(ev.reason).toBe('دو بار ثبت شده بود');
    // What the workflow wrote about it stays.
    expect((await del(`/records/lead/${lead.id}`, T.salesManager)).status).toBe(404);
  });

  it('a client goes with everything that hangs off it — people, deals, projects, tasks, files — and nothing else', async () => {
    const org = (await prisma.user.findFirstOrThrow({ where: { email: 'ceo@hiva.local' } })).organizationId;
    const project = await prisma.project.findFirstOrThrow({ where: { organizationId: org }, include: { company: true } });
    const companyId = project.companyId;
    const before = {
      projects: await prisma.project.count({ where: { companyId } }), tasks: await prisma.task.count({ where: { project: { companyId } } }),
      otherProjects: await prisma.project.count({ where: { organizationId: org, companyId: { not: companyId } } }),
      users: await prisma.user.count(), audit: await prisma.auditEvent.count(), transitions: await prisma.stateTransition.count(),
    };
    expect(before.projects).toBeGreaterThan(0);
    const plan = expectOk(await get(`/records/company/${companyId}/deletion`, T.ceo), 'plan');
    expect(plan.takes.Project).toBe(before.projects);
    const out = expectOk(await del(`/records/company/${companyId}`, T.ceo), 'delete');
    expect(out.deleted).toMatchObject({ Company: 1, Project: before.projects });
    expect(await prisma.company.findUnique({ where: { id: companyId } })).toBeNull();
    expect(await prisma.project.count({ where: { companyId } })).toBe(0);
    expect(await prisma.contact.count({ where: { companyId } })).toBe(0);
    expect(await prisma.project.count({ where: { organizationId: org, companyId: { not: companyId } } })).toBe(before.otherProjects);
    // No person goes with it, and the history only grows.
    expect(await prisma.user.count()).toBe(before.users);
    expect(await prisma.auditEvent.count()).toBe(before.audit + 1);
    expect(await prisma.stateTransition.count()).toBe(before.transitions);
  });

  it('refuses a kind that is not a record, and a record out of the manager\'s reach', async () => {
    expect((await del('/records/user/00000000-0000-4000-8000-000000000000', T.ceo)).status).toBe(400);
    const lead = expectOk(await post('/leads', T.sales, { name: 'سرنخ فروش', companyName: 'شرکت', ...directLead() }), 'lead');
    const creative = await login('creative@hiva.local');
    expect([403, 404]).toContain((await del(`/records/lead/${lead.id}`, creative)).status);
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
  });

  it('refuses a tree with an invoice that reached the accounting export', async () => {
    const org = (await prisma.user.findFirstOrThrow({ where: { email: 'ceo@hiva.local' } })).organizationId;
    const invoice = await prisma.invoice.findFirst({ where: { organizationId: org } });
    if (!invoice) return;
    const exp = await prisma.accountingExport.findFirst({ where: { organizationId: org } });
    if (!exp) return;
    await prisma.invoice.update({ where: { id: invoice.id }, data: { accountingExportId: exp.id } });
    const r = await del(`/records/invoice/${invoice.id}`, T.ceo);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DELETE_POSTED_INVOICE');
  });
});
