/**
 * Amounts in more than one currency, with the rate of the day (roadmap #28).
 *
 * The rule the whole feature rests on: a figure in another currency is converted **once**, when it
 * is recorded, at the rate in force on the record's own date — and that rate is stored with it.
 * The base columns every report already sums stay in the organisation's currency, so no report
 * mixes currencies; the original figure and its rate sit beside them. A rate corrected later
 * never moves a figure already booked; the difference between the rate a receivable was booked at
 * and the rate it was settled at is an exchange gain or loss, reported as such (`/reports/fx`).
 *
 * No rate for the date, or only one too old to trust, is a refusal that says which currency and
 * which day — never a silent fall-back to "the latest rate we have".
 */
import { Prisma } from '@prisma/client';
import { CURRENCY_LABELS, type Currency } from '@hiva/contracts';
import type { Tx } from '../db.js';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { formatJalali } from '../lib/jalali.js';

export const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const DAY = 86_400_000;
const FA = '۰۱۲۳۴۵۶۷۸۹';
const fa = (v: string | number) => String(v).replace(/\d/g, (c) => FA[Number(c)]!);
export const currencyFa = (c: string) => CURRENCY_LABELS[c as Currency] ?? c;

/** The organisation's own currency — what every base column is in. */
export async function baseCurrency(tx: Tx, organizationId: string): Promise<string> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { currency: true } });
  return org.currency;
}

/**
 * The calendar day a date names, as the rate table keys it (UTC midnight of that day). A date-only
 * input («2026-09-25», which the page sends) already is one; an instant is read on the local clock.
 */
export const dayKey = (d: Date) =>
  d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
    ? d : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const dayOf = dayKey;

export interface RateFound { rate: Prisma.Decimal; effectiveDate: Date; ageDays: number }

/** The latest rate on or before `on`, or null. Never one from after the date: that would be hindsight. */
export async function findRate(tx: Tx, organizationId: string, currency: string, on: Date): Promise<RateFound | null> {
  const row = await tx.exchangeRate.findFirst({
    where: { organizationId, currency, effectiveDate: { lte: dayOf(on) } },
    orderBy: { effectiveDate: 'desc' },
  });
  if (!row) return null;
  return { rate: row.rate, effectiveDate: row.effectiveDate, ageDays: Math.round((dayOf(on).getTime() - row.effectiveDate.getTime()) / DAY) };
}

/** The rate a new figure dated `on` converts at — or a refusal naming the currency and the day. */
export async function rateFor(tx: Tx, organizationId: string, currency: string, on: Date): Promise<RateFound> {
  const found = await findRate(tx, organizationId, currency, on);
  if (!found) {
    throw new AppError(422, 'FX_RATE_MISSING',
      `برای ${currencyFa(currency)} در تاریخ ${formatJalali(on)} یا پیش از آن نرخی ثبت نشده است؛ نخست نرخ را در «مالی ← نرخ ارز» ثبت کنید.`,
      { currency, on });
  }
  if (found.ageDays > env.FX_MAX_RATE_AGE_DAYS) {
    throw new AppError(422, 'FX_RATE_STALE',
      `آخرین نرخ ${currencyFa(currency)} پیش از ${formatJalali(on)} مربوط به ${formatJalali(found.effectiveDate)} است (${fa(found.ageDays)} روز قبل)؛ تبدیل با نرخی کهنه‌تر از ${fa(env.FX_MAX_RATE_AGE_DAYS)} روز ثبت نمی‌شود — نرخ آن روز را ثبت کنید.`,
      { currency, on, lastRateDate: found.effectiveDate, ageDays: found.ageDays, maxAgeDays: env.FX_MAX_RATE_AGE_DAYS });
  }
  return found;
}

export interface Converted {
  currency: string;
  /** In base, rounded to the column's two places. */
  base: Prisma.Decimal;
  fxRate: Prisma.Decimal;
  fxRateDate: Date | null;
  /** The figure as written, or null when it was written in base. */
  original: Prisma.Decimal | null;
}

/** One figure, written in `currency` on `on`, into base. Identity for the base currency. */
export async function convert(
  tx: Tx, organizationId: string, currency: string | undefined, amount: Prisma.Decimal.Value, on: Date,
): Promise<Converted> {
  const base = await baseCurrency(tx, organizationId);
  const c = currency ?? base;
  // Nothing to convert: a zero needs no rate, and records nothing in another currency.
  if (c === base || D(amount).isZero()) return { currency: base, base: D(amount).toDecimalPlaces(2), fxRate: D(1), fxRateDate: null, original: null };
  const r = await rateFor(tx, organizationId, c, on);
  return { currency: c, base: D(amount).mul(r.rate).toDecimalPlaces(2), fxRate: r.rate, fxRateDate: r.effectiveDate, original: D(amount).toDecimalPlaces(2) };
}

/** Converts several figures written together (an invoice's subtotal, tax and total) at one rate. */
export async function convertMany<K extends string>(
  tx: Tx, organizationId: string, currency: string | undefined, amounts: Record<K, Prisma.Decimal.Value>, on: Date,
): Promise<{ currency: string; fxRate: Prisma.Decimal; fxRateDate: Date | null; base: Record<K, Prisma.Decimal>; original: Record<K, Prisma.Decimal> | null }> {
  const baseCur = await baseCurrency(tx, organizationId);
  const c = currency ?? baseCur;
  const keys = Object.keys(amounts) as K[];
  if (c === baseCur) {
    return { currency: c, fxRate: D(1), fxRateDate: null, original: null, base: Object.fromEntries(keys.map((k) => [k, D(amounts[k]).toDecimalPlaces(2)])) as Record<K, Prisma.Decimal> };
  }
  const r = await rateFor(tx, organizationId, c, on);
  return {
    currency: c, fxRate: r.rate, fxRateDate: r.effectiveDate,
    original: Object.fromEntries(keys.map((k) => [k, D(amounts[k]).toDecimalPlaces(2)])) as Record<K, Prisma.Decimal>,
    base: Object.fromEntries(keys.map((k) => [k, D(amounts[k]).mul(r.rate).toDecimalPlaces(2)])) as Record<K, Prisma.Decimal>,
  };
}

/** Tolerance for "fully settled" in a currency with cents. */
export const SETTLED_EPSILON = D('0.005');
