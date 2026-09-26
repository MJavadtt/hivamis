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
  'crm.lead.read': 'مشاهده Lead',
  'crm.lead.write': 'ایجاد/ویرایش Lead',
  'crm.lead.convert': 'تبدیل Lead به Opportunity',
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
  'proposal.present': 'ارائه پروپوزال به مشتری',
  'proposal.record_feedback': 'ثبت بازخورد مشتری',
  'pricing.read': 'مشاهده قیمت‌گذاری',
  'pricing.declare_cost': 'اعلام قیمت تمام‌شده',
  'pricing.set_price': 'تعیین قیمت فروش و Margin',
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
  'change.scope_review': 'بررسی Scope تغییر',
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
  'governance.waive': 'صدور استثنا بر قوانین حاکم (فقط مدیرعامل و قائم‌مقام)',
  'meeting.read': 'مشاهده جلسات',
  'meeting.write': 'ثبت جلسه و صورتجلسه',

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
  'ai.configure': 'پیکربندی هوش مصنوعی',
  'admin.users': 'مدیریت کاربران',
  'admin.roles': 'مدیریت نقش‌ها و دسترسی‌ها',
  'admin.settings': 'تنظیمات سیستم',
  'admin.audit': 'مشاهده گزارش حسابرسی',
  'admin.keys': 'کلیدهای API و Webhook',
  // Client portal (roadmap #34)
  'portal.manage': 'مدیریت پورتال مشتری',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const READ_ONLY: Permission[] = [
  'crm.lead.read', 'crm.opportunity.read', 'crm.company.read', 'crm.contact.read',
  'crm.activity.read', 'brief.read', 'handoff.read', 'proposal.read', 'project.read',
  'workorder.read', 'task.read', 'deliverable.read', 'qc.read', 'revision.read',
  'change.read', 'contract.read', 'traffic.read', 'resource.read', 'supplier.read',
  'governance.read', 'meeting.read', 'document.read', 'form.read', 'report.read',
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
];

const FINANCE_CORE: Permission[] = [
  ...READ_ONLY,
  'finance.read', 'finance.proforma', 'finance.invoice', 'finance.payment',
  'finance.budget', 'finance.rates', 'pricing.read', 'pricing.set_price',
  'document.write', 'form.submit', 'ai.use',
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
];

/**
 * Permissions an API key may never carry (roadmap #46): the ones that would let a key make more
 * keys, more users, other roles, or exceptions to the rules — a leaked key must not be a way in
 * that outlives its discovery.
 */
export const NON_KEY_PERMISSIONS: Permission[] = ['admin.users', 'admin.roles', 'admin.keys', 'governance.waive', 'portal.manage'];

export const ROLE_PERMISSIONS: Record<RoleCode, Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  CEO: [
    ...ALL_PERMISSIONS.filter(
      (p) => !['admin.users', 'admin.roles', 'form.define'].includes(p),
    ),
  ],
  DEPUTY: [
    ...READ_ONLY, 'report.executive', 'admin.audit', 'governance.waive',
    'project.authorize', 'pricing.read', 'pricing.approve', 'qc.final',
    'change.approve', 'contract.approve', 'contract.sign',
    'supplier.approve', 'finance.read', 'finance.settle',
    'form.approve', 'form.submit', 'meeting.write', 'governance.write', 'ai.use',
  ],
  SALES_MANAGER: [
    ...SALES_CORE, 'crm.company.write', 'report.executive', 'form.approve', 'traffic.read',
  ],
  SALES_REP: SALES_CORE,
  // `change.approve` records the CUSTOMER's decision on a change request (Doc_H RACI #36,
  // approver «Account/Customer»). It does not alter the contract — that needs contract.amend.
  ACCOUNT_MANAGER: [...ACCOUNT_CORE, 'qc.final', 'change.approve', 'report.executive', 'traffic.manage'],
  ACCOUNT_EXEC: ACCOUNT_CORE.filter((p) => p !== 'project.close'),
  UNIT_MANAGER: [...UNIT_CORE, 'form.approve', 'supplier.write', 'supplier.evaluate', 'task.assign'],
  UNIT_MEMBER: UNIT_CORE,
  PMO_MANAGER: [...PMO_CORE, 'report.executive', 'form.approve', 'project.close'],
  PMO_SPECIALIST: PMO_CORE,
  FINANCE_MANAGER: [...FINANCE_CORE, 'finance.settle', 'form.approve', 'report.executive'],
  FINANCE_SPECIALIST: FINANCE_CORE,
  // Doc_H RACI step 26 («امضای قرارداد»): Responsible = Sales/Legal, Accountable = Management.
  // Legal records the signature; management still owns approval via `contract.approve`.
  LEGAL_MANAGER: [...LEGAL_CORE, 'contract.approve', 'contract.sign', 'form.approve'],
  LEGAL_SPECIALIST: LEGAL_CORE,
  VIEWER: READ_ONLY,
};

/** Deduplicated grants for a set of roles. */
export function permissionsForRoles(roles: RoleCode[]): Permission[] {
  const set = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) set.add(p);
  return [...set];
}
