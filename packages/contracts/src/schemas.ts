import { z } from 'zod';
import {
  DEPARTMENT_CODES, ROLE_CODES, PRIORITY_LEVELS, SEVERITY_LEVELS, CURRENCIES, MEDIA_CHANNELS, MEDIA_PRICING_MODELS,
  AUTHORIZATION_BASES, QC_LEVELS, QC_RESULTS, REVISION_REASONS,
  SCOPE_VERDICTS, INVOICE_KINDS, SUPPLIER_KINDS, RACI_ROLES, ACCOUNT_KEYS, ACCOUNTING_FIELDS, CLIENT_APPROVAL_SUBJECTS,
  BRAND_COLOR_ROLES, CUSTOM_RULE_KINDS,
} from './enums.js';
import { DIRECT_CHANNELS, LEAD_REFERRER_KINDS, LEAD_SOURCE_KINDS, normalizeIranMobile } from './crm.js';

/* ── shared primitives ─────────────────────────────────────────────────────── */

export const idSchema = z.string().uuid();
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().trim().max(200).optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

/** An Iranian mobile number, however typed, stored as 09xxxxxxxxx (Hivamis task 2). */
export const iranMobileSchema = z.string().trim().max(40).transform((v, ctx) => {
  const n = normalizeIranMobile(v);
  if (!n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'شمارهٔ همراه معتبر نیست — مانند ۰۹۱۲۱۲۳۴۵۶۷' });
    return z.NEVER;
  }
  return n;
});

export const transitionSchema = z.object({
  action: z.string().min(1).max(64),
  reason: z.string().trim().max(2000).optional(),
  payload: z.record(z.unknown()).optional(),
});

/* ── auth ──────────────────────────────────────────────────────────────────── */

export const loginSchema = z.object({
  email: z.string().email().max(160),
  password: z.string().min(8).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(12).max(200)
    .regex(/[a-z]/, 'باید شامل حرف کوچک باشد')
    .regex(/[A-Z]/, 'باید شامل حرف بزرگ باشد')
    .regex(/[0-9]/, 'باید شامل عدد باشد'),
});

export const createUserSchema = z.object({
  email: z.string().email().max(160),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(200),
  departmentCode: z.enum(DEPARTMENT_CODES),
  roleCodes: z.array(z.enum(ROLE_CODES)).min(1),
  jobTitle: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  weeklyCapacityHours: z.coerce.number().min(0).max(80).default(40),
});

export const updateUserSchema = createUserSchema.partial().omit({ password: true });

/* ── CRM ───────────────────────────────────────────────────────────────────── */

export const createCompanySchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  brandName: z.string().trim().max(200).optional(),
  industry: z.string().trim().max(120).optional(),
  nationalId: z.string().trim().max(40).optional(),
  economicCode: z.string().trim().max(40).optional(),
  postalCode: z.string().trim().max(20).optional(),
  website: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(500).optional(),
  accountOwnerId: idSchema.optional(),
  salesOwnerId: idSchema.optional(),
});
export const updateCompanySchema = createCompanySchema.partial();

export const createContactSchema = z.object({
  companyId: idSchema,
  fullName: z.string().trim().min(2).max(120),
  jobTitle: z.string().trim().max(120).optional(),
  email: z.string().email().max(160).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional(),
  isPrimary: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional(),
});
export const updateContactSchema = createContactSchema.partial().omit({ companyId: true });

const leadFields = z.object({
  name: z.string().trim().min(2).max(160),
  companyName: z.string().trim().min(2).max(200),
  contactName: z.string().trim().max(120).optional(),
  /** «تلفن همراه»: required, one written form, and how a repeated lead is recognised. */
  phone: iranMobileSchema,
  email: z.string().email().max(160).optional().or(z.literal('')),
  /** Where it came from, in two steps: the kind, then exactly who or what (see crm.ts). */
  source: z.enum(LEAD_SOURCE_KINDS),
  /** SALES_TEAM: a member of the sales unit; STAFF: a colleague outside it. */
  sourceUserId: idSchema.nullish(),
  /** MARKETER or PARTNER: one of the organisation's list. */
  sourceReferrerId: idSchema.nullish(),
  /** DIRECT: by which channel. */
  sourceChannel: z.enum(DIRECT_CHANNELS).nullish(),
  /** PARTNER: a partner company not on the list yet — added as it is named. */
  sourcePartnerName: z.string().trim().min(2).max(160).optional(),
  estimatedValue: z.coerce.number().min(0).optional(),
  need: z.string().trim().max(2000).optional(),
  ownerId: idSchema.optional(),
  /** Register it although its mobile number already belongs to another lead or contact. */
  confirmDuplicate: z.boolean().optional(),
});

/** The second step each kind of source needs. Who it names is checked against the data by the API. */
export function leadSourceIssues(v: {
  source?: string; sourceUserId?: string | null; sourceReferrerId?: string | null; sourceChannel?: string | null; sourcePartnerName?: string;
}): { path: string; message: string }[] {
  switch (v.source) {
    case 'SALES_TEAM': return v.sourceUserId ? [] : [{ path: 'sourceUserId', message: 'عضو تیم فروش را انتخاب کنید' }];
    case 'STAFF': return v.sourceUserId ? [] : [{ path: 'sourceUserId', message: 'همکاری را که سرنخ را آورده انتخاب کنید' }];
    case 'MARKETER': return v.sourceReferrerId ? [] : [{ path: 'sourceReferrerId', message: 'بازاریاب را انتخاب کنید' }];
    case 'PARTNER': return v.sourceReferrerId || v.sourcePartnerName ? [] : [{ path: 'sourceReferrerId', message: 'شرکت همکار را انتخاب کنید یا نامش را بنویسید' }];
    case 'DIRECT': return v.sourceChannel ? [] : [{ path: 'sourceChannel', message: 'کانال تماس را انتخاب کنید' }];
    default: return [];
  }
}

export const createLeadSchema = leadFields.superRefine((v, ctx) => {
  for (const i of leadSourceIssues(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i.path], message: i.message });
});
/** A change to the source is checked whole, against what the lead already has (apps/api/src/crm). */
export const updateLeadSchema = leadFields.partial();

/** A role's permissions as the system administrator grants them (Hivamis task 6). */
export const roleGrantSchema = z.object({
  permissions: z.array(z.string().trim().min(3).max(60)).max(200),
  note: z.string().trim().max(500).optional(),
});

/** Marketers (kept by the system admin) and partner companies a lead may name. */
export const createLeadReferrerSchema = z.object({
  kind: z.enum(LEAD_REFERRER_KINDS),
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(40).optional(),
  note: z.string().trim().max(500).optional(),
});
export const updateLeadReferrerSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  phone: z.string().trim().max(40).nullish(),
  note: z.string().trim().max(500).nullish(),
  isActive: z.boolean().optional(),
});

export const createOpportunitySchema = z.object({
  title: z.string().trim().min(2).max(200),
  companyId: idSchema,
  leadId: idSchema.optional(),
  estimatedValue: z.coerce.number().min(0),
  expectedCloseDate: z.coerce.date().optional(),
  servicesNeeded: z.array(z.enum(DEPARTMENT_CODES)).default([]),
  description: z.string().trim().max(4000).optional(),
  ownerId: idSchema.optional(),
});
export const updateOpportunitySchema = createOpportunitySchema.partial().omit({ companyId: true });

export const createActivitySchema = z.object({
  companyId: idSchema.optional(),
  opportunityId: idSchema.optional(),
  projectId: idSchema.optional(),
  kind: z.enum(['CALL', 'MEETING', 'EMAIL', 'VISIT', 'NOTE']),
  occurredAt: z.coerce.date(),
  summary: z.string().trim().min(2).max(4000),
  nextStep: z.string().trim().max(2000).optional(),
  nextStepDue: z.coerce.date().optional(),
});

/* ── brief / proposal / pricing ────────────────────────────────────────────── */

export const createBriefSchema = z.object({
  opportunityId: idSchema,
  title: z.string().trim().min(2).max(200),
  businessObjective: z.string().trim().max(4000).optional(),
  targetAudience: z.string().trim().max(4000).optional(),
  scope: z.string().trim().max(8000).optional(),
  expectedDeliverables: z.string().trim().max(8000).optional(),
  budgetRange: z.coerce.number().min(0).optional(),
  desiredDeadline: z.coerce.date().optional(),
  unitsNeeded: z.array(z.enum(DEPARTMENT_CODES)).default([]),
  competitorContext: z.string().trim().max(4000).optional(),
  constraints: z.string().trim().max(4000).optional(),
  successCriteria: z.string().trim().max(4000).optional(),
});
export const updateBriefSchema = createBriefSchema.partial().omit({ opportunityId: true });

export const createProposalSchema = z.object({
  briefId: idSchema,
  title: z.string().trim().min(2).max(200),
  executiveSummary: z.string().trim().max(8000).optional(),
  approach: z.string().trim().max(8000).optional(),
  deliverablesSummary: z.string().trim().max(8000).optional(),
  timelineSummary: z.string().trim().max(8000).optional(),
});
export const updateProposalSchema = createProposalSchema.partial().omit({ briefId: true });

/** Doc_H §12 — sale price and margin are set only through this schema, gated by `pricing.set_price`. */
export const setPricingSchema = z.object({
  salePrice: z.coerce.number().min(0),
  marginPercent: z.coerce.number().min(-100).max(1000).optional(),
  paymentTerms: z.string().trim().max(2000).optional(),
  contractScaleBand: z.enum(['S', 'M', 'L', 'XL']).optional(),
  rationale: z.string().trim().min(2).max(4000),
});

export const declareCostSchema = z.object({
  workOrderId: idSchema.optional(),
  proposalId: idSchema.optional(),
  departmentCode: z.enum(DEPARTMENT_CODES),
  internalCost: z.coerce.number().min(0),
  externalCost: z.coerce.number().min(0).default(0),
  /** The external cost's currency (foreign media, tools, freelancers); internal cost is always base. */
  externalCurrency: z.enum(CURRENCIES).optional(),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(400),
    quantity: z.coerce.number().min(0).default(1),
    unitCost: z.coerce.number().min(0),
  })).default([]),
  assumptions: z.string().trim().max(2000).optional(),
});

/* ── project & execution ───────────────────────────────────────────────────── */

export const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(200),
  companyId: idSchema,
  briefId: idSchema.optional(),
  proposalId: idSchema.optional(),
  accountOwnerId: idSchema,
  objective: z.string().trim().max(4000).optional(),
  plannedStart: z.coerce.date().optional(),
  plannedEnd: z.coerce.date().optional(),
  plannedBudget: z.coerce.number().min(0).optional(),
  inScope: z.string().trim().max(8000).optional(),
  outOfScope: z.string().trim().max(8000).optional(),
});
export const updateProjectSchema = createProjectSchema.partial().omit({ companyId: true });

export const authorizeProjectSchema = z.object({
  basis: z.enum(AUTHORIZATION_BASES),
  contractId: idSchema.optional(),
  invoiceId: idSchema.optional(),
  referenceDocument: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
});

export const createWorkOrderSchema = z.object({
  projectId: idSchema,
  proposalId: idSchema.optional(),
  targetDepartmentCode: z.enum(DEPARTMENT_CODES),
  title: z.string().trim().min(2).max(200),
  scopeOfWork: z.string().trim().min(2).max(8000),
  brief: z.string().trim().min(2).max(8000),
  expectedOutput: z.string().trim().min(2).max(4000),
  outputFormat: z.string().trim().min(1).max(200),
  deadline: z.coerce.date(),
  ownerId: idSchema,
  budget: z.coerce.number().min(0).optional(),
  requiredResources: z.string().trim().max(2000).optional(),
  priority: z.enum(PRIORITY_LEVELS).default('NORMAL'),
});

export const createTaskSchema = z.object({
  projectId: idSchema,
  workOrderId: idSchema.optional(),
  deliverableId: idSchema.optional(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).optional(),
  departmentCode: z.enum(DEPARTMENT_CODES),
  assigneeId: idSchema.optional(),
  dueDate: z.coerce.date().optional(),
  estimateHours: z.coerce.number().min(0).max(2000).optional(),
  priority: z.enum(PRIORITY_LEVELS).default('NORMAL'),
  /** Doc_H §6 — a task is invalid unless it traces to one of the six authorised source documents. */
  sourceType: z.enum(['BRIEF', 'ORDER_FORM', 'TASK', 'MEETING_MINUTES', 'CHANGE_REQUEST', 'REVISION_FORM']),
  sourceRef: z.string().trim().min(1).max(120),
});
export const updateTaskSchema = createTaskSchema.partial().omit({ projectId: true, sourceType: true, sourceRef: true });

export const createDeliverableSchema = z.object({
  projectId: idSchema,
  proposalId: idSchema.optional(),
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).optional(),
  departmentCode: z.enum(DEPARTMENT_CODES),
  format: z.string().trim().max(120).optional(),
  dueDate: z.coerce.date().optional(),
});

export const createRaciSchema = z.object({
  projectId: idSchema,
  entries: z.array(z.object({
    activity: z.string().trim().min(1).max(300),
    departmentCode: z.enum(DEPARTMENT_CODES),
    raciRole: z.enum(RACI_ROLES),
    userId: idSchema.optional(),
  })).min(1),
});

export const createMilestoneSchema = z.object({
  projectId: idSchema,
  name: z.string().trim().min(1).max(200),
  dueDate: z.coerce.date(),
  description: z.string().trim().max(2000).optional(),
});

/** A milestone done (or undone) — the event milestone-based revenue is earned on (roadmap #29). */
export const milestoneUpdateSchema = z.object({
  completedAt: z.coerce.date().nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  dueDate: z.coerce.date().optional(),
});

/** How a project earns its revenue, and each milestone's share of it (roadmap #29). */
export const revenueSettingsSchema = z.object({
  method: z.enum(['MILESTONE', 'EFFORT', 'COST']).optional(),
  shares: z.array(z.object({
    milestoneId: idSchema,
    revenueShare: z.coerce.number().min(0).max(100).nullable(),
  })).max(100).optional(),
  note: z.string().trim().max(500).optional(),
});

export const closeRevenuePeriodSchema = z.object({
  period: z.string().regex(/^1[34]\d\d-(0[1-9]|1[0-2])$/),
});

/* ── QC / revision / change control ────────────────────────────────────────── */

export const createQcReviewSchema = z.object({
  level: z.enum(QC_LEVELS),
  deliverableId: idSchema.optional(),
  workOrderId: idSchema.optional(),
  proposalId: idSchema.optional(),
  taskId: idSchema.optional(),
  checklist: z.record(z.boolean()).default({}),
  verdict: z.enum(QC_RESULTS),
  findings: z.string().trim().max(4000).optional(),
  /** Roadmap #38: annotations on the deliverable's files that this review carries into its revision. */
  annotationIds: z.array(idSchema).max(200).default([]),
}).refine(
  (v) => v.verdict !== 'FAILED' || (v.findings != null && v.findings.trim().length > 0) || v.annotationIds.length > 0,
  { message: 'در صورت عدم تأیید، ثبت یافته‌ها یا یادداشت روی فایل الزامی است', path: ['findings'] },
);

/** Doc_H §10 — a revision without a recorded reason is rejected. */
export const createRevisionSchema = z.object({
  deliverableId: idSchema.optional(),
  proposalId: idSchema.optional(),
  taskId: idSchema.optional(),
  qcReviewId: idSchema.optional(),
  reason: z.enum(REVISION_REASONS),
  requiredCorrection: z.string().trim().min(3).max(4000),
  responsibleDepartmentCode: z.enum(DEPARTMENT_CODES),
  assigneeId: idSchema.optional(),
  dueDate: z.coerce.date(),
});

export const createChangeRequestSchema = z.object({
  projectId: idSchema,
  title: z.string().trim().min(2).max(200),
  requestedChange: z.string().trim().min(3).max(8000),
  requestedBy: z.enum(['CLIENT', 'INTERNAL']),
  requestedDate: z.coerce.date(),
  priority: z.enum(PRIORITY_LEVELS).default('NORMAL'),
});

export const scopeReviewSchema = z.object({
  verdict: z.enum(SCOPE_VERDICTS).refine((v) => v !== 'UNDETERMINED', {
    message: 'نتیجه بررسی Scope باید مشخص باشد',
  }),
  rationale: z.string().trim().min(3).max(4000),
});

/** Doc_H §8 — six impact dimensions must be assessed before an out-of-scope change proceeds. */
export const commercialImpactSchema = z.object({
  timeImpactDays: z.coerce.number(),
  costImpact: z.coerce.number(),
  resourceImpact: z.string().trim().min(1).max(2000),
  scopeImpact: z.string().trim().min(1).max(2000),
  qualityImpact: z.string().trim().min(1).max(2000),
  contractImpact: z.string().trim().min(1).max(2000),
  proposedPrice: z.coerce.number().min(0).optional(),
});

/* ── contract & finance ────────────────────────────────────────────────────── */

export const createContractSchema = z.object({
  companyId: idSchema,
  proposalId: idSchema.optional(),
  projectId: idSchema.optional(),
  title: z.string().trim().min(2).max(200),
  contractValue: z.coerce.number().min(0),
  /** The currency contractValue is written in; converted to base at today's rate when recorded. */
  currency: z.enum(CURRENCIES).optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  scopeSummary: z.string().trim().max(8000).optional(),
  paymentTerms: z.string().trim().max(4000).optional(),
});

export const createAmendmentSchema = z.object({
  contractId: idSchema,
  changeRequestId: idSchema.optional(),
  amendmentNumber: z.string().trim().min(1).max(60),
  effectiveDate: z.coerce.date(),
  changes: z.string().trim().min(3).max(8000),
  valueDelta: z.coerce.number().default(0),
  durationDeltaDays: z.coerce.number().int().default(0),
});

export const createInvoiceSchema = z.object({
  kind: z.enum(INVOICE_KINDS),
  companyId: idSchema,
  projectId: idSchema.optional(),
  contractId: idSchema.optional(),
  number: z.string().trim().min(1).max(60),
  issueDate: z.coerce.date(),
  dueDate: z.coerce.date().optional(),
  /** Line prices are in this currency; the base totals use the rate in force on issueDate. */
  currency: z.enum(CURRENCIES).optional(),
  taxPercent: z.coerce.number().min(0).max(100).default(0),
  lines: z.array(z.object({
    description: z.string().trim().min(1).max(400),
    quantity: z.coerce.number().min(0),
    unitPrice: z.coerce.number().min(0),
  })).min(1),
  notes: z.string().trim().max(2000).optional(),
});

export const createPaymentSchema = z.object({
  invoiceId: idSchema.optional(),
  projectId: idSchema.optional(),
  supplierId: idSchema.optional(),
  direction: z.enum(['IN', 'OUT']),
  amount: z.coerce.number().positive(),
  /** The currency `amount` is in; a receipt against a foreign invoice may be in its currency or in base. */
  currency: z.enum(CURRENCIES).optional(),
  /** A payment to a media vendor for this order: pass-through, not the project's cost (roadmap #31). */
  mediaOrderId: idSchema.optional(),
  occurredAt: z.coerce.date(),
  method: z.enum(['TRANSFER', 'CHEQUE', 'CASH', 'OTHER']).default('TRANSFER'),
  reference: z.string().trim().max(120).optional(),
  description: z.string().trim().max(2000).optional(),
});

/* ── resources & governance ────────────────────────────────────────────────── */

/** An exchange rate: base-currency units for one unit of `currency`, in force from `effectiveDate`. */
export const exchangeRateSchema = z.object({
  currency: z.enum(CURRENCIES),
  rate: z.coerce.number().positive().max(1e12),
  effectiveDate: z.coerce.date(),
  /** Required when it replaces a rate already recorded for that day. */
  note: z.string().trim().max(500).optional(),
});

/** Rates in bulk — one «date,currency,rate» per line; Jalali (1405/07/01) or ISO dates. */
export const importRatesSchema = z.object({
  csv: z.string().min(5).max(200_000),
});

/**
 * A media order (roadmap #31). `amount` is the vendor-side figure: the media's gross under
 * COMMISSION (the client is billed it; the vendor deducts the commission), the vendor's net under
 * MARKUP (the client is billed it plus the markup). The server computes the rest.
 */
export const createMediaOrderSchema = z.object({
  projectId: idSchema,
  supplierId: idSchema,
  workOrderId: idSchema.optional(),
  channel: z.enum(MEDIA_CHANNELS),
  placement: z.string().trim().min(3).max(1000),
  flightStart: z.coerce.date(),
  flightEnd: z.coerce.date(),
  pricingModel: z.enum(MEDIA_PRICING_MODELS),
  amount: z.coerce.number().positive(),
  commissionPercent: z.coerce.number().min(0).max(60),
  currency: z.enum(CURRENCIES).optional(),
}).refine((v) => v.flightEnd >= v.flightStart, { message: 'پایان پخش پیش از آغاز آن است', path: ['flightEnd'] });

/** The vendor's invoice for a media order, in the order's currency. */
export const vendorInvoiceSchema = z.object({
  number: z.string().trim().min(1).max(60),
  amount: z.coerce.number().positive(),
  invoiceDate: z.coerce.date(),
  /** Required to reconcile when the invoice differs from the booked net. */
  discrepancyNote: z.string().trim().max(1000).optional(),
});

/** Billing the client for media orders — the intermediary invoice, pass-through and commission apart. */
export const billMediaSchema = z.object({
  orderIds: z.array(idSchema).min(1).max(100),
  number: z.string().trim().min(1).max(60),
  issueDate: z.coerce.date(),
  dueDate: z.coerce.date().optional(),
  taxPercent: z.coerce.number().min(0).max(100).default(0),
});

/** An API key (roadmap #46): a name, the permissions it may use, its own rate and an optional expiry. */
export const createApiKeySchema = z.object({
  name: z.string().trim().min(3).max(100),
  permissions: z.array(z.string().max(60)).min(1).max(200),
  rateLimitPerMinute: z.coerce.number().int().min(1).max(10_000).default(60),
  expiresAt: z.coerce.date().optional(),
});

/** A webhook: where to send, and which transitions — «project.activate», «invoice.*» or «*». */
export const createWebhookSchema = z.object({
  name: z.string().trim().min(3).max(100),
  url: z.string().trim().url().max(2000),
  events: z.array(z.string().regex(/^(\*|[a-zA-Z]+\.(\*|[a-z_]+))$/)).min(1).max(100),
});
export const updateWebhookSchema = z.object({
  active: z.boolean().optional(),
  events: createWebhookSchema.shape.events.optional(),
  url: createWebhookSchema.shape.url.optional(),
});

/** The organisation as a taxpayer in سامانهٔ مؤدیان (roadmap #32). */
export const taxProfileSchema = z.object({
  // Shapes are checked by the API's own validator, which names each problem in Persian; this only bounds sizes.
  memoryId: z.string().trim().max(20),
  sellerTaxId: z.string().trim().max(30),
  economicCode: z.string().trim().max(20).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  branchCode: z.string().trim().max(10).optional().nullable(),
  defaultServiceCode: z.string().trim().max(30),
  defaultUnitCode: z.string().trim().max(20),
});
/** A client's tax identifiers, which finance may complete for e-invoicing. */
export const companyTaxIdentifiersSchema = z.object({
  nationalId: z.string().trim().max(20).optional().nullable(),
  economicCode: z.string().trim().max(20).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
});
export const submitTaxSchema = z.object({ subject: z.enum(['ORIGINAL', 'CORRECTION', 'CANCELLATION']) });

/** The export to the accounting package (roadmap #33): the codes of the organisation's own chart, and its file layout. */
const accountCode = z.string().trim().max(40);
export const accountingSettingsSchema = z.object({
  accounts: z.object(Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, accountCode.optional()])) as Record<(typeof ACCOUNT_KEYS)[number], z.ZodOptional<typeof accountCode>>),
  /** companyId → the client's detail (تفصیلی) code. */
  clientCodes: z.record(idSchema, z.string().trim().min(1).max(40)).default({}),
  layout: z.object({
    columns: z.array(z.object({ field: z.enum(ACCOUNTING_FIELDS), header: z.string().trim().min(1).max(60) })).min(1).max(20),
    dateFormat: z.enum(['JALALI', 'GREGORIAN']),
  }),
});
/** Everything not yet exported up to `to` (inclusive) — a late record dated earlier is not left behind. */
export const accountingPeriodSchema = z.object({ to: z.coerce.date() });

/** Ask a client contact to approve a delivered deliverable or a presented proposal (roadmap #35). */
export const createClientApprovalSchema = z.object({
  subjectType: z.enum(CLIENT_APPROVAL_SUBJECTS),
  subjectId: idSchema,
  contactId: idSchema,
  /** The files the client is asked about; a deliverable needs at least one. Default: all of the subject's files. */
  documentIds: z.array(idSchema).max(30).optional(),
  message: z.string().trim().max(2000).optional(),
  expiresInDays: z.coerce.number().int().min(1).max(60).default(14),
});
/** The client's decision, on the public page. */
export const clientDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REQUEST_CHANGES']),
  signerName: z.string().trim().min(3).max(120),
  comment: z.string().trim().max(4000).optional(),
  code: z.string().trim().max(12).optional(),
  /** The declaration beside the button: «فایل‌های بالا را دیده‌ام …». */
  confirm: z.literal(true),
});
export const cancelClientApprovalSchema = z.object({ reason: z.string().trim().min(3).max(1000) });

/* ── client portal (roadmap #34) ───────────────────────────────────────────── */

/**
 * The organisation's own working week and hours (roadmap #48's calendar step writes these). Every
 * SLA clock is measured against them, so nonsense is refused rather than stored.
 */
export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  legalName: z.string().trim().max(200).optional(),
  currency: z.string().trim().length(3).optional(),
  timezone: z.string().trim().min(3).max(60).optional(),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine((d) => new Set(d).size === d.length, 'روز تکراری').optional(),
  workStartHour: z.number().int().min(0).max(23).optional(),
  workEndHour: z.number().int().min(1).max(24).optional(),
  breakHours: z.number().min(0).max(4).optional(),
  /** Audit CALC-1: whether contract values are written with VAT; invoices are compared on the same footing. */
  contractValueIncludesTax: z.boolean().optional(),
}).refine((o) => o.workStartHour == null || o.workEndHour == null || o.workStartHour < o.workEndHour, { message: 'ساعت پایان کار باید پس از شروع باشد', path: ['workEndHour'] });

/** Audit LOG-5: a legal hold keeps a document's file whatever happens to the document; its reason is required. */
export const legalHoldSchema = z.object({
  hold: z.boolean(),
  reason: z.string().trim().min(3).max(500).optional(),
}).refine((o) => !o.hold || !!o.reason, { message: 'دلیل نگه‌داشت حقوقی لازم است', path: ['reason'] });

export const updateSlaPolicySchema = z.object({
  hours: z.number().min(0.5).max(2000).optional(),
  warnAt: z.number().min(0.1).max(0.99).optional(),
  isActive: z.boolean().optional(),
});

/** A person imported in bulk sets their first password from a one-time link (roadmap #48). */
export const activateAccountSchema = z.object({ password: z.string().min(12).max(200)
  .regex(/[a-z]/, 'باید شامل حرف کوچک باشد')
  .regex(/[A-Z]/, 'باید شامل حرف بزرگ باشد')
  .regex(/[0-9]/, 'باید شامل عدد باشد') });

/** A browser's Web Push subscription as PushSubscription.toJSON() gives it (roadmap #49). */
const base64url = (max: number) => z.string().trim().min(1).max(max).regex(/^[A-Za-z0-9_-]+=*$/, 'باید base64url باشد');
export const pushSubscribeSchema = z.object({
  endpoint: z.string().trim().url().max(1000),
  keys: z.object({ p256dh: base64url(120), auth: base64url(40) }),
  userAgent: z.string().trim().max(300).nullish(),
});
export const pushUnsubscribeSchema = z.object({ endpoint: z.string().trim().url().max(1000) });

/** The organisation's own unit names, each mapped to one of Doc_H's ten units (roadmap #48). */
export const unitMapSchema = z.object({
  map: z.record(z.string().trim().min(1).max(120), z.enum(DEPARTMENT_CODES)).refine((m) => Object.keys(m).length <= 200, 'حداکثر ۲۰۰ نام واحد'),
});

export const invitePortalUserSchema = z.object({ contactId: idSchema });
/** The client sets their own password from the invitation — the same rules as staff passwords. */
export const acceptPortalInviteSchema = z.object({
  token: z.string().trim().min(20).max(100),
  password: changePasswordSchema.shape.newPassword,
});
export const portalLoginSchema = loginSchema;
export const portalMessageSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const documentVisibilitySchema = z.object({ clientVisible: z.boolean() });

/* ── annotation on deliverables (roadmap #38) ─────────────────────────────── */

const fraction = z.coerce.number().min(0).max(1);
/** A pin on an image, a moment in a video (optionally a point on the frame), or a region of a PDF page. */
export const createAnnotationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PIN'), documentId: idSchema, x: fraction, y: fraction, note: z.string().trim().min(1).max(2000) }),
  z.object({ kind: z.literal('TIMECODE'), documentId: idSchema, timeSec: z.coerce.number().min(0).max(86_400), x: fraction.optional(), y: fraction.optional(), note: z.string().trim().min(1).max(2000) }),
  z.object({
    kind: z.literal('HIGHLIGHT'), documentId: idSchema, page: z.coerce.number().int().min(1).max(10_000),
    x: fraction, y: fraction, w: z.coerce.number().gt(0).max(1), h: z.coerce.number().gt(0).max(1), note: z.string().trim().min(1).max(2000),
  }),
]).superRefine((v, ctx) => {
  if (v.kind === 'HIGHLIGHT' && (v.x + v.w > 1.0001 || v.y + v.h > 1.0001)) ctx.addIssue({ code: 'custom', message: 'ناحیه از صفحه بیرون زده است', path: ['w'] });
});
export const annotationStatusSchema = z.object({ status: z.enum(['OPEN', 'RESOLVED']) });

/* ── brand library (roadmap #42) ───────────────────────────────────────────── */

export const brandKitSchema = z.object({
  colors: z.array(z.object({
    name: z.string().trim().min(1).max(60),
    hex: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'رنگ باید به شکل #RRGGBB باشد').transform((v) => v.toUpperCase()),
    role: z.enum(BRAND_COLOR_ROLES),
    // Print guides give a colour in ink too; the brand check compares CMYK files against it (#43).
    cmyk: z.array(z.number().min(0).max(100).transform((v) => Math.round(v))).length(4).nullish(),
  })).max(40),
  fonts: z.array(z.object({ family: z.string().trim().min(1).max(100), usage: z.string().trim().max(200).optional() })).max(20),
  notes: z.string().trim().max(4000).optional().nullable(),
});

/* ── contract e-signature (roadmap #36) ────────────────────────────────────── */

export const createEnvelopeSchema = z.object({
  /** The contract PDF to be signed, as it is now. */
  documentId: idSchema,
  clientContactId: idSchema,
  /** The organisation's signatory — someone who holds contract.sign. */
  agencyUserId: idSchema,
  expiresInDays: z.coerce.number().int().min(1).max(60).default(14),
});
export const voidEnvelopeSchema = z.object({ reason: z.string().trim().min(3).max(1000) });
export const sandboxSignSchema = z.object({ signerName: z.string().trim().min(3).max(120), confirm: z.literal(true) });
export const sandboxDeclineSchema = z.object({ reason: z.string().trim().min(5).max(2000) });

export const createSupplierSchema = z.object({
  name: z.string().trim().min(2).max(200),
  kind: z.enum(SUPPLIER_KINDS),
  departmentCode: z.enum(DEPARTMENT_CODES).optional(),
  specialty: z.string().trim().max(200).optional(),
  contactName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().email().max(160).optional().or(z.literal('')),
  dayRate: z.coerce.number().min(0).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const createOutsourceRequestSchema = z.object({
  projectId: idSchema,
  workOrderId: idSchema.optional(),
  kind: z.enum(SUPPLIER_KINDS),
  supplierId: idSchema.optional(),
  proposedSupplierName: z.string().trim().max(200).optional(),
  scopeOfWork: z.string().trim().min(3).max(4000),
  estimatedCost: z.coerce.number().min(0),
  neededBy: z.coerce.date(),
  justification: z.string().trim().min(3).max(4000),
});

export const createAllocationSchema = z.object({
  projectId: idSchema,
  userId: idSchema,
  fromDate: z.coerce.date(),
  toDate: z.coerce.date(),
  hoursPerDay: z.coerce.number().min(0.5).max(16),
  notes: z.string().trim().max(1000).optional(),
});

export const createRiskSchema = z.object({
  projectId: idSchema,
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().min(2).max(4000),
  probability: z.enum(SEVERITY_LEVELS),
  impact: z.enum(SEVERITY_LEVELS),
  mitigation: z.string().trim().max(4000).optional(),
  ownerId: idSchema,
});

export const createIssueSchema = z.object({
  projectId: idSchema,
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().min(2).max(4000),
  severity: z.enum(SEVERITY_LEVELS),
  ownerId: idSchema,
  targetResolution: z.coerce.date().optional(),
});

export const createDecisionSchema = z.object({
  projectId: idSchema,
  title: z.string().trim().min(2).max(200),
  context: z.string().trim().min(2).max(4000),
  decision: z.string().trim().min(2).max(4000),
  alternatives: z.string().trim().max(4000).optional(),
  decidedById: idSchema,
  decidedAt: z.coerce.date(),
});

/**
 * Confirmed minutes (roadmap #23): the decisions, and the actions the person who ran the meeting
 * chose to turn into tasks. Doc_H §6 — a task sourced to a meeting traces to its minutes.
 */
export const recordMinutesSchema = z.object({
  decisions: z.string().trim().max(8000).default(''),
  /** The notes or transcript the draft came from — kept as the minutes' evidence. */
  source: z.string().trim().max(50_000).optional(),
  actions: z.array(z.object({
    title: z.string().trim().min(2).max(200),
    assigneeId: idSchema.optional(),
    departmentCode: z.enum(DEPARTMENT_CODES).optional(),
    dueDate: z.coerce.date().optional(),
    priority: z.enum(PRIORITY_LEVELS).default('NORMAL'),
    /** Record it in the minutes only, or also create the task. */
    createTask: z.boolean().default(true),
  })).max(40).default([]),
});

export const draftMinutesSchema = z.object({
  notes: z.string().trim().min(10).max(50_000),
});

export const createMeetingSchema = z.object({
  projectId: idSchema.optional(),
  companyId: idSchema.optional(),
  kind: z.enum(['INTERNAL', 'CLIENT', 'KICKOFF', 'CLOSURE']),
  subject: z.string().trim().min(2).max(200),
  heldAt: z.coerce.date(),
  attendees: z.string().trim().min(2).max(2000),
  agenda: z.string().trim().max(4000).optional(),
  decisions: z.string().trim().max(8000).optional(),
  actions: z.array(z.object({
    action: z.string().trim().min(1).max(400),
    ownerId: idSchema.optional(),
    dueDate: z.coerce.date().optional(),
  })).default([]),
});

export const createFeedbackSchema = z.object({
  projectId: idSchema,
  csat: z.coerce.number().int().min(1).max(5),
  nps: z.coerce.number().int().min(0).max(10),
  qualityRating: z.coerce.number().int().min(1).max(5).optional(),
  timelinessRating: z.coerce.number().int().min(1).max(5).optional(),
  communicationRating: z.coerce.number().int().min(1).max(5).optional(),
  positives: z.string().trim().max(4000).optional(),
  improvements: z.string().trim().max(4000).optional(),
  futureNeeds: z.string().trim().max(4000).optional(),
});

export const createLessonLearnedSchema = z.object({
  projectId: idSchema,
  title: z.string().trim().min(2).max(200),
  category: z.enum(['PROCESS', 'QUALITY', 'SCHEDULE', 'COST', 'CLIENT', 'RESOURCE']),
  situation: z.string().trim().min(2).max(4000),
  lesson: z.string().trim().min(2).max(4000),
  recommendation: z.string().trim().min(2).max(4000),
});

export const createStatusReportSchema = z.object({
  projectId: idSchema,
  period: z.string().trim().min(1).max(60),
  progress: z.string().trim().min(1).max(4000),
  completed: z.string().trim().max(4000).optional(),
  inProgress: z.string().trim().max(4000).optional(),
  next: z.string().trim().max(4000).optional(),
  timelineStatus: z.string().trim().max(2000).optional(),
  risks: z.string().trim().max(4000).optional(),
  issues: z.string().trim().max(4000).optional(),
  decisionsNeeded: z.string().trim().max(4000).optional(),
  financialStatus: z.string().trim().max(2000).optional(),
});

/* ── forms engine ──────────────────────────────────────────────────────────── */

export const submitFormSchema = z.object({
  formCode: z.string().trim().min(1).max(80),
  data: z.record(z.unknown()),
  projectId: idSchema.optional(),
  companyId: idSchema.optional(),
  opportunityId: idSchema.optional(),
  assignedToId: idSchema.optional(),
  asDraft: z.boolean().default(false),
  /**
   * Generated on the device before the form was queued (roadmap #19). Re-sending the same key
   * returns the submission already filed rather than filing a second one — which is what makes
   * a retry over a bad link safe.
   */
  clientKey: z.string().trim().min(8).max(80).optional(),
});

export const formDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'RETURN']),
  comment: z.string().trim().max(2000).optional(),
}).refine((v) => v.decision === 'APPROVE' || (v.comment && v.comment.trim().length > 0), {
  message: 'برای رد یا بازگشت فرم، ثبت دلیل الزامی است',
  path: ['comment'],
});

/* ── AI ────────────────────────────────────────────────────────────────────── */

/**
 * Natural-language reporting (roadmap #27): a question, or a plan — the page's way of correcting
 * how a question was understood without rephrasing it.
 */
export const askReportSchema = z.object({
  question: z.string().trim().min(3).max(500).optional(),
  plan: z.object({
    metric: z.string().max(40),
    filters: z.object({
      units: z.array(z.enum(DEPARTMENT_CODES)).max(10).optional(),
      companyId: idSchema.optional(),
      projectId: idSchema.optional(),
      personId: idSchema.optional(),
      entity: z.string().max(40).optional(),
    }).default({}),
    period: z.object({
      preset: z.string().max(30).nullable().optional(),
      from: z.string().datetime().nullable().optional(),
      to: z.string().datetime().nullable().optional(),
    }).default({}),
    groupBy: z.enum(['unit', 'client', 'project', 'person', 'month', 'reason', 'policy', 'state']).nullable().optional(),
    compare: z.boolean().default(false),
    sort: z.enum(['desc', 'asc']).nullable().optional(),
  }).optional(),
}).refine((v) => !!v.question || !!v.plan, { message: 'پرسش یا طرح گزارش لازم است' });

export const aiAskSchema = z.object({
  capability: z.enum([
    'BRIEF_ANALYSIS', 'PROJECT_SUMMARY', 'RISK_DETECTION', 'STATUS_REPORT_DRAFT',
    'CHANGE_IMPACT_ANALYSIS', 'QC_COMPARISON', 'CUSTOMER_HEALTH', 'NEXT_BEST_ACTION', 'FREE_QUERY',
  ]),
  entityId: idSchema.optional(),
  question: z.string().trim().max(4000).optional(),
});

/* ── PDF bundles ───────────────────────────────────────────────────────────── */

/**
 * Selection for a combined export. The server re-authorises every entry, so this shape only
 * has to be well-formed — it is never trusted as evidence of access.
 *
 * The caps here are a payload bound, not the business limit: how many sections a single bundle
 * may contain is MAX_BUNDLE_ITEMS on the server, which reports it with a usable message.
 */
export const bundleSchema = z.object({
  items: z.array(z.object({
    kind: z.string().trim().min(1).max(40),
    id: idSchema,
  })).max(100).default([]),
  fileIds: z.array(idSchema).max(100).default([]),
});

/** The interface language. Persian is the product's first language; English is additive. */
export const updateLocaleSchema = z.object({
  locale: z.enum(['fa', 'en']),
});

/**
 * Conditional approval routing (roadmap #17), as an administrator may edit it. The evaluator
 * that reads these rules is pure and total — an unknown field is simply absent — so validation
 * here is about shape and blast radius: a bounded number of rules, bounded nesting, and roles
 * that exist.
 */
const routingLeafSchema = z.object({
  field: z.string().trim().min(1).max(80),
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in', 'notIn', 'isTrue', 'isFalse', 'isSet', 'isEmpty', 'ltField', 'gtField', 'eqField', 'neField']),
  value: z.union([z.number(), z.string().max(200), z.array(z.string().max(120)).max(50)]).optional(),
});
type RoutingConditionInput =
  | z.infer<typeof routingLeafSchema>
  | { all: RoutingConditionInput[] }
  | { any: RoutingConditionInput[] };
export const routingConditionSchema: z.ZodType<RoutingConditionInput> = z.lazy(() => z.union([
  routingLeafSchema,
  z.object({ all: z.array(routingConditionSchema).min(1).max(10) }),
  z.object({ any: z.array(routingConditionSchema).min(1).max(10) }),
]));

export const routingRuleSchema = z.object({
  id: z.string().trim().min(2).max(60).regex(/^[a-z0-9.-]+$/i, 'شناسه قانون فقط حروف لاتین، رقم، نقطه و خط تیره می‌پذیرد'),
  whenFa: z.string().trim().min(5).max(200),
  when: routingConditionSchema,
  addApprovers: z.array(z.enum(ROLE_CODES)).max(8).optional(),
  notifyRoles: z.array(z.enum(ROLE_CODES)).max(8).optional(),
  source: z.enum(['DOC_H', 'DEFAULT', 'ORG']).optional(),
  docRef: z.string().trim().max(200).optional(),
  isActive: z.boolean().optional(),
});

export const updateRoutingSchema = z.object({
  rules: z.array(routingRuleSchema).max(20),
  note: z.string().trim().max(200).optional(),
});

/**
 * An organisation's own rule on a transition (roadmap #47), written without code: a guard the
 * move must satisfy, or a notice sent when it happens. The condition is #17's language, so it is
 * pure, total and readable back in Persian; it can add a requirement but never remove one.
 */
export const customRuleSchema = z.object({
  kind: z.enum(CUSTOM_RULE_KINDS),
  entity: z.string().trim().min(2).max(40),
  action: z.string().trim().min(2).max(60),
  labelFa: z.string().trim().min(3).max(120),
  messageFa: z.string().trim().max(500).optional().nullable(),
  when: routingConditionSchema.optional().nullable(),
  notifyRoles: z.array(z.enum(ROLE_CODES)).max(8).optional(),
}).superRefine((r, ctx) => {
  if (r.kind === 'GUARD' && !r.when) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['when'], message: 'قانونی که انتقال را کنترل می‌کند شرط لازم دارد' });
  if (r.kind === 'NOTIFY' && !r.notifyRoles?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notifyRoles'], message: 'دست‌کم یک نقش برای آگاه‌شدن لازم است' });
});

/** Ordered approval stages with quorum (roadmap #18), as an administrator may edit them. */
export const approvalStageSchema = z.object({
  id: z.string().trim().min(2).max(40).regex(/^[a-z0-9.-]+$/i, 'شناسهٔ مرحله فقط حروف لاتین، رقم، نقطه و خط تیره می‌پذیرد'),
  labelFa: z.string().trim().min(2).max(80),
  roles: z.array(z.enum(ROLE_CODES)).min(1).max(8),
  quorum: z.number().int().min(1).max(10).optional(),
  when: routingConditionSchema.optional(),
});

export const updateApprovalChainSchema = z.object({
  stages: z.array(approvalStageSchema).max(6),
  note: z.string().trim().max(200).optional(),
});

/* ── The form designer (roadmap #15) ───────────────────────────────────── */

/**
 * A field as the designer may write it. ADR-004 says adding a form is a data change rather
 * than a code change; this is the shape that makes that true for somebody who does not write
 * TypeScript. Deliberately the same `FieldDef` the catalogue declares — one renderer, one
 * validator, one truth.
 */
const FIELD_TYPES = [
  'text', 'textarea', 'number', 'currency', 'percent', 'date', 'datetime',
  'select', 'multiselect', 'checkbox', 'user', 'department', 'entityRef', 'attachment', 'table', 'mobile',
] as const;

const fieldOptionSchema = z.object({
  value: z.string().trim().min(1).max(60),
  labelFa: z.string().trim().min(1).max(120),
});

const baseFieldSchema = z.object({
  key: z.string().trim().min(2).max(60).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'کلید فیلد باید با حرف لاتین شروع شود و فقط حرف، رقم و زیرخط داشته باشد'),
  labelFa: z.string().trim().min(1).max(120),
  labelEn: z.string().trim().min(1).max(120),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(fieldOptionSchema).max(60).optional(),
  entity: z.string().trim().max(40).optional(),
  placeholderFa: z.string().trim().max(160).optional(),
  helpFa: z.string().trim().max(240).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  visibleWhen: z.object({
    field: z.string().trim().min(1).max(60),
    equals: z.array(z.string().max(60)).min(1).max(30),
  }).optional(),
});

export const designerFieldSchema = baseFieldSchema.extend({
  columns: z.array(baseFieldSchema).max(20).optional(),
});

/** Structural rules no form may break, whoever is editing it. */
export function checkFieldList(fields: z.infer<typeof designerFieldSchema>[]): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const f of fields) {
    if (keys.has(f.key)) problems.push(`کلید «${f.key}» تکراری است`);
    keys.add(f.key);
    if ((f.type === 'select' || f.type === 'multiselect') && !f.options?.length) {
      problems.push(`فیلد «${f.labelFa}» از نوع انتخابی است و باید دست‌کم یک گزینه داشته باشد`);
    }
    if (f.type === 'table' && !f.columns?.length) problems.push(`جدول «${f.labelFa}» باید دست‌کم یک ستون داشته باشد`);
    if (f.type === 'entityRef' && !f.entity) problems.push(`فیلد «${f.labelFa}» باید بگوید به کدام موجودیت اشاره می‌کند`);
    if (f.options?.length) {
      const values = new Set(f.options.map((o) => o.value));
      if (values.size !== f.options.length) problems.push(`گزینه‌های تکراری در «${f.labelFa}»`);
    }
  }
  for (const f of fields) {
    if (f.visibleWhen && !keys.has(f.visibleWhen.field)) {
      problems.push(`فیلد «${f.labelFa}» به فیلدی وابسته است که در این فرم نیست: ${f.visibleWhen.field}`);
    }
    if (f.visibleWhen?.field === f.key) problems.push(`فیلد «${f.labelFa}» نمی‌تواند به خودش وابسته باشد`);
  }
  return problems;
}

export const updateFormSchemaSchema = z.object({
  fields: z.array(designerFieldSchema).min(1).max(80),
  note: z.string().trim().max(200).optional(),
});

/** A form an organisation adds for itself, outside the Doc_H catalogue. */
export const createFormDefinitionSchema = z.object({
  code: z.string().trim().min(3).max(60).regex(/^[A-Z][A-Z0-9_]*$/, 'کد فرم با حرف بزرگ لاتین شروع می‌شود و فقط حرف بزرگ، رقم و زیرخط می‌پذیرد'),
  nameFa: z.string().trim().min(2).max(120),
  nameEn: z.string().trim().min(2).max(120),
  category: z.string().trim().min(1).max(2),
  module: z.string().trim().min(2).max(40),
  senderDepts: z.array(z.enum(DEPARTMENT_CODES)).max(12).default([]),
  receiverDepts: z.array(z.enum(DEPARTMENT_CODES)).max(12).default([]),
  approverRoles: z.array(z.enum(ROLE_CODES)).max(8).default([]),
  slaCode: z.string().trim().max(60).nullish(),
  nextProcessFa: z.string().trim().max(200).nullish(),
  fields: z.array(designerFieldSchema).min(1).max(80),
});

export const updateFormDefinitionSchema = z.object({
  nameFa: z.string().trim().min(2).max(120).optional(),
  nameEn: z.string().trim().min(2).max(120).optional(),
  senderDepts: z.array(z.enum(DEPARTMENT_CODES)).max(12).optional(),
  receiverDepts: z.array(z.enum(DEPARTMENT_CODES)).max(12).optional(),
  approverRoles: z.array(z.enum(ROLE_CODES)).max(8).optional(),
  slaCode: z.string().trim().max(60).nullish(),
  nextProcessFa: z.string().trim().max(200).nullish(),
  isActive: z.boolean().optional(),
});

/* ── unit tag colours (Hivamis task 9) ─────────────────────────────────────── */

/** A unit's tag colour; null returns it to the default. Stored lower case. */
export const unitColorSchema = z.object({
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'رنگ باید به شکل #RRGGBB باشد').transform((v) => v.toLowerCase()).nullable(),
});

/* ── signing in and joining (Hivamis task 4) ─────────────────────────────────── */

/** A one-time code as typed: six digits, Persian or Latin. */
const otpCode = z.string().trim().transform((v) => v.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))))
  .pipe(z.string().regex(/^\d{6}$/, 'کد شش رقم است'));

export const phoneStartSchema = z.object({ phone: iranMobileSchema });
export const phoneVerifySchema = z.object({ phone: iranMobileSchema, code: otpCode });

/** Asking to join with a mobile proved by its code. The administrator decides the rest. */
export const signupSchema = z.object({
  fullName: z.string().trim().min(3, 'نام و نام خانوادگی را کامل بنویسید').max(120),
  email: z.string().trim().toLowerCase().email('ایمیل معتبر نیست').max(200),
  phone: iranMobileSchema,
  code: otpCode,
  departmentCode: z.enum(DEPARTMENT_CODES).nullish(),
  note: z.string().trim().max(500).nullish(),
});

/** Approving a request: the administrator gives the unit and the roles (Hivamis task 6) — never system administration. */
export const approveSignupSchema = z.object({
  departmentCode: z.enum(DEPARTMENT_CODES),
  roles: z.array(z.enum(ROLE_CODES)).min(1, 'دست‌کم یک نقش لازم است').max(4)
    .refine((r) => !r.includes('SUPER_ADMIN'), 'نقش مدیر سیستم با درخواست عضویت داده نمی‌شود؛ آن را در مدیریت کاربران بدهید'),
  jobTitle: z.string().trim().max(120).nullish(),
});
export const rejectSignupSchema = z.object({ note: z.string().trim().min(3, 'دلیل را بنویسید').max(500) });
export const signupSettingsSchema = z.object({ enabled: z.boolean() });

/** A first password, for someone who joined with a mobile or Google and never had one. */
export const setPasswordSchema = z.object({ newPassword: changePasswordSchema.shape.newPassword });

/* ── the chat assistant (Hivamis task 5) ─────────────────────────────────────── */

/**
 * `GET /ai/chat/status` (audit F-1): whether the assistant can answer, what model answers, and its
 * load. The model runs inside the installation, so its size and where it sits say how fast it can be.
 */
export interface ChatModelStatus {
  mode: 'off' | 'ollama';
  ready: boolean;
  model: string | null;
  reachable: boolean;
  modelPresent: boolean;
  /** From the model store: e.g. "8.2B", "Q4_K_M", and its size on disk. Null when unknown. */
  parameterSize: string | null;
  quantization: string | null;
  sizeBytes: number | null;
  /** In memory now, how much of it in GPU memory, and until when it stays loaded. */
  loaded: boolean;
  vramBytes: number | null;
  loadedUntil: string | null;
  /** Answers being written, and questions waiting their turn. */
  busy: number;
  waiting: number;
}

export const chatRequestSchema = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().trim().min(1, 'پیامی بنویسید').max(4000),
  /** Where the person is: the page, and the record on it, if any — "this project" means it. */
  context: z.object({
    path: z.string().max(200).nullish(),
    entity: z.string().max(40).nullish(),
    id: z.string().uuid().nullish(),
    title: z.string().max(200).nullish(),
  }).nullish(),
});
