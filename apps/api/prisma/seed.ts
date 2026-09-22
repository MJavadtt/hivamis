/**
 * Seed — organisation structure, RBAC, the Doc_H SLA catalogue, all 130 form definitions,
 * and a demo dataset that exercises the full lifecycle.
 *
 * Idempotent: re-running upserts reference data and skips demo data if it already exists.
 */
import { PrismaClient } from '@prisma/client';
import {
  ALL_FORMS, ALL_PERMISSIONS, PERMISSIONS, ROLE_CODES, ROLE_LABELS, ROLE_PERMISSIONS,
  DEPARTMENT_LABELS, DEPARTMENT_CODES, EXECUTION_DEPARTMENTS, SLA_POLICIES,
  type RoleCode, type DepartmentCode,
} from '@hiva/contracts';
import { hashPassword } from '../src/auth/password.js';
import { nextCode } from '../src/lib/codes.js';
import { publishDefinition } from '../src/forms/versions.js';

const prisma = new PrismaClient();

/** Development-only shared password for the demo accounts. Never use outside local dev. */
const DEV_PASSWORD = 'Hiva@Dev2026!';

/**
 * Demo data is opt-in and never loads in production. Both conditions are required so that
 * neither a stray flag nor a mis-set NODE_ENV alone can put the published demo password
 * into a live database.
 */
function demoSeedAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.SEED_DEMO_DATA === 'true';
}

/**
 * The fifteen demo accounts. Development only — they share a password that is published in
 * README.md, so they must never exist in a production database. Called solely from the
 * demo phase, which {@link demoSeedAllowed} gates.
 */
async function seedDemoUsers(
  org: { id: string },
  departments: Map<DepartmentCode, string>,
  roleIds: Map<RoleCode, string>,
): Promise<Map<string, { id: string; dept: DepartmentCode }>> {
  console.log('→ seeding users …');
  const passwordHash = await hashPassword(DEV_PASSWORD);
  const userSpecs: { email: string; fullName: string; dept: DepartmentCode; roles: RoleCode[]; title: string }[] = [
    { email: 'admin@hiva.local', fullName: 'مدیر سیستم', dept: 'M', roles: ['SUPER_ADMIN'], title: 'مدیر سیستم' },
    { email: 'ceo@hiva.local', fullName: 'سارا مدیری', dept: 'M', roles: ['CEO'], title: 'مدیرعامل' },
    { email: 'deputy@hiva.local', fullName: 'کامران راد', dept: 'M', roles: ['DEPUTY'], title: 'قائم‌مقام' },
    { email: 'sales.manager@hiva.local', fullName: 'نیما فروزان', dept: 'S', roles: ['SALES_MANAGER'], title: 'مدیر فروش' },
    { email: 'sales@hiva.local', fullName: 'الهام کریمی', dept: 'S', roles: ['SALES_REP'], title: 'کارشناس فروش' },
    { email: 'account.manager@hiva.local', fullName: 'رضا شریفی', dept: 'A', roles: ['ACCOUNT_MANAGER'], title: 'مدیر اکانت' },
    { email: 'account@hiva.local', fullName: 'مینا رستمی', dept: 'A', roles: ['ACCOUNT_EXEC'], title: 'کارشناس اکانت' },
    { email: 'strategy@hiva.local', fullName: 'آرش نیک‌بین', dept: 'ST', roles: ['UNIT_MANAGER'], title: 'مدیر استراتژی' },
    { email: 'creative@hiva.local', fullName: 'سپیده آذر', dept: 'CR', roles: ['UNIT_MANAGER'], title: 'مدیر خلاقیت' },
    { email: 'designer@hiva.local', fullName: 'بهراد مهرنیا', dept: 'CR', roles: ['UNIT_MEMBER'], title: 'طراح ارشد' },
    { email: 'media@hiva.local', fullName: 'حمید صابری', dept: 'ME', roles: ['UNIT_MANAGER'], title: 'مدیر رسانه' },
    { email: 'digital@hiva.local', fullName: 'نگار حیدری', dept: 'DM', roles: ['UNIT_MANAGER'], title: 'مدیر دیجیتال مارکتینگ' },
    { email: 'pmo@hiva.local', fullName: 'فرشاد بهرامی', dept: 'OP', roles: ['PMO_MANAGER'], title: 'مدیر عملیات / PMO' },
    { email: 'finance@hiva.local', fullName: 'لیلا موسوی', dept: 'FI', roles: ['FINANCE_MANAGER'], title: 'مدیر مالی' },
    { email: 'legal@hiva.local', fullName: 'سعید تقوی', dept: 'LG', roles: ['LEGAL_MANAGER'], title: 'مدیر حقوقی' },
  ];

  const users = new Map<string, { id: string; dept: DepartmentCode }>();
  for (const spec of userSpecs) {
    const user = await prisma.user.upsert({
      where: { email: spec.email },
      create: {
        organizationId: org.id,
        departmentId: departments.get(spec.dept)!,
        email: spec.email,
        fullName: spec.fullName,
        jobTitle: spec.title,
        passwordHash,
        weeklyCapacityHours: 40,
      },
      update: { fullName: spec.fullName, jobTitle: spec.title, departmentId: departments.get(spec.dept)! },
    });
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.createMany({
      data: spec.roles.map((r) => ({ userId: user.id, roleId: roleIds.get(r)! })),
      skipDuplicates: true,
    });
    users.set(spec.email, { id: user.id, dept: spec.dept });
  }

  // Unit managers own their departments.
  for (const [code, email] of [
    ['S', 'sales.manager@hiva.local'], ['A', 'account.manager@hiva.local'],
    ['ST', 'strategy@hiva.local'], ['CR', 'creative@hiva.local'],
    ['ME', 'media@hiva.local'], ['DM', 'digital@hiva.local'],
    ['OP', 'pmo@hiva.local'], ['FI', 'finance@hiva.local'],
    ['LG', 'legal@hiva.local'], ['M', 'ceo@hiva.local'],
  ] as const) {
    await prisma.department.update({
      where: { id: departments.get(code)! },
      data: { managerId: users.get(email)!.id },
    });
  }
  return users;
}

async function main() {
  console.log('→ seeding organisation …');
  const org = await prisma.organization.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'هیوا',
      legalName: 'آژانس تبلیغاتی هیوا',
      currency: 'IRR',
      timezone: 'Asia/Tehran',
      workingDays: [6, 0, 1, 2, 3],
      workStartHour: 9,
      workEndHour: 18,
      breakHours: 1,
    },
    update: {},
  });

  console.log('→ seeding departments …');
  const departments = new Map<DepartmentCode, string>();
  let order = 0;
  for (const code of DEPARTMENT_CODES) {
    const dep = await prisma.department.upsert({
      where: { organizationId_code: { organizationId: org.id, code } },
      create: {
        organizationId: org.id,
        code,
        nameFa: DEPARTMENT_LABELS[code].fa,
        nameEn: DEPARTMENT_LABELS[code].en,
        isExecutionalUnit: EXECUTION_DEPARTMENTS.includes(code),
        sortOrder: order++,
      },
      update: { nameFa: DEPARTMENT_LABELS[code].fa, nameEn: DEPARTMENT_LABELS[code].en },
    });
    departments.set(code, dep.id);
  }

  console.log('→ seeding permissions & roles …');
  const permIds = new Map<string, string>();
  for (const code of ALL_PERMISSIONS) {
    const p = await prisma.permission.upsert({
      where: { code },
      create: { code, nameFa: PERMISSIONS[code] },
      update: { nameFa: PERMISSIONS[code] },
    });
    permIds.set(code, p.id);
  }

  const roleIds = new Map<RoleCode, string>();
  for (const code of ROLE_CODES) {
    const role = await prisma.role.upsert({
      where: { code },
      create: { code, nameFa: ROLE_LABELS[code].fa, nameEn: ROLE_LABELS[code].en },
      update: { nameFa: ROLE_LABELS[code].fa, nameEn: ROLE_LABELS[code].en },
    });
    roleIds.set(code, role.id);
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const grants = [...new Set(ROLE_PERMISSIONS[code])];
    await prisma.rolePermission.createMany({
      data: grants
        .map((p) => permIds.get(p))
        .filter((id): id is string => !!id)
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }

  console.log('→ seeding SLA policies …');
  for (const policy of SLA_POLICIES) {
    await prisma.slaPolicy.upsert({
      where: { code: policy.code },
      create: {
        organizationId: org.id,
        code: policy.code,
        labelFa: policy.labelFa,
        labelEn: policy.labelEn,
        hours: policy.hours,
        warnAt: policy.warnAt,
        docRef: policy.docRef,
      },
      update: { hours: policy.hours, warnAt: policy.warnAt, docRef: policy.docRef },
    });
  }

  console.log(`→ seeding ${ALL_FORMS.length} form definitions …`);
  // Through the versioning module: a changed schema becomes a new version, an unchanged one
  // writes nothing, and submissions keep pointing at the version they were filled under.
  let newVersions = 0;
  let customised = 0;
  for (const form of ALL_FORMS) {
    const { changed, skippedCustomised } = await publishDefinition(prisma, { organizationId: org.id, form, note: 'seed' });
    if (changed) newVersions++;
    if (skippedCustomised) customised++;
  }
  if (newVersions) console.log(`  ${newVersions} definition(s) gained a new version`);
  // Said out loud: a form the organisation has edited keeps its own fields, and the catalogue
  // no longer speaks for it (roadmap #15).
  if (customised) console.log(`  ${customised} definition(s) left as this organisation edited them`);

  await syncCounters();

  // ── demo phase ────────────────────────────────────────────────────────────
  // Everything above is reference data and is always safe to load. Everything below
  // creates accounts and business records that must not exist in production.
  if (!demoSeedAllowed()) {
    const why =
      process.env.NODE_ENV === 'production'
        ? 'محیط تولید است'
        : 'متغیر SEED_DEMO_DATA تنظیم نشده است';
    console.log(
      `→ داده نمونه بارگذاری نشد — ${why}.\n` +
      '→ Demo data skipped. To load it, set SEED_DEMO_DATA=true outside production.',
    );
    await summary();
    return;
  }

  const users = await seedDemoUsers(org, departments, roleIds);

  const existingCompanies = await prisma.company.count();
  if (existingCompanies > 0) {
    console.log('→ demo data already present, skipping.');
    await summary();
    return;
  }

  console.log('→ seeding demo data …');
  await seedDemo(org.id, users, departments);
  await summary();
}

async function seedDemo(
  orgId: string,
  users: Map<string, { id: string; dept: DepartmentCode }>,
  _departments: Map<DepartmentCode, string>,
) {
  const salesRep = users.get('sales@hiva.local')!.id;
  const accountMgr = users.get('account.manager@hiva.local')!.id;
  const accountExec = users.get('account@hiva.local')!.id;
  const creativeMgr = users.get('creative@hiva.local')!.id;
  const designer = users.get('designer@hiva.local')!.id;
  const strategyMgr = users.get('strategy@hiva.local')!.id;
  const mediaMgr = users.get('media@hiva.local')!.id;
  const digitalMgr = users.get('digital@hiva.local')!.id;
  const financeMgr = users.get('finance@hiva.local')!.id;
  const legalMgr = users.get('legal@hiva.local')!.id;
  const pmo = users.get('pmo@hiva.local')!.id;
  const deputy = users.get('deputy@hiva.local')!.id;

  // Business codes come from the same atomic counter the API uses, so seeded rows can never
  // collide with codes allocated at runtime.
  const SCOPE = {
    LEAD: 'lead', OPP: 'opportunity', BRF: 'brief', PRP: 'proposal', CNT: 'contract',
    PRJ: 'project', INV: 'invoice', WO: 'workOrder', DLV: 'deliverable', TSK: 'task',
    QC: 'qcReview', REV: 'revision', CR: 'changeRequest', RSK: 'risk', ISS: 'issue',
    RPT: 'statusReport', MTG: 'meeting', FRM: 'formSubmission',
  } as const;
  const code = (p: keyof typeof SCOPE) => nextCode(prisma, SCOPE[p]);

  const companySpecs = [
    { legalName: 'شرکت لبنیات پگاه سبز', brandName: 'پگاه سبز', industry: 'FMCG — لبنیات' },
    { legalName: 'بانک آینده‌سازان', brandName: 'آینده‌سازان', industry: 'بانکداری و مالی' },
    { legalName: 'گروه صنعتی آرمان خودرو', brandName: 'آرمان', industry: 'خودرو' },
    { legalName: 'فروشگاه زنجیره‌ای نیک‌مارکت', brandName: 'نیک‌مارکت', industry: 'خرده‌فروشی' },
    { legalName: 'شرکت داروسازی رها', brandName: 'رها', industry: 'دارو و سلامت' },
  ];

  const companies = [];
  for (const spec of companySpecs) {
    const c = await prisma.company.create({
      data: {
        organizationId: orgId,
        ...spec,
        phone: '021-8800' + Math.floor(1000 + Math.random() * 8999),
        address: 'تهران',
        accountOwnerId: accountMgr,
        salesOwnerId: salesRep,
        healthScore: 70 + Math.floor(Math.random() * 25),
      },
    });
    await prisma.contact.create({
      data: {
        companyId: c.id,
        fullName: 'مدیر بازاریابی ' + spec.brandName,
        jobTitle: 'مدیر بازاریابی',
        email: `marketing@${spec.brandName.replace(/\s/g, '')}.example`,
        phone: '0912' + Math.floor(1000000 + Math.random() * 8999999),
        isPrimary: true,
      },
    });
    companies.push(c);
  }

  // ── Leads in various states ────────────────────────────────────────────────
  const leadStates = ['NEW', 'CONTACTED', 'QUALIFIED', 'NEW', 'CONTACTED'];
  for (let i = 0; i < 5; i++) {
    await prisma.lead.create({
      data: {
        organizationId: orgId,
        code: await code('LEAD'),
        name: `سرنخ ${i + 1}`,
        companyName: ['هلدینگ ماد', 'صنایع غذایی دلتا', 'بیمه پارس', 'استارتاپ رهیاب', 'گروه ساختمانی آبان'][i],
        contactName: 'واحد بازاریابی',
        phone: '021-2200' + (1000 + i),
        source: ['REFERRAL', 'INBOUND', 'EVENT', 'CAMPAIGN', 'OUTBOUND'][i],
        estimatedValue: [1_500_000_000, 900_000_000, 3_200_000_000, 450_000_000, 2_100_000_000][i],
        need: 'نیاز به کمپین برندینگ و رسانه',
        state: leadStates[i],
        ownerId: salesRep,
      },
    });
  }

  // ── Scenario 1: a fully-closed project (the complete Doc_H lifecycle) ───────
  const c0 = companies[0]!;
  const opp1 = await prisma.opportunity.create({
    data: {
      organizationId: orgId, code: await code('OPP'), title: 'کمپین رونمایی محصول جدید پگاه سبز',
      companyId: c0.id, estimatedValue: 4_500_000_000, servicesNeeded: ['ST', 'CR', 'ME'],
      description: 'کمپین ۳۶۰ درجه برای معرفی خط محصول ارگانیک', state: 'WON',
      ownerId: salesRep, wonAt: daysAgo(60),
    },
  });
  const brief1 = await prisma.brief.create({
    data: {
      organizationId: orgId, code: await code('BRF'), opportunityId: opp1.id,
      title: 'بریف کمپین رونمایی پگاه سبز',
      businessObjective: 'افزایش آگاهی از برند و سهم بازار در دسته لبنیات ارگانیک',
      targetAudience: 'خانواده‌های شهری، ۲۵ تا ۴۵ سال، طبقه متوسط رو به بالا',
      scope: 'استراتژی، کانسپت خلاق، هویت کمپین، تیزر، طراحی بسته‌بندی، برنامه رسانه‌ای',
      expectedDeliverables: 'سند استراتژی، کی‌ویژوال، تیزر ۳۰ ثانیه، مدیاپلن',
      budgetRange: 4_000_000_000, desiredDeadline: daysAgo(-10),
      unitsNeeded: ['ST', 'CR', 'ME'], completenessScore: 100, missingItems: [],
      state: 'APPROVED', submittedById: salesRep, reviewedById: accountMgr, approvedAt: daysAgo(85),
    },
  });
  const prop1 = await prisma.proposal.create({
    data: {
      organizationId: orgId, code: await code('PRP'), briefId: brief1.id,
      title: 'پروپوزال کمپین رونمایی پگاه سبز', version: 2,
      executiveSummary: 'کمپین یکپارچه با محوریت «طبیعت در هر قطره»',
      approach: 'استراتژی مبتنی بر بینش مصرف‌کننده + اجرای خلاق + رسانه ترکیبی',
      deliverablesSummary: 'استراتژی، KV، تیزر، مدیاپلن',
      state: 'CLIENT_APPROVED',
      totalCost: 2_900_000_000, salePrice: 4_350_000_000, marginPercent: 33.33,
      paymentTerms: '۴۰٪ پیش‌پرداخت، ۳۰٪ میان‌دوره، ۳۰٪ تحویل', contractScaleBand: 'L',
      pricingRationale: 'حاشیه سود هدف ۳۳٪ مطابق اشل L', pricedById: accountMgr,
      pricedAt: daysAgo(80), pricingApprovedById: deputy, pricingApprovedAt: daysAgo(79),
      clientDecision: 'APPROVED', revisionCount: 1,
    },
  });
  const contract1 = await prisma.contract.create({
    data: {
      organizationId: orgId, code: await code('CNT'), contractNumber: 'HV-1404-018',
      companyId: c0.id, proposalId: prop1.id, title: 'قرارداد کمپین رونمایی پگاه سبز',
      contractValue: 4_350_000_000, startDate: daysAgo(70), endDate: daysAgo(-20),
      scopeSummary: 'مطابق پروپوزال نسخه ۲', paymentTerms: '۴۰/۳۰/۳۰',
      state: 'REGISTERED', signedDate: daysAgo(72), registeredAt: daysAgo(71), createdById: legalMgr,
    },
  });
  const proj1 = await prisma.project.create({
    data: {
      organizationId: orgId, code: await code('PRJ'), name: 'کمپین رونمایی پگاه سبز',
      companyId: c0.id, briefId: brief1.id, proposalId: prop1.id, opportunityId: opp1.id,
      accountOwnerId: accountMgr, objective: 'اجرای کمپین ۳۶۰ درجه رونمایی محصول',
      inScope: 'استراتژی، خلاقیت، تولید، رسانه', outOfScope: 'فعالیت‌های BTL و رویداد حضوری',
      plannedStart: daysAgo(70), plannedEnd: daysAgo(-15), actualStart: daysAgo(69), actualEnd: daysAgo(5),
      plannedBudget: 2_900_000_000, contractValue: 4_350_000_000,
      state: 'CLOSED', healthStatus: 'GREEN', closedAt: daysAgo(2),
    },
  });
  await prisma.contract.update({ where: { id: contract1.id }, data: { projectId: proj1.id } });
  await prisma.executionAuthorization.create({
    data: {
      projectId: proj1.id, basis: 'CONTRACT', contractId: contract1.id,
      referenceDocument: 'HV-1404-018', authorizedById: deputy, authorizedAt: daysAgo(70),
    },
  });
  for (const [act, dept, role] of [
    ['مدیریت پروژه و ارتباط با مشتری', 'A', 'A'], ['تدوین استراتژی', 'ST', 'R'],
    ['تولید خلاق و گرافیک', 'CR', 'R'], ['برنامه‌ریزی رسانه', 'ME', 'R'],
    ['کنترل ظرفیت و ترافیک', 'OP', 'C'], ['کنترل مالی', 'FI', 'I'],
  ] as const) {
    await prisma.raciAssignment.create({
      data: { projectId: proj1.id, activity: act, departmentCode: dept, raciRole: role },
    });
  }
  await prisma.closureChecklist.create({
    data: {
      projectId: proj1.id, allDeliverablesDelivered: true, finalQcDone: true,
      clientApprovalRecorded: true, closureReportDone: true, financialStatusClear: true,
      feedbackRecorded: true, lessonsLearnedRecorded: true, closedInSystem: true, updatedById: accountMgr,
    },
  });
  await prisma.feedback.create({
    data: {
      organizationId: orgId, projectId: proj1.id, csat: 5, nps: 9,
      qualityRating: 5, timelinessRating: 4, communicationRating: 5,
      positives: 'کیفیت خلاقیت و پاسخ‌گویی اکانت عالی بود',
      improvements: 'زمان‌بندی تولید تیزر می‌توانست فشرده‌تر باشد',
      futureNeeds: 'کمپین فصلی تابستان', recordedById: accountMgr,
    },
  });
  await prisma.lessonLearned.create({
    data: {
      organizationId: orgId, projectId: proj1.id, title: 'تثبیت زودهنگام کی‌ویژوال',
      category: 'PROCESS', situation: 'دو دور اصلاحیه روی کی‌ویژوال به دلیل تأخیر در تأیید مشتری',
      lesson: 'تأیید کی‌ویژوال باید به یک نقطه عطف قراردادی تبدیل شود',
      recommendation: 'افزودن Milestone «تأیید KV» با مهلت مشخص در تمام کمپین‌ها',
      recordedById: pmo,
    },
  });
  const inv1 = await prisma.invoice.create({
    data: {
      organizationId: orgId, code: await code('INV'), kind: 'INVOICE', number: 'F-1404-101',
      companyId: c0.id, projectId: proj1.id, contractId: contract1.id,
      issueDate: daysAgo(60), dueDate: daysAgo(30),
      lines: [{ description: 'فاز اول کمپین — ۴۰٪', quantity: 1, unitPrice: 1_740_000_000 }],
      subtotal: 1_740_000_000, taxPercent: 10, taxAmount: 174_000_000, total: 1_914_000_000,
      paidAmount: 1_914_000_000, state: 'PAID', createdById: financeMgr,
    },
  });
  await prisma.payment.create({
    data: {
      organizationId: orgId, invoiceId: inv1.id, projectId: proj1.id, direction: 'IN',
      amount: 1_914_000_000, occurredAt: daysAgo(45), method: 'TRANSFER',
      reference: 'SH-8891', createdById: financeMgr,
    },
  });

  // ── Scenario 2: an active project mid-execution ────────────────────────────
  const c1 = companies[1]!;
  const opp2 = await prisma.opportunity.create({
    data: {
      organizationId: orgId, code: await code('OPP'), title: 'بازطراحی هویت دیجیتال بانک آینده‌سازان',
      companyId: c1.id, estimatedValue: 6_800_000_000, servicesNeeded: ['ST', 'CR', 'DM'],
      state: 'WON', ownerId: salesRep, wonAt: daysAgo(30),
    },
  });
  const brief2 = await prisma.brief.create({
    data: {
      organizationId: orgId, code: await code('BRF'), opportunityId: opp2.id,
      title: 'بریف بازطراحی هویت دیجیتال',
      businessObjective: 'مدرن‌سازی تجربه دیجیتال و افزایش نرخ تبدیل اپلیکیشن',
      targetAudience: 'کاربران بانکی ۲۰ تا ۴۵ سال', scope: 'استراتژی محتوا، طراحی UI، کمپین performance',
      expectedDeliverables: 'گاید هویت دیجیتال، طراحی صفحات کلیدی، برنامه کمپین',
      budgetRange: 6_500_000_000, desiredDeadline: daysAgo(-45), unitsNeeded: ['ST', 'CR', 'DM'],
      completenessScore: 100, state: 'APPROVED', submittedById: salesRep,
      reviewedById: accountMgr, approvedAt: daysAgo(35),
    },
  });
  const prop2 = await prisma.proposal.create({
    data: {
      organizationId: orgId, code: await code('PRP'), briefId: brief2.id,
      title: 'پروپوزال بازطراحی هویت دیجیتال', executiveSummary: 'بازطراحی مبتنی بر داده و آزمون کاربر',
      state: 'CLIENT_APPROVED', totalCost: 4_400_000_000, salePrice: 6_600_000_000, marginPercent: 33.33,
      pricedById: accountMgr, pricedAt: daysAgo(33), pricingApprovedById: deputy,
      pricingApprovedAt: daysAgo(32), clientDecision: 'APPROVED',
    },
  });
  const contract2 = await prisma.contract.create({
    data: {
      organizationId: orgId, code: await code('CNT'), contractNumber: 'HV-1404-024', companyId: c1.id,
      proposalId: prop2.id, title: 'قرارداد بازطراحی هویت دیجیتال', contractValue: 6_600_000_000,
      startDate: daysAgo(28), endDate: daysAgo(-60), state: 'REGISTERED',
      signedDate: daysAgo(29), registeredAt: daysAgo(28), createdById: legalMgr,
    },
  });
  const proj2 = await prisma.project.create({
    data: {
      organizationId: orgId, code: await code('PRJ'), name: 'بازطراحی هویت دیجیتال آینده‌سازان',
      companyId: c1.id, briefId: brief2.id, proposalId: prop2.id, opportunityId: opp2.id,
      accountOwnerId: accountExec, objective: 'ارتقای تجربه دیجیتال بانک',
      inScope: 'استراتژی محتوا، UI، کمپین دیجیتال', outOfScope: 'توسعه نرم‌افزار و بک‌اند',
      plannedStart: daysAgo(28), plannedEnd: daysAgo(-60), actualStart: daysAgo(27),
      plannedBudget: 4_400_000_000, contractValue: 6_600_000_000,
      state: 'ACTIVE', healthStatus: 'AMBER',
    },
  });
  await prisma.contract.update({ where: { id: contract2.id }, data: { projectId: proj2.id } });
  await prisma.executionAuthorization.create({
    data: {
      projectId: proj2.id, basis: 'CONTRACT', contractId: contract2.id,
      referenceDocument: 'HV-1404-024', authorizedById: deputy, authorizedAt: daysAgo(28),
    },
  });
  for (const [act, dept, role] of [
    ['مدیریت پروژه', 'A', 'A'], ['استراتژی محتوا', 'ST', 'R'],
    ['طراحی UI', 'CR', 'R'], ['کمپین دیجیتال', 'DM', 'R'], ['ترافیک', 'OP', 'C'],
  ] as const) {
    await prisma.raciAssignment.create({
      data: { projectId: proj2.id, activity: act, departmentCode: dept, raciRole: role },
    });
  }
  for (const [name, days] of [['تأیید استراتژی محتوا', -5], ['تحویل طراحی صفحات کلیدی', 12], ['راه‌اندازی کمپین', 35]] as const) {
    await prisma.milestone.create({
      data: { projectId: proj2.id, name, dueDate: daysAgo(-days) },
    });
  }

  const orderSpecs = [
    { dept: 'ST', owner: strategyMgr, title: 'تدوین استراتژی محتوای دیجیتال', state: 'COMPLETED', cost: 900_000_000 },
    { dept: 'CR', owner: creativeMgr, title: 'طراحی UI صفحات کلیدی', state: 'IN_PROGRESS', cost: 1_800_000_000 },
    { dept: 'DM', owner: digitalMgr, title: 'برنامه کمپین Performance', state: 'ACCEPTED', cost: 1_700_000_000 },
  ] as const;

  for (const spec of orderSpecs) {
    const wo = await prisma.workOrder.create({
      data: {
        organizationId: orgId, code: await code('WO'), projectId: proj2.id, proposalId: prop2.id,
        targetDepartmentCode: spec.dept, title: spec.title,
        scopeOfWork: spec.title, brief: 'مطابق بریف تأییدشده پروژه',
        expectedOutput: 'سند/فایل نهایی مطابق استاندارد هیوا', outputFormat: 'PDF + فایل باز',
        deadline: daysAgo(-14), ownerId: spec.owner, budget: spec.cost,
        priority: 'HIGH', state: spec.state,
        acceptedAt: daysAgo(20),
        acceptedById: spec.owner,
      },
    });
    await prisma.costDeclaration.create({
      data: {
        organizationId: orgId, proposalId: prop2.id, workOrderId: wo.id, departmentCode: spec.dept,
        internalCost: spec.cost * 0.7, externalCost: spec.cost * 0.3,
        items: [{ description: spec.title, quantity: 1, unitCost: spec.cost }],
        declaredById: spec.owner,
      },
    });
    const deliv = await prisma.deliverable.create({
      data: {
        organizationId: orgId, code: await code('DLV'), projectId: proj2.id, proposalId: prop2.id,
        workOrderId: wo.id, name: spec.title, departmentCode: spec.dept, format: 'PDF',
        dueDate: daysAgo(-14),
        state: spec.state === 'COMPLETED' ? 'APPROVED' : spec.state === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'PLANNED',
      },
    });
    await prisma.task.create({
      data: {
        organizationId: orgId, code: await code('TSK'), projectId: proj2.id, workOrderId: wo.id,
        deliverableId: deliv.id, title: spec.title, departmentCode: spec.dept,
        assigneeId: spec.dept === 'CR' ? designer : spec.owner, dueDate: daysAgo(-10),
        estimateHours: 40, priority: 'HIGH',
        state: spec.state === 'COMPLETED' ? 'APPROVED' : spec.state === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'ASSIGNED',
        sourceType: 'ORDER_FORM', sourceRef: wo.code, createdById: accountExec,
      },
    });
    if (spec.state === 'COMPLETED') {
      await prisma.qcReview.create({
        data: {
          organizationId: orgId, code: await code('QC'), level: 'UNIT', deliverableId: deliv.id,
          checklist: { matchesBrief: true, technicallySound: true, brandCompliant: true },
          verdict: 'PASSED', reviewerId: spec.owner,
        },
      });
      await prisma.qcReview.create({
        data: {
          organizationId: orgId, code: await code('QC'), level: 'ACCOUNT', deliverableId: deliv.id,
          checklist: { matchesBrief: true, matchesScope: true, matchesKickoff: true },
          verdict: 'PASSED', reviewerId: accountExec,
        },
      });
    }
    await prisma.allocation.create({
      data: {
        projectId: proj2.id, userId: spec.dept === 'CR' ? designer : spec.owner,
        fromDate: daysAgo(20), toDate: daysAgo(-20), hoursPerDay: 5, createdById: pmo,
      },
    });
  }

  // A live revision loop on the creative deliverable (Doc_H cycle 2).
  const crDeliverable = await prisma.deliverable.findFirst({
    where: { projectId: proj2.id, departmentCode: 'CR' },
  });
  if (crDeliverable) {
    const failedQc = await prisma.qcReview.create({
      data: {
        organizationId: orgId, code: await code('QC'), level: 'ACCOUNT', deliverableId: crDeliverable.id,
        checklist: { matchesBrief: true, matchesScope: false },
        verdict: 'FAILED', findings: 'سلسله‌مراتب بصری صفحه اصلی با بریف هم‌راستا نیست',
        reviewerId: accountExec,
      },
    });
    await prisma.revision.create({
      data: {
        organizationId: orgId, code: await code('REV'), deliverableId: crDeliverable.id, qcReviewId: failedQc.id,
        reason: 'BRIEF_MISMATCH', requiredCorrection: 'بازطراحی سلسله‌مراتب بصری صفحه اصلی مطابق بریف',
        responsibleDepartmentCode: 'CR', assigneeId: designer, dueDate: daysAgo(-3),
        state: 'IN_PROGRESS', requestedById: accountExec,
      },
    });
  }

  await prisma.changeRequest.create({
    data: {
      organizationId: orgId, code: await code('CR'), projectId: proj2.id,
      title: 'افزودن نسخه انگلیسی صفحات کلیدی',
      requestedChange: 'مشتری درخواست نسخه انگلیسی برای ۶ صفحه کلیدی دارد',
      requestedBy: 'CLIENT', requestedDate: daysAgo(6), priority: 'HIGH',
      state: 'COMMERCIAL_REVIEW', scopeVerdict: 'OUT_OF_SCOPE',
      scopeRationale: 'نسخه چندزبانه در Scope قرارداد ذکر نشده است',
      scopeReviewedById: accountExec, scopeReviewedAt: daysAgo(5),
      createdById: accountExec,
    },
  });
  await prisma.risk.create({
    data: {
      organizationId: orgId, code: await code('RSK'), projectId: proj2.id,
      title: 'تأخیر در تأیید کی‌ویژوال توسط مشتری',
      description: 'کمیته برند مشتری جلسات دوهفته‌ای دارد و تأیید ممکن است عقب بیفتد',
      probability: 'HIGH', impact: 'MEDIUM',
      mitigation: 'تعیین مهلت قراردادی برای تأیید و ثبت Decision Log',
      ownerId: accountExec,
    },
  });
  await prisma.issue.create({
    data: {
      organizationId: orgId, code: await code('ISS'), projectId: proj2.id,
      title: 'کمبود ظرفیت طراحی در هفته جاری',
      description: 'واحد خلاقیت هم‌زمان درگیر دو پروژه است',
      severity: 'HIGH', ownerId: pmo, targetResolution: daysAgo(-4),
    },
  });
  await prisma.statusReport.create({
    data: {
      organizationId: orgId, code: await code('RPT'), projectId: proj2.id, period: 'هفته جاری',
      progress: '۴۵٪ پیشرفت کلی', completed: 'استراتژی محتوا تأیید شد',
      inProgress: 'طراحی UI صفحات کلیدی', next: 'ارائه کی‌ویژوال به مشتری',
      timelineStatus: 'با ۳ روز تأخیر نسبت به برنامه',
      risks: 'تأخیر در تأیید مشتری', issues: 'کمبود ظرفیت طراحی',
      decisionsNeeded: 'تصمیم درباره درخواست تغییر نسخه انگلیسی',
      financialStatus: 'پیش‌پرداخت دریافت شده', createdById: accountExec,
    },
  });
  const inv2 = await prisma.invoice.create({
    data: {
      organizationId: orgId, code: await code('INV'), kind: 'INVOICE', number: 'F-1404-118',
      companyId: c1.id, projectId: proj2.id, contractId: contract2.id,
      issueDate: daysAgo(25), dueDate: daysAgo(-5),
      lines: [{ description: 'پیش‌پرداخت ۴۰٪', quantity: 1, unitPrice: 2_640_000_000 }],
      subtotal: 2_640_000_000, taxPercent: 10, taxAmount: 264_000_000, total: 2_904_000_000,
      paidAmount: 2_904_000_000, state: 'PAID', createdById: financeMgr,
    },
  });
  await prisma.payment.create({
    data: {
      organizationId: orgId, invoiceId: inv2.id, projectId: proj2.id, direction: 'IN',
      amount: 2_904_000_000, occurredAt: daysAgo(20), method: 'TRANSFER', createdById: financeMgr,
    },
  });
  await prisma.meeting.create({
    data: {
      organizationId: orgId, code: await code('MTG'), projectId: proj2.id, kind: 'CLIENT',
      subject: 'جلسه بازبینی استراتژی محتوا', heldAt: daysAgo(10),
      attendees: 'مینا رستمی، آرش نیک‌بین، تیم بانک',
      agenda: 'ارائه استراتژی و دریافت بازخورد',
      decisions: 'استراتژی تأیید شد؛ لحن محتوا رسمی‌تر شود',
      actions: [{ action: 'به‌روزرسانی راهنمای لحن', owner: 'ST', due: daysAgo(-2).toISOString() }],
      minutesRecordedAt: daysAgo(10), createdById: accountExec,
    },
  });

  // ── Scenario 3: a project awaiting authorisation (Doc_H §13 gate) ───────────
  const c2 = companies[2]!;
  const opp3 = await prisma.opportunity.create({
    data: {
      organizationId: orgId, code: await code('OPP'), title: 'کمپین معرفی خودروی جدید آرمان',
      companyId: c2.id, estimatedValue: 12_000_000_000, servicesNeeded: ['ST', 'CR', 'ME', 'DM'],
      state: 'NEGOTIATION', ownerId: salesRep, expectedCloseDate: daysAgo(-20),
    },
  });
  const brief3 = await prisma.brief.create({
    data: {
      organizationId: orgId, code: await code('BRF'), opportunityId: opp3.id,
      title: 'بریف کمپین معرفی خودرو', businessObjective: 'معرفی مدل جدید و ثبت سفارش پیش‌فروش',
      targetAudience: 'مردان و زنان ۳۰ تا ۵۰ سال', scope: 'کمپین ۳۶۰ درجه',
      expectedDeliverables: 'استراتژی، تیزر، مدیاپلن، کمپین دیجیتال',
      budgetRange: 11_000_000_000, desiredDeadline: daysAgo(-70),
      unitsNeeded: ['ST', 'CR', 'ME', 'DM'], completenessScore: 100,
      state: 'APPROVED', submittedById: salesRep, reviewedById: accountMgr, approvedAt: daysAgo(12),
    },
  });
  const prop3 = await prisma.proposal.create({
    data: {
      organizationId: orgId, code: await code('PRP'), briefId: brief3.id,
      title: 'پروپوزال کمپین معرفی خودرو', state: 'PRESENTED_TO_CLIENT',
      totalCost: 8_000_000_000, salePrice: 11_800_000_000, marginPercent: 32.2,
      pricedById: accountMgr, pricedAt: daysAgo(6),
      pricingApprovedById: deputy, pricingApprovedAt: daysAgo(5),
    },
  });
  await prisma.qcReview.create({
    data: {
      organizationId: orgId, code: await code('QC'), level: 'FINAL', proposalId: prop3.id,
      checklist: { proposalComplete: true, pricingReviewed: true, qualityAcceptable: true, clientReady: true },
      verdict: 'PASSED', reviewerId: accountMgr,
    },
  });
  await prisma.project.create({
    data: {
      organizationId: orgId, code: await code('PRJ'), name: 'کمپین معرفی خودروی آرمان',
      companyId: c2.id, briefId: brief3.id, proposalId: prop3.id, opportunityId: opp3.id,
      accountOwnerId: accountMgr, objective: 'اجرای کمپین معرفی مدل جدید',
      plannedStart: daysAgo(-5), plannedEnd: daysAgo(-90), plannedBudget: 8_000_000_000,
      state: 'PENDING_AUTHORIZATION', healthStatus: 'GREEN',
    },
  });

  // ── Scenario 4: an early-stage opportunity with an incomplete brief ────────
  const c3 = companies[3]!;
  const opp4 = await prisma.opportunity.create({
    data: {
      organizationId: orgId, code: await code('OPP'), title: 'کمپین فصلی نیک‌مارکت',
      companyId: c3.id, estimatedValue: 2_400_000_000, servicesNeeded: ['CR', 'DM'],
      state: 'BRIEF_REQUESTED', ownerId: salesRep,
    },
  });
  await prisma.brief.create({
    data: {
      organizationId: orgId, code: await code('BRF'), opportunityId: opp4.id,
      title: 'بریف کمپین فصلی نیک‌مارکت',
      businessObjective: 'افزایش ترافیک فروشگاهی در فصل تابستان',
      targetAudience: 'خانواده‌های شهری',
      // Deliberately incomplete: scope/deliverables/budget/deadline are missing so the
      // completeness guard blocks approval — Doc_H recurring cycle 1.
      completenessScore: 33,
      missingItems: ['Scope درخواستی', 'خروجی‌های مورد انتظار', 'بودجه تقریبی', 'زمان مورد انتظار'],
      state: 'UNDER_REVIEW', submittedById: salesRep, reviewedById: accountExec,
    },
  });

  // ── A submitted form ───────────────────────────────────────────────────────
  // The demo dataset is meant to exercise the whole lifecycle, and until now it stopped at
  // the workflow engine and never touched the form engine. The charter carries an entityRef
  // to proj1, which is what makes a form submission's attachments discoverable — so the PDF
  // bundle has something to find without a test first having to build it by hand.
  const charter = await prisma.formDefinition.findFirst({
    where: { organizationId: orgId, code: 'J82_PROJECT_CHARTER' },
  });
  if (charter) {
    await prisma.formSubmission.create({
      data: {
        organizationId: orgId, code: await code('FRM'), definitionId: charter.id,
        projectId: proj1.id, companyId: c0.id,
        data: {
          projectId: proj1.id,
          purpose: 'رونمایی از خط محصول جدید پگاه سبز در بازار مصرف خانوار',
          objectives: 'پوشش ۶۰٪ مخاطب هدف شهری و ۱۲٪ رشد فروش در سه ماه نخست',
          successCriteria: 'تحقق شاخص‌های رسانه‌ای مصوب و تأیید کارفرما بر خروجی خلاقیت',
          constraints: 'محدودیت بودجه رسانه‌ای و تقویم پخش تلویزیونی',
        },
        state: 'APPROVED', submittedById: accountExec, assignedToId: pmo,
        submittedAt: daysAgo(66), decidedAt: daysAgo(64),
      },
    });
  }

  // ── Suppliers ─────────────────────────────────────────────────────────────
  for (const s of [
    { name: 'استودیو تصویر آبی', kind: 'OUTSOURCE', departmentCode: 'CR', specialty: 'تولید ویدئو', dayRate: 45_000_000 },
    { name: 'مهدی روشن', kind: 'FREELANCER', departmentCode: 'CR', specialty: 'تصویرسازی', dayRate: 18_000_000 },
    { name: 'آژانس رسانه پیام', kind: 'PARTNER', departmentCode: 'ME', specialty: 'خرید رسانه OOH', dayRate: null },
    { name: 'نگین کاظمی', kind: 'FREELANCER', departmentCode: 'DM', specialty: 'کپی‌رایتینگ', dayRate: 12_000_000 },
  ] as const) {
    await prisma.supplier.create({
      data: {
        organizationId: orgId, name: s.name, kind: s.kind, departmentCode: s.departmentCode,
        specialty: s.specialty, dayRate: s.dayRate ?? undefined,
      },
    });
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/**
 * Advance each code counter past the highest suffix already present in its table.
 * Self-healing: guarantees `nextCode` can never re-issue a code that exists, whatever
 * wrote the earlier rows (an older seed, a restored dump, a manual insert).
 */
async function syncCounters() {
  const tables: [scope: string, table: string][] = [
    ['lead', 'leads'], ['opportunity', 'opportunities'], ['brief', 'briefs'],
    ['proposal', 'proposals'], ['project', 'projects'], ['workOrder', 'work_orders'],
    ['task', 'tasks'], ['deliverable', 'deliverables'], ['qcReview', 'qc_reviews'],
    ['revision', 'revisions'], ['changeRequest', 'change_requests'], ['contract', 'contracts'],
    ['invoice', 'invoices'], ['risk', 'risks'], ['issue', 'issues'], ['decision', 'decisions'],
    ['meeting', 'meetings'], ['statusReport', 'status_reports'],
    ['outsourceRequest', 'outsource_requests'], ['formSubmission', 'form_submissions'],
    ['handoff', 'handoffs'],
  ];
  for (const [scope, table] of tables) {
    const rows = await prisma.$queryRawUnsafe<{ max: number | null }[]>(
      `SELECT MAX(NULLIF(regexp_replace(code, '^.*-', ''), '')::int) AS max
         FROM ${table} WHERE code ~ '^[A-Z]+-[0-9]+$'`,
    );
    const max = rows[0]?.max ?? 0;
    if (max > 0) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO counters (id, scope, value) VALUES (gen_random_uuid(), $1, $2)
         ON CONFLICT (scope) DO UPDATE SET value = GREATEST(counters.value, $2)`,
        scope, max,
      );
    }
  }
}

async function summary() {
  const [users, forms, slas, companies, projects, tasks] = await Promise.all([
    prisma.user.count(), prisma.formDefinition.count(), prisma.slaPolicy.count(),
    prisma.company.count(), prisma.project.count(), prisma.task.count(),
  ]);
  console.log('\n✓ seed complete');
  console.table({ users, formDefinitions: forms, slaPolicies: slas, companies, projects, tasks });
  // Only advertise the shared password when the demo phase actually ran; printing it after a
  // production seed would suggest accounts exist that deliberately do not.
  if (demoSeedAllowed()) {
    console.log(`\n  Development login (all demo accounts): ${DEV_PASSWORD}`);
    console.log('  Sign in as admin@hiva.local, account.manager@hiva.local, sales@hiva.local, …\n');
  } else {
    console.log('\n  Reference data only. Create the first administrator before signing in.\n');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
