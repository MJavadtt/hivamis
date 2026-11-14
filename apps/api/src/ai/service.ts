import Anthropic from '@anthropic-ai/sdk';
import { canSee, reachOf, type VisibleModel } from '../auth/visibility.js';
import { prisma } from '../db.js';
import { aiEnabled, env } from '../env.js';
import { forbidden, notFound } from '../lib/errors.js';
import { briefCompleteness } from '../workflow/guards.js';

export type AiCapability =
  | 'BRIEF_ANALYSIS' | 'PROJECT_SUMMARY' | 'RISK_DETECTION' | 'STATUS_REPORT_DRAFT'
  | 'CHANGE_IMPACT_ANALYSIS' | 'QC_COMPARISON' | 'CUSTOMER_HEALTH' | 'NEXT_BEST_ACTION' | 'FREE_QUERY';

export interface AiActor {
  id: string;
  organizationId: string;
  departmentCode: string | null;
  permissions: string[];
  roles: string[];
}

export interface AiResult {
  capability: AiCapability;
  /** True when a language model produced the narrative; false when only deterministic analysis ran. */
  modelUsed: boolean;
  model: string | null;
  /** Deterministic, rule-derived findings — always present, never hallucinated. */
  findings: { severity: 'INFO' | 'WARNING' | 'CRITICAL'; labelFa: string; detailFa: string }[];
  /** Records the analysis was grounded in; shown to the user so every claim is checkable. */
  grounding: { entity: string; id: string; label: string }[];
  narrative: string | null;
  disabledReason?: string;
}

/**
 * Every capability declares the permission its data requires. The AI layer can never widen a
 * user's reach: it reads through the same permission checks a human request would face,
 * and each call is written to `ai_interactions` for audit.
 */
const CAPABILITY_PERMISSION: Record<AiCapability, string> = {
  BRIEF_ANALYSIS: 'brief.read',
  PROJECT_SUMMARY: 'project.read',
  RISK_DETECTION: 'project.read',
  STATUS_REPORT_DRAFT: 'project.read',
  CHANGE_IMPACT_ANALYSIS: 'change.read',
  QC_COMPARISON: 'qc.read',
  CUSTOMER_HEALTH: 'crm.company.read',
  NEXT_BEST_ACTION: 'project.read',
  FREE_QUERY: 'ai.use',
};

const SYSTEM_PROMPT = `شما دستیار عملیاتی «هیوامیس» هستید؛ سیستم‌عامل سازمانی یک آژانس تبلیغاتی.

قواعد:
- فقط بر اساس داده‌های ارائه‌شده در بخش «داده» پاسخ دهید. اگر داده کافی نیست، صریح بگویید «داده کافی نیست».
- هرگز عدد، تاریخ، نام یا وضعیتی که در داده نیامده است نسازید.
- پاسخ کوتاه، عملیاتی و به زبان فارسی باشد.
- شما اجازه تغییر داده یا تأیید هیچ فرآیندی را ندارید؛ فقط تحلیل و پیشنهاد ارائه می‌کنید.
- قوانین حاکم بر فرآیند (تفکیک Sales/Account، سه سطح QC، کنترل تغییرات، مجوز شروع پروژه) را در تحلیل رعایت کنید.`;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!aiEnabled) return null;
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

/** The record each analysis reads. */
const ENTITY_OF: Partial<Record<AiCapability, VisibleModel>> = {
  BRIEF_ANALYSIS: 'brief', PROJECT_SUMMARY: 'project', RISK_DETECTION: 'project', STATUS_REPORT_DRAFT: 'project',
  NEXT_BEST_ACTION: 'project', CHANGE_IMPACT_ANALYSIS: 'changeRequest', QC_COMPARISON: 'deliverable', CUSTOMER_HEALTH: 'company',
};

export async function runAi(
  capability: AiCapability,
  entityId: string | undefined,
  question: string | undefined,
  actor: AiActor,
): Promise<AiResult> {
  if (!actor.permissions.includes('ai.use')) {
    throw forbidden('دسترسی استفاده از دستیار هوش مصنوعی را ندارید.');
  }
  const required = CAPABILITY_PERMISSION[capability];
  if (!actor.permissions.includes(required)) {
    throw forbidden(`این تحلیل نیازمند دسترسی «${required}» است.`);
  }

  // ADR-127: an analysis of a record the caller does not see is as absent as the record.
  const model = ENTITY_OF[capability];
  if (model && entityId && !(await canSee(model, await reachOf(actor), entityId))) throw notFound('رکورد');

  const started = Date.now();
  const context = await gatherContext(capability, entityId, actor);

  let narrative: string | null = null;
  let modelUsed = false;
  let error: string | null = null;

  const anthropic = getClient();
  if (anthropic) {
    try {
      const message = await anthropic.messages.create({
        model: env.AI_MODEL,
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `تحلیل مورد نیاز: ${capability}\n${question ? `پرسش کاربر: ${question}\n` : ''}\nداده:\n${JSON.stringify(context.data, null, 2)}`,
        }],
      });
      narrative = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text).join('\n').trim();
      modelUsed = true;
      await record(actor, capability, entityId, narrative, context, Date.now() - started, true, null,
        message.usage.input_tokens, message.usage.output_tokens);
    } catch (e) {
      error = e instanceof Error ? e.message : 'AI request failed';
      await record(actor, capability, entityId, null, context, Date.now() - started, false, error);
    }
  } else {
    await record(actor, capability, entityId, null, context, Date.now() - started, true, 'model disabled');
  }

  return {
    capability,
    modelUsed,
    model: modelUsed ? env.AI_MODEL : null,
    findings: context.findings,
    grounding: context.grounding,
    narrative,
    disabledReason: anthropic
      ? (error ? `فراخوانی مدل ناموفق بود: ${error}` : undefined)
      : 'مدل زبانی پیکربندی نشده است — تحلیل قاعده‌محور ارائه شده است.',
  };
}

interface Context {
  data: Record<string, unknown>;
  findings: AiResult['findings'];
  grounding: AiResult['grounding'];
}

/**
 * Builds the grounding set for a capability. Everything here is deterministic: the findings
 * are computed from the database, so they remain correct and citable even with no model available.
 */
async function gatherContext(
  capability: AiCapability,
  entityId: string | undefined,
  actor: AiActor,
): Promise<Context> {
  const findings: AiResult['findings'] = [];
  const grounding: AiResult['grounding'] = [];
  const now = new Date();

  switch (capability) {
    case 'BRIEF_ANALYSIS': {
      if (!entityId) throw notFound('بریف');
      const brief = await prisma.brief.findFirst({ where: { id: entityId, organizationId: actor.organizationId }, include: { opportunity: { include: { company: true } } },
      });
      if (!brief) throw notFound('بریف');
      grounding.push({ entity: 'brief', id: brief.id, label: brief.code });

      const { score, missing } = briefCompleteness(brief as unknown as Record<string, unknown>);
      if (missing.length) {
        findings.push({
          severity: score < 50 ? 'CRITICAL' : 'WARNING',
          labelFa: 'بریف ناقص است',
          detailFa: `موارد ناقص: ${missing.join('، ')}. طبق نقطه کنترل Doc_H بریف ناقص باید به فروش بازگردد.`,
        });
      }
      if (brief.returnCount > 0) {
        findings.push({
          severity: 'WARNING', labelFa: 'سابقه بازگشت بریف',
          detailFa: `این بریف ${brief.returnCount} بار به فروش بازگردانده شده است.`,
        });
      }
      if (brief.desiredDeadline && brief.desiredDeadline < new Date(Date.now() + 14 * 86_400_000)) {
        findings.push({
          severity: 'WARNING', labelFa: 'زمان‌بندی فشرده',
          detailFa: 'مهلت مشتری کمتر از دو هفته است؛ ظرفیت واحدها باید پیش از Kick-off بررسی شود.',
        });
      }
      return { data: { brief, completenessScore: score, missing }, findings, grounding };
    }

    case 'PROJECT_SUMMARY':
    case 'RISK_DETECTION':
    case 'STATUS_REPORT_DRAFT':
    case 'NEXT_BEST_ACTION': {
      if (!entityId) throw notFound('پروژه');
      const project = await prisma.project.findFirst({ where: { id: entityId, organizationId: actor.organizationId },
        include: {
          company: { select: { legalName: true } },
          accountOwner: { select: { fullName: true } },
          authorizations: true, closureChecklist: true,
          milestones: { orderBy: { dueDate: 'asc' } },
        },
      });
      if (!project) throw notFound('پروژه');
      grounding.push({ entity: 'project', id: project.id, label: project.code });

      const [tasks, deliverables, revisions, changeRequests, risks, issues, slas] = await Promise.all([
        prisma.task.findMany({ where: { projectId: entityId } }),
        prisma.deliverable.findMany({ where: { projectId: entityId } }),
        prisma.revision.findMany({ where: { deliverable: { projectId: entityId } } }),
        prisma.changeRequest.findMany({ where: { projectId: entityId } }),
        prisma.risk.findMany({ where: { projectId: entityId, state: 'OPEN' } }),
        prisma.issue.findMany({ where: { projectId: entityId, state: { in: ['OPEN', 'IN_PROGRESS'] } } }),
        prisma.slaClock.findMany({
          where: { entityId, state: { in: ['AT_RISK', 'BREACHED'] } }, include: { policy: true },
        }),
      ]);

      const overdue = tasks.filter(
        (t) => t.dueDate && t.dueDate < now && !['APPROVED', 'CLOSED', 'CANCELLED'].includes(t.state),
      );
      if (overdue.length) {
        findings.push({
          severity: overdue.length > 2 ? 'CRITICAL' : 'WARNING',
          labelFa: `${overdue.length} وظیفه سررسید گذشته`,
          detailFa: overdue.slice(0, 5).map((t) => `${t.code} — ${t.title}`).join('؛ '),
        });
      }
      if (project.state === 'ACTIVE' && project.authorizations.length === 0) {
        findings.push({
          severity: 'CRITICAL', labelFa: 'نقض قانون ۱۳ — پروژه بدون مجوز شروع',
          detailFa: 'پروژه در وضعیت اجرا است اما هیچ مجوز شروع معتبری ثبت نشده است.',
        });
      }
      if (project.plannedEnd && project.plannedEnd < now && !['COMPLETED', 'CLOSED'].includes(project.state)) {
        findings.push({
          severity: 'CRITICAL', labelFa: 'تأخیر نسبت به برنامه',
          detailFa: `تاریخ پایان برنامه‌ریزی‌شده (${project.plannedEnd.toISOString().slice(0, 10)}) گذشته است.`,
        });
      }
      const openOutOfScope = changeRequests.filter(
        (c) => c.scopeVerdict === 'OUT_OF_SCOPE' && !['CLOSED', 'REJECTED'].includes(c.state),
      );
      if (openOutOfScope.length) {
        findings.push({
          severity: 'WARNING', labelFa: `${openOutOfScope.length} درخواست تغییر خارج از Scope باز`,
          detailFa: 'تا پیش از تأیید مشتری، اجرای این تغییرات مجاز نیست (قانون ۸).',
        });
      }
      if (slas.length) {
        findings.push({
          severity: slas.some((s) => s.state === 'BREACHED') ? 'CRITICAL' : 'WARNING',
          labelFa: `${slas.length} SLA در خطر یا نقض‌شده`,
          detailFa: slas.map((s) => s.policy.labelFa).join('، '),
        });
      }
      if (revisions.filter((r) => !['APPROVED', 'REJECTED'].includes(r.state)).length > 2) {
        findings.push({
          severity: 'WARNING', labelFa: 'تعدد اصلاحیه‌های باز',
          detailFa: 'چرخه اصلاح در حال طولانی شدن است؛ بررسی ریشه‌ای کیفیت توصیه می‌شود.',
        });
      }

      return {
        data: {
          project: {
            code: project.code, name: project.name, state: project.state,
            company: project.company.legalName, accountOwner: project.accountOwner.fullName,
            plannedStart: project.plannedStart, plannedEnd: project.plannedEnd,
            authorized: project.authorizations.length > 0,
          },
          milestones: project.milestones,
          counts: {
            tasks: tasks.length, overdueTasks: overdue.length,
            deliverables: deliverables.length,
            deliverablesAccepted: deliverables.filter((d) => d.state === 'ACCEPTED').length,
            openRevisions: revisions.filter((r) => !['APPROVED', 'REJECTED'].includes(r.state)).length,
            openChangeRequests: changeRequests.filter((c) => !['CLOSED', 'REJECTED'].includes(c.state)).length,
            openRisks: risks.length, openIssues: issues.length,
          },
          risks: risks.map((r) => ({ title: r.title, probability: r.probability, impact: r.impact })),
          issues: issues.map((i) => ({ title: i.title, severity: i.severity })),
          closureChecklist: project.closureChecklist,
        },
        findings, grounding,
      };
    }

    case 'CHANGE_IMPACT_ANALYSIS': {
      if (!entityId) throw notFound('درخواست تغییر');
      const cr = await prisma.changeRequest.findFirst({ where: { id: entityId, organizationId: actor.organizationId },
        include: { project: { select: { id: true, code: true, name: true, inScope: true, outOfScope: true, contractValue: true, plannedEnd: true } } },
      });
      if (!cr) throw notFound('درخواست تغییر');
      grounding.push({ entity: 'changeRequest', id: cr.id, label: cr.code });

      const dims = {
        timeImpactDays: 'اثر زمانی', costImpact: 'اثر هزینه‌ای', resourceImpact: 'اثر بر منابع',
        scopeImpact: 'اثر بر Scope', qualityImpact: 'اثر بر کیفیت', contractImpact: 'اثر بر قرارداد',
      } as const;
      const missing = Object.entries(dims)
        .filter(([k]) => (cr as Record<string, any>)[k] == null)
        .map(([, v]) => v);
      if (cr.scopeVerdict === 'UNDETERMINED') {
        findings.push({
          severity: 'CRITICAL', labelFa: 'بررسی Scope انجام نشده',
          detailFa: 'طبق قانون ۸، ابتدا باید مشخص شود درخواست داخل یا خارج از Scope است.',
        });
      }
      if (cr.scopeVerdict === 'OUT_OF_SCOPE' && missing.length) {
        findings.push({
          severity: 'CRITICAL', labelFa: 'ارزیابی اثر ناقص',
          detailFa: `ابعاد ارزیابی‌نشده: ${missing.join('، ')}. تا تکمیل این موارد ارسال به مشتری مجاز نیست.`,
        });
      }
      return { data: { changeRequest: cr, missingImpactDimensions: missing }, findings, grounding };
    }

    case 'QC_COMPARISON': {
      if (!entityId) throw notFound('خروجی');
      const deliverable = await prisma.deliverable.findFirst({ where: { id: entityId, organizationId: actor.organizationId },
        include: {
          project: { select: { id: true, code: true, inScope: true, outOfScope: true, brief: true } },
          qcReviews: { orderBy: { reviewedAt: 'desc' } },
          revisions: { orderBy: { createdAt: 'desc' } },
        },
      });
      if (!deliverable) throw notFound('خروجی');
      grounding.push({ entity: 'deliverable', id: deliverable.id, label: deliverable.code });

      const unitPass = deliverable.qcReviews.find((q) => q.level === 'UNIT' && q.verdict === 'PASSED');
      const accountPass = deliverable.qcReviews.find((q) => q.level === 'ACCOUNT' && q.verdict === 'PASSED');
      if (!unitPass) {
        findings.push({
          severity: 'WARNING', labelFa: 'QC سطح ۱ ثبت نشده',
          detailFa: 'واحد اجرایی باید پیش از تحویل، QC داخلی خود را ثبت کند (قانون ۹).',
        });
      }
      if (!accountPass) {
        findings.push({
          severity: 'INFO', labelFa: 'QC سطح ۲ در انتظار',
          detailFa: 'تحویل به مشتری بدون تأیید QC اکانت مجاز نیست.',
        });
      }
      if (deliverable.revisions.length >= 3) {
        findings.push({
          severity: 'WARNING', labelFa: 'چرخه اصلاح تکرارشونده',
          detailFa: `${deliverable.revisions.length} اصلاحیه روی این خروجی ثبت شده است.`,
        });
      }
      return {
        data: {
          deliverable: { code: deliverable.code, name: deliverable.name, state: deliverable.state },
          brief: deliverable.project.brief,
          scope: { inScope: deliverable.project.inScope, outOfScope: deliverable.project.outOfScope },
          qcReviews: deliverable.qcReviews,
          revisions: deliverable.revisions.map((r) => ({ reason: r.reason, correction: r.requiredCorrection })),
        },
        findings, grounding,
      };
    }

    case 'CUSTOMER_HEALTH': {
      if (!entityId) throw notFound('مشتری');
      const company = await prisma.company.findFirst({ where: { id: entityId, organizationId: actor.organizationId },
        include: {
          projects: { where: { deletedAt: null } },
          opportunities: { where: { deletedAt: null } },
        },
      });
      if (!company) throw notFound('مشتری');
      grounding.push({ entity: 'company', id: company.id, label: company.legalName });

      const feedbacks = await prisma.feedback.findMany({
        where: { project: { companyId: entityId } }, orderBy: { createdAt: 'desc' },
      });
      const avgCsat = feedbacks.length ? feedbacks.reduce((s, f) => s + f.csat, 0) / feedbacks.length : null;

      if (avgCsat != null && avgCsat < 3.5) {
        findings.push({
          severity: 'CRITICAL', labelFa: 'رضایت پایین مشتری',
          detailFa: `میانگین CSAT برابر ${avgCsat.toFixed(1)} از ۵ است.`,
        });
      }
      const stale = company.opportunities.filter(
        (o) => !['WON', 'LOST'].includes(o.state) &&
          o.updatedAt < new Date(Date.now() - 30 * 86_400_000),
      );
      if (stale.length) {
        findings.push({
          severity: 'WARNING', labelFa: `${stale.length} فرصت راکد`,
          detailFa: 'بیش از ۳۰ روز بدون به‌روزرسانی — پیگیری فروش لازم است.',
        });
      }
      if (company.projects.length > 0 && company.opportunities.filter((o) => !['WON', 'LOST'].includes(o.state)).length === 0) {
        findings.push({
          severity: 'INFO', labelFa: 'فرصت فعالی وجود ندارد',
          detailFa: 'برای این مشتری هیچ فرصت بازی ثبت نشده — فرصت Cross-sell / Up-sell بررسی شود.',
        });
      }
      return {
        data: {
          company: { legalName: company.legalName, industry: company.industry, healthScore: company.healthScore },
          projects: company.projects.map((p) => ({ code: p.code, name: p.name, state: p.state })),
          opportunities: company.opportunities.map((o) => ({ code: o.code, title: o.title, state: o.state, value: o.estimatedValue })),
          feedback: { count: feedbacks.length, avgCsat, latest: feedbacks[0] ?? null },
        },
        findings, grounding,
      };
    }

    default: {
      // FREE_QUERY — scoped to the caller's own work so the model never sees anything they cannot open.
      const [tasks, projects] = await Promise.all([
        prisma.task.findMany({
          where: {
            organizationId: actor.organizationId, assigneeId: actor.id,
            state: { notIn: ['CLOSED', 'CANCELLED'] },
          },
          select: { code: true, title: true, state: true, dueDate: true }, take: 40,
        }),
        prisma.project.findMany({
          where: {
            organizationId: actor.organizationId, deletedAt: null,
            state: { notIn: ['CLOSED', 'CANCELLED'] },
            OR: [{ accountOwnerId: actor.id }, { tasks: { some: { assigneeId: actor.id } } }],
          },
          select: { code: true, name: true, state: true, plannedEnd: true }, take: 20,
        }),
      ]);
      return { data: { myTasks: tasks, myProjects: projects }, findings, grounding };
    }
  }
}

async function record(
  actor: AiActor, capability: string, entityId: string | undefined,
  narrative: string | null, context: Context, latencyMs: number,
  succeeded: boolean, errorMessage: string | null,
  tokensIn?: number, tokensOut?: number,
): Promise<void> {
  await prisma.aiInteraction.create({
    data: {
      organizationId: actor.organizationId, userId: actor.id, capability,
      entityType: context.grounding[0]?.entity ?? null, entityId: entityId ?? null,
      model: aiEnabled ? env.AI_MODEL : 'rule-engine',
      promptSummary: `${capability}${entityId ? ` :: ${entityId}` : ''}`,
      responseText: narrative?.slice(0, 8000) ?? null,
      groundingRefs: context.grounding as object,
      tokensIn: tokensIn ?? null, tokensOut: tokensOut ?? null,
      latencyMs, succeeded, errorMessage,
    },
  }).catch(() => undefined);
}
