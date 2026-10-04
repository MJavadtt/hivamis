import { JALALI_MONTHS, jalaliOf } from '../lib/jalali.js';

/**
 * What a tool hands the model, made ready to repeat. A small local model asked to turn
 * "4400000000" into words, or 2026-08-09 into the Persian calendar, gets it wrong — it was seen
 * writing a budget of 440 million tomans as 4,400 million. So amounts arrive with their currency
 * and their thousands marked, dates in the reader's calendar, and the noise a person never reads
 * (empty fields, the other language's label) is left out, which also keeps the prompt short.
 */

export interface ShapeOptions { locale: 'fa' | 'en'; currency: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
// `amount`, `plannedBudget`, `contractValue`… — but not a bare `value` or `total`, which are as often a count or a ratio.
const MONEY_KEY = /^(amount|budget|price|cost|fee|balance|revenue|spend)$|[a-z](Value|Amount|Budget|Cost|Price|Fee|Paid|Balance|Revenue|Spend|Receivable|Payable)$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const DROP = new Set(['organizationId', 'deletedAt', 'legacyRef']);

export function dateFor(value: string, locale: 'fa' | 'en'): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  if (locale === 'en') return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const j = jalaliOf(d);
  return `${j.d} ${JALALI_MONTHS[j.m - 1]} ${j.y}`;
}

export function moneyFor(value: number | string, currency: string, locale: 'fa' | 'en'): string {
  const n = Number(value);
  const unit = currency === 'IRR' ? (locale === 'fa' ? 'ریال' : 'IRR') : currency;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${unit}`;
}

export function shape(value: unknown, opts: ShapeOptions): unknown {
  if (Array.isArray(value)) return value.map((v) => shape(v, opts));
  if (!value || typeof value !== 'object') return typeof value === 'string' && ISO_DATE.test(value) ? dateFor(value, opts.locale) : value;
  const obj = value as Record<string, unknown>;
  // A figure written in another currency sits beside the currency it was written in.
  const written = String(obj.currency ?? Object.entries(obj).find(([k]) => /Currency$/.test(k))?.[1] ?? opts.currency);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (v === null || v === undefined || DROP.has(key) || (Array.isArray(v) && !v.length)) continue;
    // nameFa/nameEn → name, in the reader's language.
    const pair = /^(.*)(Fa|En)$/.exec(key);
    if (pair && pair[1] && `${pair[1]}${pair[2] === 'Fa' ? 'En' : 'Fa'}` in obj) {
      const mine = opts.locale === 'en' ? 'En' : 'Fa';
      if (pair[2] !== mine && obj[`${pair[1]}${mine}`] != null) continue;
      out[pair[1]] = shape(v, opts);
      continue;
    }
    if (MONEY_KEY.test(key) && (typeof v === 'number' || (typeof v === 'string' && NUMERIC.test(v)))) {
      // Base columns are in the organisation's currency; only an `original…` figure is in the written one.
      out[key] = moneyFor(v, /^original/i.test(key) ? written : opts.currency, opts.locale);
      continue;
    }
    out[key] = shape(v, opts);
  }
  return out;
}
