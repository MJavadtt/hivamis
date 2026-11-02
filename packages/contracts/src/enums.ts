/**
 * Domain enumerations.
 * Source of truth: Doc_H — «الگوریتم جامع مسیر مشتری تا پایان پروژه»,
 * «قوانین و دستورالعمل حاکم بر فرآیند اجرای پروژه‌ها», and the 52-step RACI/SLA matrix (data.pptx s31-33).
 * Every state list below is enforced by the workflow engine; illegal transitions are rejected server-side.
 */

/** Organisational unit codes — Doc_H slide 30 («کد واحدها»). */
export const DEPARTMENT_CODES = ['S', 'A', 'ST', 'CR', 'ME', 'DM', 'FI', 'LG', 'OP', 'M'] as const;
export type DepartmentCode = (typeof DEPARTMENT_CODES)[number];

export const DEPARTMENT_LABELS: Record<DepartmentCode, { fa: string; en: string }> = {
  S: { fa: 'فروش', en: 'Sales' },
  A: { fa: 'اکانت', en: 'Account' },
  ST: { fa: 'استراتژی', en: 'Strategy' },
  CR: { fa: 'خلاقیت / گرافیک / تولید', en: 'Creativity / Graphic / Production' },
  ME: { fa: 'رسانه', en: 'Media' },
  DM: { fa: 'دیجیتال مارکتینگ', en: 'Digital Marketing' },
  FI: { fa: 'مالی', en: 'Finance' },
  LG: { fa: 'حقوقی و قراردادها', en: 'Legal / Contracts' },
  OP: { fa: 'عملیات / PMO', en: 'Operations / PMO' },
  M: { fa: 'مدیریت', en: 'Management' },
};

/**
 * Each unit's tag colour until the organisation's system administrator chooses another (Hivamis
 * task 9): ten distinct hues, so two units side by side never read as one.
 */
export const DEFAULT_UNIT_COLORS: Record<DepartmentCode, string> = {
  S: '#2563eb', A: '#7c3aed', ST: '#0d9488', CR: '#db2777', ME: '#ea580c',
  DM: '#0891b2', FI: '#16a34a', LG: '#475569', OP: '#ca8a04', M: '#334155',
};
/** A colour as stored: `#rrggbb`, lower case. */
export const UNIT_COLOR_RE = /^#[0-9a-f]{6}$/;
/** For a unit outside the ten Doc_H codes. */
const NEUTRAL_UNIT_COLOR = '#64748b';

/** The colour a unit is shown in: the organisation's choice, else its default. */
export function unitColor(code: string, chosen?: string | null): string {
  return chosen ?? DEFAULT_UNIT_COLORS[code as DepartmentCode] ?? NEUTRAL_UNIT_COLOR;
}

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Black or white, whichever reads better on `background`. One of the two always reaches at least
 * 4.58:1, so any colour an administrator picks still gives a legible tag.
 */
export function textOn(background: string): '#000000' | '#ffffff' {
  return contrastRatio(background, '#000000') >= contrastRatio(background, '#ffffff') ? '#000000' : '#ffffff';
}

/** Departments that execute specialist work and receive Project Orders (Doc_H §4, forms C.20–C.26). */
export const EXECUTION_DEPARTMENTS: DepartmentCode[] = ['ST', 'CR', 'ME', 'DM'];

export const ROLE_CODES = [
  'SUPER_ADMIN', 'CEO', 'DEPUTY',
  'SALES_MANAGER', 'SALES_REP',
  'ACCOUNT_MANAGER', 'ACCOUNT_EXEC',
  'UNIT_MANAGER', 'UNIT_MEMBER',
  'PMO_MANAGER', 'PMO_SPECIALIST',
  'FINANCE_MANAGER', 'FINANCE_SPECIALIST',
  'LEGAL_MANAGER', 'LEGAL_SPECIALIST',
  'VIEWER',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_LABELS: Record<RoleCode, { fa: string; en: string }> = {
  SUPER_ADMIN: { fa: 'مدیر سیستم', en: 'System Administrator' },
  CEO: { fa: 'مدیرعامل', en: 'CEO' },
  DEPUTY: { fa: 'قائم‌مقام', en: 'Deputy CEO' },
  SALES_MANAGER: { fa: 'مدیر فروش', en: 'Sales Manager' },
  SALES_REP: { fa: 'کارشناس فروش', en: 'Sales Representative' },
  ACCOUNT_MANAGER: { fa: 'مدیر اکانت', en: 'Account Manager' },
  ACCOUNT_EXEC: { fa: 'کارشناس اکانت', en: 'Account Executive' },
  UNIT_MANAGER: { fa: 'مدیر واحد', en: 'Unit Manager' },
  UNIT_MEMBER: { fa: 'کارشناس واحد', en: 'Unit Specialist' },
  PMO_MANAGER: { fa: 'مدیر عملیات / PMO', en: 'Operations / PMO Manager' },
  PMO_SPECIALIST: { fa: 'کارشناس PMO', en: 'PMO Specialist' },
  FINANCE_MANAGER: { fa: 'مدیر مالی', en: 'Finance Manager' },
  FINANCE_SPECIALIST: { fa: 'کارشناس مالی', en: 'Finance Specialist' },
  LEGAL_MANAGER: { fa: 'مدیر حقوقی', en: 'Legal Manager' },
  LEGAL_SPECIALIST: { fa: 'کارشناس حقوقی', en: 'Legal Specialist' },
  VIEWER: { fa: 'بیننده', en: 'Viewer' },
};

/* ─────────────────────────  Entity lifecycle states  ───────────────────────── */

export const LEAD_STATES = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED'] as const;
export type LeadState = (typeof LEAD_STATES)[number];

/** Doc_H A.1–A.9 + master lifecycle. */
export const OPPORTUNITY_STATES = [
  'NEW', 'QUALIFIED', 'BRIEF_REQUESTED', 'BRIEF_COMPLETED',
  'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST',
] as const;
export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

/** Doc_H control point: «اگر بریف ناقص باشد → بازگشت به فروش برای تکمیل» (recurring cycle 1). */
export const BRIEF_STATES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'RETURNED_INCOMPLETE', 'APPROVED'] as const;
export type BriefState = (typeof BRIEF_STATES)[number];

/** Doc_H stages D, E, F — integration → pricing → final QC → sales → customer. */
export const PROPOSAL_STATES = [
  'DRAFT', 'AWAITING_UNIT_OUTPUTS', 'INTEGRATION', 'PRICING', 'UNIT_APPROVAL', 'FINAL_QC',
  'APPROVED', 'DELIVERED_TO_SALES', 'PRESENTED_TO_CLIENT',
  'CLIENT_REVISION_REQUESTED', 'CLIENT_APPROVED', 'CLIENT_REJECTED',
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** Doc_H §13 — no project may enter execution without authorisation. */
export const PROJECT_STATES = [
  'DRAFT', 'PENDING_AUTHORIZATION', 'AUTHORIZED', 'PLANNING', 'ACTIVE',
  'ON_HOLD', 'COMPLETED', 'PENDING_CLOSURE', 'CLOSED', 'CANCELLED',
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

/** Doc_H §13 — the three legal authorisation bases for starting execution. */
export const AUTHORIZATION_BASES = ['CONTRACT', 'OFFICIAL_ORDER', 'INVOICED_EXECUTION_ORDER'] as const;
export type AuthorizationBasis = (typeof AUTHORIZATION_BASES)[number];

/** Project Order issued by Account to an execution unit (Doc_H B.19, forms C.20–C.26). */
export const WORK_ORDER_STATES = [
  'DRAFT', 'ISSUED', 'PENDING_ACCEPTANCE', 'ACCEPTED',
  'CLARIFICATION_REQUESTED', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETED', 'CANCELLED',
] as const;
export type WorkOrderState = (typeof WORK_ORDER_STATES)[number];

export const TASK_STATES = [
  'CREATED', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED',
  'SUBMITTED', 'IN_QC', 'REVISION_REQUIRED', 'APPROVED', 'CLOSED', 'CANCELLED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * What a deliverable is, where the process needs to tell (owner's «فرآیند محیطی», 2026-11-02): the artwork
 * an out-of-home display runs, and the reports at its start, during it and at its end. Most deliverables
 * have none.
 */
export const DELIVERABLE_KINDS = ['OOH_ARTWORK', 'OOH_START_REPORT', 'OOH_PERIODIC_REPORT', 'OOH_END_REPORT'] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export const DELIVERABLE_STATES = [
  'PLANNED', 'IN_PROGRESS', 'SUBMITTED', 'IN_QC',
  'REVISION_REQUIRED', 'APPROVED', 'DELIVERED', 'ACCEPTED',
] as const;
export type DeliverableState = (typeof DELIVERABLE_STATES)[number];

/** Doc_H §9 — QC is performed at exactly three levels. */
export const QC_LEVELS = ['UNIT', 'ACCOUNT', 'FINAL'] as const;
export type QcLevel = (typeof QC_LEVELS)[number];

export const QC_RESULTS = ['PENDING', 'PASSED', 'FAILED'] as const;
export type QcResult = (typeof QC_RESULTS)[number];

/** Doc_H §10 — no revision without a recorded reason. */
export const REVISION_STATES = [
  'REQUESTED', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'IN_QC', 'APPROVED', 'REJECTED',
] as const;
export type RevisionState = (typeof REVISION_STATES)[number];

export const REVISION_REASONS = [
  'BRIEF_MISMATCH', 'SCOPE_MISMATCH', 'QUALITY_BELOW_STANDARD', 'INCOMPLETE_DELIVERABLE',
  'BRAND_GUIDELINE_VIOLATION', 'CLIENT_FEEDBACK', 'PRICING_ISSUE', 'TECHNICAL_DEFECT', 'OTHER',
] as const;
export type RevisionReason = (typeof REVISION_REASONS)[number];

/** Doc_H §8 + stage I — commercial impact must be assessed before execution. */
export const CHANGE_REQUEST_STATES = [
  'SUBMITTED', 'SCOPE_REVIEW', 'COMMERCIAL_REVIEW', 'PENDING_CUSTOMER_APPROVAL',
  'APPROVED', 'REJECTED', 'IMPLEMENTING', 'CLOSED',
] as const;
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

export const SCOPE_VERDICTS = ['UNDETERMINED', 'IN_SCOPE', 'OUT_OF_SCOPE'] as const;
export type ScopeVerdict = (typeof SCOPE_VERDICTS)[number];

export const CONTRACT_STATES = [
  'REQUESTED', 'DRAFTING', 'LEGAL_REVIEW', 'REVISION_REQUESTED', 'INTERNAL_APPROVED',
  'PENDING_SIGNATURE', 'SIGNED', 'REGISTERED', 'EXPIRED', 'TERMINATED',
] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

/**
 * Currencies an amount may be recorded in (roadmap #28). The organisation's own currency is the
 * base every report sums in; any other is converted at the rate in force on the record's date and
 * keeps its original figure and that rate beside the converted one.
 */
export const CURRENCIES = ['IRR', 'USD', 'EUR', 'AED', 'GBP', 'TRY', 'CNY'] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * Digits after the point in each currency, as ISO 4217 lists them (audit CALC-3). Every currency the
 * system offers today has two; the others are here so that an organisation whose base currency has none
 * (JPY) or three (KWD, IQD) is settled to its own smallest unit, not to a cent it does not have.
 */
export const CURRENCY_MINOR_UNITS: Record<string, number> = {
  IRR: 2, USD: 2, EUR: 2, AED: 2, GBP: 2, TRY: 2, CNY: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, UGX: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};
export const minorUnitsOf = (currency: string): number => CURRENCY_MINOR_UNITS[currency.toUpperCase()] ?? 2;
export const CURRENCY_LABELS: Record<Currency, string> = {
  IRR: 'ریال', USD: 'دلار آمریکا', EUR: 'یورو', AED: 'درهم امارات', GBP: 'پوند انگلیس', TRY: 'لیر ترکیه', CNY: 'یوان چین',
};

/** Media bought on a client's behalf (roadmap #31). */
export const MEDIA_CHANNELS = ['TV', 'RADIO', 'OUTDOOR', 'PRINT', 'DIGITAL', 'CINEMA', 'OTHER'] as const;
export type MediaChannel = (typeof MEDIA_CHANNELS)[number];
export const MEDIA_CHANNEL_LABELS: Record<MediaChannel, string> = {
  TV: 'تلویزیون', RADIO: 'رادیو', OUTDOOR: 'محیطی (بیلبورد)', PRINT: 'چاپی', DIGITAL: 'دیجیتال', CINEMA: 'سینما', OTHER: 'سایر',
};
/**
 * COMMISSION — the client is billed the media's gross; the vendor bills the agency net of the
 * agency commission, and the commission is the agency's revenue. MARKUP — the vendor bills net;
 * the client is billed net plus the agency's markup, and the markup is the agency's revenue.
 * Either way the vendor's net is a pass-through: billed to the client, never the agency's revenue.
 */
export const MEDIA_PRICING_MODELS = ['COMMISSION', 'MARKUP'] as const;
export type MediaPricingModel = (typeof MEDIA_PRICING_MODELS)[number];

/**
 * The accounts an accounting export posts to (roadmap #33); each organisation maps them to the
 * codes of its own chart of accounts.
 */
export const ACCOUNT_KEYS = ['receivable', 'revenue', 'vat', 'mediaClearing', 'bank', 'cash', 'clientAdvance', 'projectCost', 'fxGain', 'fxLoss'] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];
export const ACCOUNT_LABELS: Record<AccountKey, string> = {
  receivable: 'حساب‌های دریافتنی (مشتریان)', revenue: 'درآمد خدمات', vat: 'مالیات بر ارزش افزودهٔ فروش',
  mediaClearing: 'حساب واسط رسانه (عبوری)', bank: 'بانک', cash: 'صندوق', clientAdvance: 'پیش‌دریافت از مشتریان',
  projectCost: 'هزینه‌های مستقیم پروژه', fxGain: 'سود تسعیر ارز', fxLoss: 'زیان تسعیر ارز',
};
/** What a column of the export file can hold; `amount` is signed — debit positive, credit negative. */
export const ACCOUNTING_FIELDS = ['voucherNo', 'date', 'voucherDescription', 'row', 'accountCode', 'detailCode', 'lineDescription', 'debit', 'credit', 'amount', 'reference'] as const;
export type AccountingField = (typeof ACCOUNTING_FIELDS)[number];
export const ACCOUNTING_FIELD_LABELS: Record<AccountingField, string> = {
  voucherNo: 'شماره سند', date: 'تاریخ', voucherDescription: 'شرح سند', row: 'ردیف', accountCode: 'کد حساب',
  detailCode: 'کد تفصیلی', lineDescription: 'شرح', debit: 'بدهکار', credit: 'بستانکار', amount: 'مبلغ (بدهکار مثبت، بستانکار منفی)', reference: 'مرجع',
};

/** A client's approval kept as evidence (roadmap #35). */
export const CLIENT_APPROVAL_SUBJECTS = ['DELIVERABLE', 'PROPOSAL'] as const;
export type ClientApprovalSubject = (typeof CLIENT_APPROVAL_SUBJECTS)[number];
export const CLIENT_APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'CANCELLED', 'EXPIRED'] as const;
export type ClientApprovalStatus = (typeof CLIENT_APPROVAL_STATUSES)[number];
export const CLIENT_APPROVAL_STATUS_LABELS: Record<ClientApprovalStatus, string> = {
  PENDING: 'در انتظار مشتری', APPROVED: 'تأیید شد', CHANGES_REQUESTED: 'درخواست اصلاح', CANCELLED: 'لغو شد', EXPIRED: 'منقضی شد',
};
/** How the deliverable reads from the client's side (roadmap #34): the internal steps are one step to them. */
export const PORTAL_DELIVERABLE_STATUS: Record<string, string> = {
  DELIVERED: 'تحویل شده — منتظر نظر شما', ACCEPTED: 'تأیید شده', REVISION_REQUIRED: 'در حال اصلاح',
};
export const ENVELOPE_STATUS_LABELS: Record<string, string> = {
  SENT: 'در انتظار امضا', COMPLETED: 'امضا شد', DECLINED: 'رد شد', VOIDED: 'باطل شد', EXPIRED: 'منقضی شد',
};
export const SIGNER_STATUS_LABELS: Record<string, string> = { PENDING: 'در انتظار', SIGNED: 'امضا کرد', DECLINED: 'رد کرد' };
/** A client's brand library (roadmap #42). */
export const BRAND_ROLES = ['LOGO', 'FONT', 'GUIDELINE', 'IMAGE', 'OTHER'] as const;
export type BrandRole = (typeof BRAND_ROLES)[number];
export const BRAND_ROLE_LABELS: Record<BrandRole, string> = { LOGO: 'لوگو', FONT: 'فونت', GUIDELINE: 'راهنمای هویت بصری', IMAGE: 'تصویر', OTHER: 'سایر' };
export const BRAND_COLOR_ROLES = ['PRIMARY', 'SECONDARY', 'ACCENT', 'NEUTRAL'] as const;
export const BRAND_COLOR_ROLE_LABELS: Record<(typeof BRAND_COLOR_ROLES)[number], string> = { PRIMARY: 'اصلی', SECONDARY: 'دوم', ACCENT: 'تأکیدی', NEUTRAL: 'خنثی' };
/** What an organisation brings with it when it starts (roadmap #48). */
export const ONBOARDING_IMPORTS = ['users', 'companies', 'contacts', 'projects', 'holidays'] as const;
export type OnboardingImport = (typeof ONBOARDING_IMPORTS)[number];
export const ONBOARDING_IMPORT_LABELS: Record<OnboardingImport, string> = {
  users: 'کاربران و ساختار سازمانی', companies: 'مشتریان', contacts: 'مخاطبان مشتریان', projects: 'پروژه‌های در جریان', holidays: 'تعطیلات',
};
/** The states an in-flight project may come over in; a closed one is history, not onboarding. */
export const PROJECT_OPENING_STATES = ['DRAFT', 'PENDING_AUTHORIZATION', 'AUTHORIZED', 'PLANNING', 'ACTIVE', 'ON_HOLD'] as const;

/** An organisation's own rule on a transition (roadmap #47). */
export const CUSTOM_RULE_KINDS = ['GUARD', 'NOTIFY'] as const;
export type CustomRuleKind = (typeof CUSTOM_RULE_KINDS)[number];
export const CUSTOM_RULE_KIND_LABELS: Record<CustomRuleKind, string> = { GUARD: 'شرط انتقال', NOTIFY: 'آگاه‌سازی' };
/** Where a rule on a transition comes from: the product, an installed extension, or the organisation. */
export const RULE_SOURCE_LABELS: Record<string, string> = { core: 'Doc_H (هستهٔ سامانه)', extension: 'افزونه', custom: 'قانون سازمان' };

/** How a file's colour or typeface stands against the brand library (roadmap #43). */
export const BRAND_CHECK_STATUS_LABELS: Record<string, string> = {
  BRAND: 'رنگ برند', NEAR: 'نزدیک به رنگ برند', NEUTRAL: 'خنثی', OFF: 'بیرون از پالت', UNCHECKED: 'سنجیده نشد',
};
export const COLOR_SPACE_LABELS: Record<string, string> = {
  RGB: 'RGB', RGBA: 'RGB با شفافیت', GRAYSCALE: 'سیاه‌وسفید', GRAYSCALE_ALPHA: 'سیاه‌وسفید با شفافیت', INDEXED: 'پالت محدود', CMYK: 'CMYK (چاپی)', YCCK: 'YCCK (چاپی)',
};
export const PORTAL_USER_STATUS_LABELS: Record<string, string> = { INVITED: 'دعوت شده', ACTIVE: 'فعال', DISABLED: 'غیرفعال' };
export const CLIENT_APPROVAL_EVENT_LABELS: Record<string, string> = {
  CREATED: 'درخواست ثبت شد', SENT: 'پیوند فرستاده شد', OPENED: 'صفحه باز شد', FILE_VIEWED: 'فایل دریافت شد',
  FILE_MISMATCH: 'فایل با نسخهٔ ثبت‌شده نخواند', CODE_SENT: 'کد یک‌بارمصرف فرستاده شد', CODE_REJECTED: 'کد نادرست',
  DECIDED: 'تصمیم ثبت شد', CANCELLED: 'لغو شد', EXPIRED: 'منقضی شد',
};

export const INVOICE_KINDS = ['PROFORMA', 'INVOICE'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const INVOICE_STATES = ['DRAFT', 'ISSUED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

export const RISK_STATES = ['OPEN', 'MITIGATING', 'CLOSED', 'REALISED'] as const;
export type RiskState = (typeof RISK_STATES)[number];

export const ISSUE_STATES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export const SEVERITY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export const PRIORITY_LEVELS = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

/** Doc_H §5 — external resource supply. */
export const SUPPLIER_KINDS = ['FREELANCER', 'OUTSOURCE', 'SUPPLIER', 'PARTNER'] as const;
export type SupplierKind = (typeof SUPPLIER_KINDS)[number];

export const OUTSOURCE_STATES = [
  'REQUESTED', 'UNIT_MANAGER_REVIEW', 'MANAGEMENT_REVIEW', 'APPROVED', 'REJECTED', 'FULFILLED',
] as const;
export type OutsourceState = (typeof OUTSOURCE_STATES)[number];

/** Generic form-engine submission lifecycle (Doc_H: Form → … → Approver → SLA → Next Process). */
export const FORM_SUBMISSION_STATES = [
  'DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED',
] as const;
export type FormSubmissionState = (typeof FORM_SUBMISSION_STATES)[number];

export const SLA_STATES = ['RUNNING', 'PAUSED', 'MET', 'AT_RISK', 'BREACHED', 'CANCELLED'] as const;
export type SlaState = (typeof SLA_STATES)[number];

/**
 * Why a clock was paused. The distinction that matters for evaluation is whether the wait was
 * ours to control: time spent waiting on a client or a supplier is reported separately from
 * the time the deadline actually measures. TRANSITION is reserved for pauses a state machine
 * declares (`pausesSla` on a transition); the others are chosen by a person, with a reason.
 */
export const SLA_PAUSE_KINDS = [
  'WAITING_ON_CLIENT', 'WAITING_ON_SUPPLIER', 'INTERNAL_DEPENDENCY', 'TRANSITION',
] as const;
export type SlaPauseKind = (typeof SLA_PAUSE_KINDS)[number];

export const RACI_ROLES = ['R', 'A', 'C', 'I'] as const;
export type RaciRole = (typeof RACI_ROLES)[number];

export const HANDOFF_STATES = ['DRAFT', 'SUBMITTED', 'ACCEPTED', 'RETURNED'] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

/** The 10 ERP modules mandated by Doc_H («ساختار پیشنهادی نهایی فرم‌ها در ERP»). */
export const MODULES = [
  'CRM_SALES', 'ACCOUNT_MANAGEMENT', 'PROJECT_PMO', 'TRAFFIC_TASK', 'CREATIVE_PRODUCTION',
  'MEDIA_DIGITAL', 'QUALITY_CONTROL', 'FINANCE', 'CONTRACT_LEGAL', 'REPORTING_CUSTOMER_SUCCESS',
] as const;
export type ModuleCode = (typeof MODULES)[number];

export const MODULE_LABELS: Record<ModuleCode, { fa: string; en: string }> = {
  CRM_SALES: { fa: 'CRM و فروش', en: 'CRM & Sales' },
  ACCOUNT_MANAGEMENT: { fa: 'مدیریت اکانت', en: 'Account Management' },
  PROJECT_PMO: { fa: 'مدیریت پروژه / PMO', en: 'Project Management / PMO' },
  TRAFFIC_TASK: { fa: 'ترافیک و مدیریت وظایف', en: 'Traffic & Task Management' },
  CREATIVE_PRODUCTION: { fa: 'خلاقیت و تولید', en: 'Creative & Production' },
  MEDIA_DIGITAL: { fa: 'رسانه و دیجیتال', en: 'Media & Digital' },
  QUALITY_CONTROL: { fa: 'کنترل کیفیت', en: 'Quality Control' },
  FINANCE: { fa: 'مالی', en: 'Finance' },
  CONTRACT_LEGAL: { fa: 'قرارداد و حقوقی', en: 'Contract & Legal' },
  REPORTING_CUSTOMER_SUCCESS: { fa: 'گزارش‌دهی و موفقیت مشتری', en: 'Reporting & Customer Success' },
};

export const AUDIT_ACTIONS = [
  'CREATE', 'UPDATE', 'DELETE', 'STATE_TRANSITION', 'APPROVE', 'REJECT',
  'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PERMISSION_DENIED', 'REFRESH_TOKEN_REUSE', 'AI_ACTION',
  'EXPORT', 'FILE_UPLOAD', 'FILE_DOWNLOAD',
  // A file shown in the app (a preview), once per person, file and hour — roadmap #42.
  'FILE_VIEW',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
