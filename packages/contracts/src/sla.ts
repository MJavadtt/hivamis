/**
 * SLA catalogue — transcribed from Doc_H data.pptx slide 33 («SLA پیشنهادی»)
 * and the per-step SLA column of the 52-step RACI matrix (slides 31–32).
 *
 * Durations are in BUSINESS hours and are consumed by the SLA engine against the
 * organisation's business calendar (Iranian working week, see BUSINESS_CALENDAR below).
 */
export interface SlaPolicyDef {
  readonly code: string;
  readonly labelFa: string;
  readonly labelEn: string;
  /** Business hours allowed before breach. */
  readonly hours: number;
  /** Fraction of `hours` at which the clock is flagged AT_RISK and a warning is emitted. */
  readonly warnAt: number;
  readonly docRef: string;
}

const D = 8; // one business day = 8 working hours

export const SLA_POLICIES: readonly SlaPolicyDef[] = [
  { code: 'SLA_LEAD_CREATE', labelFa: 'ثبت Lead', labelEn: 'Lead registration', hours: 1 * D, warnAt: 0.75, docRef: 'RACI #1 — حداکثر ۱ روز کاری' },
  { code: 'SLA_BRIEF_PREPARE', labelFa: 'تهیه بریف فروش', labelEn: 'Prepare sales brief', hours: 1 * D, warnAt: 0.75, docRef: 'RACI #3 — ۱ روز' },
  { code: 'SLA_BRIEF_ACK', labelFa: 'پاسخ اکانت به بریف جدید', labelEn: 'Account acknowledges new brief', hours: 4, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۴ ساعت کاری' },
  { code: 'SLA_BRIEF_REVIEW', labelFa: 'بررسی کامل بودن بریف', labelEn: 'Brief completeness review', hours: 1 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۱ روز کاری' },
  { code: 'SLA_KICKOFF', labelFa: 'برگزاری Kick-off', labelEn: 'Hold kick-off', hours: 1 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۱ روز پس از تأیید بریف' },
  { code: 'SLA_PROJECT_CREATE', labelFa: 'ایجاد پروژه', labelEn: 'Create project', hours: 1 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۱ روز' },
  { code: 'SLA_TASK_DISPATCH', labelFa: 'ارسال Task به واحد', labelEn: 'Dispatch task to unit', hours: 1 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۱ روز' },
  { code: 'SLA_TASK_ACCEPTANCE', labelFa: 'اعلام پذیرش Task', labelEn: 'Task acceptance', hours: 4, warnAt: 0.75, docRef: 'SLA sheet + RACI #8 — حداکثر ۴ ساعت' },
  { code: 'SLA_CLARIFICATION', labelFa: 'اعلام و رفع ابهام', labelEn: 'Clarification', hours: 4, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۴ ساعت' },
  { code: 'SLA_RESOURCE_REQUEST', labelFa: 'تأمین منابع', labelEn: 'Resource fulfilment', hours: 2 * D, warnAt: 0.7, docRef: 'RACI #10 — طبق پروژه' },
  { code: 'SLA_UNIT_QC', labelFa: 'QC داخلی واحد', labelEn: 'Unit internal QC', hours: 4, warnAt: 0.75, docRef: 'RACI #12 — ≤ 0.5 روز' },
  { code: 'SLA_ACCOUNT_QC', labelFa: 'QC اولیه اکانت', labelEn: 'Account QC', hours: 1 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۱ روز' },
  { code: 'SLA_REVISION', labelFa: 'اصلاح خروجی', labelEn: 'Output revision', hours: 4, warnAt: 0.75, docRef: 'SLA sheet — پاسخ به Revision حداکثر ۴ ساعت' },
  { code: 'SLA_INTEGRATION', labelFa: 'یکپارچه‌سازی خروجی‌ها', labelEn: 'Output integration', hours: 2 * D, warnAt: 0.7, docRef: 'RACI #16 — ۱ تا ۲ روز' },
  { code: 'SLA_PRICING', labelFa: 'قیمت‌گذاری', labelEn: 'Pricing', hours: 1 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۱ روز' },
  { code: 'SLA_FINAL_QC', labelFa: 'QC نهایی', labelEn: 'Final QC', hours: 1 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۱ روز' },
  /**
   * APPROXIMATION. Doc_H says «همان روز تأیید» — by close of business on the day the proposal is
   * approved — which is not a fixed duration: approved at 09:00 it means eight hours, approved at
   * 16:00 it means one. The engine only supports a duration from the start instant, so this is
   * carried as one working day with an early warning threshold. Modelling it exactly needs a
   * deadline kind of "end of the current working day", which the SlaPolicy shape has no room for.
   */
  { code: 'SLA_PROPOSAL_HANDOVER', labelFa: 'تحویل Proposal به فروش', labelEn: 'Proposal handover to Sales', hours: 1 * D, warnAt: 0.6, docRef: 'SLA sheet — همان روز تأیید' },
  { code: 'SLA_PROPOSAL_REVISION', labelFa: 'اصلاح Proposal', labelEn: 'Proposal revision', hours: 2 * D, warnAt: 0.7, docRef: 'RACI #22 — طبق Revision SLA' },
  { code: 'SLA_CONTRACT_DRAFT', labelFa: 'تهیه قرارداد', labelEn: 'Contract drafting', hours: 3 * D, warnAt: 0.7, docRef: 'RACI #25 — ۱ تا ۳ روز' },
  { code: 'SLA_PROJECT_AUTHORIZATION', labelFa: 'مجوز شروع پروژه', labelEn: 'Project start authorization', hours: 1 * D, warnAt: 0.75, docRef: 'RACI #27 — ≤ ۱ روز' },
  { code: 'SLA_HANDOVER', labelFa: 'انتقال مشتری پس از قرارداد', labelEn: 'Post-contract handover', hours: 1 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۱ روز' },
  { code: 'SLA_EXECUTION_KICKOFF', labelFa: 'Kick-off اجرایی', labelEn: 'Execution kick-off', hours: 2 * D, warnAt: 0.7, docRef: 'SLA sheet — حداکثر ۲ روز' },
  { code: 'SLA_STATUS_REPORT', labelFa: 'گزارش وضعیت پروژه', labelEn: 'Project status report', hours: 5 * D, warnAt: 0.8, docRef: 'SLA sheet — هفتگی' },
  { code: 'SLA_SCOPE_REVIEW', labelFa: 'بررسی Scope', labelEn: 'Scope review', hours: 4, warnAt: 0.75, docRef: 'RACI #37 — ≤ ۴ ساعت' },
  { code: 'SLA_CHANGE_REQUEST', labelFa: 'پاسخ به Change Request', labelEn: 'Change request response', hours: 1 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۱ روز' },
  // «۲۴ ساعت» is 24 calendar hours — by the next working day — not 24 working hours, which
  // would be three working days and, across the Thursday–Friday weekend, nearly a week.
  { code: 'SLA_MEETING_MINUTES', labelFa: 'ثبت صورتجلسه', labelEn: 'Meeting minutes', hours: 1 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۲۴ ساعت پس از جلسه' },
  { code: 'SLA_PROJECT_CLOSURE', labelFa: 'گزارش پایان پروژه', labelEn: 'Project closure report', hours: 3 * D, warnAt: 0.7, docRef: 'SLA sheet — حداکثر ۳ روز' },
  { code: 'SLA_FEEDBACK', labelFa: 'دریافت Feedback مشتری', labelEn: 'Collect customer feedback', hours: 7 * D, warnAt: 0.8, docRef: 'SLA sheet — حداکثر ۷ روز' },
  { code: 'SLA_PROJECT_CLOSE', labelFa: 'بستن پروژه', labelEn: 'Close project', hours: 2 * D, warnAt: 0.75, docRef: 'SLA sheet — حداکثر ۲ روز پس از تکمیل Closure' },
  { code: 'SLA_FORM_APPROVAL', labelFa: 'تأیید فرم', labelEn: 'Form approval', hours: 1 * D, warnAt: 0.75, docRef: 'Default form-engine SLA' },
  { code: 'SLA_BOOKING_APPROVAL', labelFa: 'تأیید رزرو جلسه', labelEn: 'Meeting booking approval', hours: 4, warnAt: 0.75, docRef: 'Audit F-9 — a booking is decided within half a working day' },
];

export const SLA_BY_CODE = new Map(SLA_POLICIES.map((p) => [p.code, p]));

/**
 * Iranian working week: Saturday–Wednesday, 09:00–18:00 with a one-hour break (8 productive hours).
 * Thursday and Friday are non-working. Tenant-configurable at runtime via organisation settings.
 * JS day indices: 0=Sun … 6=Sat.
 */
export const BUSINESS_CALENDAR = {
  workingDays: [6, 0, 1, 2, 3] as number[], // Sat, Sun, Mon, Tue, Wed
  startHour: 9,
  endHour: 18,
  breakHours: 1,
  timezone: 'Asia/Tehran',
  get hoursPerDay() {
    return this.endHour - this.startHour - this.breakHours;
  },
};
