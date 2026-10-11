import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { app, call, closeApp, get, login, post, put, expectOk, zipOf, DEV_PASSWORD } from './helpers.js';
import { prisma } from '../src/db.js';
import { readTable, SheetError } from '../src/onboarding/sheet.js';
import { dateOf, numberOf } from '../src/onboarding/importers.js';
import { suggestUnit } from '../src/onboarding/units.js';
import { recordOpeningState } from '../src/workflow/engine.js';
import { mine } from '../src/reports/mining.js';
import { toCsv } from '../src/forms/bulk.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/onboarding/${name}`, import.meta.url));
const csv = (rows: string[][]) => Buffer.from(toCsv(rows));

/** Multipart to any onboarding route. */
async function send(url: string, token: string, file: Buffer, name = 'data.csv') {
  const boundary = `----hiva${Math.random().toString(36).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await (await app()).inject({ method: 'POST', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  return { status: res.statusCode, body: res.json() };
}

/** A minimal workbook by hand: inline strings, a shared string, and a cell styled as a date. */
function workbook(): Buffer {
  const xml = (s: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`;
  return zipOf([
    { name: 'xl/workbook.xml', content: xml('<workbook xmlns:r="r"><sheets><sheet name="الف" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', content: xml('<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: 'xl/sharedStrings.xml', content: xml('<sst><si><r><t>تاریخ</t></r><r><t xml:space="preserve"> شروع</t></r></si></sst>') },
    { name: 'xl/styles.xml', content: xml('<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>') },
    { name: 'xl/worksheets/sheet1.xml', content: xml('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>نام &amp; نشان</t></is></c><c r="B1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>كاظم</t></is></c><c r="B2" s="1"><v>46296</v></c><c r="D2"><v>12.5</v></c></row></sheetData></worksheet>') },
  ]);
}

describe('Reading the files an organisation has', () => {
  it('reads an Excel workbook — shared and inline strings, a date-styled cell, a gap — and an openpyxl one', () => {
    expect(readTable(workbook())).toEqual([['نام & نشان', 'تاریخ شروع'], ['کاظم', '2026-10-01', '', '12.5']]);
    const real = readTable(fixture('users-openpyxl.xlsx'));
    expect(real[0]).toEqual(['ایمیل', 'نام و نام خانوادگی', 'واحد', 'نقش‌ها', 'تاریخ شروع', 'ظرفیت']);
    expect(real[2]).toEqual(['sara@acme.ir', 'سارا "مدیر" & همکاران', 'بازاریابی دیجیتال', 'UNIT_MANAGER|UNIT_MEMBER', '2025-03-21', '36.5']);
  });

  it('reads the CSV Persian Excel saves — Windows-1256, semicolons, Arabic letters made Persian', () => {
    expect(readTable(fixture('users-1256.csv'))).toEqual([['ایمیل', 'نام', 'ظرفیت'], ['ali@acme.ir', 'علی رضایی کریمی', '40']]);
    expect(() => readTable(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]))).toThrow(SheetError);
  });

  it('reads Jalali and Gregorian dates, and digits in any script', () => {
    expect(dateOf('1405/07/01')?.toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(dateOf('۱۴۰۵/۰۱/۰۱')?.toISOString()).toBe('2026-03-21T00:00:00.000Z');
    expect(dateOf('2026-02-30')).toBeNull();
    expect(dateOf('فردا')).toBeNull();
    expect(numberOf('۱٬۵۰۰٬۰۰۰')).toBe(1_500_000);
    expect(numberOf('')).toBeNull();
  });

  it('suggests which of Doc_H’s ten units an organisation’s own unit is — and says nothing when it cannot tell', () => {
    expect(suggestUnit('واحد طراحی و گرافیک')).toBe('CR');
    expect(suggestUnit('مدیریت مشتریان')).toBe('A');
    expect(suggestUnit('بازاريابي ديجيتال')).toBe('DM');
    expect(suggestUnit('مدیریت')).toBe('M');
    expect(suggestUnit('cr')).toBe('CR');
    expect(suggestUnit('آبدارخانه')).toBeNull();
  });
});

describe('Bringing an organisation in', () => {
  let T: Record<string, string>;
  beforeAll(async () => {
    T = { admin: await login('admin@hiva.local'), ceo: await login('ceo@hiva.local'), sales: await login('sales@hiva.local') };
  });
  afterAll(async () => { await closeApp(); });

  const people = csv([
    ['ایمیل', 'نام و نام خانوادگی', 'واحد', 'نقش‌ها', 'عنوان شغلی', 'ظرفیت هفتگی (ساعت)'],
    ['niloofar@acme.ir', 'نیلوفر احمدی', 'استودیو طراحی', 'کارشناس واحد', 'طراح', '۴۰'],
    ['bahram@acme.ir', 'بهرام کاظمی', 'استودیو طراحی', 'UNIT_MANAGER|UNIT_MEMBER', 'مدیر استودیو', ''],
    ['designer@hiva.local', 'طراح موجود', 'CR', 'UNIT_MEMBER', '', ''],
    ['not-an-email', 'بی‌ایمیل', 'CR', 'UNIT_MEMBER', '', ''],
    ['boss@acme.ir', 'رئیس', 'دفتر مرکزی', 'SUPER_ADMIN', '', ''],
    ['niloofar@acme.ir', 'تکراری', 'CR', 'UNIT_MEMBER', '', ''],
    ['x@acme.ir', 'نقش عجیب', 'CR', 'جادوگر', '', '90'],
  ]);

  it('maps the organisation’s unit names first — a name nobody mapped holds its people back', async () => {
    expect((await send('/onboarding/units/scan', T.sales, people)).status).toBe(403);
    const scanned = (await send('/onboarding/units/scan', T.admin, people)).body;
    expect(scanned.find((u: any) => u.name === 'استودیو طراحی')).toEqual({ name: 'استودیو طراحی', people: 2, resolved: null, suggestion: 'CR' });
    expect(scanned.find((u: any) => u.name === 'CR')).toMatchObject({ resolved: 'CR' });
    const before = (await send('/onboarding/import/users/preview', T.admin, people)).body;
    expect(before.rows[0].issues).toContain('واحد «استودیو طراحی» نگاشته نشده — در گام «واحدها» آن را به یکی از ده واحد Doc_H وصل کنید');
    expect((await put('/onboarding/units', T.admin, { map: { 'استودیو طراحی': 'XX' } })).status).toBe(400);
    expectOk(await put('/onboarding/units', T.admin, { map: { 'استودیو طراحی': 'CR', 'دفتر مرکزی': 'M' } }), 'map');
  });

  it('checks every row before anything is written, and says why a row cannot go', async () => {
    expect((await send('/onboarding/import/users/preview', T.sales, people)).status).toBe(403);   // people are admin.users
    const p = (await send('/onboarding/import/users/preview', T.admin, people)).body;
    expect(p.summary).toEqual({ create: 2, skip: 1, invalid: 4 });
    const byLine = Object.fromEntries(p.rows.map((r: any) => [r.line, r]));
    expect(byLine[2]).toMatchObject({ status: 'CREATE', label: 'نیلوفر احمدی' });
    expect(byLine[4]).toMatchObject({ status: 'SKIP', notes: ['این ایمیل پیش‌تر در سامانه هست؛ دست نخورد'] });
    expect(byLine[5].issues).toContain('ایمیل «not-an-email» درست نیست');
    expect(byLine[6].issues).toContain('نقش مدیر سیستم با فایل داده نمی‌شود؛ آن را یک‌به‌یک در مدیریت کاربران بدهید');
    expect(byLine[7].issues).toContain('این ایمیل در همین فایل تکرار شده است');
    expect(byLine[8].issues).toEqual(expect.arrayContaining(['نقش «جادوگر» شناخته نشد', 'ظرفیت هفتگی باید عددی بین ۱ تا ۸۰ باشد']));
    expect(await prisma.user.count({ where: { email: 'niloofar@acme.ir' } })).toBe(0);
  });

  it('creates the valid people with no password anyone knows, and a one-time link each to set their own', async () => {
    const r = (await send('/onboarding/import/users/commit', T.admin, people)).body;
    expect(r.created.map((c: any) => c.label)).toEqual(['نیلوفر احمدی', 'بهرام کاظمی']);
    expect(r.activations).toHaveLength(2);
    expect(r.activations[0]).toMatchObject({ email: 'niloofar@acme.ir', emailed: false, url: expect.stringMatching(/\/activate\/[\w-]{43}$/) });
    const bahram = await prisma.user.findFirstOrThrow({ where: { email: 'bahram@acme.ir' }, include: { roles: { include: { role: true } }, department: true } });
    expect([bahram.department?.code, bahram.roles.map((x) => x.role.code).sort(), Number(bahram.weeklyCapacityHours)]).toEqual(['CR', ['UNIT_MANAGER', 'UNIT_MEMBER'], 40]);
    expect((await call('POST', '/auth/login', { payload: { email: 'bahram@acme.ir', password: DEV_PASSWORD } })).status).toBe(401);
    const audited = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'BULK_IMPORT', entityId: 'users' }, orderBy: { createdAt: 'desc' } });
    expect(audited.after).toMatchObject({ created: 2, skipped: 1, invalid: 4 });

    // The same file again creates no one twice.
    expect((await send('/onboarding/import/users/commit', T.admin, people)).body.created).toEqual([]);

    const token = r.activations[0].url.split('/activate/')[1];
    expect(expectOk(await get(`/auth/activation/${token}`, ''), 'describe')).toMatchObject({ fullName: 'نیلوفر احمدی', email: 'niloofar@acme.ir' });
    expect((await post(`/auth/activation/${token}`, '', { password: 'short' })).status).toBe(400);
    expectOk(await post(`/auth/activation/${token}`, '', { password: 'Niloofar-Hiva-2026' }), 'activate');
    expect((await call('POST', '/auth/login', { payload: { email: 'niloofar@acme.ir', password: 'Niloofar-Hiva-2026' } })).status).toBe(200);
    expect((await post(`/auth/activation/${token}`, '', { password: 'Another-Hiva-2026' })).body.error.code).toBe('ACTIVATION_USED');

    // A new link cancels the old one; an expired one says so.
    const old = r.activations[1].url.split('/activate/')[1];
    const pending = expectOk(await get('/onboarding/activations', T.admin), 'pending');
    expect(pending.map((u: any) => u.email)).toEqual(['bahram@acme.ir']);
    const fresh = expectOk(await post(`/users/${pending[0].id}/activation`, T.admin), 'fresh');
    expect(fresh.url).toMatch(/\/activate\//);
    expect((await get(`/auth/activation/${old}`, '')).body.error.code).toBe('ACTIVATION_INVALID');
    await prisma.accountActivation.updateMany({ where: { userId: pending[0].id, usedAt: null, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await get(`/auth/activation/${fresh.url.split('/activate/')[1]}`, '')).body.error.code).toBe('ACTIVATION_EXPIRED');
  });

  const clients = csv([
    ['نام حقوقی', 'نام تجاری', 'شناسهٔ ملی', 'مالک اکانت'],
    ['شرکت نوآوران پارس', 'نوآوران', '۱۴۰۰۳۲۱۵۶۸۷', 'account.manager@hiva.local'],
    ['هلدینگ سپهر', '', '', ''],
    ['شركت نوآوران پارس', '', '', ''],
    ['گروه بی‌صاحب', '', '', 'nobody@acme.ir'],
  ]);

  it('brings in clients and their contacts, found again by national id or name', async () => {
    const p = (await send('/onboarding/import/companies/preview', T.ceo, clients)).body;
    expect(p.summary).toEqual({ create: 2, skip: 0, invalid: 2 });
    expect(p.rows[1].notes).toEqual(['مالک اکانت خالی بود؛ واردکننده مالک می‌شود']);
    expect(p.rows[2].issues).toEqual(['این مشتری در همین فایل تکرار شده است']);        // Arabic kaf, same name
    expect(p.rows[3].issues).toEqual(['کاربری با ایمیل «nobody@acme.ir» نیست']);
    const r = (await send('/onboarding/import/companies/commit', T.ceo, clients)).body;
    expect(r.created).toHaveLength(2);
    expect(await prisma.company.findFirstOrThrow({ where: { legalName: 'شرکت نوآوران پارس' } })).toMatchObject({ nationalId: '14003215687', brandName: 'نوآوران' });
    const again = (await send('/onboarding/import/companies/preview', T.ceo, clients)).body;
    expect(again.summary).toEqual({ create: 0, skip: 2, invalid: 2 });
    expect(again.rows[1].notes).toEqual(['«هلدینگ سپهر» پیش‌تر ثبت شده است؛ دست نخورد']);   // nothing about an owner it will not get

    const contacts = csv([
      ['مشتری', 'نام و نام خانوادگی', 'ایمیل', 'مخاطب اصلی'],
      ['14003215687', 'مریم نادری', 'maryam@novavaran.ir', 'بله'],
      ['هلدینگ سپهر', 'رضا کامرانی', '', ''],
      ['شرکت ناشناس', 'کسی', '', ''],
    ]);
    const c = (await send('/onboarding/import/contacts/commit', T.ceo, contacts)).body;
    expect(c.created.map((x: any) => x.label)).toEqual(['مریم نادری', 'رضا کامرانی']);
    expect(c.preview.rows[2].issues).toEqual(['مشتری «شرکت ناشناس» پیدا نشد — نخست مشتریان را وارد کنید']);
    expect(await prisma.contact.findFirstOrThrow({ where: { email: 'maryam@novavaran.ir' } })).toMatchObject({ isPrimary: true });
  });

  it('brings running projects in at the state they are in — with their authorization — and never twice', async () => {
    const projects = csv([
      ['کد در سامانهٔ پیشین', 'نام پروژه', 'مشتری', 'مالک اکانت', 'وضعیت', 'شروع برنامه‌ریزی‌شده', 'پایان برنامه‌ریزی‌شده', 'ارزش قرارداد (ریال)', 'مبنای مجوز شروع', 'سند مجوز'],
      ['OLD-17', 'کمپین بهار نوآوران', 'شرکت نوآوران پارس', 'account.manager@hiva.local', 'در حال اجرا', '1405/01/15', '1405/06/31', '2,500,000,000', 'قرارداد', 'ق-۱۴۰۵-۰۳۲'],
      ['OLD-18', 'بازطراحی لوگو', 'هلدینگ سپهر', 'account.manager@hiva.local', '', '', '', '', '', ''],
      ['OLD-19', 'بدون مجوز', 'هلدینگ سپهر', 'account.manager@hiva.local', 'ACTIVE', '', '', '', '', ''],
      ['OLD-20', 'بسته‌شده', 'هلدینگ سپهر', 'account.manager@hiva.local', 'CLOSED', '', '', '', '', ''],
      ['OLD-21', 'تاریخ وارونه', 'هلدینگ سپهر', 'account.manager@hiva.local', '', '1405/06/01', '1405/01/01', '', '', ''],
    ]);
    const p = (await send('/onboarding/import/projects/preview', T.ceo, projects)).body;
    expect(p.summary).toEqual({ create: 2, skip: 0, invalid: 3 });
    expect(p.rows[2].issues[0]).toContain('قانون ۱۳');
    expect(p.rows[3].issues[0]).toContain('برای پروژهٔ در جریان پذیرفته نیست');
    expect(p.rows[4].issues).toEqual(['پایان پیش از شروع است']);

    const r = (await send('/onboarding/import/projects/commit', T.ceo, projects)).body;
    expect(r.failed).toEqual([]);
    const spring = await prisma.project.findFirstOrThrow({ where: { legacyRef: 'OLD-17' }, include: { authorizations: true } });
    expect(spring).toMatchObject({ state: 'ACTIVE', name: 'کمپین بهار نوآوران' });
    expect(Number(spring.contractValue)).toBe(2_500_000_000);
    expect(spring.plannedStart?.toISOString().slice(0, 10)).toBe('2026-04-04');
    expect(spring.authorizations).toEqual([expect.objectContaining({ basis: 'CONTRACT', referenceDocument: 'ق-۱۴۰۵-۰۳۲' })]);
    const opening = await prisma.stateTransition.findFirstOrThrow({ where: { entityId: spring.id } });
    expect(opening).toMatchObject({ fromState: 'DRAFT', toState: 'ACTIVE', action: 'opening', opening: true, reason: 'ورود از سامانهٔ پیشین (کد OLD-17)' });
    expect((await prisma.project.findFirstOrThrow({ where: { legacyRef: 'OLD-18' } })).state).toBe('DRAFT');
    expect((await send('/onboarding/import/projects/preview', T.ceo, projects)).body.summary).toEqual({ create: 0, skip: 2, invalid: 3 });

    // Recorded, not moved: once only, never a way round a guard, and not an event of the process.
    const actor = { id: (await prisma.user.findFirstOrThrow({ where: { email: 'ceo@hiva.local' } })).id, organizationId: spring.organizationId };
    await expect(recordOpeningState(prisma, { entity: 'project', id: spring.id, toState: 'ON_HOLD', reason: 'x', actor })).rejects.toThrow(/فقط یک بار/);
    const mined = await mine(prisma, spring.organizationId, 'project', { workingDays: [0, 1, 2, 3, 4, 5, 6], workStartHour: 0, workEndHour: 24, breakHours: 0, holidays: new Set() } as never);
    expect(JSON.stringify(mined)).not.toContain('opening');
  });

  it('refuses a working week or an SLA that makes no sense, and records the change', async () => {
    const patchOrg = (body: object) => call('PATCH', '/organization', { token: T.ceo, payload: body });
    expect((await patchOrg({ workingDays: [9] })).status).toBe(400);
    expect((await patchOrg({ workStartHour: 18, workEndHour: 9 })).status).toBe(400);
    expect((await patchOrg({ workEndHour: 7 })).body.error.code).toBe('INVALID_HOURS');    // before the stored start
    expectOk(await patchOrg({ workingDays: [6, 0, 1, 2, 3, 4], workEndHour: 17 }), 'week');
    const audited = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'organization', action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect(audited.after).toEqual({ workingDays: [6, 0, 1, 2, 3, 4], workEndHour: 17 });
    const patchSla = (body: object) => call('PATCH', '/sla-policies/SLA_TASK_ACCEPTANCE', { token: T.ceo, payload: body });
    expect((await patchSla({ hours: -2 })).status).toBe(400);
    expect((await patchSla({ warnAt: 1.5 })).status).toBe(400);
    expect(Number(expectOk(await patchSla({ hours: 6 }), 'sla').hours)).toBe(6);
    expect((await call('PATCH', '/sla-policies/NO_SUCH', { token: T.ceo, payload: { hours: 6 } })).status).toBe(404);
  });

  it('takes holidays in Jalali, and shows where the organisation stands', async () => {
    const holidays = csv([['تاریخ', 'عنوان'], ['1405/01/01', 'نوروز'], ['۱۴۰۵/۰۱/۱۲', 'روز جمهوری اسلامی'], ['1405/13/01', 'ماه سیزدهم']]);
    const h = (await send('/onboarding/import/holidays/commit', T.ceo, holidays)).body;
    expect(h.created.map((x: any) => x.label)).toEqual(['نوروز', 'روز جمهوری اسلامی']);
    expect(h.preview.rows[2].issues).toEqual(['تاریخ «1405/13/01» خوانا نیست']);
    expect((await prisma.holiday.findFirstOrThrow({ where: { title: 'نوروز' } })).date.toISOString().slice(0, 10)).toBe('2026-03-21');

    const status = expectOk(await get('/onboarding', T.ceo), 'status');
    expect(status.steps.map((s: any) => [s.step, s.done])).toEqual([['units', false], ['users', true], ['calendar', false], ['sla', false], ['companies', true], ['projects', true]]);
    expect(status.steps.find((s: any) => s.step === 'users').detailFa).toContain('۱ نفر هنوز رمز نگذاشته‌اند');
    expect((await post('/onboarding/confirm/users', T.ceo)).status).toBe(400);
    const after = expectOk(await post('/onboarding/confirm/calendar', T.ceo), 'confirm');
    expect(after.steps.find((s: any) => s.step === 'calendar')).toMatchObject({ done: true, confirmed: { at: expect.any(String) } });
    expect((await get('/onboarding', T.sales)).status).toBe(403);
    const template = await (await app()).inject({ method: 'GET', url: '/api/v1/onboarding/templates/projects', headers: { authorization: `Bearer ${T.ceo}` } });
    expect(template.body).toContain('کد در سامانهٔ پیشین,نام پروژه,مشتری');
  });
});
