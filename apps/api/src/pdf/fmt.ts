import { stateLabelFa } from '@hiva/contracts';
/** Server-side Persian formatting for printed documents. Mirrors apps/web/src/lib/format.ts. */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export const fa = (input: string | number): string =>
  String(input).replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);

/** Escape before interpolation — record values are untrusted input, even on the way to a PDF. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function num(value: unknown, fractionDigits = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return fa(n.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits,
  }));
}

/** Printed documents always carry the exact figure — abbreviation belongs on screen, not on paper. */
export const money = (value: unknown): string =>
  value === null || value === undefined || value === ''
    ? '—'
    : `<span class="num">${num(value)}</span> ریال`;

export const percent = (value: unknown): string =>
  value === null || value === undefined || value === ''
    ? '—'
    : `<span class="num">${fa(Number(value).toFixed(1))}</span>٪`;

const jDate = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Tehran',
});
const jDateTime = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran',
});

const asDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export const date = (v: unknown): string => {
  const d = asDate(v);
  return d ? jDate.format(d) : '—';
};

export const dateTime = (v: unknown): string => {
  const d = asDate(v);
  return d ? jDateTime.format(d) : '—';
};

/* ── Persian labels for machine states ─────────────────────────────────────── */

// State labels come from @hiva/contracts; this file used to carry a 40-entry copy that had
// drifted from the SPA's 84-entry one.

export const stateFa = (s: unknown): string =>
  s ? stateLabelFa(String(s)) : '—';

const DEPT_FA: Record<string, string> = {
  S: 'فروش', A: 'اکانت', ST: 'استراتژی', CR: 'خلاقیت / گرافیک / تولید', ME: 'رسانه',
  DM: 'دیجیتال مارکتینگ', FI: 'مالی', LG: 'حقوقی و قراردادها', OP: 'عملیات / PMO', M: 'مدیریت',
};
export const deptFa = (c: unknown): string => (c ? (DEPT_FA[String(c)] ?? String(c)) : '—');

const OK = new Set(['APPROVED', 'PASSED', 'ACTIVE', 'CLOSED', 'PAID', 'SIGNED', 'REGISTERED',
  'WON', 'ACCEPTED', 'COMPLETED', 'CLIENT_APPROVED', 'GREEN', 'IN_SCOPE', 'FULFILLED']);
const BAD = new Set(['FAILED', 'REJECTED', 'CANCELLED', 'LOST', 'DISQUALIFIED', 'BREACHED',
  'RETURNED_INCOMPLETE', 'CLIENT_REJECTED', 'RED', 'TERMINATED', 'CRITICAL', 'REALISED']);
const WARN = new Set(['PENDING_AUTHORIZATION', 'REVISION_REQUIRED', 'ON_HOLD', 'BLOCKED',
  'AT_RISK', 'AMBER', 'OUT_OF_SCOPE', 'CLIENT_REVISION_REQUESTED', 'PENDING_CUSTOMER_APPROVAL',
  'HIGH', 'URGENT', 'REVISION_REQUESTED']);

/** State chip with a severity colour, so a printed page is scannable. */
export function chip(state: unknown): string {
  const s = String(state ?? '');
  const cls = OK.has(s) ? ' chip-ok' : BAD.has(s) ? ' chip-bad' : WARN.has(s) ? ' chip-warn' : '';
  return `<span class="chip${cls}">${esc(stateFa(s))}</span>`;
}

export const yesNo = (v: unknown): string => (v ? '✓ بله' : '✗ خیر');

/** A labelled block; long free text keeps its line breaks. */
export const field = (label: string, value: string): string =>
  `<div class="field"><span class="k">${esc(label)}</span><div class="v">${value || '<span class="empty">—</span>'}</div></div>`;

export const text = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '<span class="empty">—</span>' : esc(v);

/** Key/value grid used for the document metadata band. */
export const metaGrid = (pairs: [string, string][]): string =>
  `<div class="meta">${pairs
    .map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`)
    .join('')}</div>`;

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="empty">موردی ثبت نشده است.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
