import { prisma } from '../db.js';
import { badRequest } from '../lib/errors.js';
import type { AccessTokenClaims } from '../auth/tokens.js';
import { DOCUMENT_POLICIES, type DocumentKind, redactionFor } from './access.js';
import { chip, date, dateTime, deptFa, esc, money, num, percent, table } from './fmt.js';
import { docHeader, routingBand, section } from './sections.js';
import {
  buildBrief, buildContract, buildFormSubmission, buildInvoice, buildProposal, type BuiltDocument,
} from './templates.js';
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

  const [projects, opportunities, invoices, payments, overdueTasks, breachedSlas, openRisks] = await Promise.all([
    prisma.project.findMany({
      where: { organizationId: orgId, deletedAt: null },
      include: { company: { select: { legalName: true } }, accountOwner: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.opportunity.findMany({ where: { organizationId: orgId, deletedAt: null } }),
    prisma.invoice.findMany({ where: { organizationId: orgId } }),
    prisma.payment.findMany({ where: { organizationId: orgId } }),
    prisma.task.count({
      where: {
        organizationId: orgId, dueDate: { lt: now },
        state: { notIn: ['CLOSED', 'CANCELLED', 'APPROVED'] },
      },
    }),
    prisma.slaClock.count({ where: { organizationId: orgId, state: 'BREACHED' } }),
    prisma.risk.count({ where: { organizationId: orgId, state: { not: 'CLOSED' } } }),
  ]);

  const active = projects.filter((p) => ['ACTIVE', 'PLANNING', 'AUTHORIZED'].includes(p.state));
  const invoiced = invoices.reduce((s, i) => s + Number(i.total), 0);
  const received = payments.filter((p) => p.direction === 'IN').reduce((s, p) => s + Number(p.amount), 0);
  const spent = payments.filter((p) => p.direction === 'OUT').reduce((s, p) => s + Number(p.amount), 0);
  const pipeline = opportunities
    .filter((o) => !['WON', 'LOST'].includes(o.state))
    .reduce((s, o) => s + Number(o.estimatedValue), 0);
  const won = opportunities.filter((o) => o.state === 'WON').length;
  const decided = opportunities.filter((o) => ['WON', 'LOST'].includes(o.state)).length;

  const html = [
    docHeader({ title: 'گزارش مدیریتی — برج کنترل', subtitle: `تاریخ تهیه: ${dateTime(now)}` }),
    routingBand([
      ['پروژه‌های فعال', num(active.length)],
      ['کل پروژه‌ها', num(projects.length)],
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
          ['مانده مطالبات', money(invoiced - received)],
          ['جمع هزینه پرداختی', red.cost ? money(spent) : '<span class="redacted">محرمانه</span>'],
        ])
      : '<p class="redacted">محرمانه — خارج از سطح دسترسی</p>'),
    section('وضعیت پرتفوی پروژه‌ها', table(
      ['کد', 'پروژه', 'مشتری', 'مالک اکانت', 'سلامت', 'وضعیت'],
      projects.slice(0, 60).map((p) => [
        esc(p.code), esc(p.name), esc(p.company.legalName),
        esc(p.accountOwner.fullName), chip(p.healthStatus), chip(p.state),
      ]),
    )),
    section('توزیع وضعیت پروژه‌ها', table(['وضعیت', 'تعداد'],
      Object.entries(projects.reduce<Record<string, number>>((acc, p) => {
        acc[p.state] = (acc[p.state] ?? 0) + 1;
        return acc;
      }, {})).map(([s, n]) => [chip(s), num(n)]))),
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
