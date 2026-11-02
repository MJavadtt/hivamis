import type { RoleCode } from './enums.js';

/**
 * Permission catalogue — `<resource>.<action>`.
 *
 * The grants below are the machine-readable form of Doc_H's governance rules. In particular:
 *  • Rule 2 («تفکیک Sales و Account») — Sales holds no project/execution permission after handoff,
 *    Account holds no lead-acquisition permission. The two loops are separated at the permission layer.
 *  • Rule 12 («مدیریت مالی پروژه») — execution units may declare cost but never set the sale price;
 *    `pricing.set_price` is Account+Finance, `pricing.approve` is Management only.
 *  • Rule 13 («شروع اجرای پروژه») — `project.authorize` is Management only.
 */
export const PERMISSIONS = {
  // CRM & Sales
  'crm.lead.read': 'مشاهده سرنخ',
  'crm.lead.write': 'ایجاد/ویرایش سرنخ',
  'crm.lead.convert': 'تبدیل سرنخ به فرصت فروش',
  'crm.opportunity.read': 'مشاهده فرصت فروش',
  'crm.opportunity.write': 'ایجاد/ویرایش فرصت فروش',
  'crm.company.read': 'مشاهده مشتری',
  'crm.company.write': 'ایجاد/ویرایش مشتری',
  'crm.contact.read': 'مشاهده مخاطب',
  'crm.contact.write': 'ایجاد/ویرایش مخاطب',
  'crm.activity.read': 'مشاهده فعالیت/مذاکره',
  'crm.activity.write': 'ثبت فعالیت/مذاکره',

  // Brief
  'brief.read': 'مشاهده بریف',
  'brief.write': 'تهیه/ویرایش بریف',
  'brief.submit': 'ارسال بریف به اکانت',
  'brief.review': 'کنترل کامل بودن بریف',
  'brief.approve': 'تأیید بریف',
  'brief.return': 'بازگشت بریف ناقص به فروش',

  // Handoff (Sales ↔ Account)
  'handoff.read': 'مشاهده انتقال',
  'handoff.create': 'ایجاد فرم انتقال',
  'handoff.accept': 'پذیرش انتقال',

  // Proposal & Pricing
  'proposal.read': 'مشاهده پروپوزال',
  'proposal.write': 'ایجاد/ویرایش پروپوزال',
  'proposal.integrate': 'یکپارچه‌سازی خروجی واحدها',
  'proposal.deliver_to_sales': 'تحویل پروپوزال به فروش',
  'proposal.unit_approve': 'تأیید پروپوزال به‌عنوان مدیر واحد رسانه',
  'proposal.present': 'ارائه پروپوزال به مشتری',
  'proposal.record_feedback': 'ثبت بازخورد مشتری',
  'pricing.read': 'مشاهده قیمت‌گذاری',
  'pricing.declare_cost': 'اعلام قیمت تمام‌شده',
  'pricing.set_price': 'تعیین قیمت فروش و حاشیهٔ سود',
  'pricing.approve': 'تأیید نهایی قیمت‌گذاری',

  // Project & PMO
  'project.read': 'مشاهده پروژه',
  'project.write': 'ایجاد/ویرایش پروژه',
  'project.authorize': 'صدور مجوز شروع پروژه',
  'project.plan': 'برنامه‌ریزی پروژه',
  'project.execute': 'مدیریت اجرای پروژه',
  'project.close': 'بستن پروژه',
  'project.raci': 'تعیین RACI',

  // Work orders & tasks
  'workorder.read': 'مشاهده سفارش کار',
  'workorder.issue': 'صدور سفارش کار به واحد',
  'workorder.accept': 'پذیرش سفارش کار',
  'workorder.clarify': 'اعلام ابهام',
  'workorder.submit': 'تحویل خروجی سفارش',
  'task.read': 'مشاهده وظیفه',
  'task.write': 'ایجاد/ویرایش وظیفه',
  'task.assign': 'تخصیص وظیفه',
  'task.execute': 'اجرای وظیفه',
  'deliverable.read': 'مشاهده خروجی',
  'deliverable.write': 'ایجاد/ویرایش خروجی',
  'deliverable.deliver': 'تحویل خروجی به مشتری',

  // Quality control — Doc_H §9, three levels
  'qc.read': 'مشاهده کنترل کیفیت',
  'qc.unit': 'QC سطح ۱ — واحد اجرایی',
  'qc.account': 'QC سطح ۲ — اکانت',
  'qc.final': 'QC سطح ۳ — نهایی',
  'revision.read': 'مشاهده اصلاحیه',
  'revision.create': 'صدور اصلاحیه',
  'revision.execute': 'انجام اصلاح',

  // Change control — Doc_H §8
  'change.read': 'مشاهده درخواست تغییر',
  'change.create': 'ثبت درخواست تغییر',
  'change.scope_review': 'بررسی دامنهٔ تغییر',
  'change.commercial_review': 'بررسی اثر تجاری تغییر',
  'change.approve': 'تأیید نهایی تغییر',

  // Contract & Legal
  'contract.read': 'مشاهده قرارداد',
  'contract.request': 'درخواست انعقاد قرارداد',
  'contract.draft': 'تهیه قرارداد',
  'contract.legal_review': 'بررسی حقوقی',
  'contract.approve': 'تأیید قرارداد',
  'contract.sign': 'ثبت امضای قرارداد',
  'contract.amend': 'ثبت الحاقیه',

  // Finance
  'finance.read': 'مشاهده اطلاعات مالی',
  'finance.proforma': 'صدور پیش‌فاکتور',
  'finance.invoice': 'صدور فاکتور',
  'finance.payment': 'ثبت دریافت/پرداخت',
  'finance.settle': 'تسویه پروژه',
  'finance.budget': 'مدیریت بودجه پروژه',
  'finance.rates': 'ثبت نرخ ارز',
  'media.buy': 'خرید رسانه',

  // Traffic & resources
  'traffic.read': 'مشاهده ترافیک',
  'traffic.manage': 'مدیریت ترافیک و ظرفیت',
  'resource.read': 'مشاهده منابع',
  'resource.allocate': 'تخصیص منابع',
  'supplier.read': 'مشاهده تأمین‌کننده/فریلنسر',
  'supplier.write': 'ثبت تأمین‌کننده/فریلنسر',
  'supplier.request': 'درخواست تأمین منابع خارجی',
  'supplier.approve': 'تأیید تأمین منابع خارجی',
  'supplier.evaluate': 'ارزیابی تأمین‌کننده',

  // Governance registers
  'governance.read': 'مشاهده ریسک/مسئله/تصمیم',
  'governance.write': 'ثبت ریسک/مسئله/تصمیم',
  'governance.waive': 'صدور استثنا بر قوانین حاکم',
  'meeting.read': 'مشاهده جلسات',
  'meeting.write': 'ثبت جلسه و صورتجلسه',
  // Booking rooms and resources for meetings (audit F-9): the meeting platform's roles, as permissions.
  'meeting.book': 'رزرو جلسه، اتاق و تجهیزات',
  'meeting.approve': 'تأیید رزرو جلسه',
  'meeting.view_all': 'مشاهدهٔ همهٔ رزروهای جلسه',
  'resource.manage': 'مدیریت اتاق‌ها، تجهیزات، پارکینگ و پذیرایی',
  'reception.checkin': 'پذیرش مهمانان جلسه',

  // Venues, deployment projects and rentals (ADR-103): the database of places a counter or a stand can
  // go, the projects placed in them, and what is paid for the space — rent, service charge, deposit.
  'venue.read': 'مشاهدهٔ بانک مکان‌ها',
  'venue.write': 'ثبت و ویرایش مکان‌ها و مخاطبانشان',
  'venue.manage': 'بایگانی، ادغام و ورود گروهی مکان‌ها',
  'venue.sms': 'ارسال پیامک به مکان‌ها',
  'site.read': 'مشاهدهٔ پروژه‌های استقرار',
  'site.write': 'ثبت پروژهٔ استقرار، مذاکره، نصب و نیروها',
  'site.contract.approve': 'تأیید قرارداد مکان',
  'site.close': 'بستن پروژهٔ استقرار',
  'site.configure': 'تنظیمات مکان‌ها و اجاره‌داری',
  'rental.read': 'مشاهدهٔ اجاره‌داری و مالی مکان‌ها',
  'rental.manage': 'ثبت تعهد، پرداخت و ودیعهٔ مکان‌ها',
  'rental.approve': 'تأیید کسر از ودیعه',

  // Documents, forms, reporting
  'document.read': 'مشاهده اسناد',
  'document.write': 'بارگذاری اسناد',
  'document.delete': 'حذف اسناد',
  'form.read': 'مشاهده فرم‌ها',
  'form.submit': 'ثبت فرم',
  'form.approve': 'تأیید فرم',
  'form.define': 'تعریف/ویرایش فرم',
  'report.read': 'مشاهده گزارش‌ها',
  'report.executive': 'داشبورد مدیریتی',
  'customer_success.write': 'ثبت بازخورد و درس‌آموخته',

  // AI & administration
  'ai.use': 'استفاده از دستیار هوش مصنوعی',
  // The local chat assistant (Hivamis task 5): every role has it unless the administrator takes it away.
  'ai.chat': 'گفت‌وگو با دستیار',
  'ai.write': 'نوشتن و بازنویسی با دستیار',
  'ai.image': 'ساخت تصویر با دستیار',
  'ai.configure': 'پیکربندی هوش مصنوعی',
  // Team chat (audit F-5).
  'chat.use': 'گفت‌وگو با همکاران',
  'chat.channel.create': 'ساخت کانال گفت‌وگو',
  // Disclosed oversight: no role holds it by default, only the system administrator gives it, and
  // every look is recorded with its reason (OVERSIGHT_PERMISSIONS below).
  'chat.oversight': 'بازبینی گفت‌وگوها (با ثبت دلیل در سابقهٔ حسابرسی)',
  'admin.users': 'مدیریت کاربران',
  'admin.roles': 'مدیریت نقش‌ها و دسترسی‌ها',
  'admin.settings': 'تنظیمات سیستم',
  'admin.audit': 'مشاهده گزارش حسابرسی',
  'admin.keys': 'کلیدهای API و Webhook',
  'rules.manage': 'تعریف قوانین سازمان روی گردش کار',
  // Client portal (roadmap #34)
  'portal.manage': 'مدیریت پورتال مشتری',
  // Brand library (roadmap #42)
  'brand.manage': 'مدیریت کتابخانهٔ برند مشتری',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * Permissions to read what others wrote to each other (audit F-5). Unlike every other permission
 * they are nobody's by default — not even the full-access roles' — and only the system
 * administrator (SUPER_ADMIN) may give them: to a role, or a role holding one to a person. They are
 * never delegated and never put on an API key, and each use is recorded with its reason.
 */
export const OVERSIGHT_PERMISSIONS: readonly Permission[] = ['chat.oversight'];
/** What a full-access role holds: everything but oversight, which is always someone's explicit grant. */
export const FULL_ACCESS_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter((p) => !OVERSIGHT_PERMISSIONS.includes(p));
/** The role whose holders alone may give an oversight permission. */
export const OVERSIGHT_GRANTOR_ROLE = 'SUPER_ADMIN';

const READ_ONLY: Permission[] = [
  'crm.lead.read', 'crm.opportunity.read', 'crm.company.read', 'crm.contact.read',
  'crm.activity.read', 'brief.read', 'handoff.read', 'proposal.read', 'project.read',
  'workorder.read', 'task.read', 'deliverable.read', 'qc.read', 'revision.read',
  'change.read', 'contract.read', 'traffic.read', 'resource.read', 'supplier.read',
  'governance.read', 'meeting.read', 'document.read', 'form.read', 'report.read',
  'venue.read', 'site.read',
];

const SALES_CORE: Permission[] = [
  'crm.lead.read', 'crm.lead.write', 'crm.lead.convert',
  'crm.opportunity.read', 'crm.opportunity.write',
  'crm.company.read', 'crm.company.write', 'crm.contact.read', 'crm.contact.write',
  'crm.activity.read', 'crm.activity.write',
  'brief.read', 'brief.write', 'brief.submit',
  'handoff.read', 'handoff.create',
  // Sales presents and collects feedback but never prices, integrates or executes.
  'proposal.read', 'proposal.present', 'proposal.record_feedback',
  'contract.read', 'contract.request',
  'project.read', 'task.read', 'document.read', 'document.write',
  'form.read', 'form.submit', 'meeting.read', 'meeting.write', 'report.read', 'ai.use',
  // Which places a client's campaign could go is part of the pitch.
  'venue.read',
];

const ACCOUNT_CORE: Permission[] = [
  'crm.company.read', 'crm.contact.read', 'crm.contact.write',
  'crm.opportunity.read', 'crm.activity.read', 'crm.activity.write',
  'brief.read', 'brief.review', 'brief.approve', 'brief.return', 'brief.write',
  'handoff.read', 'handoff.accept',
  'proposal.read', 'proposal.write', 'proposal.integrate', 'proposal.deliver_to_sales',
  'pricing.read', 'pricing.set_price', 'media.buy',
  'project.read', 'project.write', 'project.plan', 'project.execute', 'project.raci', 'project.close',
  'workorder.read', 'workorder.issue',
  'task.read', 'task.write', 'task.assign',
  'deliverable.read', 'deliverable.write', 'deliverable.deliver',
  'qc.read', 'qc.account', 'revision.read', 'revision.create',
  'change.read', 'change.create', 'change.scope_review', 'change.commercial_review',
  'contract.read', 'contract.request',
  'finance.read',
  'traffic.read', 'resource.read', 'supplier.read',
  'governance.read', 'governance.write', 'meeting.read', 'meeting.write',
  'document.read', 'document.write', 'form.read', 'form.submit', 'form.approve',
  'report.read', 'customer_success.write', 'ai.use',
  // The client's side of the relationship is Account's (Doc_H §2): who may use the portal, what it shows, the replies.
  'portal.manage',
  // The client's brand is kept by Account and by the units that design to it.
  'brand.manage',
  // A client's campaign placed in venues is run by Account with Operations (ADR-103).
  'venue.read', 'site.read', 'site.write',
];

const UNIT_CORE: Permission[] = [
  'brief.read', 'proposal.read',
  'project.read',
  'workorder.read', 'workorder.accept', 'workorder.clarify', 'workorder.submit',
  'task.read', 'task.write', 'task.execute',
  'deliverable.read', 'deliverable.write',
  'qc.read', 'qc.unit', 'revision.read', 'revision.execute',
  'pricing.read', 'pricing.declare_cost', // cost only — never the sale price (Doc_H §12)
  'media.buy', // held by every unit role; the booking guard confines it to the media unit (#31)
  'change.read',
  'supplier.read', 'supplier.request',
  'governance.read', 'governance.write',
  'traffic.read', 'resource.read',
  'meeting.read', 'meeting.write',
  'document.read', 'document.write', 'form.read', 'form.submit', 'report.read', 'ai.use',
  'venue.read',
];

const FINANCE_CORE: Permission[] = [
  ...READ_ONLY,
  'finance.read', 'finance.proforma', 'finance.invoice', 'finance.payment',
  'finance.budget', 'finance.rates', 'pricing.read', 'pricing.set_price',
  'document.write', 'form.submit', 'ai.use',
  // What is owed and paid for the space (ADR-103).
  'rental.read', 'rental.manage',
];

const LEGAL_CORE: Permission[] = [
  ...READ_ONLY,
  'contract.draft', 'contract.legal_review', 'contract.amend',
  'document.write', 'form.submit', 'ai.use',
];

const PMO_CORE: Permission[] = [
  ...READ_ONLY,
  'traffic.manage', 'resource.allocate',
  'project.plan', 'task.write', 'task.assign',
  'governance.write', 'meeting.write',
  'document.write', 'form.submit', 'customer_success.write', 'ai.use',
  // Operations finds the places, negotiates, installs and staffs them (ADR-103); it reads the rent, Finance pays it.
  'venue.write', 'site.write', 'rental.read',
];

/**
 * Permissions an API key may never carry (roadmap #46): the ones that would let a key make more
 * keys, more users, other roles, or exceptions to the rules — a leaked key must not be a way in
 * that outlives its discovery.
 */
export const NON_KEY_PERMISSIONS: Permission[] = [
  'admin.users', 'admin.roles', 'admin.keys', 'governance.waive', 'portal.manage', 'rules.manage',
  // Conversations are people's own (audit F-5): no key reads or writes them.
  'chat.use', 'chat.channel.create', 'chat.oversight',
  // A key does not text the venues, nor change the rules the rentals run by (ADR-103).
  'venue.sms', 'site.configure',
];

/**
 * Hivamis task 6: the managing director, the deputy, the system administrator and the account
 * manager hold the whole system — every permission but oversight (audit F-5), fixed, not something an
 * administrator can take back. The process rules (Doc_H's guards) still bind them as they bind everyone; a governed
 * exception (waiver) remains the way past one.
 */
export const FULL_ACCESS_ROLES: readonly RoleCode[] = ['SUPER_ADMIN', 'CEO', 'DEPUTY', 'ACCOUNT_MANAGER'];

/**
 * Every other role's permissions are what the organisation's system administrator grants. These are
 * the defaults a role starts with — Doc_H's separation of duties — until the administrator reviews it.
 */
/** What every role holds by default, whatever its part in the process (Hivamis task 5). */
const EVERYONE: Permission[] = ['ai.chat', 'ai.write', 'ai.image', 'chat.use', 'meeting.book'];

export const ROLE_PERMISSIONS: Record<RoleCode, Permission[]> = {
  SUPER_ADMIN: FULL_ACCESS_PERMISSIONS,
  CEO: FULL_ACCESS_PERMISSIONS,
  DEPUTY: FULL_ACCESS_PERMISSIONS,
  SALES_MANAGER: [
    ...SALES_CORE, 'crm.company.write', 'report.executive', 'form.approve', 'traffic.read', 'chat.channel.create', 'meeting.approve', ...EVERYONE,
  ],
  SALES_REP: [...SALES_CORE, ...EVERYONE],
  ACCOUNT_MANAGER: FULL_ACCESS_PERMISSIONS,
  ACCOUNT_EXEC: [...ACCOUNT_CORE.filter((p) => p !== 'project.close'), ...EVERYONE],
  UNIT_MANAGER: [...UNIT_CORE, 'form.approve', 'proposal.unit_approve', 'supplier.write', 'supplier.evaluate', 'task.assign', 'brand.manage', 'chat.channel.create', 'meeting.approve', ...EVERYONE],
  UNIT_MEMBER: [...UNIT_CORE, ...EVERYONE],
  PMO_MANAGER: [...PMO_CORE, 'report.executive', 'form.approve', 'project.close', 'rules.manage', 'chat.channel.create', 'meeting.approve', 'venue.manage', 'venue.sms', 'site.close', 'site.configure', ...EVERYONE],
  PMO_SPECIALIST: [...PMO_CORE, ...EVERYONE],
  FINANCE_MANAGER: [...FINANCE_CORE, 'finance.settle', 'form.approve', 'report.executive', 'chat.channel.create', 'meeting.approve', 'rental.approve', ...EVERYONE],
  FINANCE_SPECIALIST: [...FINANCE_CORE, ...EVERYONE],
  // Doc_H RACI step 26 («امضای قرارداد»): Responsible = Sales/Legal, Accountable = Management.
  // Legal records the signature; management still owns approval via `contract.approve`.
  LEGAL_MANAGER: [...LEGAL_CORE, 'contract.approve', 'contract.sign', 'form.approve', 'chat.channel.create', 'meeting.approve', 'site.contract.approve', ...EVERYONE],
  LEGAL_SPECIALIST: [...LEGAL_CORE, ...EVERYONE],
  VIEWER: [...READ_ONLY, ...EVERYONE],
};

/** Every role an organisation has: the code's, and its own (audit F-3), each with its permissions. */
export type RoleMap = Record<string, readonly Permission[]>;

/**
 * The roles as an organisation has them: the full-access roles hold everything but oversight, whatever is stored;
 * the rest hold what the administrator granted, or the default until one has been.
 */
export function effectiveRoleMap(granted: Partial<Record<string, readonly string[]>> = {}): RoleMap {
  const out: Record<string, readonly Permission[]> = {};
  const known = (ps: readonly string[]) => ps.filter((p): p is Permission => p in PERMISSIONS);
  for (const role of Object.keys(ROLE_PERMISSIONS) as RoleCode[]) {
    out[role] = FULL_ACCESS_ROLES.includes(role)
      ? FULL_ACCESS_PERMISSIONS
      : (granted[role] ? known(granted[role]!) : ROLE_PERMISSIONS[role]);
  }
  // An organisation's own roles (audit F-3) hold exactly what they were granted — there is no default.
  for (const [role, ps] of Object.entries(granted)) if (!(role in out) && ps) out[role] = known(ps);
  return out;
}

/** Deduplicated grants for a set of roles — under an organisation's map, or the defaults. */
export function permissionsForRoles(roles: readonly string[], map: RoleMap = ROLE_PERMISSIONS): Permission[] {
  const set = new Set<Permission>();
  for (const r of roles) for (const p of map[r] ?? []) set.add(p);
  return [...set];
}

/** The areas permissions belong to, by their prefix — how the administrator reads them (Hivamis task 6). */
export const PERMISSION_GROUPS: readonly { key: string; fa: string; en: string }[] = [
  { key: 'crm', fa: 'مشتریان و فروش', en: 'Clients and sales' },
  { key: 'brief', fa: 'بریف', en: 'Briefs' },
  { key: 'handoff', fa: 'تحویل به اکانت', en: 'Handoff to Account' },
  { key: 'proposal', fa: 'پروپوزال', en: 'Proposals' },
  { key: 'pricing', fa: 'قیمت‌گذاری', en: 'Pricing' },
  { key: 'project', fa: 'پروژه', en: 'Projects' },
  { key: 'workorder', fa: 'سفارش کار', en: 'Work orders' },
  { key: 'task', fa: 'وظیفه', en: 'Tasks' },
  { key: 'deliverable', fa: 'خروجی', en: 'Deliverables' },
  { key: 'qc', fa: 'کنترل کیفیت', en: 'Quality control' },
  { key: 'revision', fa: 'اصلاحیه', en: 'Revisions' },
  { key: 'change', fa: 'درخواست تغییر', en: 'Change requests' },
  { key: 'contract', fa: 'قرارداد', en: 'Contracts' },
  { key: 'finance', fa: 'مالی', en: 'Finance' },
  { key: 'media', fa: 'رسانه', en: 'Media' },
  { key: 'traffic', fa: 'ترافیک و ظرفیت', en: 'Traffic and capacity' },
  { key: 'resource', fa: 'منابع', en: 'Resources' },
  { key: 'supplier', fa: 'تأمین‌کنندگان', en: 'Suppliers' },
  { key: 'governance', fa: 'حاکمیت، ریسک و استثنا', en: 'Governance, risk and waivers' },
  { key: 'meeting', fa: 'جلسه', en: 'Meetings' },
  { key: 'reception', fa: 'پذیرش', en: 'Reception' },
  { key: 'venue', fa: 'بانک مکان‌ها', en: 'Venues' },
  { key: 'site', fa: 'پروژه‌های استقرار', en: 'Deployment projects' },
  { key: 'rental', fa: 'اجاره‌داری', en: 'Rentals' },
  { key: 'document', fa: 'اسناد', en: 'Documents' },
  { key: 'form', fa: 'فرم‌ها', en: 'Forms' },
  { key: 'report', fa: 'گزارش‌ها', en: 'Reports' },
  { key: 'customer_success', fa: 'موفقیت مشتری', en: 'Customer success' },
  { key: 'ai', fa: 'دستیار هوشمند', en: 'AI assistant' },
  { key: 'chat', fa: 'گفت‌وگو با همکاران', en: 'Team chat' },
  { key: 'admin', fa: 'مدیریت سیستم', en: 'Administration' },
  { key: 'rules', fa: 'قوانین سازمان', en: "Organisation's rules" },
  { key: 'portal', fa: 'پورتال مشتری', en: 'Client portal' },
  { key: 'brand', fa: 'کتابخانهٔ برند', en: 'Brand library' },
];
export const permissionGroup = (p: string) => p.split('.')[0]!;
