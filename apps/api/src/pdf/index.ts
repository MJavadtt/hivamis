import { prisma } from '../db.js';
import { badRequest } from '../lib/errors.js';
import type { AccessTokenClaims } from '../auth/tokens.js';
import { DOCUMENT_POLICIES, type DocumentKind, redactionFor } from './access.js';
import { chip, date, dateTime, deptFa, esc, money, num, percent, table } from './fmt.js';
import { docHeader, routingBand, section } from './sections.js';
import {
  buildBrief, buildContract, buildFormSubmission, buildInvoice, buildProposal, type BuiltDocument,
} from './templates.js';
import { money as decimal, sumOf } from '../lib/money.js';
import {
  buildChangeRequest, buildClosureReport, buildCompany, buildDeliverable, buildMeeting,
  buildProject, buildQcReview, buildRevision, buildStatusReport, buildWorkOrder,
} from './templates-project.js';

export type { DocumentKind, BuiltDocument };
export { DOCUMENT_POLICIES };

/* ══════════════════════════ executive portfolio report ══════════════════════════ */

async function buildExecutiveReport(_id: string, orgId: string, user: AccessTokenClaims): Promise<BuiltDocument> {
  const red = redactionFor(user);
  const now = new Date();

  // Totals from the database, and only the projects the document lists (audit PERF-4): every invoice and
  // payment of every year was read to add them up.
  const [projects, byState, opportunities, invoiceSum, paymentSums, overdueTasks, breachedSlas, openRisks] = await Promise.all([
    prisma.project.findMany({
      where: { organizationId: orgId, deletedAt: null },
      include: { company: { select: { legalName: true } }, accountOwner: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' }, take: 60,
    }),
    prisma.project.groupBy({ by: ['state'], where: { organizationId: orgId, deletedAt: null }, _count: { _all: true } }),
    prisma.opportunity.groupBy({ by: ['state'], where: { organizationId: orgId, deletedAt: null }, _count: { _all: true }, _sum: { estimatedValue: true } }),
    prisma.invoice.aggregate({ where: { organizationId: orgId }, _sum: { total: true } }),
    prisma.payment.groupBy({ by: ['direction'], where: { organizationId: orgId }, _sum: { amount: true } }),
    prisma.task.count({
      where: {
        organizationId: orgId, dueDate: { lt: now },
        state: { notIn: ['CLOSED', 'CANCELLED', 'APPROVED'] },
      },
    }),
    prisma.slaClock.count({ where: { organizationId: orgId, state: 'BREACHED' } }),
    prisma.risk.count({ where: { organizationId: orgId, state: { not: 'CLOSED' } } }),
  ]);

  const countOf = (states: string[]) => byState.filter((r) => states.includes(r.state)).reduce((s, r) => s + r._count._all, 0);
  const activeCount = countOf(['ACTIVE', 'PLANNING', 'AUTHORIZED']);
  const totalProjects = byState.reduce((s, r) => s + r._count._all, 0);
  const invoicedD = decimal(invoiceSum._sum.total);
  const receivedD = decimal(paymentSums.find((p) => p.direction === 'IN')?._sum.amount);
  const invoiced = invoicedD.toNumber(), received = receivedD.toNumber();
  const spent = decimal(paymentSums.find((p) => p.direction === 'OUT')?._sum.amount).toNumber();
  const pipeline = sumOf(opportunities.filter((o) => !['WON', 'LOST'].includes(o.state)).map((o) => o._sum.estimatedValue)).toNumber();
  const won = opportunities.filter((o) => o.state === 'WON').reduce((s, o) => s + o._count._all, 0);
  const decided = opportunities.filter((o) => ['WON', 'LOST'].includes(o.state)).reduce((s, o) => s + o._count._all, 0);

  const html = [
    docHeader({ title: 'گزارش مدیریتی — برج کنترل', subtitle: `تاریخ تهیه: ${dateTime(now)}` }),
    routingBand([
      ['پروژه‌های فعال', num(activeCount)],
      ['کل پروژه‌ها', num(totalProjects)],
      ['وظایف معوق', num(overdueTasks)],
      ['SLAهای نقض‌شده', num(breachedSlas)],
      ['ریسک‌های باز', num(openRisks)],
      ['نرخ برد', decided ? percent((won / decided) * 100) : '—'],
    ]),
    section('خلاصه مالی', red.finance
      ? table(['شاخص', 'مقدار'], [
          ['ارزش خط لوله فروش', money(pipeline)],
          ['جمع فاکتورشده', money(invoiced)],
          ['جمع دریافتی', money(received)],
          ['مانده مطالبات', money(invoicedD.sub(receivedD).toNumber())],
          ['جمع هزینه پرداختی', red.cost ? money(spent) : '<span class="redacted">محرمانه</span>'],
        ])
      : '<p class="redacted">محرمانه — خارج از سطح دسترسی</p>'),
    section('وضعیت پرتفوی پروژه‌ها', table(
      ['کد', 'پروژه', 'مشتری', 'مالک اکانت', 'سلامت', 'وضعیت'],
      projects.map((p) => [
        esc(p.code), esc(p.name), esc(p.company.legalName),
        esc(p.accountOwner.fullName), chip(p.healthStatus), chip(p.state),
      ]),
    )),
    section('توزیع وضعیت پروژه‌ها', table(['وضعیت', 'تعداد'],
      byState.map((r) => [chip(r.state), num(r._count._all)]))),
  ].join('');

  return { html, code: `EXEC-${now.toISOString().slice(0, 10)}`, titleFa: 'گزارش مدیریتی', redaction: red };
}

/* ══════════════════════════ dispatcher ══════════════════════════ */

type Builder = (id: string, orgId: string, user: AccessTokenClaims) => Promise<BuiltDocument>;

const BUILDERS: Record<DocumentKind, Builder> = {
  'form-submission': buildFormSubmission,
  brief: buildBrief,
  proposal: buildProposal,
  contract: buildContract,
  invoice: buildInvoice,
  project: buildProject,
  company: buildCompany,
  'work-order': buildWorkOrder,
  deliverable: buildDeliverable,
  'qc-review': buildQcReview,
  revision: buildRevision,
  'change-request': buildChangeRequest,
  'status-report': buildStatusReport,
  meeting: buildMeeting,
  'closure-report': buildClosureReport,
  'executive-report': buildExecutiveReport,
};

export const isDocumentKind = (k: string): k is DocumentKind => k in BUILDERS;

export async function buildDocument(
  kind: DocumentKind,
  id: string,
  orgId: string,
  user: AccessTokenClaims,
): Promise<BuiltDocument> {
  const builder = BUILDERS[kind];
  if (!builder) throw badRequest('UNKNOWN_KIND', `نوع سند «${kind}» پشتیبانی نمی‌شود.`);
  return builder(id, orgId, user);
}
