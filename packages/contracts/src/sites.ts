import { z } from 'zod';
import { idSchema, paginationSchema } from './schemas.js';
import { CURRENCIES } from './enums.js';

/**
 * Venues, deployment projects and rentals (ADR-103) — the owner's «دیتابیس» document in three parts:
 *
 *   1. the venue database: the malls, metro stations, amusement parks and centres a counter or a
 *      stand can go, with their grade, audience, photos and the people to call;
 *   2. deployment projects: one placement in one venue, from the first look at the place, through the
 *      negotiation, the contract and the installation, to the day it closes;
 *   3. rentals: what is owed for the space — rent, service charge, deposit, penalties — what was paid,
 *      the reminders before it is due, and the deposit back at the end.
 *
 * The organisation's own lists (venue types, grades, audiences, cooperation models, payment methods…)
 * are rows it edits, not code: a record keeps the code it was given, and a retired option is hidden,
 * never deleted, so nothing written under it loses its meaning.
 */

/* ── the organisation's own lists ─────────────────────────────────────────── */

export const SITE_OPTION_LISTS = [
  'VENUE_TYPE', 'VENUE_GRADE', 'AUDIENCE', 'COOPERATION', 'PAYMENT_METHOD', 'CONTACT_ROLE', 'CHANNEL', 'CHARGE_CATEGORY', 'PHOTO_CATEGORY',
] as const;
export type SiteOptionList = (typeof SITE_OPTION_LISTS)[number];

export const SITE_OPTION_LIST_LABELS: Record<SiteOptionList, { fa: string; en: string }> = {
  VENUE_TYPE: { fa: 'نوع مکان', en: 'Venue type' },
  VENUE_GRADE: { fa: 'گرید مکان', en: 'Venue grade' },
  AUDIENCE: { fa: 'مخاطبان', en: 'Audiences' },
  COOPERATION: { fa: 'مدل همکاری', en: 'Cooperation model' },
  PAYMENT_METHOD: { fa: 'نحوهٔ پرداخت', en: 'Payment method' },
  CONTACT_ROLE: { fa: 'سمت مخاطب', en: 'Contact role' },
  CHANNEL: { fa: 'راه ارتباطی', en: 'Communication channel' },
  CHARGE_CATEGORY: { fa: 'دستهٔ هزینه', en: 'Charge category' },
  PHOTO_CATEGORY: { fa: 'دستهٔ عکس', en: 'Photo category' },
};

/** What an option means to the rules, where it means anything: a cooperation model's contract, a method's cheque. */
export interface SiteOptionMeta {
  /** A cooperation model whose agreement is a written contract: a contract file must be attached before approval. */
  requiresContract?: boolean;
  /** A payment method paid by cheque: the cheque's number and date are asked for. */
  isCheque?: boolean;
}

interface DefaultOption { code: string; fa: string; en: string; meta?: SiteOptionMeta }

/** What a new organisation starts with — the document's own examples — to edit, add to and retire. */
export const SITE_OPTION_DEFAULTS: Record<SiteOptionList, DefaultOption[]> = {
  VENUE_TYPE: [
    { code: 'MALL', fa: 'مجتمع تجاری', en: 'Shopping mall' },
    { code: 'METRO', fa: 'ایستگاه مترو', en: 'Metro station' },
    { code: 'AMUSEMENT_PARK', fa: 'شهربازی', en: 'Amusement park' },
    { code: 'HYPERMARKET', fa: 'هایپرمارکت', en: 'Hypermarket' },
    { code: 'CINEMA', fa: 'سینما', en: 'Cinema' },
    { code: 'SPORTS', fa: 'مجموعهٔ ورزشی', en: 'Sports complex' },
    { code: 'OTHER', fa: 'سایر', en: 'Other' },
  ],
  VENUE_GRADE: [
    { code: 'A_PLUS', fa: 'A+', en: 'A+' },
    { code: 'A', fa: 'A', en: 'A' },
    { code: 'B', fa: 'B', en: 'B' },
    { code: 'C', fa: 'C', en: 'C' },
  ],
  AUDIENCE: [
    { code: 'MOTHER_CHILD', fa: 'مادر و کودک', en: 'Mothers and children' },
    { code: 'FAMILY', fa: 'خانواده', en: 'Families' },
    { code: 'ATHLETE', fa: 'ورزشکار', en: 'Athletes' },
    { code: 'YOUTH', fa: 'جوانان', en: 'Young people' },
    { code: 'STUDENT', fa: 'دانشجو', en: 'Students' },
    { code: 'COMMUTER', fa: 'مسافران روزانه', en: 'Commuters' },
  ],
  COOPERATION: [
    { code: 'FORMAL', fa: 'قراردادی رسمی', en: 'Formal contract', meta: { requiresContract: true } },
    { code: 'INFORMAL', fa: 'قراردادی غیررسمی', en: 'Informal agreement', meta: { requiresContract: false } },
    { code: 'INVOICE', fa: 'فاکتوری', en: 'Invoice-based', meta: { requiresContract: false } },
  ],
  PAYMENT_METHOD: [
    { code: 'CASH', fa: 'نقد', en: 'Cash' },
    { code: 'TRANSFER', fa: 'انتقال بانکی', en: 'Bank transfer' },
    { code: 'CHEQUE', fa: 'چک', en: 'Cheque', meta: { isCheque: true } },
  ],
  CONTACT_ROLE: [
    { code: 'CEO', fa: 'مدیرعامل', en: 'Managing director' },
    { code: 'MARKETING', fa: 'مسئول مارکتینگ', en: 'Marketing manager' },
    { code: 'TECHNICAL', fa: 'مسئول فنی', en: 'Technical manager' },
    { code: 'FINANCE', fa: 'مسئول مالی', en: 'Finance' },
    { code: 'OPERATIONS', fa: 'مسئول بهره‌برداری', en: 'Operations' },
    { code: 'OTHER', fa: 'سایر', en: 'Other' },
  ],
  CHANNEL: [
    { code: 'PHONE', fa: 'تلفن', en: 'Phone' },
    { code: 'MOBILE', fa: 'همراه', en: 'Mobile' },
    { code: 'EMAIL', fa: 'ایمیل', en: 'Email' },
    { code: 'WHATSAPP', fa: 'واتس‌اپ', en: 'WhatsApp' },
    { code: 'TELEGRAM', fa: 'تلگرام', en: 'Telegram' },
    { code: 'INSTAGRAM', fa: 'اینستاگرام', en: 'Instagram' },
    { code: 'LETTER', fa: 'نامه', en: 'Letter' },
    { code: 'WEBSITE', fa: 'وب‌سایت', en: 'Website' },
  ],
  CHARGE_CATEGORY: [
    { code: 'LATE_FEE', fa: 'جریمهٔ تأخیر', en: 'Late fee' },
    { code: 'DAMAGE', fa: 'خسارت', en: 'Damage' },
    { code: 'EXTRA_WORK', fa: 'کار غیرقراردادی', en: 'Non-contract work' },
    { code: 'UTILITIES', fa: 'آب، برق و خدمات', en: 'Utilities' },
    { code: 'PERMIT', fa: 'مجوز', en: 'Permit' },
    { code: 'OTHER', fa: 'سایر', en: 'Other' },
  ],
  PHOTO_CATEGORY: [
    { code: 'ENTRANCE', fa: 'ورودی', en: 'Entrance' },
    { code: 'INSIDE', fa: 'داخل', en: 'Inside' },
    { code: 'PLACEMENT', fa: 'محل استقرار', en: 'Placement spot' },
    { code: 'OTHER', fa: 'سایر', en: 'Other' },
  ],
};

export const siteOptionSchema = z.object({
  list: z.enum(SITE_OPTION_LISTS),
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,39}$/, 'کد با حرف لاتین آغاز شود و فقط حرف، رقم و _ داشته باشد.'),
  labelFa: z.string().trim().min(1).max(80),
  labelEn: z.string().trim().max(80).optional(),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
  meta: z.object({ requiresContract: z.boolean().optional(), isCheque: z.boolean().optional() }).default({}),
});
export const siteOptionUpdateSchema = siteOptionSchema.omit({ list: true, code: true }).partial();

/* ── values ───────────────────────────────────────────────────────────────── */

const PERSIAN = '۰۱۲۳۴۵۶۷۸۹', ARABIC = '٠١٢٣٤٥٦٧٨٩';
const latin = (s: string) => s.replace(/[۰-۹٠-٩]/g, (c) => String(PERSIAN.indexOf(c) >= 0 ? PERSIAN.indexOf(c) : ARABIC.indexOf(c)));

/**
 * A telephone number reduced to what identifies it: its digits, in Latin, with the country code read as
 * a leading zero — «۰۲۱-۸۸۱۲ ۳۴۵۶» and «+98 21 88123456» are one number. Null when there are too few
 * digits to be a number. Used to find duplicates; what was typed is kept as it was.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = latin(String(raw)).replace(/[^\d+]/g, '');
  if (d.startsWith('+98')) d = `0${d.slice(3)}`;
  else if (d.startsWith('0098')) d = `0${d.slice(4)}`;
  else if (d.startsWith('98') && d.length >= 11) d = `0${d.slice(2)}`;
  d = d.replace(/\+/g, '');
  return d.length >= 7 ? d : null;
}

/**
 * A name reduced to what identifies it: Arabic ي and ك read as the Persian letters, no spaces, half-spaces,
 * punctuation or case — «مجتمع  تجاری‌کوروش» and «مجتمع تجاري كوروش» are one name.
 */
export function nameKey(raw: string | null | undefined): string {
  return latin(String(raw ?? ''))
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[ةۀ]/g, 'ه').replace(/[أإآ]/g, 'ا')
    .toLowerCase()
    .replace(/[\s‌‏‎.,،؛;:'"«»()\-_/\\]+/g, '');
}

/**
 * A sum of money as the API takes it: a number, or a string with Persian or Latin digits and thousands
 * separators. It leaves as a decimal string with at most two places — never a float, so nothing is lost
 * between the form and the ledger.
 */
export const moneySchema = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : latin(v).replace(/[,٬،\s]/g, '').replace('٫', '.');
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(s)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'مبلغ نامعتبر است — عددی نامنفی با حداکثر دو رقم اعشار.' });
    return z.NEVER;
  }
  return s.replace(/^0+(?=\d)/, '');
});
const positiveMoney = moneySchema.refine((v) => Number(v) > 0, { message: 'مبلغ باید بیشتر از صفر باشد.' });

const code = z.string().trim().toUpperCase().max(40);
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).optional().nullable();

/* ── module A: venues ─────────────────────────────────────────────────────── */

/** Fields a venue may be required to have, beyond its name, province, city and type. */
export const VENUE_EXPECTED_FIELDS = ['address', 'phone', 'gradeCode', 'audienceCodes', 'contacts', 'photos'] as const;
export type VenueExpectedField = (typeof VENUE_EXPECTED_FIELDS)[number];
export const VENUE_FIELD_LABELS: Record<VenueExpectedField, { fa: string; en: string }> = {
  address: { fa: 'آدرس', en: 'Address' },
  phone: { fa: 'تلفن', en: 'Phone' },
  gradeCode: { fa: 'گرید', en: 'Grade' },
  audienceCodes: { fa: 'مخاطبان', en: 'Audiences' },
  contacts: { fa: 'مخاطب', en: 'A contact' },
  photos: { fa: 'عکس', en: 'A photo' },
};

export const venueChannelSchema = z.object({
  typeCode: code,
  value: text(200).min(1),
  note: optionalText(200),
});

export const venueContactSchema = z.object({
  fullName: text(120).min(2),
  roleCode: code,
  jobTitle: optionalText(120),
  phone: optionalText(40),
  email: z.string().trim().email('نشانی ایمیل معتبر نیست.').max(200).optional().nullable().or(z.literal('').transform(() => null)),
  notes: optionalText(1000),
  isPrimary: z.boolean().default(false),
  channels: z.array(venueChannelSchema).max(10).default([]),
});

export const venueSchema = z.object({
  name: text(160).min(2),
  province: text(60).min(2),
  city: text(60).min(2),
  address: optionalText(500),
  typeCode: code.min(1),
  gradeCode: code.optional().nullable(),
  audienceCodes: z.array(code).max(20).default([]),
  phone: optionalText(40),
  email: z.string().trim().email('نشانی ایمیل معتبر نیست.').max(200).optional().nullable().or(z.literal('').transform(() => null)),
  website: optionalText(200),
  notes: optionalText(4000),
  isActive: z.boolean().default(true),
  /** Contacts and channels written with a new venue; afterwards each has its own route. */
  contacts: z.array(venueContactSchema).max(30).optional(),
  channels: z.array(venueChannelSchema).max(20).optional(),
  /** Save although it looks like a venue already here — the person has seen the likely duplicates. */
  confirmNotDuplicate: z.boolean().default(false),
});
export type VenueInput = z.infer<typeof venueSchema>;
export const venueUpdateSchema = venueSchema.omit({ contacts: true, channels: true }).partial().extend({ version: z.number().int().min(1).optional() });

export const venueListSchema = paginationSchema.extend({
  province: z.string().trim().max(60).optional(),
  city: z.string().trim().max(60).optional(),
  typeCode: z.string().trim().max(40).optional(),
  gradeCode: z.string().trim().max(40).optional(),
  audience: z.string().trim().max(40).optional(),
  status: z.enum(['active', 'inactive', 'archived', 'all']).default('active'),
  incomplete: z.enum(['true', 'false']).optional(),
  withoutActiveProject: z.enum(['true', 'false']).optional(),
});

/** Two venues that look alike, said by someone who may to be one place (merged) or two (kept apart). */
export const venueDuplicateDecisionSchema = z.object({
  otherId: idSchema,
  decision: z.enum(['MERGE', 'DISTINCT']),
  reason: text(500).min(3),
});

/* ── module B: deployment projects ───────────────────────────────────────── */

export const RENT_PERIODS = ['MONTHLY', 'DAILY', 'ONCE'] as const;
export type RentPeriod = (typeof RENT_PERIODS)[number];
export const RENT_PERIOD_LABELS: Record<RentPeriod, { fa: string; en: string }> = {
  MONTHLY: { fa: 'ماهیانه', en: 'Monthly' },
  DAILY: { fa: 'روزانه', en: 'Daily' },
  ONCE: { fa: 'یکجا برای کل دوره', en: 'Once for the whole term' },
};

export const INSTALL_STATUSES = ['NOT_STARTED', 'PLANNED', 'IN_PROGRESS', 'DONE', 'DELAYED'] as const;

export const siteProjectSchema = z.object({
  name: text(200).min(2),
  venueId: idSchema,
  placement: optionalText(300),
  projectId: idSchema.optional().nullable(),
  companyId: idSchema.optional().nullable(),
  responsibleId: idSchema.optional().nullable(),
  cooperationCode: code.optional().nullable(),
  currency: z.enum(CURRENCIES).optional(),
  contractStart: z.coerce.date().optional().nullable(),
  contractEnd: z.coerce.date().optional().nullable(),
  depositAmount: moneySchema.optional().nullable(),
  rentAmount: moneySchema.optional().nullable(),
  rentPeriod: z.enum(RENT_PERIODS).default('MONTHLY'),
  /** Days after a period begins that its rent is due; 0 is the first day. */
  rentDueDay: z.number().int().min(0).max(27).optional().nullable(),
  rentMethodCode: code.optional().nullable(),
  chargeAmount: moneySchema.optional().nullable(),
  chargeDueDay: z.number().int().min(0).max(27).optional().nullable(),
  chargeMethodCode: code.optional().nullable(),
  installPlannedAt: z.coerce.date().optional().nullable(),
  installedAt: z.coerce.date().optional().nullable(),
  installDays: z.number().int().min(0).max(365).optional().nullable(),
  installStatus: z.enum(INSTALL_STATUSES).optional(),
  installCost: moneySchema.optional().nullable(),
  transportCost: moneySchema.optional().nullable(),
  installNotes: optionalText(2000),
  notes: optionalText(4000),
});
const termsInOrder = <T extends { contractStart?: Date | null; contractEnd?: Date | null }>(v: T) =>
  !v.contractStart || !v.contractEnd || v.contractEnd > v.contractStart;
export const siteProjectCreateSchema = siteProjectSchema.refine(termsInOrder, { message: 'پایان قرارداد باید پس از آغاز آن باشد.', path: ['contractEnd'] });
export const siteProjectUpdateSchema = siteProjectSchema.partial().extend({
  /** The version the editor read: a change on top of someone else's newer one is refused, not merged. */
  version: z.number().int().min(1),
}).refine(termsInOrder, { message: 'پایان قرارداد باید پس از آغاز آن باشد.', path: ['contractEnd'] });

export const siteProjectListSchema = paginationSchema.extend({
  state: z.string().trim().max(40).optional(),
  venueId: idSchema.optional(),
  projectId: idSchema.optional(),
  province: z.string().trim().max(60).optional(),
  city: z.string().trim().max(60).optional(),
  cooperationCode: z.string().trim().max(40).optional(),
  responsibleId: idSchema.optional(),
  open: z.enum(['true', 'false']).optional(),
});

/* negotiations */

export const NEGOTIATION_CHANNELS = ['MEETING', 'PHONE', 'MESSAGE', 'EMAIL', 'OTHER'] as const;
export const NEGOTIATION_OUTCOMES = ['OPEN', 'AGREED', 'COUNTER_OFFER', 'REJECTED', 'POSTPONED'] as const;
export const NEGOTIATION_LABELS: Record<(typeof NEGOTIATION_CHANNELS)[number] | (typeof NEGOTIATION_OUTCOMES)[number], { fa: string; en: string }> = {
  MEETING: { fa: 'جلسهٔ حضوری', en: 'Meeting' },
  PHONE: { fa: 'تلفنی', en: 'Phone call' },
  MESSAGE: { fa: 'پیام', en: 'Message' },
  EMAIL: { fa: 'ایمیل', en: 'Email' },
  OTHER: { fa: 'سایر', en: 'Other' },
  OPEN: { fa: 'در جریان', en: 'Ongoing' },
  AGREED: { fa: 'توافق شد', en: 'Agreed' },
  COUNTER_OFFER: { fa: 'پیشنهاد متقابل', en: 'Counter-offer' },
  REJECTED: { fa: 'رد شد', en: 'Rejected' },
  POSTPONED: { fa: 'موکول شد', en: 'Postponed' },
};

export const negotiationSchema = z.object({
  heldAt: z.coerce.date(),
  channel: z.enum(NEGOTIATION_CHANNELS).default('MEETING'),
  summary: text(4000).min(3),
  proposedRent: moneySchema.optional().nullable(),
  proposedRentPeriod: z.enum(RENT_PERIODS).optional().nullable(),
  proposedDeposit: moneySchema.optional().nullable(),
  proposedCharge: moneySchema.optional().nullable(),
  otherTerms: optionalText(2000),
  outcome: z.enum(NEGOTIATION_OUTCOMES).default('OPEN'),
  nextAction: optionalText(500),
  followUpAt: z.coerce.date().optional().nullable(),
  assigneeId: idSchema.optional().nullable(),
  contactIds: z.array(idSchema).max(20).default([]),
  userIds: z.array(idSchema).max(20).default([]),
  /** People there who are in neither list — someone from the client, a broker. */
  otherParticipants: z.array(text(120).min(2)).max(10).default([]),
});
export const negotiationUpdateSchema = negotiationSchema.partial().extend({ followUpDone: z.boolean().optional() });

/* contracts and approvals */

export const SITE_CONTRACT_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;

/** The terms a contract fixes. Before approval they are the project's; an amendment afterwards brings new ones. */
export const SITE_TERM_FIELDS = [
  'cooperationCode', 'contractStart', 'contractEnd', 'depositAmount', 'rentAmount', 'rentPeriod', 'rentDueDay', 'rentMethodCode',
  'chargeAmount', 'chargeDueDay', 'chargeMethodCode', 'currency',
] as const;

export const siteContractSchema = z.object({
  reference: optionalText(80),
  notes: optionalText(2000),
  /**
   * An amendment to an approved contract: the terms it changes. Approved, they become the project's,
   * and the schedule is built again from them. Before the first approval the project's own terms are
   * edited instead.
   */
  amendment: siteProjectSchema.pick({
    cooperationCode: true, contractStart: true, contractEnd: true, depositAmount: true, rentAmount: true, rentPeriod: true, rentDueDay: true,
    rentMethodCode: true, chargeAmount: true, chargeDueDay: true, chargeMethodCode: true,
  }).partial().optional(),
});
export const siteContractDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  comment: optionalText(2000),
}).refine((d) => d.decision === 'APPROVE' || (d.comment ?? '').trim().length >= 3, { message: 'دلیل رد قرارداد را بنویسید.', path: ['comment'] });

/** The client's (employer's) approval, recorded by a colleague with the evidence — a photo of the signed page. */
export const employerApprovalSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  approverName: text(120).min(2),
  approverTitle: optionalText(120),
  decidedAt: z.coerce.date(),
  comment: optionalText(2000),
  subject: z.enum(['CONTRACT', 'INSTALLATION', 'GENERAL']).default('INSTALLATION'),
});

/* installation and people */

export const counterSchema = z.object({
  label: text(120).min(1),
  quantity: z.number().int().min(1).max(1000).default(1),
  widthCm: z.number().int().min(0).max(100_000).optional().nullable(),
  depthCm: z.number().int().min(0).max(100_000).optional().nullable(),
  heightCm: z.number().int().min(0).max(100_000).optional().nullable(),
  specs: optionalText(1000),
  /** What making one costs; the total is quantity × this. */
  unitCost: moneySchema.optional().nullable(),
  supplierId: idSchema.optional().nullable(),
});

export const ASSIGNMENT_ROLES = ['PROMOTER', 'INSTALLER', 'SUPERVISOR', 'OTHER'] as const;
export const ASSIGNMENT_ROLE_LABELS: Record<(typeof ASSIGNMENT_ROLES)[number], { fa: string; en: string }> = {
  PROMOTER: { fa: 'پروموتر', en: 'Promoter' },
  INSTALLER: { fa: 'نصاب', en: 'Installer' },
  SUPERVISOR: { fa: 'سرپرست', en: 'Supervisor' },
  OTHER: { fa: 'سایر', en: 'Other' },
};
export const assignmentSchema = z.object({
  role: z.enum(ASSIGNMENT_ROLES).default('PROMOTER'),
  userId: idSchema.optional().nullable(),
  personName: optionalText(120),
  phone: optionalText(40),
  startsOn: z.coerce.date().optional().nullable(),
  endsOn: z.coerce.date().optional().nullable(),
  shift: optionalText(120),
  notes: optionalText(1000),
}).refine((a) => a.userId || (a.personName ?? '').trim().length >= 2, { message: 'همکار را برگزینید یا نام فرد را بنویسید.', path: ['personName'] })
  .refine((a) => !a.startsOn || !a.endsOn || a.endsOn >= a.startsOn, { message: 'پایان حضور پیش از آغاز آن است.', path: ['endsOn'] });

/* ── module C: the rental ledger ──────────────────────────────────────────── */

export const OBLIGATION_KINDS = ['RENT', 'CHARGE', 'DEPOSIT', 'PENALTY', 'OTHER', 'INSTALLATION', 'TRANSPORT', 'FABRICATION'] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];
export const OBLIGATION_KIND_LABELS: Record<ObligationKind, { fa: string; en: string }> = {
  RENT: { fa: 'اجاره', en: 'Rent' },
  CHARGE: { fa: 'شارژ', en: 'Service charge' },
  DEPOSIT: { fa: 'ودیعه', en: 'Deposit' },
  PENALTY: { fa: 'جریمه', en: 'Penalty' },
  OTHER: { fa: 'سایر هزینه‌ها', en: 'Other charges' },
  INSTALLATION: { fa: 'هزینهٔ نصب', en: 'Installation' },
  TRANSPORT: { fa: 'حمل و نقل', en: 'Transport' },
  FABRICATION: { fa: 'ساخت کانتر', en: 'Counter fabrication' },
};
export const OBLIGATION_STATUSES = ['OPEN', 'PARTIAL', 'SETTLED', 'WAIVED', 'VOID'] as const;

export const obligationSchema = z.object({
  kind: z.enum(OBLIGATION_KINDS),
  categoryCode: code.optional().nullable(),
  description: optionalText(500),
  periodStart: z.coerce.date().optional().nullable(),
  periodEnd: z.coerce.date().optional().nullable(),
  dueDate: z.coerce.date(),
  amount: positiveMoney,
});
/** A change to an unpaid amount or date: always with its reason, and never below what was already paid. */
export const obligationAdjustSchema = z.object({
  amount: positiveMoney.optional(),
  dueDate: z.coerce.date().optional(),
  description: optionalText(500),
  reason: text(500).min(3),
});
export const obligationCloseSchema = z.object({
  /** WAIVE: the venue forgave it. VOID: it was never owed — entered by mistake, or the project ended first. */
  action: z.enum(['WAIVE', 'VOID']),
  reason: text(500).min(3),
});

export const obligationListSchema = paginationSchema.extend({
  siteProjectId: idSchema.optional(),
  venueId: idSchema.optional(),
  kind: z.enum(OBLIGATION_KINDS).optional(),
  status: z.enum(['open', 'overdue', 'settled', 'all']).default('open'),
  province: z.string().trim().max(60).optional(),
  city: z.string().trim().max(60).optional(),
  responsibleId: idSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const scheduleSchema = z.object({
  /** Show what would be made, and make nothing. */
  dryRun: z.boolean().default(true),
});

export const PAYMENT_PURPOSES = ['OBLIGATIONS', 'DEPOSIT_REFUND', 'CREDIT_REFUND'] as const;
export const PAYMENT_PURPOSE_LABELS: Record<(typeof PAYMENT_PURPOSES)[number], { fa: string; en: string }> = {
  OBLIGATIONS: { fa: 'پرداخت به مکان', en: 'Paid to the venue' },
  DEPOSIT_REFUND: { fa: 'عودت ودیعه از مکان', en: 'Deposit returned by the venue' },
  CREDIT_REFUND: { fa: 'بازگشت اضافه‌پرداخت', en: 'Overpayment returned' },
};

/**
 * One payment: to the venue against what is owed (OBLIGATIONS), or from it — the deposit back
 * (DEPOSIT_REFUND), or an overpayment back (CREDIT_REFUND).
 */
export const sitePaymentSchema = z.object({
  purpose: z.enum(PAYMENT_PURPOSES).default('OBLIGATIONS'),
  amount: positiveMoney,
  paidAt: z.coerce.date(),
  methodCode: code.min(1),
  reference: optionalText(120),
  chequeNumber: optionalText(40),
  chequeBank: optionalText(80),
  chequeDate: z.coerce.date().optional().nullable(),
  note: optionalText(1000),
  /** Where an OUT payment goes. Left out, it goes to the oldest open items first. */
  allocations: z.array(z.object({ obligationId: idSchema, amount: positiveMoney })).max(100).optional(),
  /**
   * The client's own id for this payment. A payment sent twice — a double click, a retry after a
   * dropped connection — is recorded once, and the second answer is the first.
   */
  clientKey: z.string().trim().min(8).max(80),
});
export const reversalSchema = z.object({ reason: text(500).min(3) });

export const DEPOSIT_ENTRY_KINDS = ['DEDUCTION', 'REFUND'] as const;
/** The venue keeps part of the deposit — for what was owed, a penalty, damage — with the reason and the evidence. */
export const depositDeductionSchema = z.object({
  amount: positiveMoney,
  reason: text(1000).min(3),
  /** What was owed that this pays: rent, charge or a penalty the venue takes from the deposit. */
  obligationId: idSchema.optional().nullable(),
});
export const depositDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  comment: optionalText(1000),
});

/* ── reminders and messages ───────────────────────────────────────────────── */

export const SITE_EVENTS = [
  'RENT_DUE', 'CHARGE_DUE', 'PAYMENT_DUE', 'RENT_OVERDUE', 'CHARGE_OVERDUE', 'PAYMENT_OVERDUE', 'PENALTY_OUTSTANDING',
  'CONTRACT_EXPIRY', 'FOLLOW_UP', 'CONTRACT_APPROVAL', 'EMPLOYER_APPROVAL', 'DEPOSIT_RETURN', 'CLOSURE_PENDING',
] as const;
export type SiteEvent = (typeof SITE_EVENTS)[number];
export const SITE_EVENT_LABELS: Record<SiteEvent, { fa: string; en: string }> = {
  RENT_DUE: { fa: 'سررسید اجاره', en: 'Rent due' },
  CHARGE_DUE: { fa: 'سررسید شارژ', en: 'Service charge due' },
  PAYMENT_DUE: { fa: 'سررسید پرداخت', en: 'Payment due' },
  RENT_OVERDUE: { fa: 'اجارهٔ معوق', en: 'Rent overdue' },
  CHARGE_OVERDUE: { fa: 'شارژ معوق', en: 'Service charge overdue' },
  PAYMENT_OVERDUE: { fa: 'پرداخت معوق', en: 'Payment overdue' },
  PENALTY_OUTSTANDING: { fa: 'جریمهٔ پرداخت‌نشده', en: 'Penalty outstanding' },
  CONTRACT_EXPIRY: { fa: 'پایان قرارداد', en: 'Contract ending' },
  FOLLOW_UP: { fa: 'پیگیری مذاکره', en: 'Negotiation follow-up' },
  CONTRACT_APPROVAL: { fa: 'قرارداد در انتظار تأیید', en: 'Contract awaiting approval' },
  EMPLOYER_APPROVAL: { fa: 'تأییدیهٔ کارفرما ثبت نشده', en: 'Client approval missing' },
  DEPOSIT_RETURN: { fa: 'عودت ودیعه', en: 'Deposit return' },
  CLOSURE_PENDING: { fa: 'بستن پروژه در انتظار', en: 'Closure waiting' },
};

export const SMS_PLACEHOLDERS = ['{venue}', '{contact}', '{project}', '{amount}', '{dueDate}', '{sender}'] as const;

const templateSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_-]{1,39}$/, 'کلید قالب با حرف کوچک لاتین آغاز شود.'),
  label: text(80).min(2),
  text: text(600).min(5),
});

export const SITE_SMS_TEMPLATE_DEFAULTS: z.infer<typeof templateSchema>[] = [
  { key: 'greeting', label: 'معرفی و درخواست همکاری', text: 'سلام {contact}، از {sender} تماس می‌گیریم دربارهٔ همکاری برای استقرار در {venue}. لطفاً زمانی برای گفت‌وگو اعلام بفرمایید.' },
  { key: 'payment', label: 'اطلاع پرداخت', text: 'سلام {contact}، مبلغ {amount} بابت پروژهٔ {project} در {venue} پرداخت شد. با سپاس، {sender}' },
  { key: 'visit', label: 'هماهنگی بازدید و نصب', text: 'سلام {contact}، برای نصب پروژهٔ {project} در تاریخ {dueDate} به {venue} می‌آییم. {sender}' },
];

/** How the rentals run — one row per organisation, every part with a default, changed by site.configure. */
export const siteSettingsSchema = z.object({
  reminders: z.object({
    enabled: z.boolean().default(true),
    /** Days before a payment is due that its reminder goes out. */
    daysBefore: z.array(z.number().int().min(0).max(365)).max(10).default([30, 14, 7, 3, 1]),
    /** Days after it fell due that an unpaid one is reminded again. */
    overdueDays: z.array(z.number().int().min(1).max(365)).max(10).default([1, 7, 14, 30]),
    /** Days before a contract ends. */
    contractDays: z.array(z.number().int().min(0).max(365)).max(10).default([60, 30, 14, 7]),
    /** Days an approval, a client's approval or a closure has waited, at which someone is reminded of it. */
    waitingDays: z.array(z.number().int().min(1).max(365)).max(10).default([1, 3, 7, 14]),
    events: z.record(z.enum(SITE_EVENTS), z.boolean()).default({}),
    /** Who hears of money due: the project's responsible colleague, everyone holding rental.manage, these people. */
    toResponsible: z.boolean().default(true),
    toFinance: z.boolean().default(true),
    userIds: z.array(idSchema).max(50).default([]),
    /** Also by SMS to the colleague's own mobile, through the installation's SMS provider. */
    smsToStaff: z.boolean().default(false),
  }).default({}),
  schedule: z.object({
    /** A part-month at either end of a contract: charged for its days (DAYS), or as a whole month (FULL). */
    proration: z.enum(['DAYS', 'FULL']).default('DAYS'),
  }).default({}),
  payments: z.object({
    /** A payment larger than what it is put against: refused (REJECT), or kept as credit on the project (CREDIT). */
    overpayment: z.enum(['REJECT', 'CREDIT']).default('REJECT'),
  }).default({}),
  activation: z.object({
    requireInstallationPhoto: z.boolean().default(true),
    requireEmployerApproval: z.boolean().default(false),
  }).default({}),
  deposits: z.object({
    /** A deduction counts only once someone holding rental.approve approves it. */
    requireDeductionApproval: z.boolean().default(true),
  }).default({}),
  venues: z.object({
    required: z.array(z.enum(VENUE_EXPECTED_FIELDS)).max(VENUE_EXPECTED_FIELDS.length).default(['address', 'phone']),
    /** What makes two venues look like one: the same name in the same city, a shared phone number, the same address. */
    duplicateBy: z.array(z.enum(['NAME_CITY', 'PHONE', 'ADDRESS'])).max(3).default(['NAME_CITY', 'PHONE']),
  }).default({}),
  smsTemplates: z.array(templateSchema).max(30).default(SITE_SMS_TEMPLATE_DEFAULTS),
});
export type SiteSettings = z.infer<typeof siteSettingsSchema>;

export const venueSmsSchema = z.object({
  /** The venues to write to: each one's primary contact with a mobile, or the venue's own mobile. */
  venueIds: z.array(idSchema).max(500).default([]),
  /** Or these people precisely. */
  contactIds: z.array(idSchema).max(500).default([]),
  siteProjectId: idSchema.optional().nullable(),
  templateKey: z.string().trim().max(40).optional().nullable(),
  text: text(600).min(5),
  /** Values for the placeholders a template uses beyond the venue's and contact's names. */
  values: z.object({ amount: optionalText(60), dueDate: optionalText(40), project: optionalText(120) }).default({}),
}).refine((m) => m.venueIds.length + m.contactIds.length > 0, { message: 'دست‌کم یک مکان یا مخاطب برگزینید.', path: ['venueIds'] });

export const savedViewSchema = z.object({
  page: z.enum(['venues', 'projects', 'rentals']),
  name: text(80).min(2),
  filters: z.record(z.string().max(200)).default({}),
  shared: z.boolean().default(false),
});

/* ── Excel ────────────────────────────────────────────────────────────────── */

export const IMPORT_KINDS = ['VENUES', 'CONTACTS', 'SITE_PROJECTS', 'OBLIGATIONS'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const IMPORT_KIND_LABELS: Record<ImportKind, { fa: string; en: string }> = {
  VENUES: { fa: 'مکان‌ها', en: 'Venues' },
  CONTACTS: { fa: 'مخاطبان مکان‌ها', en: 'Venue contacts' },
  SITE_PROJECTS: { fa: 'پروژه‌های استقرار', en: 'Deployment projects' },
  OBLIGATIONS: { fa: 'تعهدات مالی', en: 'Financial obligations' },
};
/** CREATE: new rows only, a match is an error. UPSERT: a match by code is updated, the rest are created. */
export const IMPORT_MODES = ['CREATE', 'UPSERT'] as const;

export const EXPORT_KINDS = ['venues', 'contacts', 'projects', 'obligations', 'payments', 'deposits', 'report'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const siteReportSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  province: z.string().trim().max(60).optional(),
  city: z.string().trim().max(60).optional(),
  venueId: idSchema.optional(),
  siteProjectId: idSchema.optional(),
});
