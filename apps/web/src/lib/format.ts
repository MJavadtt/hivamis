/** Persian formatting helpers. All user-visible numbers and dates go through here. */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export const toPersianDigits = (input: string | number): string =>
  String(input).replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);

export function formatNumber(value: number | string | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return toPersianDigits(
    n.toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }),
  );
}

/**
 * Rial amounts run to billions, so large figures are abbreviated («۴٫۳ میلیارد ریال»)
 * with the exact value available on hover.
 */
export function formatCurrency(value: number | string | null | undefined, compact = true): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  if (!compact) return `${formatNumber(n)} ریال`;
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000_000) return `${toPersianDigits((n / 1_000_000_000_000).toFixed(1))} هزار میلیارد ریال`;
  if (abs >= 1_000_000_000) return `${toPersianDigits((n / 1_000_000_000).toFixed(1))} میلیارد ریال`;
  if (abs >= 1_000_000) return `${toPersianDigits((n / 1_000_000).toFixed(1))} میلیون ریال`;
  return `${formatNumber(n)} ریال`;
}

export const exactCurrency = (value: number | string | null | undefined): string =>
  value === null || value === undefined ? '' : `${formatNumber(value)} ریال`;

const jalaliFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric', month: '2-digit', day: '2-digit',
});
const jalaliLong = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric', month: 'long', day: 'numeric',
});
const jalaliDateTime = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

const asDate = (v: string | Date | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Jalali (Solar Hijri) date — the calendar the organisation actually works in. */
export function formatDate(value: string | Date | null | undefined): string {
  const d = asDate(value);
  return d ? jalaliFormatter.format(d) : '—';
}

export function formatDateLong(value: string | Date | null | undefined): string {
  const d = asDate(value);
  return d ? jalaliLong.format(d) : '—';
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const d = asDate(value);
  return d ? jalaliDateTime.format(d) : '—';
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
  if (days === 0) return 'امروز';
  if (days === 1) return 'فردا';
  if (days === -1) return 'دیروز';
  if (days > 0) return `${toPersianDigits(days)} روز دیگر`;
  return `${toPersianDigits(Math.abs(days))} روز پیش`;
}

export const formatPercent = (value: number | string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : `${toPersianDigits(Number(value).toFixed(1))}٪`;

/** Convert a Jalali date input back to an ISO string for the API. */
export const toIso = (value: string): string | undefined =>
  value ? new Date(value).toISOString() : undefined;
