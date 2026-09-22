import { z } from 'zod';
import {
  DEPARTMENT_CODES, ROLE_CODES, PRIORITY_LEVELS, SEVERITY_LEVELS,
  AUTHORIZATION_BASES, QC_LEVELS, QC_RESULTS, REVISION_REASONS,
  SCOPE_VERDICTS, INVOICE_KINDS, SUPPLIER_KINDS, RACI_ROLES,
} from './enums.js';

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

export const createLeadSchema = z.object({
  name: z.string().trim().min(2).max(160),
  companyName: z.string().trim().min(2).max(200),
  contactName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().email().max(160).optional().or(z.literal('')),
  source: z.enum(['REFERRAL', 'INBOUND', 'OUTBOUND', 'EVENT', 'CAMPAIGN', 'OTHER']),
  estimatedValue: z.coerce.number().min(0).optional(),
  need: z.string().trim().max(2000).optional(),
  ownerId: idSchema.optional(),
});
export const updateLeadSchema = createLeadSchema.partial();

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
}).refine(
  (v) => v.verdict !== 'FAILED' || (v.findings != null && v.findings.trim().length > 0),
  { message: 'در صورت عدم تأیید، ثبت یافته‌ها الزامی است', path: ['findings'] },
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
  occurredAt: z.coerce.date(),
  method: z.enum(['TRANSFER', 'CHEQUE', 'CASH', 'OTHER']).default('TRANSFER'),
  reference: z.string().trim().max(120).optional(),
  description: z.string().trim().max(2000).optional(),
});

/* ── resources & governance ────────────────────────────────────────────────── */

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
});

export const formDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'RETURN']),
  comment: z.string().trim().max(2000).optional(),
}).refine((v) => v.decision === 'APPROVE' || (v.comment && v.comment.trim().length > 0), {
  message: 'برای رد یا بازگشت فرم، ثبت دلیل الزامی است',
  path: ['comment'],
});

/* ── AI ────────────────────────────────────────────────────────────────────── */

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
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in', 'notIn', 'isTrue', 'isFalse', 'isSet', 'isEmpty', 'ltField', 'gtField']),
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
  'select', 'multiselect', 'checkbox', 'user', 'department', 'entityRef', 'attachment', 'table',
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
