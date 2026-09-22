import type { DepartmentCode, ModuleCode, RoleCode } from './enums.js';
import type { RoutingRule } from './routing.js';

/** Field primitives supported by the form engine renderer and the server-side validator. */
export type FieldType =
  | 'text' | 'textarea' | 'number' | 'currency' | 'percent'
  | 'date' | 'datetime' | 'select' | 'multiselect' | 'checkbox'
  | 'user' | 'department' | 'entityRef' | 'attachment' | 'table';

export interface FieldOption {
  readonly value: string;
  readonly labelFa: string;
}

export interface FieldDef {
  readonly key: string;
  readonly labelFa: string;
  readonly labelEn: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly options?: readonly FieldOption[];
  /** For `entityRef` — which domain entity this field points at. */
  readonly entity?: string;
  readonly placeholderFa?: string;
  readonly helpFa?: string;
  readonly min?: number;
  readonly max?: number;
  /** Show this field only when another field holds one of these values. */
  readonly visibleWhen?: { readonly field: string; readonly equals: readonly string[] };
  /** Column definitions when type === 'table'. */
  readonly columns?: readonly FieldDef[];
}

export interface FormDef {
  /** Doc_H sequence number (1–130) from «دسته‌بندی فرم‌های ارتباطی و انتقال داده شرکت». */
  readonly no: number;
  readonly code: string;
  readonly nameFa: string;
  readonly nameEn: string;
  /** Doc_H category letter A–N. */
  readonly category: string;
  readonly module: ModuleCode;
  readonly senderDepts: readonly DepartmentCode[];
  readonly receiverDepts: readonly DepartmentCode[];
  readonly approverRoles: readonly RoleCode[];
  readonly slaCode?: string;
  /**
   * When set, submitting this form drives a first-class domain entity through a typed handler
   * (apps/api/src/forms/handlers.ts) rather than being stored purely as generic form data.
   */
  readonly binding?: string;
  /** Doc_H "Next Process" column — what this form triggers downstream. */
  readonly nextProcessFa?: string;
  /**
   * Conditional approvers on top of `approverRoles` (roadmap #17) — evaluated against the
   * submitted values. The thresholds shipped here are defaults for an organisation to adjust,
   * not Doc_H clauses; the rule says which it is.
   */
  readonly routing?: readonly RoutingRule[];
  readonly fields: readonly FieldDef[];
}

/* ── reusable field builders ───────────────────────────────────────────────── */

export const f = {
  text: (key: string, fa: string, en: string, required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'text', required }),
  area: (key: string, fa: string, en: string, required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'textarea', required }),
  num: (key: string, fa: string, en: string, required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'number', required }),
  money: (key: string, fa: string, en: string, required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'currency', required }),
  pct: (key: string, fa: string, en: string, required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'percent', required }),
  date: (key: string, fa: string, en: string, required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'date', required }),
  dt: (key: string, fa: string, en: string, required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'datetime', required }),
  user: (key: string, fa: string, en: string, required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'user', required }),
  dept: (key: string, fa: string, en: string, required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'department', required }),
  ref: (key: string, fa: string, en: string, entity: string, required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'entityRef', entity, required }),
  files: (key = 'attachments', fa = 'پیوست‌ها', en = 'Attachments'): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'attachment' }),
  check: (key: string, fa: string, en: string): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'checkbox' }),
  sel: (key: string, fa: string, en: string, options: readonly FieldOption[], required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'select', options, required }),
  multi: (key: string, fa: string, en: string, options: readonly FieldOption[], required = false): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'multiselect', options, required }),
  table: (key: string, fa: string, en: string, columns: readonly FieldDef[]): FieldDef => ({ key, labelFa: fa, labelEn: en, type: 'table', columns }),
};

export const OPT = {
  yesNo: [
    { value: 'YES', labelFa: 'بله' },
    { value: 'NO', labelFa: 'خیر' },
  ],
  priority: [
    { value: 'LOW', labelFa: 'کم' },
    { value: 'NORMAL', labelFa: 'عادی' },
    { value: 'HIGH', labelFa: 'زیاد' },
    { value: 'URGENT', labelFa: 'فوری' },
  ],
  severity: [
    { value: 'LOW', labelFa: 'کم' },
    { value: 'MEDIUM', labelFa: 'متوسط' },
    { value: 'HIGH', labelFa: 'زیاد' },
    { value: 'CRITICAL', labelFa: 'بحرانی' },
  ],
  units: [
    { value: 'ST', labelFa: 'استراتژی' },
    { value: 'CR', labelFa: 'خلاقیت / گرافیک / تولید' },
    { value: 'ME', labelFa: 'رسانه' },
    { value: 'DM', labelFa: 'دیجیتال مارکتینگ' },
  ],
  scopeVerdict: [
    { value: 'IN_SCOPE', labelFa: 'داخل Scope' },
    { value: 'OUT_OF_SCOPE', labelFa: 'خارج از Scope' },
  ],
  qcVerdict: [
    { value: 'PASSED', labelFa: 'تأیید' },
    { value: 'FAILED', labelFa: 'عدم تأیید' },
  ],
  revisionReason: [
    { value: 'BRIEF_MISMATCH', labelFa: 'عدم تطابق با بریف' },
    { value: 'SCOPE_MISMATCH', labelFa: 'عدم تطابق با Scope' },
    { value: 'QUALITY_BELOW_STANDARD', labelFa: 'کیفیت پایین‌تر از استاندارد' },
    { value: 'INCOMPLETE_DELIVERABLE', labelFa: 'خروجی ناقص' },
    { value: 'BRAND_GUIDELINE_VIOLATION', labelFa: 'مغایرت با هویت بصری' },
    { value: 'CLIENT_FEEDBACK', labelFa: 'بازخورد مشتری' },
    { value: 'PRICING_ISSUE', labelFa: 'اشکال قیمت‌گذاری' },
    { value: 'TECHNICAL_DEFECT', labelFa: 'نقص فنی' },
    { value: 'OTHER', labelFa: 'سایر' },
  ],
  authBasis: [
    { value: 'CONTRACT', labelFa: 'قرارداد معتبر' },
    { value: 'OFFICIAL_ORDER', labelFa: 'سفارش رسمی مورد تأیید' },
    { value: 'INVOICED_EXECUTION_ORDER', labelFa: 'دستور اجرای فاکتوری' },
  ],
  supplierKind: [
    { value: 'FREELANCER', labelFa: 'فریلنسر' },
    { value: 'OUTSOURCE', labelFa: 'آوت‌سورس' },
    { value: 'SUPPLIER', labelFa: 'تأمین‌کننده' },
    { value: 'PARTNER', labelFa: 'شریک تجاری' },
  ],
  rating: [
    { value: '1', labelFa: '۱ — بسیار ضعیف' },
    { value: '2', labelFa: '۲ — ضعیف' },
    { value: '3', labelFa: '۳ — متوسط' },
    { value: '4', labelFa: '۴ — خوب' },
    { value: '5', labelFa: '۵ — عالی' },
  ],
} as const;

/**
 * Doc_H §C: every order form issued to an execution unit MUST carry these nine elements
 * («شرح کار، Brief، خروجی مورد انتظار، فرمت خروجی، Deadline، مسئول، بودجه، منابع، پیوست‌ها»).
 * Enforced structurally — the unit-order template is generated from this list.
 */
export const UNIT_ORDER_FIELDS: readonly FieldDef[] = [
  f.ref('projectId', 'پروژه', 'Project', 'project', true),
  f.area('scopeOfWork', 'شرح کار', 'Scope of work', true),
  f.area('brief', 'بریف', 'Brief', true),
  f.area('expectedOutput', 'خروجی مورد انتظار', 'Expected output', true),
  f.text('outputFormat', 'فرمت خروجی', 'Output format', true),
  f.date('deadline', 'Deadline', 'Deadline', true),
  f.user('owner', 'مسئول', 'Owner', true),
  f.money('budget', 'بودجه / قیمت تمام‌شده', 'Budget / cost', false),
  f.area('requiredResources', 'منابع مورد نیاز', 'Required resources'),
  f.sel('priority', 'اولویت', 'Priority', OPT.priority),
  f.files(),
];

/** Shared header for meeting-minute style forms. */
export const MEETING_FIELDS: readonly FieldDef[] = [
  f.text('subject', 'موضوع جلسه', 'Subject', true),
  f.dt('heldAt', 'تاریخ و ساعت جلسه', 'Held at', true),
  f.area('attendees', 'حاضرین', 'Attendees', true),
  f.area('agenda', 'دستور جلسه', 'Agenda'),
  f.area('decisions', 'تصمیمات', 'Decisions', true),
  f.table('actions', 'اقدامات', 'Action items', [
    f.text('action', 'اقدام', 'Action', true),
    f.user('owner', 'مسئول', 'Owner', true),
    f.date('due', 'مهلت', 'Due', true),
  ]),
  f.files(),
];

/** Shared header for the reporting family (Doc_H §K, and §14 report content requirements). */
export const STATUS_REPORT_FIELDS: readonly FieldDef[] = [
  f.ref('projectId', 'پروژه', 'Project', 'project', true),
  f.text('period', 'دوره گزارش', 'Reporting period', true),
  f.area('progress', 'وضعیت پیشرفت', 'Progress status', true),
  f.area('completed', 'فعالیت‌های انجام‌شده', 'Completed activities', true),
  f.area('inProgress', 'فعالیت‌های در حال انجام', 'In-progress activities', true),
  f.area('next', 'فعالیت‌های بعدی', 'Next activities', true),
  f.area('timelineStatus', 'وضعیت Timeline', 'Timeline status', true),
  f.area('risks', 'ریسک‌ها', 'Risks'),
  f.area('issues', 'مشکلات', 'Issues'),
  f.area('decisionsNeeded', 'تصمیمات مورد نیاز', 'Decisions needed'),
  f.area('financialStatus', 'وضعیت مالی', 'Financial status'),
  f.files(),
];
