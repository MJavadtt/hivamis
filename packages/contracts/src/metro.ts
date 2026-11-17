import { z } from 'zod';
export { METRO_CATALOGUE, metroInterchanges } from './metro-catalogue.js';

/**
 * Metro advertising (the owner, 2026-11-17; ADR-135): like the venues and rentals module, for the
 * metro of Tehran and Karaj. A line has its stations, and trains of wagons; a wagon carries the
 * spaces sold — the body (بدنه), the panels inside (کتیبه) and the handles (دستگیره). A booking
 * holds spaces for a client over dates, for an amount, with its payments, reminders, reports, notes
 * and files.
 */

export const METRO_SPACE_KINDS = ['BODY', 'KATIBEH', 'HANDLE'] as const;
export type MetroSpaceKind = (typeof METRO_SPACE_KINDS)[number];
export const METRO_SPACE_LABELS: Record<MetroSpaceKind, { fa: string; en: string }> = {
  BODY: { fa: 'بدنه', en: 'Body' },
  KATIBEH: { fa: 'کتیبه', en: 'Panel' },
  HANDLE: { fa: 'دستگیره', en: 'Handle' },
};

export const METRO_CITIES = ['TEHRAN', 'KARAJ'] as const;
export type MetroCity = (typeof METRO_CITIES)[number];
export const METRO_CITY_LABELS: Record<MetroCity, { fa: string; en: string }> = {
  TEHRAN: { fa: 'تهران', en: 'Tehran' },
  KARAJ: { fa: 'تهران و کرج', en: 'Tehran–Karaj' },
};

/** A booking, from a hold to its end. Holds, confirmed and running bookings take the space. */
export const METRO_BOOKING_STATES = ['HOLD', 'CONFIRMED', 'ACTIVE', 'ENDED', 'CANCELLED'] as const;
export type MetroBookingState = (typeof METRO_BOOKING_STATES)[number];
export const METRO_BOOKING_LABELS: Record<MetroBookingState, { fa: string; en: string }> = {
  HOLD: { fa: 'رزرو موقت', en: 'On hold' },
  CONFIRMED: { fa: 'قطعی', en: 'Confirmed' },
  ACTIVE: { fa: 'در حال اجرا', en: 'Running' },
  ENDED: { fa: 'پایان‌یافته', en: 'Ended' },
  CANCELLED: { fa: 'لغوشده', en: 'Cancelled' },
};
export const METRO_HOLDING_STATES: readonly MetroBookingState[] = ['HOLD', 'CONFIRMED', 'ACTIVE'];
/** Where a booking may go from each state. */
export const METRO_BOOKING_MOVES: Record<MetroBookingState, readonly MetroBookingState[]> = {
  HOLD: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['ACTIVE', 'HOLD', 'CANCELLED'],
  ACTIVE: ['ENDED', 'CANCELLED'],
  ENDED: ['ACTIVE'],
  CANCELLED: ['HOLD'],
};

/** What a new wagon carries unless told otherwise: one body, eight panels, forty handles. */
export const METRO_WAGON_TEMPLATE: Record<MetroSpaceKind, number> = { BODY: 1, KATIBEH: 8, HANDLE: 40 };

const text = (max: number) => z.string().trim().max(max);
const money = z.coerce.number().min(0).max(1e15);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاریخ را کامل وارد کنید.');

export const metroLineSchema = z.object({
  number: z.coerce.number().int().min(1).max(99),
  nameFa: text(80).min(2, 'نام خط را بنویسید.'),
  nameEn: text(80).default(''),
  city: z.enum(METRO_CITIES).default('TEHRAN'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
  notes: text(2000).nullish(),
  isActive: z.boolean().default(true),
});
export const metroLineUpdateSchema = metroLineSchema.partial();

export const metroStationSchema = z.object({
  nameFa: text(120).min(2, 'نام ایستگاه را بنویسید.'),
  nameEn: text(120).default(''),
  order: z.coerce.number().int().min(0).max(999).optional(),
  branch: text(80).nullish(),
  isInterchange: z.boolean().default(false),
  underConstruction: z.boolean().default(false),
  notes: text(2000).nullish(),
});
export const metroStationUpdateSchema = metroStationSchema.partial();

const template = z.object({ BODY: z.coerce.number().int().min(0).max(10), KATIBEH: z.coerce.number().int().min(0).max(200), HANDLE: z.coerce.number().int().min(0).max(500) }).partial();
const prices = z.object({ BODY: money, KATIBEH: money, HANDLE: money }).partial();

export const metroTrainSchema = z.object({
  code: text(40).min(1, 'شمارهٔ قطار را بنویسید.'),
  notes: text(2000).nullish(),
  isActive: z.boolean().default(true),
  /** Wagons made with it, each with the template's spaces at these monthly prices. */
  wagons: z.coerce.number().int().min(0).max(20).default(7),
  template: template.default({}),
  prices: prices.default({}),
});
export const metroTrainUpdateSchema = metroTrainSchema.pick({ code: true, notes: true, isActive: true }).partial();

export const metroWagonSchema = z.object({
  count: z.coerce.number().int().min(1).max(20).default(1),
  template: template.default({}),
  prices: prices.default({}),
  notes: text(2000).nullish(),
});
export const metroWagonUpdateSchema = z.object({ number: z.coerce.number().int().min(1).max(99).optional(), notes: text(2000).nullish() });

export const metroSpaceSchema = z.object({
  kind: z.enum(METRO_SPACE_KINDS),
  label: text(80).nullish(),
  quantity: z.coerce.number().int().min(1).max(500).default(1),
  widthCm: z.coerce.number().int().min(0).max(10000).nullish(),
  heightCm: z.coerce.number().int().min(0).max(10000).nullish(),
  /** The price of one unit for thirty days. */
  monthlyPrice: money.default(0),
  isActive: z.boolean().default(true),
  notes: text(2000).nullish(),
});
export const metroSpaceUpdateSchema = metroSpaceSchema.partial();

export const metroBookingItemSchema = z.object({ spaceId: z.string().uuid(), quantity: z.coerce.number().int().min(1).max(500).default(1) });
export const metroBookingSchema = z.object({
  companyId: z.string().uuid().nullish(),
  clientName: text(200).nullish(),
  projectId: z.string().uuid().nullish(),
  title: text(200).nullish(),
  startDate: day,
  endDate: day,
  /** Left out: the spaces' monthly prices over the days. */
  amount: money.nullish(),
  ownerId: z.string().uuid().nullish(),
  notes: text(4000).nullish(),
  state: z.enum(['HOLD', 'CONFIRMED']).default('HOLD'),
  items: z.array(metroBookingItemSchema).min(1, 'دست‌کم یک فضا را برگزینید.').max(500),
}).refine((b) => b.endDate >= b.startDate, { message: 'پایان رزرو پیش از آغاز آن است.', path: ['endDate'] })
  .refine((b) => !!b.companyId || !!b.clientName?.trim(), { message: 'مشتری را برگزینید یا نامش را بنویسید.', path: ['clientName'] });
export const metroBookingUpdateSchema = z.object({
  companyId: z.string().uuid().nullish(), clientName: text(200).nullish(), projectId: z.string().uuid().nullish(), title: text(200).nullish(),
  startDate: day.optional(), endDate: day.optional(), amount: money.nullish(), ownerId: z.string().uuid().nullish(), notes: text(4000).nullish(),
  items: z.array(metroBookingItemSchema).min(1).max(500).optional(),
});
export const metroBookingMoveSchema = z.object({ to: z.enum(METRO_BOOKING_STATES), reason: text(1000).nullish() });
export const metroPaymentSchema = z.object({
  amount: money.refine((v) => v > 0, 'مبلغ پرداخت را بنویسید.'),
  paidAt: day,
  method: text(60).nullish(),
  reference: text(120).nullish(),
  note: text(1000).nullish(),
});
export const metroSettingsSchema = z.object({
  endingSoonDays: z.coerce.number().int().min(1).max(90).optional(),
  holdDays: z.coerce.number().int().min(1).max(60).optional(),
});

/** Days between two dates, both counted. */
export const metroDays = (start: string, end: string) => Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1);
/** What a set of spaces costs over the days: each unit's monthly price, by the day. */
export const metroSuggestedAmount = (items: { quantity: number; monthlyPrice: number | string }[], start: string, end: string) =>
  Math.round(items.reduce((s, i) => s + i.quantity * Number(i.monthlyPrice), 0) * metroDays(start, end) / 30);
