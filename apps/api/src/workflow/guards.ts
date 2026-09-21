import type { Tx } from '../db.js';

export interface GuardContext {
  tx: Tx;
  entity: string;
  id: string;
  record: Record<string, any>;
  payload: Record<string, unknown>;
  actorId: string;
}

export interface GuardResult {
  ok: boolean;
  /** Persian explanation shown to the user when the guard blocks the transition. */
  messageFa?: string;
  /** Doc_H clause the guard enforces — surfaced in the API error for traceability. */
  rule?: string;
  details?: unknown;
}

const pass: GuardResult = { ok: true };

/** Fields Doc_H requires a sales brief to carry before Account may accept it. */
const BRIEF_REQUIRED_FIELDS: { key: string; labelFa: string }[] = [
  { key: 'businessObjective', labelFa: 'هدف کسب‌وکار' },
  { key: 'targetAudience', labelFa: 'مخاطب هدف' },
  { key: 'scope', labelFa: 'Scope درخواستی' },
  { key: 'expectedDeliverables', labelFa: 'خروجی‌های مورد انتظار' },
  { key: 'budgetRange', labelFa: 'بودجه تقریبی' },
  { key: 'desiredDeadline', labelFa: 'زمان مورد انتظار' },
];

export function briefCompleteness(brief: Record<string, any>): { score: number; missing: string[] } {
  const missing = BRIEF_REQUIRED_FIELDS.filter((fld) => {
    const v = brief[fld.key];
    return v == null || (typeof v === 'string' && v.trim().length === 0);
  }).map((fld) => fld.labelFa);
  const filled = BRIEF_REQUIRED_FIELDS.length - missing.length;
  return { score: Math.round((filled / BRIEF_REQUIRED_FIELDS.length) * 100), missing };
}

/**
 * Guard registry. Each guard encodes one Doc_H governance rule that RBAC alone cannot express.
 * The workflow engine refuses the transition when a guard returns `ok: false`.
 */
export const GUARDS: Record<string, (c: GuardContext) => Promise<GuardResult>> = {
  /** Doc_H control point A / cycle 1 — an incomplete brief may not be approved. */
  'brief.isComplete': async ({ record }) => {
    const { missing } = briefCompleteness(record);
    return missing.length === 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §A — نقطه کنترل بریف',
          messageFa: `بریف ناقص است و قابل تأیید نیست. موارد ناقص: ${missing.join('، ')}`,
          details: { missing },
        };
  },

  'opportunity.hasApprovedProposal': async ({ tx, id }) => {
    const count = await tx.proposal.count({
      where: { brief: { opportunityId: id }, state: { in: ['CLIENT_APPROVED'] } },
    });
    return count > 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §F — تأیید مشتری',
          messageFa: 'فرصت بدون پروپوزال تأییدشده توسط مشتری قابل بستن به‌عنوان برنده نیست.',
        };
  },

  /** Doc_H §D — Account may integrate only once every unit output has passed Account QC. */
  'proposal.allUnitOutputsAccepted': async ({ tx, id }) => {
    const orders = await tx.workOrder.findMany({
      where: { proposalId: id, state: { not: 'CANCELLED' } },
      select: { id: true, code: true, state: true, targetDepartmentCode: true },
    });
    if (orders.length === 0) {
      return {
        ok: false,
        rule: 'Doc_H §B/C — سفارش به واحدهای اجرایی',
        messageFa: 'هیچ سفارش کاری برای این پروپوزال صادر نشده است.',
      };
    }
    const pending = orders.filter((o) => !['SUBMITTED', 'COMPLETED'].includes(o.state));
    return pending.length === 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §D — تجمیع خروجی واحدها',
          messageFa: `خروجی ${pending.length} واحد هنوز تحویل نشده است: ${pending.map((p) => `${p.targetDepartmentCode} (${p.code})`).join('، ')}`,
          details: { pending },
        };
  },

  /** Doc_H §12 — pricing may not start before every unit declared its cost. */
  'proposal.allCostsDeclared': async ({ tx, id }) => {
    const orders = await tx.workOrder.findMany({
      where: { proposalId: id, state: { not: 'CANCELLED' } },
      select: { id: true, code: true, targetDepartmentCode: true },
    });
    const declared = await tx.costDeclaration.findMany({
      where: { OR: [{ proposalId: id }, { workOrderId: { in: orders.map((o) => o.id) } }] },
      select: { workOrderId: true },
    });
    const declaredSet = new Set(declared.map((d) => d.workOrderId));
    const missing = orders.filter((o) => !declaredSet.has(o.id));
    return missing.length === 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §12 — اعلام قیمت تمام‌شده',
          messageFa: `قیمت تمام‌شده این سفارش‌ها اعلام نشده است: ${missing.map((m) => `${m.targetDepartmentCode} (${m.code})`).join('، ')}`,
          details: { missing },
        };
  },

  'proposal.pricingComplete': async ({ record }) =>
    record.salePrice != null && record.pricedAt != null
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §E — قیمت‌گذاری',
          messageFa: 'قیمت فروش تعیین نشده است؛ ابتدا فرآیند Pricing را تکمیل کنید.',
        },

  /** Doc_H §9 level 3 — the proposal cannot be approved without a passing Final QC. */
  'proposal.finalQcPassed': async ({ tx, id }) => {
    const qc = await tx.qcReview.findFirst({
      where: { proposalId: id, level: 'FINAL' },
      orderBy: { reviewedAt: 'desc' },
    });
    return qc?.verdict === 'PASSED'
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §9 — QC سطح ۳',
          messageFa: 'پروپوزال بدون QC نهایی تأییدشده قابل تصویب نیست.',
        };
  },

  /** Doc_H §12 — the sale price must be approved by management before the proposal is final. */
  'proposal.pricingApproved': async ({ record }) =>
    record.pricingApprovedAt != null
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §12 — تأیید قیمت‌گذاری',
          messageFa: 'قیمت فروش هنوز توسط مقام مجاز تأیید نشده است.',
        },

  /** Doc_H §13 — one of the three authorisation bases must exist and be live. */
  'project.hasValidAuthorizationBasis': async ({ tx, id }) => {
    const auth = await tx.executionAuthorization.findFirst({
      where: { projectId: id, revokedAt: null },
      orderBy: { authorizedAt: 'desc' },
    });
    if (!auth) {
      return {
        ok: false,
        rule: 'Doc_H §13 — شروع اجرای پروژه',
        messageFa: 'مجوز شروع پروژه ثبت نشده است. یکی از سه مبنا لازم است: قرارداد معتبر، سفارش رسمی، یا دستور اجرای فاکتوری.',
      };
    }
    if (auth.basis === 'CONTRACT') {
      if (!auth.contractId) {
        return { ok: false, rule: 'Doc_H §13', messageFa: 'مبنای مجوز «قرارداد» است اما قراردادی ثبت نشده.' };
      }
      const contract = await tx.contract.findUnique({ where: { id: auth.contractId } });
      if (!contract || !['SIGNED', 'REGISTERED'].includes(contract.state)) {
        return {
          ok: false,
          rule: 'Doc_H §13 — قرارداد معتبر',
          messageFa: 'قرارداد مرجع هنوز امضا/ثبت نشده است.',
        };
      }
    }
    if (auth.basis === 'INVOICED_EXECUTION_ORDER' && !auth.invoiceId) {
      return {
        ok: false,
        rule: 'Doc_H §G — پروژه فاکتوری',
        messageFa: 'دستور اجرای فاکتوری باید به یک پیش‌فاکتور/فاکتور متصل باشد.',
      };
    }
    return pass;
  },

  'project.isAuthorized': async ({ tx, id }) => {
    const auth = await tx.executionAuthorization.count({ where: { projectId: id, revokedAt: null } });
    return auth > 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §13 — شروع اجرای پروژه',
          messageFa: 'پروژه بدون مجوز معتبر وارد اجرا نمی‌شود.',
        };
  },

  'project.hasSchedule': async ({ tx, id, record }) => {
    if (record.plannedStart && record.plannedEnd) return pass;
    const milestones = await tx.milestone.count({ where: { projectId: id } });
    return milestones > 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §H — تدوین برنامه اجرایی و Timeline',
          messageFa: 'برنامه زمانی پروژه (تاریخ شروع/پایان یا نقاط عطف) تعریف نشده است.',
        };
  },

  /** Doc_H §H.68 — RACI must exist before execution starts. */
  'project.hasRaci': async ({ tx, id }) => {
    const [responsible, accountable] = await Promise.all([
      tx.raciAssignment.count({ where: { projectId: id, raciRole: 'R' } }),
      tx.raciAssignment.count({ where: { projectId: id, raciRole: 'A' } }),
    ]);
    if (responsible > 0 && accountable > 0) return pass;
    return {
      ok: false,
      rule: 'Doc_H §H — تعیین RACI',
      messageFa: 'ماتریس RACI ناقص است؛ حداقل یک Responsible و یک Accountable لازم است.',
    };
  },

  'project.allDeliverablesAccepted': async ({ tx, id }) => {
    const open = await tx.deliverable.findMany({
      where: { projectId: id, state: { notIn: ['ACCEPTED', 'DELIVERED'] } },
      select: { code: true, name: true, state: true },
    });
    return open.length === 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §J — تکمیل تمام Deliverableها',
          messageFa: `${open.length} خروجی هنوز تحویل/تأیید نشده است: ${open.map((d) => d.name).join('، ')}`,
          details: { open },
        };
  },

  /** Doc_H §15 — all eight closure conditions must hold before a project may be closed. */
  'project.closureChecklistComplete': async ({ tx, id }) => {
    const cl = await tx.closureChecklist.findUnique({ where: { projectId: id } });
    const labels: Record<string, string> = {
      allDeliverablesDelivered: 'تحویل تمام خروجی‌ها',
      finalQcDone: 'انجام QC نهایی',
      clientApprovalRecorded: 'ثبت تأیید مشتری',
      closureReportDone: 'تکمیل گزارش پایان پروژه',
      financialStatusClear: 'مشخص بودن وضعیت مالی',
      feedbackRecorded: 'ثبت Feedback مشتری',
      lessonsLearnedRecorded: 'ثبت Lessons Learned',
    };
    if (!cl) {
      return {
        ok: false,
        rule: 'Doc_H §15 — پایان پروژه',
        messageFa: 'چک‌لیست پایان پروژه ایجاد نشده است.',
        details: { missing: Object.values(labels) },
      };
    }
    const missing = Object.keys(labels).filter((k) => !(cl as Record<string, any>)[k]);
    return missing.length === 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §15 — پایان پروژه',
          messageFa: `پروژه بسته نمی‌شود؛ شرایط تکمیل‌نشده: ${missing.map((k) => labels[k]).join('، ')}`,
          details: { missing: missing.map((k) => labels[k]) },
        };
  },

  /** Doc_H §C — an order form must carry all nine mandatory elements. */
  'workOrder.hasCompleteSpec': async ({ record }) => {
    const required: { key: string; labelFa: string }[] = [
      { key: 'scopeOfWork', labelFa: 'شرح کار' },
      { key: 'brief', labelFa: 'بریف' },
      { key: 'expectedOutput', labelFa: 'خروجی مورد انتظار' },
      { key: 'outputFormat', labelFa: 'فرمت خروجی' },
      { key: 'deadline', labelFa: 'Deadline' },
      { key: 'ownerId', labelFa: 'مسئول' },
    ];
    const missing = required.filter((r) => {
      const v = record[r.key];
      return v == null || (typeof v === 'string' && v.trim().length === 0);
    }).map((r) => r.labelFa);
    return missing.length === 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §C — الزامات فرم سفارش',
          messageFa: `سفارش کار ناقص است. موارد الزامی: ${missing.join('، ')}`,
          details: { missing },
        };
  },

  'workOrder.costDeclared': async ({ tx, id }) => {
    const n = await tx.costDeclaration.count({ where: { workOrderId: id } });
    return n > 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §12 — اعلام قیمت تمام‌شده',
          messageFa: 'تحویل خروجی بدون اعلام قیمت تمام‌شده مجاز نیست.',
        };
  },

  /** Doc_H §9 level 1 — the unit must QC its own output before handing it to Account. */
  'workOrder.unitQcPassed': async ({ tx, id }) => {
    const deliverables = await tx.deliverable.findMany({
      where: { workOrderId: id },
      select: { id: true, name: true },
    });
    if (deliverables.length === 0) {
      const direct = await tx.qcReview.findFirst({
        where: { workOrderId: id, level: 'UNIT', verdict: 'PASSED' },
      });
      return direct
        ? pass
        : {
            ok: false,
            rule: 'Doc_H §9 — QC سطح ۱',
            messageFa: 'QC داخلی واحد ثبت نشده است.',
          };
    }
    const passed = await tx.qcReview.findMany({
      where: { deliverableId: { in: deliverables.map((d) => d.id) }, level: 'UNIT', verdict: 'PASSED' },
      select: { deliverableId: true },
    });
    const ok = new Set(passed.map((p) => p.deliverableId));
    const missing = deliverables.filter((d) => !ok.has(d.id));
    return missing.length === 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §9 — QC سطح ۱',
          messageFa: `QC داخلی واحد برای این خروجی‌ها ثبت نشده است: ${missing.map((m) => m.name).join('، ')}`,
          details: { missing },
        };
  },

  /** Doc_H §D/§9 — nothing goes to the client without a passing Account QC. */
  'deliverable.accountQcPassed': async ({ tx, id }) => {
    const qc = await tx.qcReview.findFirst({
      where: { deliverableId: id, level: 'ACCOUNT' },
      orderBy: { reviewedAt: 'desc' },
    });
    return qc?.verdict === 'PASSED'
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §9 — QC سطح ۲',
          messageFa: 'خروجی بدون تأیید QC اکانت قابل تحویل به مشتری نیست.',
        };
  },

  /** Doc_H §10 — a revision without a recorded reason is invalid. */
  'revision.hasReason': async ({ record }) =>
    typeof record.reason === 'string' && record.reason.trim().length > 0
      && typeof record.requiredCorrection === 'string' && record.requiredCorrection.trim().length > 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §10 — فرآیند اصلاح',
          messageFa: 'اصلاحیه بدون ثبت علت و شرح اصلاح مورد انتظار معتبر نیست.',
        },

  'change.isInScope': async ({ record }) =>
    record.scopeVerdict === 'IN_SCOPE'
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §8 / §I — کنترل تغییرات',
          messageFa: 'این مسیر فقط برای تغییرات داخل Scope است. ابتدا بررسی Scope را ثبت کنید.',
        },

  'change.isOutOfScope': async ({ record }) =>
    record.scopeVerdict === 'OUT_OF_SCOPE'
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §8 / §I — کنترل تغییرات',
          messageFa: 'بررسی تجاری فقط برای تغییرات خارج از Scope انجام می‌شود.',
        },

  /** Doc_H §8 — all six impact dimensions must be assessed before the customer is asked. */
  'change.impactAssessed': async ({ record }) => {
    const labels: Record<string, string> = {
      timeImpactDays: 'اثر زمانی',
      costImpact: 'اثر هزینه‌ای',
      resourceImpact: 'اثر بر منابع',
      scopeImpact: 'اثر بر Scope',
      qualityImpact: 'اثر بر کیفیت',
      contractImpact: 'اثر بر قرارداد',
    };
    const missing = Object.keys(labels).filter((k) => {
      const v = record[k];
      return v == null || (typeof v === 'string' && v.trim().length === 0);
    });
    return missing.length === 0
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §8 — کنترل تغییرات',
          messageFa: `پیش از ارسال به مشتری، اثر تغییر بر این موارد باید مشخص شود: ${missing.map((k) => labels[k]).join('، ')}`,
          details: { missing: missing.map((k) => labels[k]) },
        };
  },

  /**
   * Doc_H §I — an out-of-scope change may only be implemented after the customer approved it.
   * In-scope changes need no customer gate.
   */
  'change.readyForImplementation': async ({ record }) => {
    if (record.scopeVerdict === 'IN_SCOPE') return pass;
    return record.customerDecision === 'APPROVED'
      ? pass
      : {
          ok: false,
          rule: 'Doc_H §I — مدیریت تغییرات',
          messageFa: 'تغییر خارج از Scope بدون تأیید مشتری قابل اجرا نیست.',
        };
  },
};

/**
 * What each guard requires, stated positively — the line a checklist shows next to a tick.
 * A guard's own messageFa only exists on failure, so it cannot label a passing check.
 */
export const GUARD_LABELS: Record<string, string> = {
  'brief.isComplete': 'بریف کامل باشد (Scope، خروجی‌ها، بودجه، زمان)',
  'opportunity.hasApprovedProposal': 'پروپوزال تأییدشده وجود داشته باشد',
  'proposal.allUnitOutputsAccepted': 'خروجی همهٔ واحدها از QC اکانت گذشته باشد',
  'proposal.allCostsDeclared': 'همهٔ واحدها قیمت تمام‌شده را اعلام کرده باشند',
  'proposal.pricingComplete': 'قیمت‌گذاری تکمیل شده باشد',
  'proposal.finalQcPassed': 'QC نهایی با نتیجهٔ قبول ثبت شده باشد',
  'proposal.pricingApproved': 'قیمت فروش به تأیید مدیریت رسیده باشد',
  'project.hasValidAuthorizationBasis': 'مبنای مجوز (قرارداد، پیش‌پرداخت یا تأییدیهٔ مدیریت) معتبر باشد',
  'project.isAuthorized': 'مجوز شروع پروژه صادر شده باشد',
  'project.hasSchedule': 'زمان‌بندی پروژه (شروع و پایان) ثبت شده باشد',
  'project.hasRaci': 'ماتریس RACI تعریف شده باشد',
  'project.allDeliverablesAccepted': 'همهٔ خروجی‌ها پذیرفته شده باشند',
  'project.closureChecklistComplete': 'هر هشت شرط بستن پروژه برقرار باشد',
  'workOrder.hasCompleteSpec': 'سفارش کار هر نه عنصر الزامی را داشته باشد',
  'workOrder.costDeclared': 'قیمت تمام‌شدهٔ واحد اعلام شده باشد',
  'workOrder.unitQcPassed': 'QC سطح ۱ واحد با نتیجهٔ قبول ثبت شده باشد',
  'deliverable.accountQcPassed': 'QC اکانت با نتیجهٔ قبول ثبت شده باشد',
  'revision.hasReason': 'دلیل اصلاحیه ثبت شده باشد',
  'change.isInScope': 'تغییر در محدودهٔ Scope ارزیابی شده باشد',
  'change.isOutOfScope': 'تغییر خارج از Scope ارزیابی شده باشد',
  'change.impactAssessed': 'هر شش بُعد اثر تغییر ارزیابی شده باشد',
  'change.readyForImplementation': 'تأیید مشتری برای تغییر خارج از Scope ثبت شده باشد',
};

/** One guard's verdict, for a checklist: which rule, what it requires, and whether it holds. */
export interface GuardCheck extends GuardResult {
  guard: string;
  labelFa: string;
  /** Present when the guard does not hold but a governed exception covers it (roadmap #7). */
  waived?: { id: string; grantedById: string; reason: string; expiresAt: Date };
}

export interface ActiveWaiver { id: string; guard: string; action: string | null; grantedById: string; reason: string; expiresAt: Date }

/** The waivers that could apply to a transition of this record right now: unexpired, unused, unrevoked. */
export async function activeWaivers(tx: Tx, entity: string, id: string, action?: string): Promise<ActiveWaiver[]> {
  const now = new Date();
  const rows = await tx.waiver.findMany({
    where: {
      entityType: entity, entityId: id, usedAt: null, revokedAt: null, expiresAt: { gt: now },
      ...(action ? { OR: [{ action: null }, { action }] } : {}),
    },
    select: { id: true, guard: true, action: true, grantedById: true, reason: true, expiresAt: true },
    orderBy: { grantedAt: 'asc' },
  });
  return rows;
}

/**
 * Run every guard and report every verdict — the checklist behind "why can't I?". Enforcement
 * uses `runGuards`, which stops at the first failure; a person deciding what to do next needs
 * all of them, or they fix one thing, click again, and discover the next.
 */
export async function runAllGuards(
  guardIds: readonly string[] | undefined,
  ctx: GuardContext,
  waivers: readonly ActiveWaiver[] = [],
): Promise<GuardCheck[]> {
  const checks: GuardCheck[] = [];
  for (const gid of guardIds ?? []) {
    const guard = GUARDS[gid];
    const labelFa = GUARD_LABELS[gid] ?? gid;
    if (!guard) {
      checks.push({ guard: gid, labelFa, ok: false, rule: gid, messageFa: `قانون کنترلی «${gid}» تعریف نشده است.` });
      continue;
    }
    const result = await guard(ctx);
    const waiver = result.ok ? undefined : waivers.find((w) => w.guard === gid);
    checks.push(waiver
      ? { guard: gid, labelFa, ok: true, rule: result.rule, messageFa: result.messageFa, waived: { id: waiver.id, grantedById: waiver.grantedById, reason: waiver.reason, expiresAt: waiver.expiresAt } }
      : { guard: gid, labelFa, ...result });
  }
  return checks;
}

/**
 * Enforcement: stops at the first failing guard. A failing guard covered by an active waiver is
 * treated as holding — and the waiver is reported back so the caller can consume it: a waiver is
 * good for one use, which is what keeps an exception an exception.
 */
export async function runGuards(
  guardIds: readonly string[] | undefined,
  ctx: GuardContext,
  waivers: readonly ActiveWaiver[] = [],
): Promise<GuardResult & { usedWaivers: ActiveWaiver[] }> {
  const usedWaivers: ActiveWaiver[] = [];
  for (const gid of guardIds ?? []) {
    const guard = GUARDS[gid];
    if (!guard) {
      return { ok: false, rule: gid, messageFa: `قانون کنترلی «${gid}» تعریف نشده است.`, usedWaivers };
    }
    const result = await guard(ctx);
    if (!result.ok) {
      const waiver = waivers.find((w) => w.guard === gid);
      if (!waiver) return { ...result, usedWaivers };
      usedWaivers.push(waiver);
    }
  }
  return { ...pass, usedWaivers };
}
