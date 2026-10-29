import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { closeApp, login } from './helpers.js';
import { prisma } from '../src/db.js';
import { fromMizito, rolesFor, similar, unitFor, type MizitoExport, type MizitoExtra, type SheetExport } from '../src/onboarding/mizito.js';
import { runMigration, standInEmail } from '../src/onboarding/migration.js';
import { run } from '../src/cli.js';

/**
 * The owner's request (2026-10-28): "bring everything from Mizito into this project — analyse it first,
 * then import it with care", with the company's client sheet beside it. A small made-up export stands
 * in for theirs: the same shapes, none of their data.
 */
const mizito: MizitoExport = {
  format: 'mizito-raw/1',
  users: [
    { _id: 'u1', first_name: 'سارا', last_name: 'نمونه', workspace_role_name: 'کارشناس ارشد گرافیک', role: 0 },
    { _id: 'u2', first_name: 'رضا', last_name: 'آزمون', workspace_role_name: 'مدیر امور مشتریان', role: 0, email: 'reza@example.com' },
    { _id: 'u3', first_name: 'مدیر', last_name: 'سیستم', workspace_role_name: 'مدیر عامل', role: 1, email: 'admin@hiva.local' },
  ],
  removedUsers: [{ _id: 'u9', first_name: 'رفته', last_name: 'پیشین', workspace_role_name: 'کارشناس رسانه' }],
  customers: [
    { _id: 'c1', title: 'H9001', name: 'H9001', short_name: 'بانک نمونه', phone: [{ phone_number: '02100000001' }, { phone_number: '02100000002' }], customer_admins: ['u2'], representatives: [{ name: 'خانم رابط', title: 'مدیر بازاریابی', mobile: [{ phone_number: '09120000001' }] }] },
    // Filed under another client's code: the sheet says H9002 is «بیمه آزمون», so this one is a second file of «بانک نمونه».
    { _id: 'c2', title: 'H9002', name: 'H9002', short_name: 'بانک نمونه', notes: 'پروندهٔ قدیمی' },
    { _id: 'c3', title: 'H9002', name: 'H9002', short_name: 'بیمه آزمون' },
  ],
  projects: [
    { _id: 'p1', title: 'بانک نمونه | ریبرندینگ', owner: 'u2' },
    { _id: 'p2', title: 'واحد خلاقیت' },
    { _id: 'p3', title: 'بیمه ازمون | کمپین (آرشیو شده)', owner: 'u2' },
    { _id: 'p4', title: 'برند تازه | هویت بصری', owner: 'u1' },
    { _id: 'p5', title: 'سئو سایت برند تازه (آرشیو شده)' },
    { _id: 'p6', title: 'کافه نمونه' },
    { _id: 'p7', title: 'جلسات هیوا' },
  ],
  tasks: [
    { _id: 't1', title: 'طرح لوگو', project: 'p1', owner: 'u2', assignee: ['u1'], progress: 40, created_at: '2026-08-01T08:00:00.000Z', deadline: '2026-09-01T08:00:00.000Z', has_deadline: true, checklist: [{ title: 'سه پیشنهاد', checked: true }, { title: 'نهایی', checked: false }] },
    { _id: 't2', title: 'گزارش کمپین', project: 'p3', owner: 'u9', assignee: ['u9'], completed: true, completed_at: '2026-06-10T10:00:00.000Z', created_at: '2026-05-01T08:00:00.000Z' },
    { _id: 't3', title: 'بی‌پروژه', project: 'gone' },
  ],
  comments: [
    { id: 'm1', task: 't1', project: 'p1', from: 'u1', date: '2026-08-02T09:00:00.000Z', text: 'نسخهٔ اول آماده است' },
    { id: 'm2', task: 't2', project: 'p3', from: 'zz', date: '2026-06-01T09:00:00.000Z', text: 'از کسی که دیگر نیست' },
  ],
  messages: [{ id: 'g1', project: 'p1', from: 'u2', date: '2026-08-03T09:00:00.000Z', text: 'جلسه با مشتری فردا' }],
};
const sheet: SheetExport = {
  format: 'sheet-raw/1',
  clients: [
    ['H9000', 'آژانس هیوا', 'آژانس', '', '', '', '', '', '', ''],
    ['H9001', 'بانک نمونه', 'بانک', 'مشتری فعال', 'در حال همکاری', '', '', 'bank.example', '', ''],
    ['H9002', 'بیمه آزمون', 'بیمه', '', '', '', '', '', '', ''],
    ['H9003', 'پوشاک آزمون', 'پوشاک', 'فرصت فروش', '', '', '', '', '', ''],
  ],
  projects: [
    ['FALSE', 'H9001', 'بانک نمونه', 'H9001-01', 'ریبرندینگ', '', '', 'رضا آزمون', 'در حال انجام', '1405/06/01', ''],
    ['FALSE', 'H9003', 'پوشاک آزمون', '', 'مانیتور', '', '', '', 'شروع نشده', '', ''],
    ['FALSE', 'H9003', 'پوشاک آزمون', '', 'مانیتور', '', '', '', 'متوقف شده', '', ''],
  ],
};

describe('Reading Mizito and the client sheet (owner’s request, 2026-10-28)', () => {
  const m = fromMizito(mizito, sheet);

  it('gives each person a unit and roles from the job title — never the system administrator’s', () => {
    expect([unitFor('کارشناس ارشد گرافیک'), unitFor('معاون مالی - اداری'), unitFor('سرپرست OOH'), unitFor('کارشناس ترافیک'), unitFor(null)]).toEqual(['CR', 'FI', 'ME', 'OP', 'OP']);
    expect([rolesFor('مدیر عامل'), rolesFor('قائم‌مقام مدیر عامل'), rolesFor('مدیر امور مشتریان'), rolesFor('نماینده فروش'), rolesFor('مدیر خلاقیت'), rolesFor('کارشناس تدوین')])
      .toEqual([['CEO'], ['DEPUTY'], ['ACCOUNT_MANAGER'], ['SALES_REP'], ['UNIT_MANAGER'], ['UNIT_MEMBER']]);
    expect(m.people.flatMap((p) => p.roles)).not.toContain('SUPER_ADMIN');
    expect(m.people.find((p) => p.ref === 'user:u9')).toMatchObject({ removed: true, unit: 'ME' });
  });

  it('joins a client by its code, gives a code to the client the sheet names, and folds a second file into the first', () => {
    const bank = m.clients.find((c) => c.code === 'H9001')!;
    expect(bank).toMatchObject({ legalName: 'بانک نمونه', industry: 'بانک', website: 'bank.example', phone: '02100000001', accountOwnerRef: 'user:u2' });
    expect(bank.notes).toContain('02100000002');
    expect(bank.notes).toContain('پروندهٔ قدیمی');
    expect(bank.contacts).toEqual([{ fullName: 'خانم رابط', jobTitle: 'مدیر بازاریابی', phone: '09120000001', email: null }]);
    expect(m.clients.find((c) => c.code === 'H9002')!.legalName).toBe('بیمه آزمون');
    expect(m.clients.find((c) => c.code === 'H9003')!.notes).toContain('فرصت فروش');
    expect(m.clients.filter((c) => c.legalName === 'بانک نمونه')).toHaveLength(1);
  });

  it('places each project with its client — a typo forgiven, a unit the agency’s own, a new name a new client — in the state it was left in', () => {
    const by = (ref: string) => m.projects.find((p) => p.ref === ref)!;
    expect(by('project:p1')).toMatchObject({ clientRef: 'client:H9001', legacyRef: 'H9001-01', state: 'ACTIVE', accountOwnerRef: 'user:u2' });
    expect(by('project:p1').plannedStart?.toISOString().slice(0, 10)).toBe('2026-08-23');
    expect(by('project:p3')).toMatchObject({ clientRef: 'client:H9002', state: 'CLOSED', name: 'کمپین' });
    expect(by('project:p3').closedAt?.toISOString()).toBe('2026-06-10T10:00:00.000Z');
    // A Mizito unit's workspace has no client in its name: it is the agency's own project.
    expect(by('project:p2').clientRef).toBe('client:H9000');
    expect(by('project:p7').clientRef).toBe('client:H9000');
    expect(by('project:p4').clientRef).toBe(m.clients.find((c) => c.code === null && c.legalName === 'برند تازه')!.ref);
    // Without "client |", a title that is not the agency's own is its client's work: the work's words set aside.
    expect(by('project:p5')).toMatchObject({ clientRef: by('project:p4').clientRef, state: 'CLOSED' });
    expect(by('project:p6').clientRef).toBe(m.clients.find((c) => c.code === null && c.legalName === 'کافه نمونه')!.ref);
    // Two rows of the same name without codes are two projects, each known by its line.
    expect(m.projects.filter((p) => p.clientRef === 'client:H9003').map((p) => [p.ref, p.state])).toEqual([['project:sheet:row:3', 'DRAFT'], ['project:sheet:row:4', 'ON_HOLD']]);
    expect(m.notes.join('\n')).toContain('برند تازه');
  });

  it('keeps every task with its checklist, and every comment on its task', () => {
    expect(m.tasks.map((t) => t.ref)).toEqual(['task:t1', 'task:t2']);
    expect(m.tasks[0]!.description).toBe('☑ سه پیشنهاد\n☐ نهایی');
    expect(m.tasks[1]).toMatchObject({ done: true, assigneeRef: 'user:u9' });
    expect(m.comments.map((c) => [c.ref, c.taskRef])).toEqual([['comment:m1', 'task:t1'], ['comment:m2', 'task:t2'], ['message:g1', null]]);
  });
});

/**
 * The owner, after the first move (2026-10-30): "the projects and clients are incomplete — not analysed or
 * brought in properly". What the first export left out comes in a second file: the labels (a client's
 * account manager; a project's status, whether it is the agency's own, its account manager), each project's
 * phases, and the sales deals. Made up like the rest.
 */
const extra: MizitoExtra = {
  format: 'mizito-extra/1',
  labels: {
    crm: [{ _id: 'lc1', title: 'سارا نمونه' }, { _id: 'lc2', title: 'بدون اکانت' }],
    project: [
      { _id: 'lp1', title: 'پروژه های در حال مذاکره' }, { _id: 'lp2', title: 'غیر فعال( بلاتکلیف)' }, { _id: 'lp3', title: 'پروژه رد شده' },
      { _id: 'lp4', title: 'واحدهای داخلی هیوا' }, { _id: 'lp5', title: 'رضا آزمون' },
    ],
    deal: [{ _id: 'ld1', title: 'قیمت' }, { _id: 'ld2', title: 'معرفی مشتری' }],
  },
  projects: [
    { _id: 'p1', labels: ['lp5'], kanban_boards: [{ _id: 'b1', title: 'خلاقیت و آتلیه' }, { _id: 'b2', title: 'Doing' }] },
    { _id: 'p8', labels: ['lp1'] }, { _id: 'p9', labels: ['lp2'] }, { _id: 'p10', labels: ['lp3'] }, { _id: 'p11', labels: ['lp4'] },
  ],
  deals: [
    { _id: 'd1', title: 'بانک نمونه | ریبرندینگ', price: 500_000_000, probability: 100, customer: 'c1', tracking_user: 'u2', created_at: '2026-07-01T08:00:00.000Z', invoice_date: '2026-07-20T08:00:00.000Z' },
    { _id: 'd2', title: 'هدایای سازمانی', price: 30_000_000, probability: 0, customer: 'c3', labels: ['ld1', 'ld2'], created_at: '2026-06-01T08:00:00.000Z' },
    // Filed on the second file of «بانک نمونه»: it follows that file to the client it was folded into.
    { _id: 'd3', title: 'کمپین تابستان', price: 100_000_000, probability: 40, customer: 'c2', comments: 'پیشنهاد فرستاده شد', created_at: '2026-08-01T08:00:00.000Z' },
  ],
};
const mizito2: MizitoExport = {
  ...mizito,
  // Sara's old account, removed: the same person, not another.
  removedUsers: [...mizito.removedUsers!, { _id: 'u8', first_name: 'سارا', last_name: 'نمونه' }],
  customers: mizito.customers.map((c) => (c._id === 'c1' ? { ...c, labels: ['lc1'] } : c._id === 'c3' ? { ...c, labels: ['lc2'] } : c)),
  projects: [
    ...mizito.projects,
    { _id: 'p8', title: 'فروشگاه نمونه (آرشیو شده)' },
    { _id: 'p9', title: 'بیمه آزمون (آرشیو شده)' },
    { _id: 'p10', title: 'رستوران آزمون (آرشیو شده)' },
    { _id: 'p11', title: 'نفت نمونه (آرشیو شده)' },
    { _id: 'p12', title: 'بانک نمونه (آرشیو شده)' },
    { _id: 'p13', title: 'سارا نمونه (آرشیو شده)' },
    { _id: 'p14', title: 'بانک نمونه | بیلبوردهای بانک' },
  ],
  tasks: [
    ...mizito.tasks.map((t) => (t._id === 't1' ? { ...t, assignee: ['u1', 'u2'], kanban_board: 'b1' } : t)),
    { _id: 't4', title: 'کار قدیمی', project: 'p9', owner: 'u8', assignee: ['u8'], completed: true, completed_at: '2026-04-01T08:00:00.000Z' },
  ],
};
const sheet2: SheetExport = {
  ...sheet,
  projects: [
    ...sheet.projects,
    ['FALSE', 'H9001', 'بانک نمونه', 'H9001-02', 'بیلبورد بانک', '', '', '', 'در حال انجام', '', ''],
    ['FALSE', 'H9002', 'بیمه آزمون', 'H9002-01', 'مانیتور شهری', '', '', '', '', '403/12', ''],
  ],
};

describe('Reading the labels, phases and deals the first export left out (owner’s report, 2026-10-30)', () => {
  const m = fromMizito(mizito2, sheet2, extra);
  const by = (ref: string) => m.projects.find((p) => p.ref === ref);
  const opp = (ref: string) => m.opportunities.find((o) => o.ref === ref);

  it('takes a client’s account manager from its label, and none from «بدون اکانت»', () => {
    expect(m.clients.find((c) => c.code === 'H9001')!.accountOwnerRef).toBe('user:u1');
    expect(m.clients.find((c) => c.code === 'H9002')!.accountOwnerRef).toBeNull();
  });

  it('keeps one person for a removed account of someone still here', () => {
    expect(m.people.map((p) => p.ref)).not.toContain('user:u8');
    expect(m.tasks.find((t) => t.ref === 'task:t4')!.assigneeRef).toBe('user:u1');
  });

  it('brings each deal as an opportunity of its client, in its stage, its value in rials', () => {
    expect(opp('deal:d1')).toMatchObject({ clientRef: 'client:H9001', state: 'WON', value: 5_000_000_000, ownerRef: 'user:u2' });
    expect(opp('deal:d1')!.wonAt?.toISOString()).toBe('2026-07-20T08:00:00.000Z');
    expect(opp('deal:d2')).toMatchObject({ clientRef: 'client:H9002', state: 'LOST', lostReason: 'قیمت' });
    expect(opp('deal:d2')!.description).toContain('منبع: معرفی مشتری');
    expect(opp('deal:d3')).toMatchObject({ clientRef: 'client:H9001', state: 'BRIEF_REQUESTED' });
    expect(opp('deal:d3')!.description).toContain('پیشنهاد فرستاده شد');
    // The won deal is the sale its project came from.
    expect(by('project:p1')!.opportunityRef).toBe('deal:d1');
  });

  it('reads a project’s state from its label: in negotiation a sale, undecided on hold, rejected cancelled', () => {
    expect(by('project:p8')).toMatchObject({ state: 'DRAFT', opportunityRef: 'opportunity:project:p8' });
    expect(opp('opportunity:project:p8')).toMatchObject({ state: 'NEGOTIATION', title: 'فروشگاه نمونه' });
    expect(by('project:p9')).toMatchObject({ clientRef: 'client:H9002', state: 'ON_HOLD' });
    expect(by('project:p9')!.stateReason).toContain('بلاتکلیف');
    expect(by('project:p10')).toMatchObject({ state: 'CANCELLED', opportunityRef: 'opportunity:project:p10' });
    expect(opp('opportunity:project:p10')).toMatchObject({ state: 'LOST' });
    expect(by('project:p1')!.accountOwnerRef).toBe('user:u2');
  });

  it('files the agency’s own by label or by a colleague’s name, and leaves out an empty workspace named only for its client', () => {
    expect(by('project:p11')!.clientRef).toBe('client:H9000');
    expect(by('project:p13')!.clientRef).toBe('client:H9000');
    expect(by('project:p12')).toBeUndefined();
    expect(m.clients.filter((c) => c.legalName === 'بانک نمونه')).toHaveLength(1);
  });

  it('joins a sheet row by its words, puts a row without status on hold, and reads a month as its first day', () => {
    expect(similar('بیلبوردهای قشم', 'بیلبورد قشم')).toBe(true);
    expect(similar('ساخت تیزر', 'ساخت و اکران تیزر فرودگاهی')).toBe(false);
    expect(by('project:p14')).toMatchObject({ legacyRef: 'H9001-02', state: 'ACTIVE' });
    const row = by('project:sheet:H9002-01')!;
    expect(row).toMatchObject({ state: 'ON_HOLD', stateReason: 'وضعیتش در فایل پروژه‌ها خالی بود' });
    expect(row.plannedStart?.toISOString().slice(0, 10)).toBe('2025-02-19');
  });

  it('files a task under its phase’s unit, and keeps its other doers by name', () => {
    const t1 = m.tasks.find((t) => t.ref === 'task:t1')!;
    expect(t1).toMatchObject({ unit: 'CR', assigneeRef: 'user:u1' });
    expect(t1.description).toContain('همکاران دیگر در میزیتو: رضا آزمون');
  });
});

describe('Writing the move (owner’s request, 2026-10-28)', () => {
  let admin: { id: string; organizationId: string };
  beforeAll(async () => {
    await login('admin@hiva.local');
    admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hiva.local' }, select: { id: true, organizationId: true } });
  });
  afterAll(closeApp);

  it('says what it would make, and makes nothing, without --commit', async () => {
    const before = await prisma.importLink.count();
    const report = await runMigration(admin, fromMizito(mizito, sheet), { commit: false });
    expect(report.dryRun).toBe(true);
    expect(report.counts.people).toMatchObject({ create: 3, link: 1 });
    expect(report.standInEmails).toContain(`سارا نمونه → ${standInEmail('user:u1')}`);
    expect(await prisma.importLink.count()).toBe(before);
  });

  it('makes everything once, on the record, in the state it was left in — and nothing twice', async () => {
    const report = await runMigration(admin, fromMizito(mizito, sheet), { commit: true });
    expect(report.failures).toEqual([]);
    expect(report.counts).toMatchObject({ people: { create: 3, link: 1 }, clients: { create: 6 }, contacts: { create: 1 }, projects: { create: 9 }, tasks: { create: 2 }, comments: { create: 3 } });

    // The administrator who runs the move is the Mizito member of the same address: linked, not doubled.
    expect(await prisma.importLink.findFirst({ where: { externalId: 'user:u3' }, select: { entityId: true } })).toEqual({ entityId: admin.id });
    const sara = await prisma.user.findFirstOrThrow({ where: { email: standInEmail('user:u1') }, include: { department: true, roles: { include: { role: true } } } });
    expect(sara.passwordHash.startsWith('!')).toBe(true);
    expect(sara.department?.code).toBe('CR');
    expect(await prisma.user.findFirstOrThrow({ where: { email: standInEmail('user:u9') }, select: { isActive: true } })).toEqual({ isActive: false });

    const bank = await prisma.company.findFirstOrThrow({ where: { organizationId: admin.organizationId, clientCode: 'H9001' }, include: { contacts: true } });
    expect(bank.contacts).toHaveLength(1);
    const rebrand = await prisma.project.findFirstOrThrow({ where: { organizationId: admin.organizationId, legacyRef: 'H9001-01' } });
    expect(rebrand).toMatchObject({ state: 'ACTIVE', companyId: bank.id });
    expect(await prisma.stateTransition.findFirst({ where: { entityId: rebrand.id }, select: { action: true, opening: true, reason: true } })).toEqual({ action: 'opening', opening: true, reason: 'ورود از میزیتو' });
    expect(report.withoutAuthorization).toBeGreaterThanOrEqual(1);

    const logo = await prisma.task.findFirstOrThrow({ where: { projectId: rebrand.id }, include: { comments: true } });
    expect(logo).toMatchObject({ title: 'طرح لوگو', state: 'IN_PROGRESS', assigneeId: sara.id, departmentCode: 'CR', sourceType: 'TASK' });
    expect(logo.comments.map((c) => [c.body, c.authorId, c.createdAt.toISOString()])).toEqual([['نسخهٔ اول آماده است', sara.id, '2026-08-02T09:00:00.000Z']]);
    const report2 = await prisma.task.findFirstOrThrow({ where: { title: 'گزارش کمپین', organizationId: admin.organizationId }, include: { comments: true } });
    expect(report2.state).toBe('CLOSED');
    expect(report2.closedAt?.toISOString()).toBe('2026-06-10T10:00:00.000Z');
    // Nobody here wrote it: carried by the administrator, signed with the name it had (none known — «نامشخص»).
    expect(report2.comments[0]).toMatchObject({ authorId: admin.id, body: '«نامشخص»: از کسی که دیگر نیست' });
    expect(await prisma.auditEvent.count({ where: { organizationId: admin.organizationId, action: 'CREATE', reason: 'ورود از میزیتو' } })).toBeGreaterThanOrEqual(3 + 4 + 6 + 2);

    const again = await runMigration(admin, fromMizito(mizito, sheet), { commit: true });
    expect(Object.values(again.counts).every((c) => c.create === 0 && c.failed === 0)).toBe(true);
    expect(again.counts.tasks.skip).toBe(2);
  });

  it('then writes what the second file adds: the opportunities, linked to their projects, and each state with its reason', async () => {
    const report = await runMigration(admin, fromMizito(mizito2, sheet2, extra), { commit: true });
    expect(report.failures).toEqual([]);
    expect(report.counts.opportunities.create).toBe(5);
    const won = await prisma.opportunity.findFirstOrThrow({ where: { organizationId: admin.organizationId, title: 'بانک نمونه | ریبرندینگ' } });
    expect(won).toMatchObject({ state: 'WON' });
    expect(Number(won.estimatedValue)).toBe(5_000_000_000);
    const lost = await prisma.opportunity.findFirstOrThrow({ where: { organizationId: admin.organizationId, title: 'هدایای سازمانی' } });
    expect(lost).toMatchObject({ state: 'LOST', lostReason: 'قیمت' });
    const store = await prisma.project.findFirstOrThrow({ where: { organizationId: admin.organizationId, name: 'فروشگاه نمونه' }, include: { opportunity: true } });
    expect(store).toMatchObject({ state: 'DRAFT', opportunity: { state: 'NEGOTIATION' } });
    expect(await prisma.project.findFirstOrThrow({ where: { organizationId: admin.organizationId, name: 'رستوران آزمون' } })).toMatchObject({ state: 'CANCELLED', cancelReason: 'در میزیتو «پروژه رد شده» بود' });
    expect(await prisma.project.findFirstOrThrow({ where: { organizationId: admin.organizationId, legacyRef: 'H9002-01' } })).toMatchObject({ state: 'ON_HOLD', holdReason: 'وضعیتش در فایل پروژه‌ها خالی بود' });
    const again = await runMigration(admin, fromMizito(mizito2, sheet2, extra), { commit: true });
    expect(Object.values(again.counts).every((c) => c.create === 0 && c.failed === 0)).toBe(true);
  });

  it('runs from the command line only as the organisation’s system administrator', async () => {
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' }, select: { email: true } });
    await expect(run(['import:mizito', '--mizito', '/nonexistent.json', '--as', pmo.email])).rejects.toMatchObject({ code: 'NOT_SYSTEM_ADMIN' });
  });
});

describe('The move on a server (infrastructure/hivamis import-mizito)', () => {
  it('copies the files in, takes a backup before it commits, and takes the files out again', async () => {
    const env = { ...process.env, HIVAMIS_DRY_RUN: '1', HIVAMIS_ENV_FILE: '/dev/null', HIVAMIS_BACKUP_DIR: '/tmp/hivamis-test-backups' };
    const script = path.resolve(__dirname, '../../../infrastructure/hivamis');
    const { stdout } = await promisify(execFile)('bash', [script, 'import-mizito', '--mizito', 'm.json', '--sheet', 's.json', '--extra', 'x.json', '--as', 'admin@x.ir', '--commit'], { env });
    expect(stdout).toContain('cp x.json api:/tmp/hivamis-mizito-extra.json');
    expect(stdout).toContain('rm -f /tmp/hivamis-mizito.json /tmp/hivamis-sheet.json /tmp/hivamis-mizito-extra.json');
    expect(stdout).toMatch(/cp m\.json api:\/tmp\/hivamis-mizito\.json/);
    expect(stdout.indexOf('pg_dump')).toBeLessThan(stdout.indexOf('import:mizito'));
    expect(stdout).toContain('import:mizito --mizito /tmp/hivamis-mizito.json --as admin@x.ir --sheet /tmp/hivamis-sheet.json --extra /tmp/hivamis-mizito-extra.json --commit');
    expect(stdout.indexOf('import:mizito')).toBeLessThan(stdout.indexOf('rm -f /tmp/hivamis-mizito.json /tmp/hivamis-sheet.json'));
    const dry = (await promisify(execFile)('bash', [script, 'import-mizito', '--mizito', 'm.json', '--as', 'admin@x.ir'], { env })).stdout;
    expect(dry).not.toContain('pg_dump');
    expect(dry).not.toContain('--commit');
  });
});
