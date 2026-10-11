import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { normalizeIranMobile } from '@hiva/contracts';
import { call, closeApp, expectOk, get, login, mobile, patch, post } from './helpers.js';
import { prisma } from '../src/db.js';
import { resolveLeadSource } from '../src/crm/lead-sources.js';

/**
 * A lead's mobile number and its source, in two steps (Hivamis task 2): the kind — sales team,
 * marketers, company staff, direct contact, partner companies — then exactly who or what.
 */
describe('A mobile number in one written form', () => {
  it('reads it however it was typed, and refuses what is not a mobile number', () => {
    for (const typed of ['09121234567', '۰۹۱۲ ۱۲۳ ۴۵۶۷', '٠٩١٢١٢٣٤٥٦٧', '+98 912 123 4567', '00989121234567', '989121234567', '9121234567', '0912-123-4567']) {
      expect(normalizeIranMobile(typed), typed).toBe('09121234567');
    }
    for (const bad of ['021-22001000', '0912', '091212345678', '08121234567', 'نامعلوم', '', null]) {
      expect(normalizeIranMobile(bad as string), String(bad)).toBeNull();
    }
  });
});

describe('Registering a lead', () => {
  let T: Record<string, string>;
  const ids: Record<string, string> = {};
  const base = (extra: Record<string, unknown>) => ({ name: `سرنخ ${Math.random().toString(36).slice(2, 7)}`, companyName: 'شرکت منبع', phone: mobile(), ...extra });

  beforeAll(async () => {
    T = { sales: await login('sales@hiva.local'), admin: await login('admin@hiva.local'), designer: await login('designer@hiva.local') };
    for (const e of ['sales', 'sales.manager', 'designer']) ids[e] = (await prisma.user.findFirstOrThrow({ where: { email: `${e}@hiva.local` } })).id;
    ids.marketer = (await prisma.leadReferrer.findFirstOrThrow({ where: { kind: 'MARKETER', name: 'مهسا یزدانی' } })).id;
    ids.partner = (await prisma.leadReferrer.findFirstOrThrow({ where: { kind: 'PARTNER' } })).id;
  });
  afterAll(async () => { await closeApp(); });

  it('needs a mobile number, and keeps it in one form', async () => {
    const none = await post('/leads', T.sales, { name: 'بی‌شماره', companyName: 'شرکت', source: 'DIRECT', sourceChannel: 'PHONE' });
    expect(none.status).toBe(400);
    const landline = await post('/leads', T.sales, base({ phone: '021-88776655', source: 'DIRECT', sourceChannel: 'PHONE' }));
    expect(landline.status).toBe(400);
    expect(JSON.stringify(landline.body)).toContain('شمارهٔ همراه معتبر نیست');
    const lead = expectOk(await post('/leads', T.sales, base({ phone: '+98 935 777 0011', source: 'DIRECT', sourceChannel: 'EXHIBITION' })), 'lead');
    expect(lead).toMatchObject({ phone: '09357770011', source: 'DIRECT', sourceChannel: 'EXHIBITION', sourceUserId: null, sourceReferrerId: null });
  });

  it('names a seller from the sales unit — and nobody else — for «تیم فروش»', async () => {
    const ok = expectOk(await post('/leads', T.sales, base({ source: 'SALES_TEAM', sourceUserId: ids['sales.manager'] })), 'sales team');
    expect(ok).toMatchObject({ source: 'SALES_TEAM', sourceUserId: ids['sales.manager'] });
    const wrong = await post('/leads', T.sales, base({ source: 'SALES_TEAM', sourceUserId: ids.designer }));
    expect([wrong.status, wrong.body.error.code]).toEqual([400, 'LEAD_SOURCE']);
    expect(wrong.body.error.message).toContain('عضو تیم فروش نیست');
    const missing = await post('/leads', T.sales, base({ source: 'SALES_TEAM' }));
    expect(missing.status).toBe(400);
  });

  it('names a colleague outside sales for «پرسنل شرکت»', async () => {
    expect(expectOk(await post('/leads', T.sales, base({ source: 'STAFF', sourceUserId: ids.designer })), 'staff')).toMatchObject({ source: 'STAFF', sourceUserId: ids.designer });
    const seller = await post('/leads', T.sales, base({ source: 'STAFF', sourceUserId: ids.sales }));
    expect(seller.body.error.message).toContain('عضو تیم فروش است');
  });

  it('names a marketer from the admin’s list, and keeps only the detail the kind has', async () => {
    const lead = expectOk(await post('/leads', T.sales, base({ source: 'MARKETER', sourceReferrerId: ids.marketer, sourceUserId: ids.sales, sourceChannel: 'PHONE' })), 'marketer');
    expect(lead).toMatchObject({ source: 'MARKETER', sourceReferrerId: ids.marketer, sourceUserId: null, sourceChannel: null });
    const partnerAsMarketer = await post('/leads', T.sales, base({ source: 'MARKETER', sourceReferrerId: ids.partner }));
    expect(partnerAsMarketer.body.error.message).toContain('بازاریاب در فهرست سازمان نیست');
    const typed = await post('/leads', T.sales, base({ source: 'MARKETER', sourcePartnerName: 'بازاریاب تازه' }));
    expect(typed.status).toBe(400);
  });

  it('adds a partner company the first time a seller names it, and finds it again however it is spelt', async () => {
    const first = expectOk(await post('/leads', T.sales, base({ source: 'PARTNER', sourcePartnerName: '  آژانس   رويداد كيش ' })), 'partner');
    const added = await prisma.leadReferrer.findUniqueOrThrow({ where: { id: first.sourceReferrerId } });
    expect(added).toMatchObject({ kind: 'PARTNER', name: 'آژانس رویداد کیش', createdById: ids.sales, isActive: true });
    expect(await prisma.auditEvent.findFirst({ where: { entityType: 'leadReferrer', entityId: added.id, action: 'CREATE', actorId: ids.sales } })).toMatchObject({ reason: 'نام‌برده هنگام ثبت سرنخ' });
    const again = expectOk(await post('/leads', T.sales, base({ source: 'PARTNER', sourcePartnerName: 'آژانس رویداد کیش' })), 'partner again');
    expect(again.sourceReferrerId).toBe(added.id);
    expect(await prisma.leadReferrer.count({ where: { name: 'آژانس رویداد کیش' } })).toBe(1);
  });

  it('asks for the channel of a direct contact', async () => {
    const res = await post('/leads', T.sales, base({ source: 'DIRECT' }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('کانال تماس');
  });

  it('stops a repeated number — naming who has it, a lead or a client’s contact — unless told it is meant', async () => {
    const first = expectOk(await post('/leads', T.sales, base({ phone: '09391112233', source: 'DIRECT', sourceChannel: 'PHONE' })), 'first');
    const again = await post('/leads', T.sales, base({ phone: '۰۹۳۹ ۱۱۱ ۲۲۳۳', source: 'DIRECT', sourceChannel: 'EVENT' }));
    expect([again.status, again.body.error.code]).toEqual([409, 'DUPLICATE_LEAD']);
    expect(again.body.error.message).toContain(first.code);
    expect(again.body.error.details.leads[0]).toMatchObject({ id: first.id, code: first.code, owner: 'الهام کریمی' });
    expectOk(await post('/leads', T.sales, base({ phone: '09391112233', source: 'DIRECT', sourceChannel: 'EVENT', confirmDuplicate: true })), 'meant');

    const contact = await prisma.contact.findFirstOrThrow({ where: { phone: { startsWith: '09' }, deletedAt: null }, include: { company: true } });
    const client = await post('/leads', T.sales, base({ phone: `+98${contact.phone!.slice(1)}`, source: 'DIRECT', sourceChannel: 'PHONE' }));
    expect(client.status).toBe(409);
    expect(client.body.error.message).toContain(contact.fullName);

    const asked = expectOk(await get('/leads/duplicates', T.sales, { phone: '9391112233' }), 'duplicates');
    expect(asked.phone).toBe('09391112233');
    expect(asked.leads).toHaveLength(2);
    expect(expectOk(await get('/leads/duplicates', T.sales, { phone: '021' }), 'not mobile')).toEqual({ phone: null, leads: [], contacts: [] });
  });

  it('checks a change of source or number the same way', async () => {
    const lead = expectOk(await post('/leads', T.sales, base({ source: 'DIRECT', sourceChannel: 'PHONE' })), 'lead');
    expect(expectOk(await patch(`/leads/${lead.id}`, T.sales, { sourceChannel: 'CAMPAIGN' }), 'channel')).toMatchObject({ source: 'DIRECT', sourceChannel: 'CAMPAIGN' });
    expect(expectOk(await patch(`/leads/${lead.id}`, T.sales, { source: 'STAFF', sourceUserId: ids.designer }), 'kind')).toMatchObject({ source: 'STAFF', sourceUserId: ids.designer, sourceChannel: null });
    expect((await patch(`/leads/${lead.id}`, T.sales, { source: 'SALES_TEAM' })).status).toBe(400);
    expect((await patch(`/leads/${lead.id}`, T.sales, { sourceUserId: ids.sales })).body.error.message).toContain('عضو تیم فروش است');
    expect((await patch(`/leads/${lead.id}`, T.sales, { phone: '09391112233' })).status).toBe(409);
    expect(expectOk(await patch(`/leads/${lead.id}`, T.sales, { name: 'نام تازه' }), 'unrelated')).toMatchObject({ name: 'نام تازه', phone: lead.phone });
  });

  it('keeps marketers on a list only the admin edits; partners a seller may add', async () => {
    expect((await post('/lead-referrers', T.sales, { kind: 'MARKETER', name: 'بازاریاب بی‌اجازه' })).status).toBe(403);
    const m = expectOk(await post('/lead-referrers', T.admin, { kind: 'MARKETER', name: 'سینا فرهمند', phone: '09121230000' }), 'marketer');
    expect((await post('/lead-referrers', T.admin, { kind: 'MARKETER', name: 'سینا  فرهمند' })).status).toBe(409);
    expect((await post('/lead-referrers', T.sales, { kind: 'PARTNER', name: 'استودیو نور' })).status).toBe(201);
    expect((await patch(`/lead-referrers/${m.id}`, T.sales, { isActive: false })).status).toBe(403);

    const named = expectOk(await post('/leads', T.sales, base({ source: 'MARKETER', sourceReferrerId: m.id })), 'named');
    expectOk(await patch(`/lead-referrers/${m.id}`, T.admin, { isActive: false }), 'retire');
    const after = await post('/leads', T.sales, base({ source: 'MARKETER', sourceReferrerId: m.id }));
    expect(after.body.error.message).toContain('کنار گذاشته شده');
    const listed = expectOk(await get('/lead-referrers', T.sales, { kind: 'MARKETER', all: 'true' }), 'list');
    expect(listed.items.find((r: any) => r.id === m.id)).toMatchObject({ isActive: false, leads: 1 });
    expect(expectOk(await get('/lead-referrers', T.sales, { kind: 'MARKETER' }), 'active').items.some((r: any) => r.id === m.id)).toBe(false);
    expect(named.sourceReferrerId).toBe(m.id);
  });

  it('offers the picker everything in one request: sellers, colleagues, marketers, partners, channels', async () => {
    const o = expectOk(await get('/leads/source-options', T.sales), 'options');
    expect(o.kinds.map((k: any) => k.value)).toEqual(['SALES_TEAM', 'MARKETER', 'STAFF', 'DIRECT', 'PARTNER']);
    expect(o.channels.map((c: any) => c.fa)).toEqual(['تلفن', 'نمایشگاه', 'رویداد', 'کمپین']);
    expect(o.salesTeam.map((u: any) => u.id)).toEqual(expect.arrayContaining([ids.sales, ids['sales.manager']]));
    expect(o.staff.some((u: any) => u.id === ids.sales)).toBe(false);
    expect(o.staff.some((u: any) => u.id === ids.designer)).toBe(true);
    expect(o.marketers.map((m: any) => m.name)).toContain('مهسا یزدانی');
    expect(o).toMatchObject({ canManageMarketers: false, canAddPartners: true });
  });

  it('applies the same rules to the lead form of the form engine', async () => {
    const s = expectOk(await post('/forms/submissions', T.sales, {
      formCode: 'A01_LEAD', data: { name: 'سرنخ فرم', companyName: 'شرکت فرم', phone: '۰۹۳۵ ۲۲۲ ۳۳۴۴', source: 'SALES_TEAM', sourceUserId: ids['sales.manager'] },
    }), 'form');
    const lead = await prisma.lead.findFirstOrThrow({ where: { name: 'سرنخ فرم' } });
    expect(lead).toMatchObject({ phone: '09352223344', source: 'SALES_TEAM', sourceUserId: ids['sales.manager'] });
    expect(s.id).toBeTruthy();

    const bad = await post('/forms/submissions', T.sales, { formCode: 'A01_LEAD', data: { name: 'x', companyName: 'y', phone: '021', source: 'DIRECT', sourceChannel: 'PHONE' } });
    expect(bad.body.error.details.issues.map((i: any) => i.path)).toContain('phone');
    const twice = await post('/forms/submissions', T.sales, { formCode: 'A01_LEAD', data: { name: 'سرنخ فرم ۲', companyName: 'y', phone: '09352223344', source: 'DIRECT', sourceChannel: 'PHONE' } });
    expect(twice.status).toBe(409);
    expectOk(await post('/forms/submissions', T.sales, { formCode: 'A01_LEAD', data: { name: 'سرنخ فرم ۳', companyName: 'y', phone: '09352223344', source: 'PARTNER', sourcePartnerId: ids.partner, confirmDuplicate: true } }), 'meant');
    expect(await prisma.lead.findFirstOrThrow({ where: { name: 'سرنخ فرم ۳' } })).toMatchObject({ source: 'PARTNER', sourceReferrerId: ids.partner });
  });

  it('reads an old single-step source as its two steps, and the database holds the set', async () => {
    const org = (await prisma.user.findUniqueOrThrow({ where: { id: ids.sales } })).organizationId;
    expect(await resolveLeadSource(prisma, org, ids.sales, { source: 'OUTBOUND' })).toEqual({ source: 'SALES_TEAM', sourceUserId: ids.sales, sourceReferrerId: null, sourceChannel: null });
    expect(await resolveLeadSource(prisma, org, ids.sales, { source: 'CAMPAIGN' })).toMatchObject({ source: 'DIRECT', sourceChannel: 'CAMPAIGN' });
    await expect(prisma.lead.create({ data: { organizationId: org, code: 'LEAD-CHECK', name: 'x', companyName: 'y', source: 'INBOUND' } })).rejects.toThrow();
    await expect(prisma.lead.create({ data: { organizationId: org, code: 'LEAD-CHECK', name: 'x', companyName: 'y', source: 'PARTNER', sourceChannel: 'PHONE' } })).rejects.toThrow();
    expect((await call('GET', '/leads', { token: T.sales, query: { source: 'MARKETER' } })).body.items.every((l: any) => l.source === 'MARKETER' && l.sourceReferrer)).toBe(true);
  });
});
