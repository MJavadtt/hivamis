import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call, closeApp, get, login, tinyPdf, upload } from './helpers.js';
import { prisma } from '../src/db.js';
import { tenancy } from '../src/lib/tenant.js';
import { nextCode } from '../src/lib/codes.js';
import { twoOrgs, type TwoOrgs } from './helpers/two-orgs.js';

/**
 * ADR-121 (the owner, 2026-11-06): any record can hold files — a lead, a task, an invoice, a risk…
 * A file sits on its record alone, in its own organisation, and is read as the record is: everyone who
 * may read files does not thereby read an invoice's, and a private booking's stay with those who see it.
 */
const pdf = { name: 'evidence.pdf', type: 'application/pdf', content: tinyPdf() };

describe('Files on any record (ADR-121)', () => {
  let orgs: TwoOrgs;
  let theirLead: { id: string };
  let ourLead: { id: string };

  beforeAll(async () => {
    orgs = await twoOrgs();
    theirLead = await prisma.lead.findFirstOrThrow({ where: { organizationId: orgs.b.id } });
    ourLead = await prisma.lead.create({ data: { organizationId: orgs.a.id, code: `LEAD-F${Math.floor(Math.random() * 1e6)}`, name: 'سرنخ با فایل', companyName: 'شرکت', phone: '09120000001', source: 'DIRECT', sourceChannel: 'PHONE', state: 'NEW' } });
  }, 120_000);
  afterAll(async () => { tenancy.mode = 'single'; await closeApp(); });

  it('files a document on a record and lists it there', async () => {
    const res = await upload(orgs.a.full.token, pdf, { recordType: 'lead', recordId: ourLead.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ recordType: 'lead', recordId: ourLead.id });
    const list = await get('/documents', orgs.a.full.token, { recordType: 'lead', recordId: ourLead.id });
    expect(list.body.map((d: { id: string }) => d.id)).toEqual([res.body.id]);
  });

  it('refuses another organisation’s record with the same answer as no record at all', async () => {
    const foreign = await upload(orgs.a.full.token, pdf, { recordType: 'lead', recordId: theirLead.id });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe('UNKNOWN_REFERENCE');
    const missing = await upload(orgs.a.full.token, pdf, { recordType: 'lead', recordId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.body.error.code).toBe('UNKNOWN_REFERENCE');
    expect(await prisma.document.count({ where: { recordId: theirLead.id } })).toBe(0);
  });

  it('keeps a record’s file to that record, and refuses what is not a record', async () => {
    const project = await prisma.project.findFirst({ where: { organizationId: orgs.a.id } });
    if (project) {
      const both = await upload(orgs.a.full.token, pdf, { recordType: 'lead', recordId: ourLead.id, projectId: project.id });
      expect(both.body.error.code).toBe('RECORD_FILE_ALONE');
    }
    expect((await upload(orgs.a.full.token, pdf, { recordType: 'nonsense', recordId: ourLead.id })).status).toBe(400);
    expect((await upload(orgs.a.full.token, pdf, { recordType: 'lead' })).status).toBe(400);
  });
});

describe('A record’s file is read as the record is (ADR-121)', () => {
  const T: Record<string, string> = {};
  let orgId: string;

  beforeAll(async () => {
    T.finance = await login('finance@hiva.local');
    T.sales = await login('sales@hiva.local');
    T.designer = await login('designer@hiva.local');
    T.admin = await login('admin@hiva.local');
    orgId = (await prisma.user.findFirstOrThrow({ where: { email: 'finance@hiva.local' } })).organizationId;
  }, 60_000);
  afterAll(closeApp);

  it('keeps an invoice’s file from someone who may read files but not invoices', async () => {
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { organizationId: orgId } });
    const res = await upload(T.finance, pdf, { recordType: 'invoice', recordId: invoice.id });
    expect(res.status).toBe(201);
    const id = res.body.id as string;

    const finance = await get('/documents', T.finance, { recordType: 'invoice', recordId: invoice.id });
    expect(finance.body.map((d: { id: string }) => d.id)).toContain(id);
    // Sales may read files, not invoices: the list, the file and its versions are as if it were not there.
    const sales = await get('/documents', T.sales, { recordType: 'invoice', recordId: invoice.id });
    expect(sales.status).toBe(200);
    expect(sales.body).toEqual([]);
    expect((await get('/documents', T.sales)).body.map((d: { id: string }) => d.id)).not.toContain(id);
    for (const path of ['download', 'preview', 'versions']) {
      expect((await call('GET', `/documents/${id}/${path}`, { token: T.sales })).status).toBe(404);
    }
    // Nor may they attach to what they cannot read.
    expect((await upload(T.sales, pdf, { recordType: 'invoice', recordId: invoice.id })).status).toBe(403);
  });

  it('keeps a private booking’s file with those who see the booking', async () => {
    const organizer = await prisma.user.findFirstOrThrow({ where: { email: 'finance@hiva.local' } });
    const start = new Date(Date.now() + 86_400_000);
    const booking = await prisma.booking.create({
      data: {
        organizationId: orgId, code: await nextCode(prisma, 'booking'), state: 'DRAFT', title: 'جلسهٔ خصوصی', kind: 'INTERNAL', startsAt: start,
        endsAt: new Date(start.getTime() + 3_600_000), organizerId: organizer.id,
      },
    });
    const res = await upload(T.finance, pdf, { recordType: 'booking', recordId: booking.id });
    expect(res.status).toBe(201);
    expect((await get('/documents', T.finance, { recordType: 'booking', recordId: booking.id })).body).toHaveLength(1);
    expect((await get('/documents', T.designer, { recordType: 'booking', recordId: booking.id })).body).toEqual([]);
    expect((await call('GET', `/documents/${res.body.id}/download`, { token: T.designer })).status).toBe(404);
    expect((await upload(T.designer, pdf, { recordType: 'booking', recordId: booking.id })).status).toBe(403);
    // The system administrator sees every booking in their own right.
    expect((await get('/documents', T.admin, { recordType: 'booking', recordId: booking.id })).body).toHaveLength(1);
  });
});
