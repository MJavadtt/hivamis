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
  'DRAFT', 'AWAITING_UNIT_OUTPUTS', 'INTEGRATION', 'PRICING', 'FINAL_QC',
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
export const CURRENCY_LABELS: Record<Currency, string> = {
  IRR: 'ریال', USD: 'دلار آمریکا', EUR: 'یورو', AED: 'درهم امارات', GBP: 'پوند انگلیس', TRY: 'لیر ترکیه', CNY: 'یوان چین',
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
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
