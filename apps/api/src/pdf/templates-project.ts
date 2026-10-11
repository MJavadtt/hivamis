import { prisma } from '../db.js';
import { notFound } from '../lib/errors.js';
import type { AccessTokenClaims } from '../auth/tokens.js';
import { guard, redactionFor } from './access.js';
import { chip, date, dateTime, deptFa, esc, field, money, num, percent, stateFa, table, text, yesNo } from './fmt.js';
import { docHeader, routingBand, ruleNote, section, signatures, stateTrail } from './sections.js';
import { billedOf } from '../finance/revenue.js';
import type { BuiltDocument } from './templates.js';

/* ══════════════════════════ Project 360 ══════════════════════════ */

export async function buildProject(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const p = await prisma.project.findFirst({ where: { id, organizationId: orgId },
    include: {
      company: { select: { legalName: true } },
      accountOwner: { select: { fullName: true } },
      authorizations: { orderBy: { authorizedAt: 'desc' } },
      milestones: { orderBy: { dueDate: 'asc' } },
      deliverables: { orderBy: { dueDate: 'asc' } },
      workOrders: { orderBy: { deadline: 'asc' } },
      raciAssignments: true,
      changeRequests: { orderBy: { createdAt: 'asc' } },
      risks: { where: { state: { not: 'CLOSED' } }, include: { owner: { select: { fullName: true } } } },
      issues: { where: { state: { notIn: ['RESOLVED', 'CLOSED'] } }, include: { owner: { select: { fullName: true } } } },
      decisions: { orderBy: { decidedAt: 'asc' }, include: { decidedBy: { select: { fullName: true } } } },
      invoices: true,
      payments: true,
      tasks: { select: { state: true, dueDate: true } },
      contracts: { select: { code: true, contractNumber: true, contractValue: true, state: true } },
    },
  });
  if (!p || p.organizationId !== orgId) throw notFound('پروژه');
  const red = redactionFor(user);

  const invoiced = p.invoices.reduce((s, i) => s + Number(i.total), 0);
  const received = p.payments.filter((x) => x.direction === 'IN').reduce((s, x) => s + Number(x.amount), 0);
  const spent = p.payments.filter((x) => x.direction === 'OUT').reduce((s, x) => s + Number(x.amount), 0);
  const openTasks = p.tasks.filter((t) => !['CLOSED', 'CANCELLED', 'APPROVED'].includes(t.state)).length;
  const overdue = p.tasks.filter(
    (t) => t.dueDate && t.dueDate < new Date() && !['CLOSED', 'CANCELLED', 'APPROVED'].includes(t.state),
  ).length;

  const html = [
    docHeader({ title: `پرونده پروژه — ${p.name}`, code: p.code, subtitle: p.company.legalName, state: p.state }),
    routingBand([
      ['مشتری', esc(p.company.legalName)],
      ['مالک اکانت', esc(p.accountOwner.fullName)],
      ['وضعیت سلامت', chip(p.healthStatus)],
      ['شروع برنامه‌ریزی‌شده', date(p.plannedStart)],
      ['پایان برنامه‌ریزی‌شده', date(p.plannedEnd)],
      // One LTR run, so the pair keeps the order its label promises.
      ['وظایف باز / معوق', `<span class="num">${num(openTasks)} / ${num(overdue)}</span>`],
    ]),
    p.authorizations.length === 0 && !['DRAFT', 'PENDING_AUTHORIZATION', 'CANCELLED'].includes(p.state)
      ? ruleNote('برای این پروژه مجوز شروع ثبت نشده است. طبق بند ۱۳ «قوانین و دستورالعمل حاکم بر فرآیند اجرای پروژه‌ها»، هیچ پروژه‌ای بدون قرارداد معتبر، سفارش رسمی یا دستور اجرای فاکتوری نباید وارد اجرای رسمی شود.')
      : '',
    section('تعریف پروژه', [
      field('هدف', text(p.objective)),
      field('داخل Scope', text(p.inScope)),
      field('خارج از Scope', text(p.outOfScope)),
    ].join('')),
    p.authorizations.length
      ? section('مجوز شروع اجرا', table(['مبنا', 'سند مرجع', 'تاریخ صدور', 'وضعیت'],
          p.authorizations.map((a) => [
            chip(a.basis), esc(a.referenceDocument), dateTime(a.authorizedAt),
            a.revokedAt ? chip('CANCELLED') : chip('APPROVED'),
          ])))
      : '',
    p.raciAssignments.length
      ? section('ماتریس RACI', table(['فعالیت', 'واحد', 'نقش'],
          p.raciAssignments.map((r) => [esc(r.activity), esc(deptFa(r.departmentCode)), `<span class="chip">${esc(r.raciRole)}</span>`])))
      : '',
    p.milestones.length
      ? section('نقاط عطف', table(['عنوان', 'تاریخ', 'وضعیت'],
          p.milestones.map((m) => [esc(m.name), date(m.dueDate), m.completedAt ? chip('COMPLETED') : chip('PLANNED')])))
      : '',
    p.deliverables.length
      ? section('خروجی‌ها', table(['کد', 'عنوان', 'واحد', 'مهلت', 'وضعیت'],
          p.deliverables.map((d) => [esc(d.code), esc(d.name), esc(deptFa(d.departmentCode)), date(d.dueDate), chip(d.state)])))
      : '',
    p.workOrders.length
      ? section('سفارش‌های کار', table(['کد', 'واحد', 'عنوان', 'مهلت', 'بودجه', 'وضعیت'],
          p.workOrders.map((w) => [
            esc(w.code), esc(deptFa(w.targetDepartmentCode)), esc(w.title), date(w.deadline),
            guard(red.cost, w.budget, money), chip(w.state),
          ])))
      : '',
    p.changeRequests.length
      ? section('درخواست‌های تغییر', table(['کد', 'عنوان', 'Scope', 'اثر هزینه', 'اثر زمان (روز)', 'وضعیت'],
          p.changeRequests.map((c) => [
            esc(c.code), esc(c.title), chip(c.scopeVerdict),
            guard(red.price, c.costImpact, money), num(c.timeImpactDays), chip(c.state),
          ])))
      : '',
    p.risks.length
      ? section('ریسک‌های باز', table(['کد', 'عنوان', 'احتمال', 'اثر', 'مسئول'],
          p.risks.map((r) => [esc(r.code), esc(r.title), chip(r.probability), chip(r.impact), esc(r.owner.fullName)])))
      : '',
    p.issues.length
      ? section('مسائل باز', table(['کد', 'عنوان', 'شدت', 'مسئول', 'مهلت رفع'],
          p.issues.map((i) => [esc(i.code), esc(i.title), chip(i.severity), esc(i.owner.fullName), date(i.targetResolution)])))
      : '',
    p.decisions.length
      ? section('تصمیمات', table(['تاریخ', 'عنوان', 'تصمیم‌گیرنده'],
          p.decisions.map((d) => [date(d.decidedAt), esc(d.title), esc(d.decidedBy.fullName)])))
      : '',
    section('وضعیت مالی', red.finance || red.price
      ? table(['عنوان', 'مبلغ'], [
          ['ارزش قرارداد', money(p.contractValue)],
          ['بودجه برنامه‌ریزی‌شده', guard(red.cost, p.plannedBudget, money)],
          ['جمع فاکتورشده', money(invoiced)],
          ['جمع دریافتی', money(received)],
          ['جمع پرداختی (هزینه)', guard(red.cost, spent, money)],
          ['مانده مطالبات', money(invoiced - received)],
        ])
      : '<p class="redacted">محرمانه — خارج از سطح دسترسی</p>'),
    await stateTrail('project', p.id),
    signatures(['مدیر پروژه / اکانت', 'واحد عملیات / PMO', 'تأیید مدیریت']),
  ].join('');

  return { html, code: p.code, titleFa: 'پرونده پروژه', redaction: red };
}

/* ══════════════════════════ Customer 360 ══════════════════════════ */

export async function buildCompany(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const c = await prisma.company.findFirst({ where: { id, organizationId: orgId },
    include: {
      contacts: { where: { deletedAt: null } },
      accountOwner: { select: { fullName: true } },
      salesOwner: { select: { fullName: true } },
      opportunities: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } },
      projects: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } },
      contracts: { orderBy: { startDate: 'desc' } },
      invoices: true,
    },
  });
  if (!c || c.organizationId !== orgId) throw notFound('مشتری');
  const red = redactionFor(user);

  const feedbacks = await prisma.feedback.findMany({
    where: { project: { companyId: id } },
    include: { project: { select: { code: true, name: true } } },
    orderBy: { createdAt: 'desc' }, take: 20,
  });

  const invoiced = c.invoices.reduce((s, i) => s + Number(i.total), 0);
  const paid = c.invoices.reduce((s, i) => s + Number(i.paidAmount), 0);

  const html = [
    docHeader({ title: `پرونده مشتری — ${c.legalName}`, code: c.nationalId ?? undefined, subtitle: c.industry ?? undefined }),
    routingBand([
      ['نام برند', text(c.brandName)],
      ['صنعت', text(c.industry)],
      ['مالک اکانت', esc(c.accountOwner?.fullName ?? '—')],
      ['مالک فروش', esc(c.salesOwner?.fullName ?? '—')],
      ['شناسه ملی', text(c.nationalId)],
      ['کد اقتصادی', text(c.economicCode)],
    ]),
    c.contacts.length
      ? section('مخاطبین', table(['نام', 'سمت', 'تلفن', 'ایمیل', 'اصلی'],
          c.contacts.map((x) => [esc(x.fullName), text(x.jobTitle), text(x.phone), text(x.email), yesNo(x.isPrimary)])))
      : '',
    c.opportunities.length
      ? section('فرصت‌های فروش', table(['کد', 'عنوان', 'ارزش تخمینی', 'وضعیت'],
          c.opportunities.map((o) => [esc(o.code), esc(o.title), guard(red.price, o.estimatedValue, money), chip(o.state)])))
      : '',
    c.projects.length
      ? section('پروژه‌ها', table(['کد', 'نام', 'شروع', 'پایان', 'وضعیت'],
          c.projects.map((p) => [esc(p.code), esc(p.name), date(p.plannedStart), date(p.plannedEnd), chip(p.state)])))
      : '',
    c.contracts.length
      ? section('قراردادها', table(['شماره', 'عنوان', 'مبلغ', 'شروع', 'پایان', 'وضعیت'],
          c.contracts.map((k) => [
            esc(k.contractNumber ?? k.code), esc(k.title),
            guard(red.price || red.finance, k.contractValue, money),
            date(k.startDate), date(k.endDate), chip(k.state),
          ])))
      : '',
    section('خلاصه مالی', red.finance
      ? table(['عنوان', 'مبلغ'], [
          ['جمع فاکتورشده', money(invoiced)],
          ['جمع دریافتی', money(paid)],
          ['مانده مطالبات', money(invoiced - paid)],
        ])
      : '<p class="redacted">محرمانه — خارج از سطح دسترسی</p>'),
    feedbacks.length
      ? section('بازخورد مشتری', table(['پروژه', 'CSAT', 'NPS', 'تاریخ'],
          feedbacks.map((f) => [esc(f.project.code), num(f.csat), num(f.nps), date(f.createdAt)])))
      : '',
    signatures(['مالک اکانت', 'مدیر اکانت', 'تأیید مدیریت']),
  ].join('');

  return { html, code: c.legalName.slice(0, 40), titleFa: 'پرونده مشتری', redaction: red };
}

/* ══════════════════════════ smaller records ══════════════════════════ */

export async function buildWorkOrder(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const w = await prisma.workOrder.findFirst({ where: { id, organizationId: orgId },
    include: {
      project: { select: { code: true, name: true, company: { select: { legalName: true } } } },
      owner: { select: { fullName: true } },
      tasks: { include: { assignee: { select: { fullName: true } } } },
      costDeclarations: true,
    },
  });
  if (!w || w.organizationId !== orgId) throw notFound('سفارش کار');
  const red = redactionFor(user);

  const html = [
    docHeader({ title: `سفارش کار — ${w.title}`, code: w.code, subtitle: `${w.project.code} — ${w.project.name}`, state: w.state }),
    routingBand([
      ['واحد مقصد', esc(deptFa(w.targetDepartmentCode))],
      ['مسئول', esc(w.owner.fullName)],
      ['مهلت', date(w.deadline)],
      ['اولویت', chip(w.priority)],
      ['بودجه', guard(red.cost, w.budget, money)],
      ['تاریخ پذیرش', dateTime(w.acceptedAt)],
    ]),
    section('مشخصات سفارش', [
      field('شرح کار', text(w.scopeOfWork)),
      field('بریف', text(w.brief)),
      field('خروجی مورد انتظار', text(w.expectedOutput)),
      field('فرمت خروجی', text(w.outputFormat)),
      field('منابع مورد نیاز', text(w.requiredResources)),
    ].join('')),
    w.clarificationNote ? section('ابهام اعلام‌شده', `<p>${esc(w.clarificationNote)}</p>`) : '',
    w.tasks.length
      ? section('وظایف', table(['کد', 'عنوان', 'مسئول', 'مهلت', 'وضعیت'],
          w.tasks.map((t) => [esc(t.code), esc(t.title), esc(t.assignee?.fullName ?? '—'), date(t.dueDate), chip(t.state)])))
      : '',
    red.cost && w.costDeclarations.length
      ? section('قیمت تمام‌شده اعلامی', table(['واحد', 'هزینه داخلی', 'هزینه خارجی'],
          w.costDeclarations.map((c) => [esc(deptFa(c.departmentCode)), money(c.internalCost), money(c.externalCost)])))
      : '',
    await stateTrail('workOrder', w.id),
    signatures(['صادرکننده (اکانت)', 'پذیرنده (مدیر واحد)', 'تأیید تحویل']),
  ].join('');

  return { html, code: w.code, titleFa: 'سفارش کار', redaction: red };
}

export async function buildQcReview(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const q = await prisma.qcReview.findFirst({ where: { id, organizationId: orgId },
    include: {
      reviewer: { select: { fullName: true, jobTitle: true } },
      deliverable: { select: { code: true, name: true } },
      proposal: { select: { code: true, title: true } },
      revisions: true,
    },
  });
  if (!q || q.organizationId !== orgId) throw notFound('کنترل کیفیت');
  const red = redactionFor(user);

  const checklist = (q.checklist ?? {}) as Record<string, boolean>;
  const CHECK_FA: Record<string, string> = {
    matchesBrief: 'تطابق با بریف', matchesScope: 'تطابق با Scope',
    matchesKickoff: 'تطابق با تصمیمات Kick-off', deliverablesComplete: 'کامل بودن خروجی‌ها',
    costReviewed: 'بررسی قیمت تمام‌شده', technicallySound: 'صحت فنی',
    brandCompliant: 'مطابقت با هویت بصری', completeDeliverable: 'کامل بودن',
    proposalComplete: 'کامل بودن پروپوزال', pricingReviewed: 'بررسی قیمت',
    qualityAcceptable: 'کیفیت قابل قبول', clientReady: 'آماده ارائه به مشتری',
  };

  const html = [
    docHeader({
      title: `فرم کنترل کیفیت — سطح ${stateFa(q.level)}`, code: q.code,
      subtitle: q.deliverable ? `${q.deliverable.code} — ${q.deliverable.name}` : q.proposal?.title ?? undefined,
      state: q.verdict,
    }),
    routingBand([
      ['سطح QC', chip(q.level)],
      ['نتیجه', chip(q.verdict)],
      ['بازبین', esc(q.reviewer.fullName)],
      ['سمت', text(q.reviewer.jobTitle)],
      ['تاریخ بازبینی', dateTime(q.reviewedAt)],
      ['اصلاحیه صادرشده', num(q.revisions.length)],
    ]),
    section('چک‌لیست', Object.keys(checklist).length
      ? table(['بند', 'نتیجه'], Object.entries(checklist).map(([k, v]) => [esc(CHECK_FA[k] ?? k), yesNo(v)]))
      : '<p class="empty">چک‌لیستی ثبت نشده است.</p>'),
    q.findings ? section('یافته‌ها', `<p>${esc(q.findings)}</p>`) : '',
    q.verdict === 'FAILED'
      ? ruleNote('طبق بند ۱۰ «قوانین و دستورالعمل حاکم»، خروجی تأییدنشده باید با فرم اصلاحیه و ذکر علت به واحد مسئول بازگردد؛ هیچ اصلاحی بدون ثبت درخواست و علت مجاز نیست.')
      : '',
    signatures(['بازبین', 'مدیر واحد', 'تأیید اکانت']),
  ].join('');

  return { html, code: q.code, titleFa: 'کنترل کیفیت', redaction: red };
}

export async function buildRevision(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const r = await prisma.revision.findFirst({ where: { id, organizationId: orgId },
    include: {
      assignee: { select: { fullName: true } },
      deliverable: { select: { code: true, name: true } },
      qcReview: { select: { code: true, level: true, findings: true } },
    },
  });
  if (!r || r.organizationId !== orgId) throw notFound('اصلاحیه');
  const red = redactionFor(user);

  const html = [
    docHeader({
      title: 'فرم اصلاحیه', code: r.code,
      subtitle: r.deliverable ? `${r.deliverable.code} — ${r.deliverable.name}` : undefined, state: r.state,
    }),
    routingBand([
      ['علت اصلاح', chip(r.reason)],
      ['واحد مسئول', esc(deptFa(r.responsibleDepartmentCode))],
      ['مسئول اجرا', esc(r.assignee?.fullName ?? '—')],
      ['مهلت', date(r.dueDate)],
      ['دور اصلاح', num(r.round)],
      ['QC مرجع', esc(r.qcReview?.code ?? '—')],
    ]),
    section('اصلاح مورد انتظار', `<p>${esc(r.requiredCorrection)}</p>`),
    r.qcReview?.findings ? section('یافته‌های کنترل کیفیت', `<p>${esc(r.qcReview.findings)}</p>`) : '',
    r.rejectNote ? section('دلیل رد اصلاح', `<p>${esc(r.rejectNote)}</p>`) : '',
    await stateTrail('revision', r.id),
    signatures(['صادرکننده (اکانت)', 'مجری اصلاح', 'تأیید مجدد QC']),
  ].join('');

  return { html, code: r.code, titleFa: 'اصلاحیه', redaction: red };
}

export async function buildChangeRequest(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const c = await prisma.changeRequest.findFirst({ where: { id, organizationId: orgId },
    include: {
      project: { select: { code: true, name: true, company: { select: { legalName: true } } } },
      amendments: true,
    },
  });
  if (!c || c.organizationId !== orgId) throw notFound('درخواست تغییر');
  const red = redactionFor(user);

  const assessed = c.impactAssessedAt != null;

  const html = [
    docHeader({ title: `درخواست تغییر — ${c.title}`, code: c.code, subtitle: `${c.project.code} — ${c.project.name}`, state: c.state }),
    routingBand([
      ['مشتری', esc(c.project.company.legalName)],
      ['درخواست‌کننده', chip(c.requestedBy)],
      ['تاریخ درخواست', date(c.requestedDate)],
      ['اولویت', chip(c.priority)],
      ['نتیجه بررسی Scope', chip(c.scopeVerdict)],
      ['تصمیم مشتری', c.customerDecision ? chip(c.customerDecision) : '—'],
    ]),
    section('شرح تغییر درخواستی', `<p>${esc(c.requestedChange)}</p>`),
    c.scopeRationale ? section('مبنای تعیین Scope', `<p>${esc(c.scopeRationale)}</p>`) : '',
    c.scopeVerdict === 'OUT_OF_SCOPE' && !assessed
      ? ruleNote('این درخواست خارج از Scope است و هنوز ارزیابی اثر آن ثبت نشده. طبق بند ۸ «قوانین و دستورالعمل حاکم»، پیش از اجرا باید اثر تغییر بر زمان، هزینه، منابع، Scope، کیفیت و قرارداد مشخص شود.')
      : '',
    assessed
      ? section('ارزیابی اثر تغییر (بند ۸)', table(['بُعد', 'اثر'], [
          ['زمان (روز)', num(c.timeImpactDays)],
          ['هزینه', guard(red.price, c.costImpact, money)],
          ['منابع', text(c.resourceImpact)],
          ['Scope', text(c.scopeImpact)],
          ['کیفیت', text(c.qualityImpact)],
          ['قرارداد', text(c.contractImpact)],
          ['قیمت پیشنهادی به مشتری', guard(red.price, c.proposedPrice, money)],
        ]))
      : '',
    c.amendments.length
      ? section('الحاقیه‌های مرتبط', table(['شماره', 'تاریخ اجرا', 'تغییر مبلغ'],
          c.amendments.map((a) => [esc(a.amendmentNumber), date(a.effectiveDate), guard(red.price, a.valueDelta, money)])))
      : '',
    c.rejectReason ? section('دلیل رد', `<p>${esc(c.rejectReason)}</p>`) : '',
    await stateTrail('changeRequest', c.id),
    signatures(['اکانت', 'تأیید تجاری / مدیریت', 'تأیید مشتری']),
  ].join('');

  return { html, code: c.code, titleFa: 'درخواست تغییر', redaction: red };
}

export async function buildDeliverable(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const d = await prisma.deliverable.findFirst({ where: { id, organizationId: orgId },
    include: {
      project: { select: { code: true, name: true } },
      qcReviews: { include: { reviewer: { select: { fullName: true } } }, orderBy: { reviewedAt: 'asc' } },
      revisions: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!d || d.organizationId !== orgId) throw notFound('خروجی');
  const red = redactionFor(user);

  const html = [
    docHeader({ title: `خروجی — ${d.name}`, code: d.code, subtitle: `${d.project.code} — ${d.project.name}`, state: d.state }),
    routingBand([
      ['واحد مسئول', esc(deptFa(d.departmentCode))],
      ['نسخه', esc(d.version)],
      ['فرمت', text(d.format)],
      ['مهلت', date(d.dueDate)],
      ['تاریخ تحویل', dateTime(d.deliveredAt)],
      ['تأیید مشتری', dateTime(d.acceptedAt)],
    ]),
    section('شرح', `<p>${text(d.description)}</p>`),
    d.qcReviews.length
      ? section('کنترل کیفیت', table(['سطح', 'نتیجه', 'بازبین', 'تاریخ', 'یافته‌ها'],
          d.qcReviews.map((q) => [chip(q.level), chip(q.verdict), esc(q.reviewer.fullName), dateTime(q.reviewedAt), text(q.findings)])))
      : '',
    d.revisions.length
      ? section('اصلاحیه‌ها', table(['کد', 'علت', 'دور', 'مهلت', 'وضعیت'],
          d.revisions.map((r) => [esc(r.code), chip(r.reason), num(r.round), date(r.dueDate), chip(r.state)])))
      : '',
    await stateTrail('deliverable', d.id),
    signatures(['واحد اجرایی', 'QC اکانت', 'تأیید مشتری']),
  ].join('');

  return { html, code: d.code, titleFa: 'خروجی', redaction: red };
}

export async function buildStatusReport(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const r = await prisma.statusReport.findFirst({ where: { id, organizationId: orgId },
    include: { project: { select: { code: true, name: true, company: { select: { legalName: true } } } } },
  });
  if (!r || r.organizationId !== orgId) throw notFound('گزارش وضعیت');
  const red = redactionFor(user);

  const html = [
    docHeader({ title: `گزارش وضعیت پروژه — ${r.project.name}`, code: r.code, subtitle: r.project.company.legalName }),
    routingBand([
      ['پروژه', esc(r.project.code)],
      ['دوره گزارش', esc(r.period)],
      ['تاریخ تهیه', dateTime(r.createdAt)],
    ]),
    section('گزارش', [
      field('وضعیت پیشرفت', text(r.progress)),
      field('فعالیت‌های انجام‌شده', text(r.completed)),
      field('فعالیت‌های در حال انجام', text(r.inProgress)),
      field('فعالیت‌های بعدی', text(r.next)),
      field('وضعیت Timeline', text(r.timelineStatus)),
      field('ریسک‌ها', text(r.risks)),
      field('مشکلات', text(r.issues)),
      field('تصمیمات مورد نیاز', text(r.decisionsNeeded)),
      field('وضعیت مالی', guard(red.finance, r.financialStatus, text)),
    ].join('')),
    signatures(['تهیه‌کننده (اکانت)', 'تأیید مدیر اکانت', 'دریافت‌کننده']),
  ].join('');

  return { html, code: r.code, titleFa: 'گزارش وضعیت', redaction: red };
}

export async function buildMeeting(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const m = await prisma.meeting.findFirst({ where: { id, organizationId: orgId },
    include: {
      project: { select: { code: true, name: true } },
      company: { select: { legalName: true } },
    },
  });
  if (!m || m.organizationId !== orgId) throw notFound('صورتجلسه');
  const red = redactionFor(user);

  const actions = (m.actions ?? []) as { action: string; ownerName?: string; dueDate?: string }[];

  const html = [
    docHeader({
      title: `صورتجلسه — ${m.subject}`, code: m.code,
      subtitle: m.project ? `${m.project.code} — ${m.project.name}` : m.company?.legalName ?? undefined,
      state: m.kind,
    }),
    routingBand([
      ['نوع جلسه', chip(m.kind)],
      ['زمان برگزاری', dateTime(m.heldAt)],
      ['ثبت صورتجلسه', dateTime(m.minutesRecordedAt ?? m.createdAt)],
    ]),
    section('حاضرین', `<p>${esc(m.attendees)}</p>`),
    m.agenda ? section('دستور جلسه', `<p>${esc(m.agenda)}</p>`) : '',
    m.decisions ? section('تصمیمات', `<p>${esc(m.decisions)}</p>`) : '',
    actions.length
      ? section('اقدامات', table(['اقدام', 'مسئول', 'مهلت'],
          actions.map((a) => [esc(a.action), esc(a.ownerName ?? '—'), date(a.dueDate)])))
      : '',
    signatures(['تنظیم‌کننده', 'تأییدکننده', 'حاضرین']),
  ].join('');

  return { html, code: m.code, titleFa: 'صورتجلسه', redaction: red };
}

/* ══════════════════════════ closure report (Doc_H §15) ══════════════════════════ */

export async function buildClosureReport(id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const p = await prisma.project.findFirst({ where: { id, organizationId: orgId },
    include: {
      company: { select: { legalName: true } },
      accountOwner: { select: { fullName: true } },
      closureChecklist: true,
      feedbacks: true,
      lessonsLearned: true,
      deliverables: true,
      invoices: true,
      payments: true,
      changeRequests: true,
      tasks: { select: { state: true } },
    },
  });
  if (!p || p.organizationId !== orgId) throw notFound('پروژه');
  const red = redactionFor(user);

  const cl = p.closureChecklist;
  const CONDITIONS: [string, boolean][] = [
    ['تمام خروجی‌ها تحویل شده', cl?.allDeliverablesDelivered ?? false],
    ['QC نهایی انجام شده', cl?.finalQcDone ?? false],
    ['تأیید مشتری ثبت شده', cl?.clientApprovalRecorded ?? false],
    ['گزارش پایان پروژه تکمیل شده', cl?.closureReportDone ?? false],
    ['وضعیت مالی مشخص شده', cl?.financialStatusClear ?? false],
    ['Feedback مشتری ثبت شده', cl?.feedbackRecorded ?? false],
    ['Lessons Learned ثبت شده', cl?.lessonsLearnedRecorded ?? false],
    ['پروژه در سیستم بسته شده', cl?.closedInSystem ?? false],
  ];
  const met = CONDITIONS.filter(([, v]) => v).length;

  const invoiced = p.invoices.reduce((s, i) => s + Number(i.total), 0);
  const received = p.payments.filter((x) => x.direction === 'IN').reduce((s, x) => s + Number(x.amount), 0);
  const spent = p.payments.filter((x) => x.direction === 'OUT').reduce((s, x) => s + Number(x.amount), 0);
  // The margin on what was earned: VAT is owed to the state, and pass-through is the vendor's (audit CALC-1).
  const earned = p.invoices.filter((i) => i.kind === 'INVOICE' && i.state !== 'CANCELLED').reduce((s, i) => s + billedOf(i, false), 0);
  const margin = earned > 0 ? ((earned - spent) / earned) * 100 : null;

  const html = [
    docHeader({ title: `گزارش پایان پروژه — ${p.name}`, code: p.code, subtitle: p.company.legalName, state: p.state }),
    routingBand([
      ['مشتری', esc(p.company.legalName)],
      ['مالک اکانت', esc(p.accountOwner.fullName)],
      ['شروع واقعی', date(p.actualStart)],
      ['پایان واقعی', date(p.actualEnd)],
      ['شرایط بستن', `<span class="num">${num(met)} / ${num(8)}</span>`],
      ['تاریخ بستن', date(p.closedAt)],
    ]),
    met < 8
      ? ruleNote(`${8 - met} شرط از هشت شرط بند ۱۵ «قوانین و دستورالعمل حاکم» هنوز محقق نشده است؛ تا تکمیل همه شروط، پروژه قابل بستن نیست.`)
      : '',
    section('چک‌لیست بستن پروژه (بند ۱۵)', table(['شرط', 'وضعیت'],
      CONDITIONS.map(([label, ok]) => [esc(label), ok ? '<span class="chip chip-ok">✓ محقق</span>' : '<span class="chip chip-bad">✗ محقق نشده</span>']))),
    section('خروجی‌ها', table(['کد', 'عنوان', 'وضعیت'],
      p.deliverables.map((d) => [esc(d.code), esc(d.name), chip(d.state)]))),
    section('عملکرد', table(['شاخص', 'مقدار'], [
      ['تعداد خروجی', num(p.deliverables.length)],
      ['خروجی تأییدشده توسط مشتری', num(p.deliverables.filter((d) => d.state === 'ACCEPTED').length)],
      ['تعداد درخواست تغییر', num(p.changeRequests.length)],
      ['تعداد وظایف', num(p.tasks.length)],
    ])),
    section('گزارش مالی نهایی', red.finance
      ? table(['عنوان', 'مبلغ'], [
          ['ارزش قرارداد', money(p.contractValue)],
          ['جمع فاکتورشده', money(invoiced)],
          ['جمع دریافتی', money(received)],
          ['جمع هزینه', guard(red.cost, spent, money)],
          ['مانده مطالبات', money(invoiced - received)],
          ['حاشیه سود', margin === null ? '—' : percent(margin)],
        ])
      : '<p class="redacted">محرمانه — خارج از سطح دسترسی</p>'),
    p.feedbacks.length
      ? section('بازخورد مشتری', table(['CSAT', 'NPS', 'نقاط قوت', 'نقاط بهبود'],
          p.feedbacks.map((f) => [num(f.csat), num(f.nps), text(f.positives), text(f.improvements)])))
      : '',
    p.lessonsLearned.length
      ? section('درس‌آموخته‌ها', table(['عنوان', 'دسته', 'درس', 'توصیه'],
          p.lessonsLearned.map((l) => [esc(l.title), chip(l.category), esc(l.lesson), esc(l.recommendation)])))
      : '',
    await stateTrail('project', p.id),
    signatures(['مالک اکانت', 'واحد مالی', 'تأیید مدیریت']),
  ].join('');

  return { html, code: `${p.code}-CLOSURE`, titleFa: 'گزارش پایان پروژه', redaction: red };
}
