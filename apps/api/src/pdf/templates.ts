import type { FormDef } from '@hiva/contracts';
import { prisma } from '../db.js';
import { schemaForSubmission } from '../forms/versions.js';
import { notFound } from '../lib/errors.js';
import type { AccessTokenClaims } from '../auth/tokens.js';
import { type DocumentKind, type RedactionContext, guard, redactionFor, classifyField, PROPOSAL_SANCTIONED_STATES } from './access.js';
import { chip, date, dateTime, deptFa, esc, field, money, num, percent, stateFa, table, text, yesNo } from './fmt.js';
import { docHeader, routingBand, ruleNote, section, signatures, stateTrail } from './sections.js';

export interface BuiltDocument {
  html: string;
  /** Used for the download filename and the header. */
  code: string;
  titleFa: string;
  redaction: RedactionContext;
}

const S = (v: unknown) => (v == null ? undefined : String(v));

/* ══════════════════════════ form submission (all 130 forms) ══════════════════════════ */

/** Render one submitted value according to its declared field type. */
function renderFormValue(f: FormDef['fields'][number], raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '<span class="empty">—</span>';
  switch (f.type) {
    case 'currency': return money(raw);
    case 'percent': return percent(raw);
    case 'number': return `<span class="num">${num(raw)}</span>`;
    case 'date': return date(raw);
    case 'datetime': return dateTime(raw);
    case 'checkbox': return yesNo(raw);
    case 'department': return esc(deptFa(raw));
    case 'select': {
      const opt = f.options?.find((o) => o.value === String(raw));
      return esc(opt?.labelFa ?? stateFa(raw));
    }
    case 'multiselect': {
      const vals = Array.isArray(raw) ? raw : [raw];
      return vals.map((v) => {
        const opt = f.options?.find((o) => o.value === String(v));
        return `<span class="chip">${esc(opt?.labelFa ?? stateFa(v))}</span>`;
      }).join(' ');
    }
    case 'table': {
      const rows = Array.isArray(raw) ? raw : [];
      const cols = f.columns ?? [];
      if (rows.length === 0 || cols.length === 0) return '<span class="empty">—</span>';
      return table(
        cols.map((c) => c.labelFa),
        rows.map((r: Record<string, unknown>) => cols.map((c) => renderFormValue(c, r?.[c.key]))),
      );
    }
    case 'attachment': {
      const files = Array.isArray(raw) ? raw : [raw];
      return files.map((x) => esc(typeof x === 'string' ? x : (x as { fileName?: string })?.fileName ?? '—')).join('، ');
    }
    default: return text(raw);
  }
}

async function buildFormSubmission(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const sub = await prisma.formSubmission.findFirst({ where: { id, organizationId: orgId },
    include: {
      definition: true,
      submittedBy: { select: { fullName: true, jobTitle: true } },
      assignedTo: { select: { fullName: true, jobTitle: true } },
      approvals: { include: { approver: { select: { fullName: true } } }, orderBy: { decidedAt: 'asc' } },
      project: { select: { code: true, name: true } },
      company: { select: { legalName: true } },
    },
  });
  if (!sub || sub.organizationId !== orgId) throw notFound('فرم');

  // The version this submission was filled under. Reading the current catalogue here was the
  // defect: a reworded or removed field changed what every archived form said.
  const fields = await schemaForSubmission(prisma, sub);
  const data = (sub.data ?? {}) as Record<string, unknown>;
  const red = redactionFor(user);

  // A form may legitimately carry cost or price fields; the same redaction order applies here.
  const isCostField = (k: string) => classifyField(k) === 'cost';
  const isPriceField = (k: string) => classifyField(k) === 'price';

  const body = fields.length
    ? fields.map((f) => {
        const raw = data[f.key];
        if (isPriceField(f.key)) return field(f.labelFa, guard(red.price, raw, (v) => renderFormValue(f, v)));
        if (isCostField(f.key)) return field(f.labelFa, guard(red.cost, raw, (v) => renderFormValue(f, v)));
        return field(f.labelFa, renderFormValue(f, raw));
      }).join('')
    : Object.entries(data).map(([k, v]) => field(k, text(v))).join('');

  const slaLabel = sub.definition.slaCode ?? '—';

  const html = [
    docHeader({
      title: sub.definition.nameFa,
      code: sub.code,
      subtitle: `فرم شماره ${num(sub.definition.no)} — دسته ${esc(sub.definition.category)}`,
      state: sub.state,
    }),
    routingBand([
      ['فرستنده', esc(sub.submittedBy.fullName)],
      ['گیرنده', esc(sub.assignedTo?.fullName ?? sub.definition.receiverDepts.map(deptFa).join('، '))],
      ['تأییدکننده', esc(sub.definition.approverRoles.join('، ') || '—')],
      ['SLA', esc(slaLabel)],
      ['تاریخ ثبت', dateTime(sub.submittedAt ?? sub.createdAt)],
      ['فرآیند بعدی', esc(sub.definition.nextProcessFa ?? '—')],
    ]),
    sub.project ? section('پروژه مرتبط', `<p>${esc(sub.project.code)} — ${esc(sub.project.name)}</p>`) : '',
    sub.company ? section('مشتری', `<p>${esc(sub.company.legalName)}</p>`) : '',
    section('محتوای فرم', body || '<p class="empty">فیلدی ثبت نشده است.</p>'),
    sub.approvals.length
      ? section('تأییدها', table(['تاریخ', 'تأییدکننده', 'تصمیم', 'توضیح'],
          sub.approvals.map((a) => [dateTime(a.decidedAt), esc(a.approver.fullName), chip(a.decision), text(a.comment)])))
      : '',
    sub.returnReason ? section('دلیل بازگشت', `<p>${esc(sub.returnReason)}</p>`) : '',
    await stateTrail('formSubmission', sub.id),
    signatures(['امضای فرستنده', 'امضای گیرنده', 'امضای تأییدکننده']),
  ].join('');

  return { html, code: sub.code, titleFa: sub.definition.nameFa, redaction: red };
}

/* ══════════════════════════ brief ══════════════════════════ */

async function buildBrief(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const b = await prisma.brief.findFirst({ where: { id, organizationId: orgId },
    include: { opportunity: { include: { company: { select: { legalName: true } }, owner: { select: { fullName: true } } } } },
  });
  if (!b || b.organizationId !== orgId) throw notFound('بریف');
  const red = redactionFor(user);

  const html = [
    docHeader({ title: `بریف — ${b.title}`, code: b.code, subtitle: b.opportunity.company.legalName, state: b.state }),
    routingBand([
      ['مشتری', esc(b.opportunity.company.legalName)],
      ['فرصت فروش', esc(b.opportunity.code)],
      ['مسئول فروش', esc(b.opportunity.owner?.fullName ?? '—')],
      ['کامل بودن', `<span class="num">${num(b.completenessScore)}</span>٪`],
      ['تعداد بازگشت', num(b.returnCount)],
      ['مهلت مشتری', date(b.desiredDeadline)],
    ]),
    b.completenessScore < 100
      ? ruleNote(`این بریف کامل نیست (${b.completenessScore}٪). طبق نقطه کنترل مرحله A سند «الگوریتم جامع مسیر مشتری»، بریف ناقص باید برای تکمیل به فروش بازگردد.`)
      : '',
    section('اطلاعات بریف', [
      field('هدف کسب‌وکار', text(b.businessObjective)),
      field('مخاطب هدف', text(b.targetAudience)),
      field('Scope درخواستی', text(b.scope)),
      field('خروجی‌های مورد انتظار', text(b.expectedDeliverables)),
      field('بودجه تقریبی مشتری', guard(red.cost, b.budgetRange, money)),
      field('واحدهای درگیر', b.unitsNeeded.map((u) => `<span class="chip">${esc(deptFa(u))}</span>`).join(' ') || '—'),
      field('رقبا و سابقه', text(b.competitorContext)),
      field('محدودیت‌ها', text(b.constraints)),
      field('معیار موفقیت', text(b.successCriteria)),
    ].join('')),
    b.missingItems.length ? section('موارد ناقص', `<ul>${b.missingItems.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`) : '',
    b.returnReason ? section('دلیل آخرین بازگشت', `<p>${esc(b.returnReason)}</p>`) : '',
    await stateTrail('brief', b.id),
    signatures(['تهیه‌کننده (فروش)', 'کنترل‌کننده (اکانت)', 'تأیید نهایی']),
  ].join('');

  return { html, code: b.code, titleFa: 'بریف', redaction: red };
}

/* ══════════════════════════ proposal ══════════════════════════ */

const SANCTIONED = PROPOSAL_SANCTIONED_STATES;

async function buildProposal(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const p = await prisma.proposal.findFirst({ where: { id, organizationId: orgId },
    include: {
      brief: { include: { opportunity: { include: { company: { select: { legalName: true } } } } } },
      costDeclarations: true,
      qcReviews: { include: { reviewer: { select: { fullName: true } } }, orderBy: { reviewedAt: 'asc' } },
    },
  });
  if (!p || p.organizationId !== orgId) throw notFound('پروپوزال');

  // Sales may see the sanctioned price once Final QC has passed — see access.ts.
  const red = redactionFor(user, { proposalSanctioned: SANCTIONED.has(p.state) });

  const html = [
    docHeader({
      title: `پروپوزال — ${p.title}`, code: p.code,
      subtitle: `${p.brief.opportunity.company.legalName} — نسخه ${num(p.version)}`, state: p.state,
    }),
    routingBand([
      ['مشتری', esc(p.brief.opportunity.company.legalName)],
      ['بریف مرجع', esc(p.brief.code)],
      ['قیمت فروش', guard(red.price, p.salePrice, money)],
      ['حاشیه سود', guard(red.price, p.marginPercent, percent)],
      ['قیمت تمام‌شده', guard(red.cost, p.totalCost, money)],
      ['تعداد اصلاح', num(p.revisionCount)],
    ]),
    section('محتوای پروپوزال', [
      field('خلاصه مدیریتی', text(p.executiveSummary)),
      field('رویکرد', text(p.approach)),
      field('خروجی‌ها', text(p.deliverablesSummary)),
      field('زمان‌بندی', text(p.timelineSummary)),
      field('شرایط پرداخت', guard(red.price, p.paymentTerms, text)),
      field('اشل قرارداد', guard(red.price, p.contractScaleBand, text)),
    ].join('')),
    red.cost && p.costDeclarations.length
      ? section('قیمت تمام‌شده به تفکیک واحد', table(
          ['واحد', 'هزینه داخلی', 'هزینه خارجی', 'جمع'],
          p.costDeclarations.map((c) => [
            esc(deptFa(c.departmentCode)), money(c.internalCost), money(c.externalCost),
            money(Number(c.internalCost) + Number(c.externalCost)),
          ])))
      : '',
    red.price && p.pricingRationale ? section('مبنای قیمت‌گذاری', `<p>${esc(p.pricingRationale)}</p>`) : '',
    p.qcReviews.length
      ? section('سوابق کنترل کیفیت', table(['سطح', 'نتیجه', 'بازبین', 'تاریخ', 'یافته‌ها'],
          p.qcReviews.map((q) => [chip(q.level), chip(q.verdict), esc(q.reviewer.fullName), dateTime(q.reviewedAt), text(q.findings)])))
      : '',
    p.clientFeedback ? section('بازخورد مشتری', `<p>${esc(p.clientFeedback)}</p>`) : '',
    await stateTrail('proposal', p.id),
    signatures(['تهیه‌کننده (اکانت)', 'تأیید قیمت‌گذاری', 'تأیید نهایی (QC سطح ۳)']),
  ].join('');

  return { html, code: p.code, titleFa: 'پروپوزال', redaction: red };
}

/* ══════════════════════════ contract ══════════════════════════ */

async function buildContract(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const c = await prisma.contract.findFirst({ where: { id, organizationId: orgId },
    include: {
      company: { select: { legalName: true, nationalId: true, economicCode: true, address: true } },
      amendments: { orderBy: { effectiveDate: 'asc' } },
      project: { select: { code: true, name: true } },
    },
  });
  if (!c || c.organizationId !== orgId) throw notFound('قرارداد');
  const red = redactionFor(user);

  const html = [
    docHeader({ title: `قرارداد — ${c.title}`, code: c.contractNumber ?? c.code, subtitle: c.company.legalName, state: c.state }),
    routingBand([
      ['طرف قرارداد', esc(c.company.legalName)],
      ['شناسه ملی', text(c.company.nationalId)],
      ['مبلغ قرارداد', guard(red.price || red.finance, c.contractValue, money)],
      ['تاریخ شروع', date(c.startDate)],
      ['تاریخ پایان', date(c.endDate)],
      ['پروژه', esc(c.project ? `${c.project.code}` : '—')],
    ]),
    section('مفاد', [
      field('خلاصه Scope', text(c.scopeSummary)),
      field('شرایط پرداخت', guard(red.price || red.finance, c.paymentTerms, text)),
      field('تاریخ امضا', date(c.signedDate)),
      field('تاریخ ثبت', date(c.registeredAt)),
    ].join('')),
    c.legalReviewNote ? section('یادداشت بررسی حقوقی', `<p>${esc(c.legalReviewNote)}</p>`) : '',
    c.amendments.length
      ? section('الحاقیه‌ها', table(['شماره', 'تاریخ اجرا', 'تغییر مبلغ', 'تغییر مدت (روز)', 'شرح'],
          c.amendments.map((a) => [
            esc(a.amendmentNumber), date(a.effectiveDate),
            guard(red.price || red.finance, a.valueDelta, money),
            num(a.durationDeltaDays), esc(a.changes),
          ])))
      : '',
    await stateTrail('contract', c.id),
    signatures(['امضای هیوا', 'امضای کارفرما', 'تأیید واحد حقوقی']),
  ].join('');

  return { html, code: c.contractNumber ?? c.code, titleFa: 'قرارداد', redaction: red };
}

/* ══════════════════════════ invoice ══════════════════════════ */

async function buildInvoice(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const inv = await prisma.invoice.findFirst({ where: { id, organizationId: orgId },
    include: {
      company: { select: { legalName: true, nationalId: true, economicCode: true, address: true } },
      project: { select: { code: true, name: true } },
      payments: { orderBy: { occurredAt: 'asc' } },
    },
  });
  if (!inv || inv.organizationId !== orgId) throw notFound('سند مالی');
  const red = redactionFor(user);

  const lines = (inv.lines ?? []) as { description: string; quantity: number; unitPrice: number }[];

  const html = [
    docHeader({
      title: stateFa(inv.kind), code: inv.number,
      subtitle: `${inv.company.legalName}${inv.project ? ` — ${inv.project.name}` : ''}`, state: inv.state,
    }),
    routingBand([
      ['طرف حساب', esc(inv.company.legalName)],
      ['شناسه ملی', text(inv.company.nationalId)],
      ['کد اقتصادی', text(inv.company.economicCode)],
      ['تاریخ صدور', date(inv.issueDate)],
      ['سررسید', date(inv.dueDate)],
      ['پروژه', esc(inv.project?.code ?? '—')],
    ]),
    section('اقلام', table(
      ['شرح', 'تعداد', 'قیمت واحد', 'جمع'],
      lines.map((l) => [
        esc(l.description), num(l.quantity), money(l.unitPrice), money(Number(l.quantity) * Number(l.unitPrice)),
      ]),
    )),
    section('جمع‌بندی', table(['عنوان', 'مبلغ'], [
      ['جمع اقلام', money(inv.subtotal)],
      [`مالیات (${percent(inv.taxPercent)})`, money(inv.taxAmount)],
      ['<strong>مبلغ نهایی</strong>', `<strong>${money(inv.total)}</strong>`],
      ['پرداخت‌شده', money(inv.paidAmount)],
      ['مانده', money(Number(inv.total) - Number(inv.paidAmount))],
    ])),
    inv.payments.length
      ? section('دریافت‌ها', table(['تاریخ', 'مبلغ', 'روش', 'پیگیری'],
          inv.payments.map((p) => [date(p.occurredAt), money(p.amount), esc(stateFa(p.method)), text(p.reference)])))
      : '',
    inv.notes ? section('توضیحات', `<p>${esc(inv.notes)}</p>`) : '',
    await stateTrail('invoice', inv.id),
    signatures(['واحد مالی', 'تأیید مدیر مالی', 'مهر و امضای شرکت']),
  ].join('');

  return { html, code: inv.number, titleFa: stateFa(inv.kind), redaction: red };
}

export const _internal = { renderFormValue, SANCTIONED };
export { buildFormSubmission, buildBrief, buildProposal, buildContract, buildInvoice, S };
