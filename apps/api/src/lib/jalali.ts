/**
 * The Persian calendar through the platform's own Intl implementation — the one the browser also
 * renders with, so the server and the page cannot disagree about which day «۱۲ مهر» is. No
 * conversion tables of our own.
 */
export const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

const persianParts = new Intl.DateTimeFormat('en-u-ca-persian', { year: 'numeric', month: 'numeric', day: 'numeric' });

export function jalaliOf(d: Date): { y: number; m: number; d: number } {
  const p = Object.fromEntries(persianParts.formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, Number.parseInt(x.value, 10)]));
  return { y: p.year!, m: p.month!, d: p.day! };
}

/** Jalali → Date (local noon): estimate, then step to the day whose Persian reading is the one asked for. */
export function jalaliToDate(jy: number, jm: number, jd: number): Date | null {
  if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
  const offset = jm <= 6 ? (jm - 1) * 31 : 186 + (jm - 7) * 30;
  const approx = new Date(jy + 621, 2, 21 + offset + jd - 1, 12, 0, 0);
  for (let delta = -4; delta <= 4; delta++) {
    const d = new Date(approx); d.setDate(d.getDate() + delta);
    const j = jalaliOf(d);
    if (j.y === jy && j.m === jm && j.d === jd) return d;
  }
  return null;
}

/** Days in a Jalali month: 31 for the first six, 30 for the next five, 29 or 30 for Esfand. */
export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return jalaliToDate(jy, 12, 30) ? 30 : 29;
}

/** Local midnight at the start of a Jalali day. */
export function jalaliStart(jy: number, jm: number, jd = 1): Date {
  // Normalise month overflow so callers can ask for "month 13" or "month 0".
  while (jm > 12) { jm -= 12; jy++; }
  while (jm < 1) { jm += 12; jy--; }
  const d = jalaliToDate(jy, jm, Math.min(jd, jalaliMonthLength(jy, jm)))!;
  d.setHours(0, 0, 0, 0);
  return d;
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const fa = (v: string | number) => String(v).replace(/\d/g, (c) => FA_DIGITS[Number(c)]!);

/** «۱۴۰۵/۰۷/۰۳» */
export function formatJalali(d: Date): string {
  const j = jalaliOf(d);
  return fa(`${j.y}/${String(j.m).padStart(2, '0')}/${String(j.d).padStart(2, '0')}`);
}

/** «مهر ۱۴۰۵» */
export const jalaliMonthLabel = (jy: number, jm: number): string => `${JALALI_MONTHS[jm - 1]} ${fa(jy)}`;
