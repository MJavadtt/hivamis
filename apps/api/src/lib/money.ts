import { Prisma } from '@prisma/client';

/**
 * Money, computed exactly (audit CALC-2). Amounts come out of the database as decimals and were
 * turned into floating point to be added up: 0.1 + 0.2 is not 0.3 there, a long sum drifts, and
 * Math.round rounds −2.5 to −2. Here a figure stays a decimal while it is worked on, and is rounded
 * once — two places, half away from zero, as a person rounds — where it leaves the calculation.
 */
export type Money = Prisma.Decimal;

/** A decimal from whatever a column, a JSON field or a form held; nothing is zero. */
export function money(v: unknown): Money {
  if (v instanceof Prisma.Decimal) return v;
  if (v == null || v === '') return new Prisma.Decimal(0);
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return new Prisma.Decimal(v.toString());
  return new Prisma.Decimal(String(v));
}

export const ZERO: Money = new Prisma.Decimal(0);

export const sumOf = (values: Iterable<unknown>): Money => {
  let s = ZERO;
  for (const v of values) s = s.add(money(v));
  return s;
};

/** Rounded once, two places (or `places`), half away from zero — still a decimal. */
export const rounded = (v: unknown, places = 2): Money => money(v).toDecimalPlaces(places, Prisma.Decimal.ROUND_HALF_UP);

/** The figure as it leaves: rounded once, as a number for JSON. */
export const toMoney = (v: unknown, places = 2): number => rounded(v, places).toNumber();

export const maxOf = (a: Money, b: Money): Money => (a.gte(b) ? a : b);
