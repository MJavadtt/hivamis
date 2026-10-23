import { tr } from '../i18n';

/**
 * What each audit action is called on screen. Every action the API writes has one — the audit trail
 * showed REFRESH_TOKEN_REUSE as the code spells it (audit UI-V), and audit-labels.test.ts reads the
 * API's source so a new action cannot arrive without a name.
 */
export const ACTION_LABELS: Record<string, string> = {
  CREATE: tr('ایجاد'), UPDATE: tr('ویرایش'), DELETE: tr('حذف'), STATE_TRANSITION: tr('تغییر وضعیت'),
  APPROVE: tr('تأیید'), REJECT: tr('رد'), REVOKE: tr('لغو'), LOGIN: tr('ورود'), LOGIN_FAILED: tr('ورود ناموفق'),
  // The system administrator's hand on accounts (owner's report, 2026-10-23).
  ACT_AS_STARTED: tr('آغاز کار مدیر سیستم در حساب'), ACT_AS_ENDED: tr('پایان کار مدیر سیستم در حساب'),
  PASSWORD_SET: tr('تعیین رمز عبور به دست مدیر'), PERMISSIONS_SET: tr('تعیین دسترسی‌های شخصی'), ACTIVATE: tr('فعال‌سازی حساب'),
  ORGANIZATION_RESET: tr('شروع دوباره سازمان (با نگه‌داشتن سابقه)'),
  LOGOUT: tr('خروج'), PERMISSION_DENIED: tr('دسترسی رد شد'), AI_ACTION: tr('عملیات هوش مصنوعی'),
  FILE_UPLOAD: tr('بارگذاری فایل'), FILE_DOWNLOAD: tr('دریافت فایل'), FILE_VIEW: tr('مشاهدهٔ فایل'), EXPORT: tr('خروجی‌گیری'),
  BULK_IMPORT: tr('ورود گروهی داده'), TRANSITION_BLOCKED: tr('گذار متوقف‌شده'), GUARD_REMOVED: tr('حذف شرط'),
  WAIVER_GRANTED: tr('صدور استثنا'), WAIVER_REVOKED: tr('لغو استثنا'),
  SLA_PAUSE: tr('توقف ساعت SLA'), SLA_RESUME: tr('ادامهٔ ساعت SLA'),
  REFRESH_TOKEN_REUSE: tr('استفادهٔ دوباره از نشست — احتمال سرقت'), SECURITY_ALERT_REVIEWED: tr('بررسی هشدار امنیتی'),
  ACCOUNT_ACTIVATED: tr('فعال‌سازی حساب'), ORG_PROVISION: tr('ایجاد سازمان'),
  DELEGATION_GRANTED: tr('تفویض اختیار'), DELEGATION_REVOKED: tr('لغو تفویض'), DELEGATION_USED: tr('اقدام با تفویض'),
  PORTAL_INVITED: tr('دعوت به پورتال'), PORTAL_REINVITED: tr('دعوت دوباره به پورتال'), PORTAL_ACTIVATED: tr('فعال‌سازی پورتال'),
  PORTAL_DISABLED: tr('غیرفعال‌سازی پورتال'), PORTAL_LOGIN: tr('ورود به پورتال'), PORTAL_LOGIN_FAILED: tr('ورود ناموفق به پورتال'),
  CLIENT_APPROVAL_REQUESTED: tr('درخواست تأیید مشتری'), CLIENT_APPROVAL_DECIDED: tr('تصمیم مشتری'),
  CLIENT_APPROVAL_CANCELLED: tr('لغو درخواست تأیید مشتری'), CLIENT_REPORT_SENT: tr('ارسال گزارش به مشتری'),
  ESIGN_SENT: tr('ارسال برای امضای الکترونیک'), ESIGN_VOIDED: tr('ابطال امضای الکترونیک'),
  MESSENGER_LINKED: tr('اتصال پیام‌رسان'), MESSENGER_UNLINKED: tr('قطع پیام‌رسان'), MESSENGER_WEBHOOK_SET: tr('تنظیم وب‌هوک پیام‌رسان'), MESSENGER_MENU_SET: tr('ثبت دکمهٔ برنامه در ربات'),
  MEETING_TRANSCRIBED: tr('رونویسی جلسه'), LESSON_REVIEWED: tr('بررسی درس آموخته'),
  GUIDE_VIDEO_UPLOAD: tr('بارگذاری ویدیوی راهنما'), GUIDE_VIDEO_DELETE: tr('حذف ویدیوی راهنما'),
  TAX_SUBMISSION_PREPARED: tr('آماده‌سازی ارسال به سامانهٔ مؤدیان'), REVENUE_PERIOD_CLOSED: tr('بستن دورهٔ درآمد'),
  PURGE: tr('پاک‌سازی فایل'), LEGAL_HOLD: tr('نگهداری حقوقی'), LEGAL_HOLD_RELEASED: tr('برداشتن نگهداری حقوقی'),
  GENERATE: tr('ساخت با دستیار'),
  CHAT_OVERSIGHT_LIST: tr('فهرست گفت‌وگوها برای بازبینی'), CHAT_OVERSIGHT_VIEW: tr('بازبینی گفت‌وگو'),
  AI_PLAN_PROPOSED: tr('پیشنهاد تغییر از دستیار'), AI_PLAN_EXECUTED: tr('اجرای پیشنهاد تأییدشدهٔ دستیار'), AI_PLAN_DECLINED: tr('رد پیشنهاد دستیار'),
  BOOKING_RESPONDED: tr('پاسخ به دعوت جلسه'), GUEST_CHECKED_IN: tr('ورود مهمان'), GUEST_CHECKED_OUT: tr('خروج مهمان'),
};
