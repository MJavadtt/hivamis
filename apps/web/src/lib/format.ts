// Individual getters rather than `format`: the formatting engine and its locale data cost
// roughly 30 kB gzipped, and all this needs is the three calendar numbers.
import {
  getDate as jalaliGetDate, getMonth as jalaliGetMonth, getYear as jalaliGetYear,
  newDate as jalaliNewDate, getDaysInMonth as jalaliGetDaysInMonth,
} from 'date-fns-jalali';
import { isEnglish } from '../i18n';
/**
 * Number and date formatting. All user-visible numbers and dates go through here.
 *
 * Persian: Persian digits, «ریال», the Solar Hijri calendar the organisation works in. English
 * (Hivamis task 7): Latin digits, "Rials", and Gregorian dates — an English reader is not assumed to
 * read the Persian calendar; the stored value is the same instant either way.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/** Persian digits, whatever the interface language — for the Solar Hijri date input. */
export const toPersianDigits = (input: string | number): string =>
  String(input).replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);

/** Digits as the reader's language writes them: Persian in Persian, Latin in English. */
export const localDigits = (input: string | number): string =>
  isEnglish() ? String(input) : toPersianDigits(input);

export function formatNumber(value: number | string | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return localDigits(
    n.toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }),
  );
}

const rials = (amount: string) => (isEnglish() ? `${amount} Rials` : `${amount} ریال`);

/**
 * Rial amounts run to billions, so large figures are abbreviated («۴٫۳ میلیارد ریال», "4.3 billion
 * Rials") with the exact value available on hover.
 */
export function formatCurrency(value: number | string | null | undefined, compact = true): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  if (!compact) return rials(formatNumber(n));
  const abs = Math.abs(n);
  const scaled = (div: number, fa: string, en: string) =>
    isEnglish() ? `${(n / div).toFixed(1)} ${en} Rials` : `${toPersianDigits((n / div).toFixed(1))} ${fa} ریال`;
  if (abs >= 1_000_000_000_000) return scaled(1_000_000_000_000, 'هزار میلیارد', 'trillion');
  if (abs >= 1_000_000_000) return scaled(1_000_000_000, 'میلیارد', 'billion');
  if (abs >= 1_000_000) return scaled(1_000_000, 'میلیون', 'million');
  return rials(formatNumber(n));
}

export const exactCurrency = (value: number | string | null | undefined): string =>
  value === null || value === undefined ? '' : rials(formatNumber(value));

const jalaliFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric', month: '2-digit', day: '2-digit',
});
const jalaliLong = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric', month: 'long', day: 'numeric',
});
const jalaliDateTime = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
// "3 Oct 2026": day first and the month in words, so no reader mistakes 03/10 for March.
const gregorian = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
const gregorianLong = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
const gregorianDateTime = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const asDate = (v: string | Date | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The organisation's calendar in Persian — Solar Hijri — and Gregorian in English. */
export function formatDate(value: string | Date | null | undefined): string {
  const d = asDate(value);
  return d ? (isEnglish() ? gregorian : jalaliFormatter).format(d) : '—';
}

export function formatDateLong(value: string | Date | null | undefined): string {
  const d = asDate(value);
  return d ? (isEnglish() ? gregorianLong : jalaliLong).format(d) : '—';
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const d = asDate(value);
  return d ? (isEnglish() ? gregorianDateTime : jalaliDateTime).format(d) : '—';
}

/** Signed day distance from today; negative means overdue. */
export function daysFromNow(value: string | Date | null | undefined): number | null {
  const d = asDate(value);
  if (!d) return null;
  return Math.round((d.getTime() - Date.now()) / 86_400_000);
}

export function formatRelative(value: string | Date | null | undefined): string {
  const days = daysFromNow(value);
  if (days === null) return '—';
  if (isEnglish()) {
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
  }
  if (days === 0) return 'امروز';
  if (days === 1) return 'فردا';
  if (days === -1) return 'دیروز';
  if (days > 0) return `${toPersianDigits(days)} روز دیگر`;
  return `${toPersianDigits(Math.abs(days))} روز پیش`;
}

export const formatPercent = (value: number | string | null | undefined): string =>
  value === null || value === undefined || value === ''
    ? '—'
    : isEnglish() ? `${Number(value).toFixed(1)}%` : `${toPersianDigits(Number(value).toFixed(1))}٪`;

/** Convert a Jalali date input back to an ISO string for the API. */
/** Kept for callers that hold a Gregorian value; Jalali entry uses jalaliPartsToValue. */
export const toIso = (value: string): string | undefined =>
  value ? new Date(value).toISOString() : undefined;

/* ── Jalali date entry ─────────────────────────────────────────────────────
 * Display was already Jalali (formatDate uses fa-IR-u-ca-persian) but entry was not: the
 * form engine rendered a native <input type="date">, which is Gregorian in practice. A user
 * read «مهلت: ۱۴۰۵/۰۶/۳۱» and had to type 2026-09-22. These fields are the ones filled every
 * day — deadlines, committed dates, milestones — and they feed the SLA engine.
 *
 * The wire format is unchanged, deliberately: a `date` field still posts YYYY-MM-DD, exactly
 * what the native input produced for the same real-world day, so no Zod schema moves.
 */

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Accept Persian and Arabic-Indic digits on input; people type whatever their keyboard gives. */
export function toLatinDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (d) => {
    const p = PERSIAN_DIGITS.indexOf(d);
    return String(p >= 0 ? p : ARABIC_DIGITS.indexOf(d));
  });
}

/** Local calendar parts, not toISOString — that would shift the day across the UTC boundary. */
export function localDateOnly(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface JalaliParts { jy: number; jm: number; jd: number; hh: number; mm: number }

/** Split a stored value into Jalali parts for display. Returns null for empty or unparseable. */
export function isoToJalaliParts(value: string | null | undefined): JalaliParts | null {
  if (!value) return null;
  // A bare YYYY-MM-DD is a calendar day, not an instant: read it as local midnight so the
  // displayed day matches the stored one regardless of the viewer's offset.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return {
    jy: jalaliGetYear(d), jm: jalaliGetMonth(d) + 1, jd: jalaliGetDate(d),
    hh: d.getHours(), mm: d.getMinutes(),
  };
}

/** Jalali parts → the string the API stores. */
export function jalaliPartsToValue(p: JalaliParts, mode: 'date' | 'datetime'): string {
  const d = jalaliNewDate(p.jy, p.jm - 1, p.jd);
  if (mode === 'date') return localDateOnly(d);
  d.setHours(p.hh, p.mm, 0, 0);
  // A datetime is an instant, so it goes out as UTC — unlike the old datetime-local value,
  // which carried no offset and was re-read in whatever timezone the server happened to run in.
  return d.toISOString();
}

/** Display form: ۱۴۰۵/۰۶/۳۱ — or with the time for a datetime field. */
export function formatJalaliInput(p: JalaliParts | null, mode: 'date' | 'datetime'): string {
  if (!p) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${p.jy}/${pad(p.jm)}/${pad(p.jd)}`;
  return toPersianDigits(mode === 'date' ? date : `${date} ${pad(p.hh)}:${pad(p.mm)}`);
}

/**
 * Parse what someone typed. Tolerant on purpose: Persian or Latin digits, `/`, `-` or `.` as
 * the separator, and a time that may be absent.
 */
export function parseJalaliInput(raw: string, mode: 'date' | 'datetime'): JalaliParts | null {
  const s = toLatinDigits(raw).trim();
  if (!s) return null;
  const m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[\s,]+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [jy, jm, jd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hh = mode === 'datetime' ? Number(m[4] ?? 0) : 0;
  const mm = mode === 'datetime' ? Number(m[5] ?? 0) : 0;
  if (jm < 1 || jm > 12 || jd < 1 || hh > 23 || mm > 59) return null;
  // Reject a day past the end of that Jalali month — 31 اسفند, or 30 اسفند in a common year.
  if (jd > jalaliDaysInMonth(jy, jm)) return null;
  return { jy, jm, jd, hh, mm };
}

/** Days in a Jalali month, which is where hand-rolled conversions usually break. */
export function jalaliDaysInMonth(jy: number, jm: number): number {
  return jalaliGetDaysInMonth(jalaliNewDate(jy, jm - 1, 1));
}

export const JALALI_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
] as const;

/** Saturday-first, matching the Iranian week the SLA calendar already uses. */
export const JALALI_WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'] as const;
const WEEKDAYS_EN = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;

/** A weekday's short name in the reader's language; `i` counts from Saturday, as the week here does. */
export const weekdayShort = (i: number): string => (isEnglish() ? WEEKDAYS_EN : JALALI_WEEKDAYS)[i] ?? '';

/** Weekday column (0 = Saturday) for the 1st of a Jalali month. */
export function jalaliFirstWeekday(jy: number, jm: number): number {
  const d = jalaliNewDate(jy, jm - 1, 1);
  return (d.getDay() + 1) % 7; // JS Sunday=0 → Saturday-first
}

export function todayJalaliParts(): JalaliParts {
  return isoToJalaliParts(new Date().toISOString())!;
}
