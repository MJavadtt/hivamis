import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeApp, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { tenancy } from '../src/lib/tenant.js';
import { twoOrgs, type TwoOrgs } from './helpers/two-orgs.js';

/**
 * Audit SEC-12, on the lead's conversion: the client a qualified lead becomes a sale for is named by
 * the caller (the sales journey and the leads list both ask which client, ADR-113) — it must be the
 * caller's organisation's. Another's answers exactly as a client that does not exist, and nothing is
 * made; the caller's own works, and with none named a new client is made as before.
 */

describe('Converting a lead names only the caller’s own client (SEC-12)', () => {
  let orgs: TwoOrgs;
  let theirs: { id: string };
  let ours: { id: string };
  const qualified = async (name: string) => prisma.lead.create({
    data: { organizationId: orgs.a.id, code: `LEAD-T${Math.floor(Math.random() * 1e6)}`, name, companyName: name, phone: '09120000000', source: 'DIRECT', sourceChannel: 'PHONE', state: 'QUALIFIED' },
  });

  beforeAll(async () => {
    orgs = await twoOrgs();
    theirs = await prisma.company.findFirstOrThrow({ where: { organizationId: orgs.b.id } });
    ours = await prisma.company.create({ data: { organizationId: orgs.a.id, legalName: 'مشتری خودی' } });
  }, 120_000);
  afterAll(async () => { tenancy.mode = 'single'; await closeApp(); });

  it('refuses another organisation’s client with the same answer as no client at all, and makes nothing', async () => {
    const lead = await qualified('سرنخ نفوذی');
    const foreign = await post(`/leads/${lead.id}/convert`, orgs.a.full.token, { companyId: theirs.id, title: 'فرصت نفوذی' });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error).toMatchObject({ code: 'UNKNOWN_REFERENCE', details: { field: 'companyId' } });
    const missing = await post(`/leads/${lead.id}/convert`, orgs.a.full.token, { companyId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.body.error).toMatchObject({ code: 'UNKNOWN_REFERENCE' });

    expect(await prisma.opportunity.count({ where: { title: 'فرصت نفوذی' } })).toBe(0);
    expect(await prisma.opportunity.count({ where: { companyId: theirs.id, organizationId: orgs.a.id } })).toBe(0);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).state).toBe('QUALIFIED');
  });

  it('converts onto the caller’s own client, and makes a new one when none is named', async () => {
    const onOurs = await post(`/leads/${(await qualified('سرنخ خودی')).id}/convert`, orgs.a.full.token, { companyId: ours.id, title: 'فرصت خودی' });
    expect(onOurs.status).toBe(201);
    expect(onOurs.body).toMatchObject({ companyId: ours.id, organizationId: orgs.a.id });

    const fresh = await post(`/leads/${(await qualified('سرنخ تازه')).id}/convert`, orgs.a.full.token, {});
    expect(fresh.status).toBe(201);
    const made = await prisma.company.findUniqueOrThrow({ where: { id: fresh.body.companyId } });
    expect(made).toMatchObject({ organizationId: orgs.a.id, legalName: 'سرنخ تازه' });
  });

  it('refuses a body it does not understand', async () => {
    const lead = await qualified('سرنخ بدشکل');
    expect((await post(`/leads/${lead.id}/convert`, orgs.a.full.token, { companyId: 'not-an-id' })).status).toBe(400);
    expect((await post(`/leads/${lead.id}/convert`, orgs.a.full.token, { estimatedValue: -5 })).status).toBe(400);
  });
});
