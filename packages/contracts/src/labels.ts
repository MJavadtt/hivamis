/**
 * Persian labels for every state, verdict, level and enumerated value the platform displays.
 *
 * This lived twice: STATE_META in apps/web/src/components/ui.tsx (84 entries, with a display
 * tone) and STATE_FA in apps/api/src/pdf/fmt.ts (40 entries, labels only). The two had drifted —
 * each held entries the other lacked — so a value could render in Persian in the SPA and as a
 * raw code in the PDF of the same record, or the reverse. This is the union of both.
 *
 * It sits in contracts because the states themselves are declared here, and because a label is
 * exactly the kind of thing the api/web boundary should not duplicate.
 */

/** Display tones. A presentation vocabulary, but small, stable, and shared by both consumers. */
export type LabelTone =
  | 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'progress';

export const STATE_LABELS: Record<string, { fa: string; tone: LabelTone }> = {
  ACCEPTED: { fa: 'پذیرفته‌شده', tone: 'progress' },
  ACCOUNT: { fa: 'اکانت', tone: 'neutral' },
  ACTIVE: { fa: 'در حال اجرا', tone: 'success' },
  AMBER: { fa: 'نیازمند توجه', tone: 'warning' },
  APPROVED: { fa: 'تأییدشده', tone: 'success' },
  ASSIGNED: { fa: 'تخصیص‌یافته', tone: 'info' },
  AT_RISK: { fa: 'در خطر', tone: 'warning' },
  AUTHORIZED: { fa: 'مجوز صادر شد', tone: 'progress' },
  AWAITING_UNIT_OUTPUTS: { fa: 'در انتظار خروجی واحدها', tone: 'warning' },
  BLOCKED: { fa: 'مسدود', tone: 'danger' },
  BRAND_GUIDELINE_VIOLATION: { fa: 'مغایرت با هویت بصری', tone: 'danger' },
  BREACHED: { fa: 'نقض‌شده', tone: 'danger' },
  BRIEF_COMPLETED: { fa: 'بریف تکمیل شد', tone: 'progress' },
  BRIEF_MISMATCH: { fa: 'عدم تطابق با بریف', tone: 'danger' },
  BRIEF_REQUESTED: { fa: 'در انتظار بریف', tone: 'warning' },
  CANCELLED: { fa: 'لغو شده', tone: 'danger' },
  CLARIFICATION_REQUESTED: { fa: 'ابهام اعلام شد', tone: 'warning' },
  CLIENT: { fa: 'مشتری', tone: 'neutral' },
  CLIENT_APPROVED: { fa: 'تأیید مشتری', tone: 'success' },
  CLIENT_FEEDBACK: { fa: 'بازخورد مشتری', tone: 'info' },
  CLIENT_REJECTED: { fa: 'رد مشتری', tone: 'danger' },
  CLIENT_REVISION_REQUESTED: { fa: 'درخواست اصلاح مشتری', tone: 'warning' },
  CLOSED: { fa: 'بسته‌شده', tone: 'neutral' },
  CLOSURE: { fa: 'جلسه اختتام', tone: 'neutral' },
  COMMERCIAL_REVIEW: { fa: 'بررسی تجاری', tone: 'progress' },
  COMPLETED: { fa: 'تکمیل‌شده', tone: 'success' },
  CONTACTED: { fa: 'تماس گرفته‌شده', tone: 'info' },
  CONTRACT: { fa: 'قرارداد معتبر', tone: 'neutral' },
  CONVERTED: { fa: 'تبدیل‌شده', tone: 'success' },
  CREATED: { fa: 'ایجادشده', tone: 'neutral' },
  CRITICAL: { fa: 'بحرانی', tone: 'neutral' },
  DELIVERED: { fa: 'تحویل‌شده', tone: 'info' },
  DELIVERED_TO_SALES: { fa: 'تحویل به فروش', tone: 'info' },
  DISQUALIFIED: { fa: 'رد شده', tone: 'neutral' },
  DRAFT: { fa: 'پیش‌نویس', tone: 'neutral' },
  DRAFTING: { fa: 'در حال تنظیم', tone: 'progress' },
  EXPIRED: { fa: 'منقضی', tone: 'neutral' },
  FAILED: { fa: 'عدم تأیید', tone: 'danger' },
  FINAL: { fa: 'نهایی', tone: 'neutral' },
  FINAL_QC: { fa: 'QC نهایی', tone: 'warning' },
  FREELANCER: { fa: 'فریلنسر', tone: 'neutral' },
  FULFILLED: { fa: 'تأمین‌شده', tone: 'success' },
  GREEN: { fa: 'سالم', tone: 'success' },
  HIGH: { fa: 'زیاد', tone: 'neutral' },
  IMPLEMENTING: { fa: 'در حال اجرا', tone: 'progress' },
  INCOMPLETE_DELIVERABLE: { fa: 'خروجی ناقص', tone: 'warning' },
  INTEGRATION: { fa: 'یکپارچه‌سازی', tone: 'progress' },
  INTERNAL: { fa: 'داخلی', tone: 'neutral' },
  INTERNAL_APPROVED: { fa: 'تأیید داخلی', tone: 'progress' },
  INVOICE: { fa: 'فاکتور', tone: 'neutral' },
  INVOICED_EXECUTION_ORDER: { fa: 'دستور اجرای فاکتوری', tone: 'neutral' },
  IN_PROGRESS: { fa: 'در حال انجام', tone: 'progress' },
  IN_QC: { fa: 'در کنترل کیفیت', tone: 'warning' },
  IN_SCOPE: { fa: 'داخل Scope', tone: 'success' },
  ISSUED: { fa: 'صادرشده', tone: 'info' },
  KICKOFF: { fa: 'جلسه شروع', tone: 'neutral' },
  LEGAL_REVIEW: { fa: 'بررسی حقوقی', tone: 'progress' },
  LOST: { fa: 'از دست رفته', tone: 'danger' },
  LOW: { fa: 'کم', tone: 'neutral' },
  MANAGEMENT_REVIEW: { fa: 'بررسی مدیریت', tone: 'progress' },
  MEDIUM: { fa: 'متوسط', tone: 'neutral' },
  MET: { fa: 'رعایت‌شده', tone: 'success' },
  MITIGATING: { fa: 'در حال کاهش', tone: 'progress' },
  NEGOTIATION: { fa: 'مذاکره', tone: 'info' },
  NEW: { fa: 'جدید', tone: 'neutral' },
  NORMAL: { fa: 'عادی', tone: 'neutral' },
  OFFICIAL_ORDER: { fa: 'سفارش رسمی', tone: 'neutral' },
  ON_HOLD: { fa: 'متوقف', tone: 'warning' },
  OPEN: { fa: 'باز', tone: 'warning' },
  OTHER: { fa: 'سایر', tone: 'neutral' },
  OUTSOURCE: { fa: 'آوت‌سورس', tone: 'neutral' },
  OUT_OF_SCOPE: { fa: 'خارج از Scope', tone: 'warning' },
  PAID: { fa: 'تسویه‌شده', tone: 'success' },
  PARTIALLY_PAID: { fa: 'دریافت جزئی', tone: 'warning' },
  PARTNER: { fa: 'شریک تجاری', tone: 'neutral' },
  PASSED: { fa: 'تأیید', tone: 'success' },
  PAUSED: { fa: 'متوقف', tone: 'neutral' },
  WAITING_ON_CLIENT: { fa: 'در انتظار مشتری', tone: 'neutral' },
  WAITING_ON_SUPPLIER: { fa: 'در انتظار تأمین‌کننده', tone: 'neutral' },
  INTERNAL_DEPENDENCY: { fa: 'وابستگی داخلی', tone: 'neutral' },
  TRANSITION: { fa: 'طبق گردش کار', tone: 'neutral' },
  PENDING: { fa: 'در انتظار', tone: 'neutral' },
  PENDING_ACCEPTANCE: { fa: 'در انتظار پذیرش', tone: 'warning' },
  PENDING_APPROVAL: { fa: 'در انتظار تأیید', tone: 'warning' },
  PENDING_AUTHORIZATION: { fa: 'در انتظار مجوز', tone: 'warning' },
  PENDING_CLOSURE: { fa: 'در انتظار بستن', tone: 'warning' },
  PENDING_CUSTOMER_APPROVAL: { fa: 'در انتظار تأیید مشتری', tone: 'warning' },
  PENDING_SIGNATURE: { fa: 'در انتظار امضا', tone: 'warning' },
  PLANNED: { fa: 'برنامه‌ریزی‌شده', tone: 'neutral' },
  PLANNING: { fa: 'برنامه‌ریزی', tone: 'progress' },
  PRESENTED_TO_CLIENT: { fa: 'ارائه به مشتری', tone: 'info' },
  PRICING: { fa: 'قیمت‌گذاری', tone: 'progress' },
  PRICING_ISSUE: { fa: 'اشکال قیمت‌گذاری', tone: 'warning' },
  PROFORMA: { fa: 'پیش‌فاکتور', tone: 'neutral' },
  PROPOSAL: { fa: 'در حال پروپوزال', tone: 'progress' },
  QUALIFIED: { fa: 'واجد شرایط', tone: 'progress' },
  QUALITY_BELOW_STANDARD: { fa: 'کیفیت پایین‌تر از استاندارد', tone: 'danger' },
  REALISED: { fa: 'محقق‌شده', tone: 'danger' },
  RED: { fa: 'بحرانی', tone: 'danger' },
  REGISTERED: { fa: 'ثبت‌شده', tone: 'success' },
  REJECTED: { fa: 'رد شده', tone: 'danger' },
  REQUESTED: { fa: 'درخواست‌شده', tone: 'info' },
  RESOLVED: { fa: 'حل‌شده', tone: 'success' },
  RETURNED: { fa: 'بازگشت‌داده‌شده', tone: 'warning' },
  RETURNED_INCOMPLETE: { fa: 'بازگشت — ناقص', tone: 'danger' },
  REVISION_REQUESTED: { fa: 'نیاز به اصلاح', tone: 'warning' },
  REVISION_REQUIRED: { fa: 'نیاز به اصلاح', tone: 'danger' },
  RUNNING: { fa: 'در جریان', tone: 'info' },
  SCOPE_MISMATCH: { fa: 'عدم تطابق با Scope', tone: 'danger' },
  SCOPE_REVIEW: { fa: 'بررسی Scope', tone: 'progress' },
  SENT: { fa: 'ارسال‌شده', tone: 'info' },
  SIGNED: { fa: 'امضاشده', tone: 'success' },
  SUBMITTED: { fa: 'ارسال‌شده', tone: 'info' },
  SUPPLIER: { fa: 'تأمین‌کننده', tone: 'neutral' },
  TECHNICAL_DEFECT: { fa: 'نقص فنی', tone: 'danger' },
  TERMINATED: { fa: 'فسخ‌شده', tone: 'danger' },
  UNDER_REVIEW: { fa: 'در حال بررسی', tone: 'progress' },
  UNDETERMINED: { fa: 'تعیین‌نشده', tone: 'neutral' },
  UNIT: { fa: 'واحد اجرایی', tone: 'neutral' },
  UNIT_MANAGER_REVIEW: { fa: 'بررسی مدیر واحد', tone: 'progress' },
  URGENT: { fa: 'فوری', tone: 'neutral' },
  WON: { fa: 'برنده', tone: 'success' },
};

/** Persian label for a state, falling back to the raw value so nothing renders blank. */
export function stateLabelFa(state: string | null | undefined): string {
  if (!state) return '—';
  return STATE_LABELS[state]?.fa ?? state;
}

export function stateTone(state: string | null | undefined): LabelTone {
  return (state && STATE_LABELS[state]?.tone) || 'neutral';
}

/**
 * Doc_H §10 revision reasons. Was copy-pasted into three separate page components
 * (Projects, Dashboard, Quality), so a new reason had to be added in three places.
 */
export const REVISION_REASON_LABELS: Record<string, string> = {
  BRIEF_MISMATCH: 'عدم تطابق با بریف',
  SCOPE_MISMATCH: 'عدم تطابق با Scope',
  QUALITY_BELOW_STANDARD: 'کیفیت پایین‌تر از استاندارد',
  INCOMPLETE_DELIVERABLE: 'خروجی ناقص',
  BRAND_GUIDELINE_VIOLATION: 'مغایرت با هویت بصری',
  CLIENT_FEEDBACK: 'بازخورد مشتری',
  PRICING_ISSUE: 'اشکال قیمت‌گذاری',
  TECHNICAL_DEFECT: 'نقص فنی',
  OTHER: 'سایر',
};

export const revisionReasonFa = (reason: string): string =>
  REVISION_REASON_LABELS[reason] ?? reason;
