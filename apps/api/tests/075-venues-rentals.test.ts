import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import ExcelJS from 'exceljs';
import { app, closeApp, expectOk, get, login, move, patch, post, put, tinyPdf, upload } from './helpers.js';
import { prisma } from '../src/db.js';
import { buildSchedule, addJalaliMonths } from '../src/sites/schedule.js';
import { beforeOffset, afterOffset, runReminders } from '../src/sites/reminders.js';
import { parseDateCell, safeText } from '../src/sites/excel.js';
import { jalaliOf } from '../src/lib/jalali.js';
import { siteSettingsSchema, nameKey, phoneKey, moneySchema } from '@hiva/contracts';

/**
 * ADR-103 — the owner's «دیتابیس» document: the venue database, deployment projects and rentals, end to
 * end through the API as people use it: a venue with its people and photos, a project negotiated, its
 * contract approved by someone other than its writer, installed, live, paid in full and in part, a
 * penalty, reminders sent once, the deposit's deduction approved and the rest returned, the project closed
 * with its statement — and the refusals on the way: duplicates, early moves, double payments, a closure
 * with money still open, a reader without the right permission.
 */

const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#e0e0e0' } }).png().toBuffer();
let seq = 0;
const key = () => `pay-${Date.now()}-${++seq}-abcdef`;
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function uploadTo(url: string, token: string, file: { name: string; type: string; content: Buffer }, fields: Record<string, string> = {}) {
  const a = await app();
  const boundary = `----hiva${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await a.inject({ method: 'POST', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) });
  return { status: res.statusCode, body: res.json() };
}

async function xlsx(headers: string[], rows: (string | number | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('data');
  s.addRow(headers);
  for (const r of rows) s.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('Venues, deployment projects and rentals (ADR-103)', () => {
  let T: Record<string, string>;
  let users: Record<string, string>;
  beforeAll(async () => {
    T = {
      admin: await login('admin@hiva.local'), pmo: await login('pmo@hiva.local'), finance: await login('finance@hiva.local'),
      legal: await login('legal@hiva.local'), account: await login('account@hiva.local'), sales: await login('sales@hiva.local'),
      designer: await login('designer@hiva.local'),
    };
    const rows = await prisma.user.findMany({ where: { email: { in: ['pmo@hiva.local', 'finance@hiva.local', 'account@hiva.local', 'legal@hiva.local'] } }, select: { id: true, email: true } });
    users = Object.fromEntries(rows.map((u) => [u.email.split('@')[0]!, u.id]));
  });
  afterAll(closeApp);

  /* ── pure rules ────────────────────────────────────────────────────────── */

  describe('the rules underneath', () => {
    it('reads a name, a phone and a sum as people type them', () => {
      expect(nameKey('مجتمع  تجاري‌كوروش')).toBe(nameKey('مجتمع تجاری کوروش'));
      expect(phoneKey('۰۲۱-۸۸۱۲ ۳۴۵۶')).toBe(phoneKey('+98 21 88123456'));
      expect(phoneKey('12')).toBeNull();
      expect(moneySchema.parse('۱۲٬۵۰۰٬۰۰۰')).toBe('12500000');
      expect(moneySchema.parse(1500.5)).toBe('1500.5');
      expect(moneySchema.safeParse('-3').success).toBe(false);
      expect(moneySchema.safeParse('1.234').success).toBe(false);
    });

    it('builds a schedule in Persian months, part-months by their days unless told otherwise', () => {
      const start = new Date('2026-10-23T00:00:00Z'); // ۱ آبان ۱۴۰۵
      const end = addJalaliMonths(start, 2);
      const s = siteSettingsSchema.parse({});
      const plan = buildSchedule({ contractStart: start, contractEnd: new Date(end.getTime() + 15 * 86_400_000), depositAmount: '50000000' as never, rentAmount: '30000000' as never, rentPeriod: 'MONTHLY', rentDueDay: 5, chargeAmount: '3000000' as never, chargeDueDay: 0 }, s);
      expect(plan.filter((x) => x.kind === 'DEPOSIT')).toHaveLength(1);
      const rents = plan.filter((x) => x.kind === 'RENT');
      expect(rents).toHaveLength(3);
      expect(rents[0]!.amount).toBe('30000000.00');
      // The third period is 15 of آذر's 30 days.
      expect(rents[2]!.amount).toBe('15000000.00');
      expect(rents[0]!.dueDate.getTime() - rents[0]!.periodStart!.getTime()).toBe(5 * 86_400_000);
      expect(jalaliOf(rents[1]!.periodStart!).m).toBe(jalaliOf(start).m + 1);
      const full = buildSchedule({ contractStart: start, contractEnd: new Date(end.getTime() + 15 * 86_400_000), depositAmount: null, rentAmount: '30000000' as never, rentPeriod: 'MONTHLY', rentDueDay: 0, chargeAmount: null, chargeDueDay: null }, siteSettingsSchema.parse({ schedule: { proration: 'FULL' } }));
      expect(full.at(-1)!.amount).toBe('30000000.00');
      const daily = buildSchedule({ contractStart: start, contractEnd: addJalaliMonths(start, 1), depositAmount: null, rentAmount: '1000000' as never, rentPeriod: 'DAILY', rentDueDay: 0, chargeAmount: null, chargeDueDay: null }, s);
      expect(daily[0]!.amount).toBe('30000000.00'); // آبان has 30 days
    });

    it('reminds at the nearest interval crossed — once — and after a due date by the largest passed', () => {
      expect(beforeOffset(5, [30, 14, 7, 3, 1])).toBe(7);
      expect(beforeOffset(40, [30, 14, 7])).toBeNull();
      expect(beforeOffset(0, [30, 14, 7, 3, 1])).toBe(1);
      expect(afterOffset(9, [1, 7, 14])).toBe(-7);
      expect(afterOffset(0, [1, 7])).toBeNull();
    });

    it('reads Persian and Gregorian dates from a sheet, and writes formulas as text', () => {
      const d = parseDateCell('۱۴۰۵/۰۸/۰۱');
      expect(d).toBeInstanceOf(Date);
      expect(iso(d as Date)).toBe('2026-10-23');
      expect(parseDateCell('2026-10-23')).toEqual(new Date('2026-10-23T00:00:00Z'));
      expect(parseDateCell('1405/13/01')).toBe('invalid');
      expect(safeText('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")');
      expect(safeText('+98912')).toBe("'+98912");
      expect(safeText('مجتمع')).toBe('مجتمع');
    });
  });

  /* ── the whole life of a placement ─────────────────────────────────────── */

  describe('a placement, from the venue to the deposit back', () => {
    let venueId: string; let projectId: string; let contactId: string;

    it('lists the organisation’s own lists, and lets its configurer add to them', async () => {
      const options = expectOk(await get('/site-options', T.pmo), 'options');
      expect(options.some((o: { list: string; code: string }) => o.list === 'VENUE_TYPE' && o.code === 'MALL')).toBe(true);
      expect(options.find((o: { list: string; code: string }) => o.list === 'COOPERATION' && o.code === 'FORMAL').meta).toEqual({ requiresContract: true });
      expect((await post('/site-options', T.account, { list: 'VENUE_TYPE', code: 'KIOSK', labelFa: 'کیوسک' })).status).toBe(403);
      const made = expectOk(await post('/site-options', T.pmo, { list: 'VENUE_TYPE', code: 'stadium', labelFa: 'ورزشگاه', labelEn: 'Stadium' }), 'option');
      expect(made.code).toBe('STADIUM');
      expect((await post('/site-options', T.pmo, { list: 'VENUE_TYPE', code: 'STADIUM', labelFa: 'دوباره' })).status).toBe(409);
      // Retired, it is refused for new records — and kept.
      expectOk(await patch(`/site-options/${made.id}`, T.pmo, { isActive: false }), 'retire');
      const refused = await post('/venues', T.pmo, { name: 'ورزشگاه آزادی آزمون', province: 'تهران', city: 'تهران', typeCode: 'STADIUM', address: 'بزرگراه', phone: '02144000001' });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('UNKNOWN_OPTION');
    });

    it('records a venue with its people and channels, and refuses one that looks like it', async () => {
      const v = expectOk(await post('/venues', T.pmo, {
        name: 'مجتمع تجاری کوروش آزمون', province: 'تهران', city: 'تهران', address: 'بلوار ستاری، تقاطع پیامبر', typeCode: 'MALL', gradeCode: 'A_PLUS',
        audienceCodes: ['FAMILY', 'MOTHER_CHILD'], phone: '021-44000000', email: 'info@kourosh.test',
        channels: [{ typeCode: 'WEBSITE', value: 'https://kourosh.test' }],
        contacts: [
          { fullName: 'علی مدیرزاده', roleCode: 'CEO', phone: '09121110001', isPrimary: true, channels: [{ typeCode: 'WHATSAPP', value: '09121110001' }] },
          { fullName: 'نرگس بازاریاب', roleCode: 'MARKETING', phone: '09121110002', email: 'm@kourosh.test' },
          { fullName: 'حسن فنی', roleCode: 'TECHNICAL', phone: '09121110003' },
        ],
      }), 'venue');
      venueId = v.id;
      expect(v.code).toMatch(/^VEN-\d{6}$/);
      const dup = await post('/venues', T.pmo, { name: 'مجتمع تجاري كوروش آزمون', province: 'تهران', city: 'تهران', typeCode: 'MALL', address: 'جای دیگر', phone: '02199999999' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('POSSIBLE_DUPLICATE');
      expect(dup.body.error.details.candidates[0].reasons).toContain('NAME_CITY');
      // By a contact's phone too.
      const byPhone = await post('/venues', T.pmo, { name: 'شعبهٔ دیگر', province: 'البرز', city: 'کرج', typeCode: 'MALL', address: 'کرج', phone: '+98 912 111 0002' });
      expect(byPhone.status).toBe(409);
      expect(byPhone.body.error.details.candidates[0].reasons).toContain('PHONE');
      // The organisation's required fields: an address and a phone, by default.
      const bare = await post('/venues', T.pmo, { name: 'مکان بی‌نشانی', province: 'تهران', city: 'تهران', typeCode: 'METRO' });
      expect(bare.status).toBe(400);
    });

    it('keeps photos with the venue, read with venue.read only', async () => {
      const photo = expectOk(await upload(T.pmo, { name: 'entrance.png', type: 'image/png', content: await png() }, { venueId, category: 'ENTRANCE', caption: 'ورودی اصلی' }), 'photo');
      expect(photo.venueId).toBe(venueId);
      expect(photo.category).toBe('ENTRANCE');
      expectOk(await upload(T.pmo, { name: 'inside.png', type: 'image/png', content: await png() }, { venueId, category: 'INSIDE' }), 'photo 2');
      // A venue's file is filed by someone who may write there, on nothing else.
      expect((await upload(T.designer, { name: 'x.png', type: 'image/png', content: await png() }, { venueId })).status).toBe(403);
      const profile = expectOk(await get(`/venues/${venueId}`, T.account), 'profile');
      expect(profile.contacts).toHaveLength(3);
      expect(profile.contacts[0].fullName).toBe('علی مدیرزاده');
      expect(profile.contacts[0].channels[0].typeCode).toBe('WHATSAPP');
      expect(profile.documents).toHaveLength(2);
      expect(profile.completeness).toEqual({ score: 100, missing: [] });
      contactId = profile.contacts[1].id;
      // A unit's designer reads the venues (to design for them) but files nothing on them.
      expect((await get(`/venues/${venueId}`, T.designer)).status).toBe(200);
      const docs = expectOk(await get('/documents', T.designer, { venueId }), 'docs');
      expect(docs).toHaveLength(2);
    });

    it('finds venues by filters, search and completeness', async () => {
      const list = expectOk(await get('/venues', T.sales, { q: 'کوروش', province: 'تهران' }), 'list');
      expect(list.items.map((v: { id: string }) => v.id)).toContain(venueId);
      expect(list.items.find((v: { id: string }) => v.id === venueId).primaryContact.fullName).toBe('علی مدیرزاده');
      const byPhone = expectOk(await get('/venues', T.sales, { q: '09121110003' }), 'by phone');
      expect(byPhone.items.map((v: { id: string }) => v.id)).toContain(venueId);
      const audience = expectOk(await get('/venues', T.sales, { audience: 'MOTHER_CHILD', gradeCode: 'A_PLUS' }), 'audience');
      expect(audience.items.map((v: { id: string }) => v.id)).toContain(venueId);
      const incomplete = expectOk(await get('/venues', T.sales, { incomplete: 'true', pageSize: '200' }), 'incomplete');
      expect(incomplete.items.map((v: { id: string }) => v.id)).not.toContain(venueId);
      expect((await post('/venues', T.sales, {})).status).toBe(403);
    });

    it('merges a duplicate into the venue that stays, or keeps two apart, by someone who may', async () => {
      const twin = expectOk(await post('/venues', T.pmo, { name: 'کوروش (ثبت دوباره)', province: 'تهران', city: 'تهران', typeCode: 'MALL', address: 'ستاری', phone: '02144000000', confirmNotDuplicate: true }), 'twin');
      const other = expectOk(await post('/venues', T.pmo, { name: 'مترو صادقیه آزمون', province: 'تهران', city: 'تهران', typeCode: 'METRO', address: 'میدان صادقیه', phone: '02144000000', confirmNotDuplicate: true }), 'other');
      const profile = expectOk(await get(`/venues/${venueId}`, T.pmo), 'profile');
      expect(profile.duplicates.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([twin.id, other.id]));
      expect((await post(`/venues/${venueId}/duplicates/decision`, T.account, { otherId: twin.id, decision: 'MERGE', reason: 'یک مکان' })).status).toBe(403);
      expectOk(await post(`/venues/${venueId}/duplicates/decision`, T.pmo, { otherId: other.id, decision: 'DISTINCT', reason: 'مترو جداست، تلفن مشترک مرکز است' }), 'distinct');
      const merged = expectOk(await post(`/venues/${venueId}/duplicates/decision`, T.pmo, { otherId: twin.id, decision: 'MERGE', reason: 'همان مجتمع' }), 'merge');
      expect(merged.decision).toBe('MERGE');
      const after = expectOk(await get(`/venues/${venueId}`, T.pmo), 'after');
      expect(after.duplicates).toEqual([]);
      expect(after.mergedFrom.map((m: { id: string }) => m.id)).toEqual([twin.id]);
      expect(expectOk(await get(`/venues/${twin.id}`, T.pmo), 'twin').mergedInto.id).toBe(venueId);
    });

    it('creates a project in the venue, and moves it only as the rules allow', async () => {
      const p = expectOk(await post('/site-projects', T.account, {
        name: 'کانتر جشنوارهٔ پاییز — کوروش', venueId, placement: 'طبقهٔ همکف، کنار آسانسور', responsibleId: users.account,
        cooperationCode: 'FORMAL', installCost: '120000000', transportCost: '15000000',
      }), 'project');
      projectId = p.id;
      expect(p.code).toMatch(/^SIT-\d{6}$/);
      expect(p.state).toBe('DRAFT');
      expect(p.currency).toBe('IRR');
      expectOk(await move('siteProject', projectId, 'evaluate', T.account), 'evaluate');
      expectOk(await move('siteProject', projectId, 'negotiate', T.account), 'negotiate');
      // Terms are not agreed with nothing agreed.
      const early = await move('siteProject', projectId, 'agree_terms', T.account);
      expect(early.status).toBe(422);
      expect(early.body.error.details.guard).toBe('siteProject.termsComplete');
      // Nor straight to installation.
      expect((await move('siteProject', projectId, 'plan_installation', T.account)).status).toBe(409);
    });

    it('keeps the negotiation’s history, follow-up and all', async () => {
      const first = expectOk(await post(`/site-projects/${projectId}/negotiations`, T.account, {
        heldAt: day(-10).toISOString(), channel: 'MEETING', summary: 'پیشنهاد اولیهٔ مجتمع: اجارهٔ ۴۰ میلیون، ودیعه ۱۰۰ میلیون',
        proposedRent: '40000000', proposedDeposit: '100000000', proposedCharge: '5000000', outcome: 'COUNTER_OFFER',
        nextAction: 'پیشنهاد متقابل ۳۰ میلیون', followUpAt: day(1).toISOString(), assigneeId: users.account,
        contactIds: [contactId], userIds: [users.account], otherParticipants: ['کارگزار مستقل'],
      }), 'negotiation');
      expect(first.outcome).toBe('COUNTER_OFFER');
      // Someone from another venue is not at this one's negotiation.
      const other = await prisma.venueContact.findFirst({ where: { venueId: { not: venueId } }, select: { id: true } });
      if (other) expect((await post(`/site-projects/${projectId}/negotiations`, T.account, { heldAt: day(-1).toISOString(), summary: 'غریبه', contactIds: [other.id] })).status).toBe(422);
      expectOk(await post(`/site-projects/${projectId}/negotiations`, T.account, {
        heldAt: day(-2).toISOString(), channel: 'PHONE', summary: 'توافق نهایی: اجاره ۳۰ میلیون ماهیانه، ودیعه ۶۰ میلیون، شارژ ۳ میلیون',
        proposedRent: '30000000', proposedDeposit: '60000000', proposedCharge: '3000000', outcome: 'AGREED',
      }), 'agreed');
      expectOk(await patch(`/site-negotiations/${first.id}`, T.account, { followUpDone: true }), 'done');
      const detail = expectOk(await get(`/site-projects/${projectId}`, T.account), 'detail');
      expect(detail.negotiations).toHaveLength(2);
      expect(detail.negotiations[1].participants.map((x: { name: string | null }) => x.name)).toContain('کارگزار مستقل');
      expect(detail.negotiations[1].followUpDoneAt).not.toBeNull();
    });

    it('agrees the terms, then sends a contract that needs its file and someone else to approve it', async () => {
      const before = expectOk(await get(`/site-projects/${projectId}`, T.account), 'before');
      const start = day(-40), end = addJalaliMonths(start, 6);
      expectOk(await patch(`/site-projects/${projectId}`, T.account, {
        version: before.version, contractStart: start.toISOString(), contractEnd: end.toISOString(),
        depositAmount: '60000000', rentAmount: '30000000', rentPeriod: 'MONTHLY', rentDueDay: 5, rentMethodCode: 'CHEQUE',
        chargeAmount: '3000000', chargeDueDay: 0, chargeMethodCode: 'TRANSFER',
      }), 'terms');
      // An edit on an older reading is refused, not merged.
      expect((await patch(`/site-projects/${projectId}`, T.account, { version: before.version, notes: 'دیر' })).status).toBe(409);
      expectOk(await move('siteProject', projectId, 'agree_terms', T.account), 'agree');

      const c = expectOk(await post(`/site-projects/${projectId}/contracts`, T.account, { reference: 'ق-۱۴۰۵-۲۲' }), 'contract');
      expect(c.version).toBe(1);
      expect(c.terms.rentAmount).toBe('30000000');
      const noFile = await post(`/site-contracts/${c.id}/submit`, T.account);
      expect(noFile.status).toBe(422);
      expect(noFile.body.error.details.guard).toBe('siteProject.contractSubmitted');
      expectOk(await upload(T.account, { name: 'contract.pdf', type: 'application/pdf', content: tinyPdf('contract') }, { siteProjectId: projectId, siteRecordType: 'contract', siteRecordId: c.id }), 'file');
      expect((await upload(T.account, { name: 'x.pdf', type: 'application/pdf', content: tinyPdf() }, { siteProjectId: projectId, siteRecordType: 'contract', siteRecordId: venueId })).status).toBe(422);
      expectOk(await post(`/site-contracts/${c.id}/submit`, T.account), 'submit');
      expect(expectOk(await get(`/site-projects/${projectId}`, T.account), 'pending').state).toBe('CONTRACT_PENDING');
      // Terms are the contract's now.
      const locked = expectOk(await get(`/site-projects/${projectId}`, T.account), 'locked');
      const r = await patch(`/site-projects/${projectId}`, T.account, { version: locked.version, rentAmount: '1' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('TERMS_LOCKED');
      // The writer does not decide it; an account executive may not at all.
      expect((await post(`/site-contracts/${c.id}/decision`, T.account, { decision: 'APPROVE' })).status).toBe(403);
      expect((await post(`/site-contracts/${c.id}/decision`, T.legal, { decision: 'REJECT' })).status).toBe(400);
      expectOk(await post(`/site-contracts/${c.id}/decision`, T.legal, { decision: 'APPROVE', comment: 'بندها بررسی شد' }), 'approve');
      const approved = expectOk(await get(`/site-projects/${projectId}`, T.account), 'approved');
      expect(approved.state).toBe('CONTRACT_APPROVED');
      expect(approved.approvals.find((a: { kind: string }) => a.kind === 'CONTRACT').decision).toBe('APPROVED');
      // Its file is evidence now: not deleted.
      const file = approved.documents.find((d: { siteRecordType: string }) => d.siteRecordType === 'contract');
      expect((await (await app()).inject({ method: 'DELETE', url: `/api/v1/documents/${file.id}`, headers: { authorization: `Bearer ${T.admin}` } })).statusCode).toBe(409);
    });

    it('plans and records the installation with its counters and people', async () => {
      expect((await move('siteProject', projectId, 'plan_installation', T.account)).status).toBe(422);
      const before = expectOk(await get(`/site-projects/${projectId}`, T.account), 'before');
      expectOk(await patch(`/site-projects/${projectId}`, T.account, { version: before.version, installPlannedAt: day(-35).toISOString() }), 'plan date');
      const supplier = await prisma.supplier.findFirst({ select: { id: true } });
      expectOk(await post(`/site-projects/${projectId}/counters`, T.account, { label: 'کانتر اصلی', quantity: 2, widthCm: 200, depthCm: 80, heightCm: 110, unitCost: '45000000', supplierId: supplier?.id ?? null }), 'counter');
      expectOk(await post(`/site-projects/${projectId}/assignments`, T.account, { role: 'PROMOTER', personName: 'مریم پروموتر', phone: '09120000001', startsOn: day(-34).toISOString(), shift: '۱۰ تا ۱۸' }), 'promoter');
      expectOk(await post(`/site-projects/${projectId}/assignments`, T.account, { role: 'SUPERVISOR', userId: users.pmo }), 'supervisor');
      expect((await post(`/site-projects/${projectId}/assignments`, T.account, { role: 'PROMOTER' })).status).toBe(400);
      expectOk(await move('siteProject', projectId, 'plan_installation', T.account), 'planned');
      expectOk(await move('siteProject', projectId, 'start_installation', T.account), 'installing');
      const p = expectOk(await get(`/site-projects/${projectId}`, T.account), 'p');
      expectOk(await patch(`/site-projects/${projectId}`, T.account, { version: p.version, installedAt: day(-34).toISOString(), installDays: 1 }), 'installed');
      // Not live without its photo and its schedule.
      const early = await move('siteProject', projectId, 'activate', T.account);
      expect(early.status).toBe(422);
      expect(early.body.error.details.guard).toBe('siteProject.activationEvidence');
      expectOk(await upload(T.account, { name: 'installed.png', type: 'image/png', content: await png() }, { siteProjectId: projectId, siteRecordType: 'installation', caption: 'کانتر نصب‌شده' }), 'install photo');
      const noSchedule = await move('siteProject', projectId, 'activate', T.account);
      expect(noSchedule.body.error.details.guard).toBe('siteProject.scheduleReady');
    });

    it('builds the rental schedule: previewed, made once, the same when made again', async () => {
      expect((await post(`/site-projects/${projectId}/schedule`, T.account, { dryRun: true })).status).toBe(403);
      const preview = expectOk(await post(`/site-projects/${projectId}/schedule`, T.finance, { dryRun: true }), 'preview');
      expect(preview.create.filter((x: { kind: string }) => x.kind === 'RENT')).toHaveLength(6);
      expect(preview.create.filter((x: { kind: string }) => x.kind === 'CHARGE')).toHaveLength(6);
      expect(preview.create.filter((x: { kind: string }) => x.kind === 'DEPOSIT')).toHaveLength(1);
      expect(await prisma.siteObligation.count({ where: { siteProjectId: projectId } })).toBe(0);
      expectOk(await post(`/site-projects/${projectId}/schedule`, T.finance, { dryRun: false }), 'commit');
      expect(await prisma.siteObligation.count({ where: { siteProjectId: projectId } })).toBe(13);
      const again = expectOk(await post(`/site-projects/${projectId}/schedule`, T.finance, { dryRun: false }), 'again');
      expect(again.create).toHaveLength(0);
      expect(await prisma.siteObligation.count({ where: { siteProjectId: projectId } })).toBe(13);
      expectOk(await move('siteProject', projectId, 'activate', T.account), 'live');
      expect(expectOk(await get(`/site-projects/${projectId}`, T.account), 'live').installStatus).toBe('DONE');
    });

    it('records payments exactly: oldest first, partial, by allocation, once however often sent', async () => {
      // The deposit, by cheque — the cheque's number is asked for.
      const deposit = await prisma.siteObligation.findFirstOrThrow({ where: { siteProjectId: projectId, kind: 'DEPOSIT' } });
      const noCheque = await post(`/site-projects/${projectId}/payments`, T.finance, { amount: '60000000', paidAt: day(-40).toISOString(), methodCode: 'CHEQUE', clientKey: key(), allocations: [{ obligationId: deposit.id, amount: '60000000' }] });
      expect(noCheque.status).toBe(400);
      const k = key();
      const paid = await post(`/site-projects/${projectId}/payments`, T.finance, { amount: '60000000', paidAt: day(-40).toISOString(), methodCode: 'CHEQUE', chequeNumber: '۷۷۸۸۹۹', chequeBank: 'ملت', clientKey: k, allocations: [{ obligationId: deposit.id, amount: '60000000' }] });
      expect(paid.status).toBe(201);
      // Sent again — a double click, a retry: the same payment, recorded once.
      const replay = await post(`/site-projects/${projectId}/payments`, T.finance, { amount: '60000000', paidAt: day(-40).toISOString(), methodCode: 'CHEQUE', chequeNumber: '۷۷۸۸۹۹', clientKey: k, allocations: [{ obligationId: deposit.id, amount: '60000000' }] });
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(paid.body.id);
      expect((await post(`/site-projects/${projectId}/payments`, T.finance, { amount: '1000', paidAt: day(-1).toISOString(), methodCode: 'CASH', clientKey: k })).status).toBe(409);
      expect(await prisma.sitePayment.count({ where: { siteProjectId: projectId } })).toBe(1);

      // The first month's rent and charge, oldest first, and part of the second rent.
      const firstRent = await prisma.siteObligation.findFirstOrThrow({ where: { siteProjectId: projectId, kind: 'RENT' }, orderBy: { dueDate: 'asc' } });
      const payment = expectOk(await post(`/site-projects/${projectId}/payments`, T.finance, { amount: '43000000', paidAt: day(-30).toISOString(), methodCode: 'TRANSFER', reference: 'TRX-1', clientKey: key() }), 'oldest first');
      expect(payment.allocations.length).toBeGreaterThanOrEqual(2);
      const rent1 = await prisma.siteObligation.findUniqueOrThrow({ where: { id: firstRent.id } });
      expect(rent1.status).toBe('SETTLED');
      const partial = await prisma.siteObligation.findMany({ where: { siteProjectId: projectId, status: 'PARTIAL' } });
      expect(partial).toHaveLength(1);
      // 43m: the first charge (3m), the first rent (30m), the second charge (3m), and 7m of the second rent.
      expect(Number(partial[0]!.settledAmount)).toBe(7000000);

      // More than what is owed is refused (the organisation's default), the allocation's arithmetic too.
      const over = await post(`/site-projects/${projectId}/payments`, T.finance, { amount: '999999999999', paidAt: day(-1).toISOString(), methodCode: 'TRANSFER', clientKey: key() });
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe('OVERPAYMENT');
      const tooMuch = await post(`/site-projects/${projectId}/payments`, T.finance, { amount: '50000000', paidAt: day(-1).toISOString(), methodCode: 'TRANSFER', clientKey: key(), allocations: [{ obligationId: partial[0]!.id, amount: '50000000' }] });
      expect(tooMuch.body.error.code).toBe('OVER_ALLOCATED');
      // Someone without rental.manage records nothing.
      expect((await post(`/site-projects/${projectId}/payments`, T.account, { amount: '1000', paidAt: day(-1).toISOString(), methodCode: 'CASH', clientKey: key() })).status).toBe(403);

      const ledger = expectOk(await get(`/site-projects/${projectId}/ledger`, T.finance), 'ledger');
      expect(ledger.balances.deposit).toMatchObject({ original: '60000000.00', held: '60000000.00', remaining: '60000000.00', status: 'HELD' });
      expect(ledger.balances.byKind.RENT.settled).toBe('37000000.00');
      expect(ledger.balances.paidOut).toBe('103000000.00');
      expect(ledger.balances.costs).toMatchObject({ installation: '120000000.00', transport: '15000000.00', fabrication: '90000000.00' });
    });

    it('takes a mistaken payment back with its reason, reopening what it settled', async () => {
      const wrong = expectOk(await post(`/site-projects/${projectId}/payments`, T.finance, { amount: '5000000', paidAt: day(-2).toISOString(), methodCode: 'CASH', clientKey: key() }), 'wrong');
      const before = await prisma.siteObligation.findMany({ where: { siteProjectId: projectId, status: { in: ['OPEN', 'PARTIAL'] } }, orderBy: { dueDate: 'asc' } });
      expect((await post(`/site-payments/${wrong.id}/reverse`, T.finance, { reason: '' })).status).toBe(400);
      expectOk(await post(`/site-payments/${wrong.id}/reverse`, T.finance, { reason: 'دو بار وارد شد' }), 'reverse');
      expect((await post(`/site-payments/${wrong.id}/reverse`, T.finance, { reason: 'دوباره' })).status).toBe(409);
      const after = await prisma.siteObligation.findUniqueOrThrow({ where: { id: before[0]!.id } });
      expect(Number(after.settledAmount)).toBe(Number(before[0]!.settledAmount) - 5000000);
      const audit = await prisma.auditEvent.findFirst({ where: { entityId: projectId, action: 'PAYMENT_REVERSED' } });
      expect(audit?.reason).toBe('دو بار وارد شد');
    });

    it('records a penalty, and lists the register by status, due date and place', async () => {
      expectOk(await post(`/site-projects/${projectId}/obligations`, T.finance, { kind: 'PENALTY', categoryCode: 'LATE_FEE', description: 'تأخیر در پرداخت شارژ', dueDate: day(-3).toISOString(), amount: '2000000' }), 'penalty');
      const overdue = expectOk(await get('/site-obligations', T.finance, { status: 'overdue', siteProjectId: projectId, pageSize: '100' }), 'overdue');
      expect(overdue.items.some((o: { kind: string; overdue: boolean }) => o.kind === 'PENALTY' && o.overdue)).toBe(true);
      expect(overdue.totals[0].currency).toBe('IRR');
      const byCity = expectOk(await get('/site-obligations', T.finance, { city: 'تهران', status: 'all', pageSize: '200' }), 'by city');
      expect(byCity.items.every((o: { siteProject: { venue: { city: string } } }) => o.siteProject.venue.city === 'تهران')).toBe(true);
      const cal = expectOk(await get('/site-obligations/calendar', T.finance, { from: day(-31).toISOString(), to: day(29).toISOString() }), 'calendar');
      expect(cal.items.length).toBeGreaterThan(0);
      expect((await get('/site-obligations', T.account)).status).toBe(403);
      // An amount below what was paid against it is refused; a change says why.
      const partial = await prisma.siteObligation.findFirstOrThrow({ where: { siteProjectId: projectId, status: 'PARTIAL' } });
      expect((await patch(`/site-obligations/${partial.id}`, T.finance, { amount: '1', reason: 'اشتباه' })).body.error.code).toBe('BELOW_SETTLED');
    });

    it('reminds of what is due and overdue, once — the run repeated sends nothing', async () => {
      await put('/site-settings', T.pmo, { reminders: { userIds: [users.pmo] } });
      const first = await runReminders(new Date());
      expect(first.sent).toBeGreaterThan(0);
      const rows = await prisma.siteReminder.findMany({ where: { siteProjectId: projectId } });
      expect(rows.some((r) => r.event === 'PENALTY_OUTSTANDING')).toBe(true);
      expect(rows.some((r) => r.recipient === users.account)).toBe(true); // the responsible colleague
      expect(rows.some((r) => r.recipient === users.finance)).toBe(true); // rental.manage in their own right
      const notes = await prisma.notification.count({ where: { kind: 'SITE_REMINDER', entityId: projectId } });
      const second = await runReminders(new Date());
      expect(await prisma.siteReminder.count({ where: { siteProjectId: projectId } })).toBe(rows.length);
      expect(await prisma.notification.count({ where: { kind: 'SITE_REMINDER', entityId: projectId } })).toBe(notes);
      expect(second.skipped).toBeGreaterThan(0);
      const log = expectOk(await get('/site-reminders', T.finance), 'log');
      expect(log.items[0].recipientName).toBeTruthy();
      // Turned off, an event sends nothing new.
      expectOk(await put('/site-settings', T.pmo, { reminders: { events: { PENALTY_OUTSTANDING: false } } }), 'off');
      expect((await put('/site-settings', T.finance, {})).status).toBe(403);
    });

    it('records the client’s approval with its evidence', async () => {
      const a = expectOk(await post(`/site-projects/${projectId}/approvals`, T.account, { decision: 'APPROVED', approverName: 'مهندس کارفرما', approverTitle: 'مدیر برند', decidedAt: day(-33).toISOString(), subject: 'INSTALLATION' }), 'employer');
      expectOk(await upload(T.account, { name: 'signed.png', type: 'image/png', content: await png() }, { siteProjectId: projectId, siteRecordType: 'approval', siteRecordId: a.id }), 'evidence');
      expect((await post(`/site-projects/${projectId}/approvals`, T.account, { decision: 'APPROVED', approverName: 'آینده', decidedAt: day(3).toISOString() })).status).toBe(400);
    });

    it('closes only when everything is settled: rent, charge, penalty, the deposit — with approvals by others', async () => {
      expectOk(await move('siteProject', projectId, 'start_settlement', T.account), 'settling');
      const early = await move('siteProject', projectId, 'request_closure', T.account);
      expect(early.status).toBe(422);
      expect(early.body.error.details.guard).toBe('siteProject.settled');
      const closure = expectOk(await get(`/site-projects/${projectId}/closure`, T.finance), 'closure');
      expect(closure.verdict.ok).toBe(false);
      expect(closure.steps.find((s: { key: string }) => s.key === 'deposit').done).toBe(false);

      // What has not fallen due is void (the placement ended early); the rest is paid or kept from the deposit.
      const future = await prisma.siteObligation.findMany({ where: { siteProjectId: projectId, status: 'OPEN', dueDate: { gt: new Date() }, settledAmount: 0 } });
      for (const o of future) expectOk(await post(`/site-obligations/${o.id}/close`, T.finance, { action: 'VOID', reason: 'جمع‌آوری زودتر از پایان قرارداد' }), 'void');
      const penalty = await prisma.siteObligation.findFirstOrThrow({ where: { siteProjectId: projectId, kind: 'PENALTY' } });
      // The venue keeps the penalty from the deposit — proposed by one, approved by another.
      const d = expectOk(await post(`/site-projects/${projectId}/deductions`, T.finance, { amount: '2000000', reason: 'جریمهٔ تأخیر از ودیعه کسر شد', obligationId: penalty.id }), 'deduction');
      expect(d.status).toBe('PROPOSED');
      expect((await post(`/site-deposit-entries/${d.id}/decision`, T.finance, { decision: 'APPROVE' })).status).toBe(403);
      expect((await post(`/site-deposit-entries/${d.id}/decision`, T.account, { decision: 'APPROVE' })).status).toBe(403);
      expectOk(await post(`/site-deposit-entries/${d.id}/decision`, T.admin, { decision: 'APPROVE', comment: 'مستند کسر دیده شد' }), 'approved');
      expect((await prisma.siteObligation.findUniqueOrThrow({ where: { id: penalty.id } })).status).toBe('SETTLED');
      // More than is left of the deposit is refused.
      expect((await post(`/site-projects/${projectId}/deductions`, T.finance, { amount: '999000000', reason: 'زیاد' })).body.error.code).toBe('OVER_DEDUCTION');

      // What is still owed, paid.
      const open = await prisma.siteObligation.findMany({ where: { siteProjectId: projectId, status: { in: ['OPEN', 'PARTIAL'] } } });
      const owed = open.reduce((s, o) => s + Number(o.amount) - Number(o.settledAmount), 0);
      if (owed > 0) expectOk(await post(`/site-projects/${projectId}/payments`, T.finance, { amount: String(owed), paidAt: day(-1).toISOString(), methodCode: 'TRANSFER', clientKey: key() }), 'pay the rest');

      // The deposit back: never more than is left with the venue.
      expect((await post(`/site-projects/${projectId}/payments`, T.finance, { purpose: 'DEPOSIT_REFUND', amount: '60000000', paidAt: day(0).toISOString(), methodCode: 'TRANSFER', clientKey: key() })).body.error.code).toBe('OVER_REFUND');
      expectOk(await post(`/site-projects/${projectId}/payments`, T.finance, { purpose: 'DEPOSIT_REFUND', amount: '58000000', paidAt: day(0).toISOString(), methodCode: 'TRANSFER', reference: 'REF-BACK', clientKey: key() }), 'refund');
      const ledger = expectOk(await get(`/site-projects/${projectId}/ledger`, T.finance), 'ledger');
      expect(ledger.balances.deposit).toMatchObject({ held: '60000000.00', deductionsApproved: '2000000.00', refunded: '58000000.00', remaining: '0.00', status: 'REFUNDED' });
      expect(ledger.balances.outstanding).toBe('0.00');

      expectOk(await move('siteProject', projectId, 'request_closure', T.account), 'request');
      // Closing is for someone holding site.close.
      expect((await move('siteProject', projectId, 'close', T.account)).status).toBe(403);
      expectOk(await move('siteProject', projectId, 'close', T.pmo), 'close');
      const closed = await prisma.siteProject.findUniqueOrThrow({ where: { id: projectId } });
      expect(closed.state).toBe('CLOSED');
      expect((closed.closureStatement as { deposit: { status: string } }).deposit.status).toBe('REFUNDED');
      // Its books are closed: no payment, reversal or deduction.
      expect((await post(`/site-projects/${projectId}/payments`, T.finance, { amount: '1000', paidAt: day(0).toISOString(), methodCode: 'CASH', clientKey: key() })).body.error.code).toBe('PROJECT_CLOSED');
      const anyPayment = await prisma.sitePayment.findFirstOrThrow({ where: { siteProjectId: projectId, reversedAt: null } });
      expect((await post(`/site-payments/${anyPayment.id}/reverse`, T.finance, { reason: 'بعد از بستن' })).status).toBe(409);
      const transitions = await prisma.stateTransition.count({ where: { entityType: 'siteProject', entityId: projectId } });
      expect(transitions).toBeGreaterThanOrEqual(11);
    });

    it('reports real figures, by currency and place, with what each means', async () => {
      const venues = expectOk(await get('/site-reports/venues', T.sales), 'venues');
      expect(venues.byType.find((r: { key: string }) => r.key === 'MALL').n).toBeGreaterThan(0);
      expect(venues.byAudience.find((r: { key: string }) => r.key === 'FAMILY')).toBeTruthy();
      const projects = expectOk(await get('/site-reports/projects', T.account), 'projects');
      expect(projects.groups.completed).toBeGreaterThan(0);
      expect(projects.costs.find((c: { currency: string }) => c.currency === 'IRR').fabrication).not.toBe('0.00');
      const rentals = expectOk(await get('/site-reports/rentals', T.finance), 'rentals');
      expect(rentals.definitions.outstanding).toBeTruthy();
      expect(rentals.cashflow.some((m: { out: string }) => Number(m.out) > 0)).toBe(true);
      expect(rentals.deposits.byCurrency[0].refunded).not.toBe('0.00');
      expect((await get('/site-reports/rentals', T.account)).status).toBe(403);
      const dash = expectOk(await get('/rentals/dashboard', T.finance), 'dashboard');
      expect(dash.counts).toHaveProperty('overdue');
    });
  });

  /* ── what is refused ───────────────────────────────────────────────────── */

  describe('the refusals', () => {
    it('does not cancel a project with money still with the venue, and voids what was never paid when it does', async () => {
      const v = expectOk(await post('/venues', T.pmo, { name: 'شهربازی آزمون لغو', province: 'اصفهان', city: 'اصفهان', typeCode: 'AMUSEMENT_PARK', address: 'خیابان آزمون', phone: '03132000000' }), 'venue');
      const p = expectOk(await post('/site-projects', T.account, { name: 'پروژهٔ لغو', venueId: v.id, cooperationCode: 'INVOICE', contractStart: day(-5).toISOString(), contractEnd: day(55).toISOString(), depositAmount: '10000000', rentAmount: '5000000', rentMethodCode: 'CASH' }), 'p');
      for (const a of ['evaluate', 'negotiate']) expectOk(await move('siteProject', p.id, a, T.account), a);
      expectOk(await post(`/site-projects/${p.id}/negotiations`, T.account, { heldAt: day(-6).toISOString(), summary: 'توافق فاکتوری', outcome: 'AGREED' }), 'agreed');
      expectOk(await move('siteProject', p.id, 'agree_terms', T.account), 'agree');
      const c = expectOk(await post(`/site-projects/${p.id}/contracts`, T.account, {}), 'contract');
      // An invoice arrangement needs no contract file.
      expectOk(await post(`/site-contracts/${c.id}/submit`, T.account), 'submit');
      expectOk(await post(`/site-contracts/${c.id}/decision`, T.legal, { decision: 'APPROVE' }), 'approve');
      expectOk(await post(`/site-projects/${p.id}/schedule`, T.finance, { dryRun: false }), 'schedule');
      const dep = await prisma.siteObligation.findFirstOrThrow({ where: { siteProjectId: p.id, kind: 'DEPOSIT' } });
      expectOk(await post(`/site-projects/${p.id}/payments`, T.finance, { amount: '10000000', paidAt: day(-4).toISOString(), methodCode: 'CASH', clientKey: key(), allocations: [{ obligationId: dep.id, amount: '10000000' }] }), 'deposit');
      const refused = await move('siteProject', p.id, 'cancel', T.account, 'مکان منصرف شد');
      expect(refused.status).toBe(422);
      expect(refused.body.error.details.guard).toBe('siteProject.noMoneyOpen');
      expectOk(await post(`/site-projects/${p.id}/payments`, T.finance, { purpose: 'DEPOSIT_REFUND', amount: '10000000', paidAt: day(0).toISOString(), methodCode: 'CASH', clientKey: key() }), 'back');
      expect((await move('siteProject', p.id, 'cancel', T.account)).status).toBe(400); // a reason is required
      expectOk(await move('siteProject', p.id, 'cancel', T.account, 'مکان منصرف شد'), 'cancel');
      const left = await prisma.siteObligation.groupBy({ by: ['status'], where: { siteProjectId: p.id }, _count: { _all: true } });
      expect(left.find((x) => x.status === 'VOID')!._count._all).toBeGreaterThan(0);
      expect(left.find((x) => x.status === 'SETTLED')!._count._all).toBe(1); // the deposit, kept as history
      // A waiver is the documented way past a rule — and it is not needed here any more.
      expect((await post(`/site-projects/${p.id}/counters`, T.account, { label: 'دیر' })).status).toBe(409);
    });

    it('keeps another organisation’s venue and project out of reach', async () => {
      const org = await prisma.organization.create({ data: { name: 'سازمان دیگر آزمون مکان' } });
      const someone = await prisma.user.findFirstOrThrow({ select: { id: true } });
      const foreign = await prisma.venue.create({ data: { organizationId: org.id, code: `VEN-X${Date.now()}`, name: 'مکان سازمان دیگر', nameKey: 'x', province: 'تهران', city: 'تهران', typeCode: 'MALL', createdById: someone.id } });
      expect((await get(`/venues/${foreign.id}`, T.pmo)).status).toBe(404);
      expect((await post('/site-projects', T.account, { name: 'در مکان دیگران', venueId: foreign.id })).status).toBe(422);
      expect((await upload(T.pmo, { name: 'x.png', type: 'image/png', content: await png() }, { venueId: foreign.id })).status).toBe(422);
      expect((await get('/venues/00000000-0000-4000-8000-000000000000', T.pmo)).status).toBe(404);
      expect((await post('/site-projects', T.account, { name: 'نامعتبر', venueId: '00000000-0000-4000-8000-000000000000' })).status).toBe(422);
    });

    it('imports venues from Excel: checked row by row, written only when asked, skipped rows only when accepted', async () => {
      const file = await xlsx(['نام مکان', 'استان', 'شهر', 'آدرس', 'نوع مکان', 'گرید', 'مخاطبان', 'تلفن', 'نام مخاطب', 'سمت مخاطب', 'تلفن مخاطب'], [
        ['مجتمع تجاری اکسل یک', 'تهران', 'تهران', 'خیابان یک', 'مجتمع تجاری', 'A', 'خانواده، جوانان', '02155550001', 'رضا اکسلی', 'مدیرعامل', '09125550001'],
        ['مترو اکسل دو', 'تهران', 'تهران', 'خیابان دو', 'METRO', '', '', '02155550002', '', '', ''],
        ['', 'تهران', 'تهران', '', 'ناشناخته', 'Z', '', '', '', '', ''],
        ['مجتمع تجاری اکسل یک', 'تهران', 'تهران', 'خیابان یک', 'MALL', '', '', '02155550009', '', '', ''],
      ]);
      expect((await uploadTo('/site-data/import/VENUES', T.account, { name: 'venues.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: file })).status).toBe(403);
      const preview = expectOk(await uploadTo('/site-data/import/VENUES', T.pmo, { name: 'venues.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: file }), 'preview');
      expect(preview.dryRun).toBe(true);
      expect(preview.rows.map((r: { action: string }) => r.action)).toEqual(['CREATE', 'CREATE', 'ERROR', 'ERROR']);
      expect(preview.rows[2].errors.join(' ')).toMatch(/نام مکان|ناشناخته/);
      expect(preview.rows[3].errors.join(' ')).toMatch(/ردیف 2/);
      expect(await prisma.venue.count({ where: { name: 'مترو اکسل دو' } })).toBe(0);
      const refused = await uploadTo('/site-data/import/VENUES?dryRun=false', T.pmo, { name: 'venues.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: file });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('IMPORT_HAS_ERRORS');
      const done = expectOk(await uploadTo('/site-data/import/VENUES?dryRun=false&skipInvalid=true', T.pmo, { name: 'venues.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: file }), 'commit');
      expect(done.created).toBe(2);
      const v = await prisma.venue.findFirstOrThrow({ where: { name: 'مجتمع تجاری اکسل یک' }, include: { contacts: true } });
      expect(v).toMatchObject({ source: 'IMPORT', typeCode: 'MALL', gradeCode: 'A', importId: done.importId });
      expect(v.audienceCodes.sort()).toEqual(['FAMILY', 'YOUTH']);
      expect(v.contacts[0]).toMatchObject({ fullName: 'رضا اکسلی', roleCode: 'CEO', isPrimary: true });
      expect((v.importedValues as Record<string, string>).name).toBe('مجتمع تجاری اکسل یک');
      const history = expectOk(await get(`/site-data/imports/${done.importId}`, T.pmo), 'history');
      expect(history.report).toHaveLength(4);
      // Not a spreadsheet, whatever its name.
      expect((await uploadTo('/site-data/import/VENUES', T.pmo, { name: 'x.xlsx', type: 'application/octet-stream', content: Buffer.from('not a zip') })).status).toBe(400);
    });

    it('exports what the screen shows, with formulas written as text', async () => {
      await prisma.venue.updateMany({ where: { name: 'مترو اکسل دو' }, data: { notes: '=HYPERLINK("http://x","y")' } });
      const res = await (await app()).inject({ method: 'GET', url: '/api/v1/site-data/export/venues', headers: { authorization: `Bearer ${T.sales}` } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
      const sheet = wb.worksheets[0]!;
      expect(sheet.getRow(1).getCell(1).value).toBe('کد مکان');
      let found = '';
      sheet.eachRow((row) => row.eachCell((c) => { if (String(c.value).includes('HYPERLINK')) found = String(c.value); }));
      expect(found.startsWith("'=")).toBe(true);
      const obligations = await (await app()).inject({ method: 'GET', url: '/api/v1/site-data/export/obligations?status=all', headers: { authorization: `Bearer ${T.finance}` } });
      expect(obligations.statusCode).toBe(200);
      expect((await (await app()).inject({ method: 'GET', url: '/api/v1/site-data/export/payments', headers: { authorization: `Bearer ${T.sales}` } })).statusCode).toBe(403);
      const template = await (await app()).inject({ method: 'GET', url: '/api/v1/site-data/templates/SITE_PROJECTS', headers: { authorization: `Bearer ${T.account}` } });
      expect(template.statusCode).toBe(200);
    });

    it('texts the venues through the provider abstraction, and logs what it answered — never “delivered” on hope', async () => {
      const venue = await prisma.venue.findFirstOrThrow({ where: { name: 'مجتمع تجاری کوروش آزمون' } });
      expect((await post('/venue-messages', T.account, { venueIds: [venue.id], text: 'سلام {contact}' })).status).toBe(403);
      const out = expectOk(await post('/venue-messages', T.pmo, { venueIds: [venue.id], templateKey: 'visit', text: 'سلام {contact}، برای نصب در {venue} می‌آییم. {sender}' }), 'sms');
      // The test installation's provider is the sandbox: kept, not sent, and said so.
      expect(out.sandbox + out.failed).toBe(1);
      const m = await prisma.venueMessage.findFirstOrThrow({ where: { venueId: venue.id }, orderBy: { createdAt: 'desc' } });
      expect(m.text).toContain('علی مدیرزاده');
      expect(['SANDBOX', 'FAILED']).toContain(m.status);
      expect(m.status).not.toBe('DELIVERED');
    });
  });
});
