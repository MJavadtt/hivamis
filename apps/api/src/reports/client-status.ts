/**
 * Client status reports (roadmap #37).
 *
 * Doc_H §14 makes a weekly status report mandatory, and SLA_STATUS_REPORT times it. The report,
 * the Persian PDF engine and the redaction order all existed; what did not was the last step —
 * the client actually receiving it. This module builds the client's copy, sends it with the PDF
 * attached, records the delivery, and runs weekly.
 *
 * The client's copy is not the internal one with numbers blacked out. It is built for a reader
 * outside the organisation: no financial status, no "decisions we need internally", and the
 * redaction context of someone with no financial permission at all, so a cost or price figure
 * cannot reach paper by any route.
 */
import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { redactionFor } from '../pdf/access.js';
import { renderPdf } from '../pdf/renderer.js';
import { dateTime, esc, field, text } from '../pdf/fmt.js';
import { docHeader, routingBand, section } from '../pdf/sections.js';
import { enqueueMail, type MailJob } from '../jobs/runner.js';
import { notify } from '../mail/notify.js';
import type { AccessTokenClaims } from '../auth/tokens.js';

/** The client as a reader: authenticated to nothing, so every financial guard closes. */
export const CLIENT_VIEWER: AccessTokenClaims = {
  sub: 'client', organizationId: '', departmentCode: null, roles: [], permissions: [],
};

export interface ClientReport {
  html: string;
  code: string;
  projectCode: string;
  projectName: string;
  companyName: string;
  period: string;
  /** Sections the internal report has and this one deliberately does not. */
  omitted: string[];
}

/** The report as the client will read it. */
export async function buildClientStatusReport(tx: Tx, reportId: string): Promise<ClientReport> {
  const r = await tx.statusReport.findFirst({
    where: { id: reportId },
    include: { project: { select: { code: true, name: true, company: { select: { legalName: true } } } } },
  });
  if (!r) throw notFound('گزارش وضعیت');
  const red = redactionFor(CLIENT_VIEWER);

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
      field('وضعیت زمان‌بندی', text(r.timelineStatus)),
      field('ریسک‌ها', text(r.risks)),
      field('مشکلات', text(r.issues)),
    ].join('')),
  ].join('');

  // Belt and braces: the builder above never touches these, and the redaction says why.
  const omitted = ['financialStatus', 'decisionsNeeded', ...red.withheld.map((w) => `redaction:${w}`)];
  return {
    html, code: r.code, projectCode: r.project.code, projectName: r.project.name,
    companyName: r.project.company.legalName, period: r.period, omitted,
  };
}

/** The address a project's client is reached at: the company's primary contact, else any contact with one. */
export async function clientAddressFor(tx: Tx, projectId: string): Promise<{ email: string; name: string } | null> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { company: { select: { contacts: { where: { email: { not: null } }, orderBy: { isPrimary: 'desc' } } } } },
  });
  const contact = project?.company.contacts[0];
  return contact?.email ? { email: contact.email, name: contact.fullName } : null;
}

export type Deliver = (job: MailJob & { attachments?: { filename: string; contentBase64: string }[] }) => Promise<void>;

export interface SendResult {
  to: string;
  subject: string;
  filename: string;
  bytes: number;
  omitted: string[];
}

/**
 * Build, render and send one report to the client, and record that it happened. `deliver`
 * defaults to the mail queue; tests pass their own to see what would have gone out.
 */
export async function sendClientStatusReport(
  reportId: string,
  opts: { actorId: string | null; to?: string; deliver?: Deliver } = { actorId: null },
): Promise<SendResult> {
  const report = await prisma.statusReport.findUniqueOrThrow({ where: { id: reportId }, select: { projectId: true, organizationId: true } });
  const built = await buildClientStatusReport(prisma, reportId);
  const address = opts.to ? { email: opts.to, name: null } : await clientAddressFor(prisma, report.projectId);
  if (!address) throw notFound('نشانی ایمیل مشتری');

  const pdf = await renderPdf(built.html, {
    headerRight: built.code,
    footerNote: `گزارش وضعیت — ${built.companyName} — ${dateTime(new Date())}`,
  });
  const filename = `${built.code}.pdf`;
  const subject = `گزارش وضعیت پروژه ${built.projectName} — ${built.period}`;
  const greeting = address.name ? `${address.name} گرامی،` : 'با سلام،';
  const html = `<p>${esc(greeting)}</p><p>گزارش وضعیت پروژه «${esc(built.projectName)}» برای دوره «${esc(built.period)}» پیوست است.</p><p>هیوا</p>`;
  const textBody = `${greeting}\nگزارش وضعیت پروژه «${built.projectName}» برای دوره «${built.period}» پیوست است.\nهیوا`;

  await (opts.deliver ?? enqueueMail)({
    to: address.email, subject, html, text: textBody,
    attachments: [{ filename, contentBase64: pdf.toString('base64') }],
  });

  await audit({
    organizationId: report.organizationId, actorId: opts.actorId, action: 'CLIENT_REPORT_SENT',
    entityType: 'statusReport', entityId: reportId,
    after: { to: address.email, filename, bytes: pdf.length, omitted: built.omitted },
  });

  return { to: address.email, subject, filename, bytes: pdf.length, omitted: built.omitted };
}

export interface WeeklyPlan {
  /** Projects with a report in the window and a client address: these are sent. */
  send: { projectId: string; reportId: string; projectCode: string }[];
  /** Active projects with no report this week: the account owner is told. */
  missing: { projectId: string; projectCode: string; accountOwnerId: string | null }[];
  /** Reports that exist but have nowhere to go. */
  unaddressed: { projectId: string; projectCode: string }[];
}

/** What the weekly run will do, decided before it does any of it. */
export async function planWeeklyRun(tx: Tx, now = new Date(), windowDays = 7): Promise<WeeklyPlan> {
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const projects = await tx.project.findMany({
    where: { state: 'ACTIVE', deletedAt: null },
    select: {
      id: true, code: true, accountOwnerId: true,
      statusReports: { where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } },
    },
  });
  const plan: WeeklyPlan = { send: [], missing: [], unaddressed: [] };
  for (const p of projects) {
    const latest = p.statusReports[0];
    if (!latest) { plan.missing.push({ projectId: p.id, projectCode: p.code, accountOwnerId: p.accountOwnerId }); continue; }
    const address = await clientAddressFor(tx, p.id);
    if (!address) { plan.unaddressed.push({ projectId: p.id, projectCode: p.code }); continue; }
    plan.send.push({ projectId: p.id, reportId: latest.id, projectCode: p.code });
  }
  return plan;
}

/** The weekly job body: send what can be sent, tell whoever owes a report that they owe it. */
export async function runWeekly(now = new Date(), deliver?: Deliver): Promise<{ sent: number; missing: number; unaddressed: number }> {
  const plan = await planWeeklyRun(prisma, now);
  for (const s of plan.send) {
    await sendClientStatusReport(s.reportId, { actorId: null, deliver }).catch(() => undefined);
  }
  for (const m of plan.missing) {
    await notify({
      userId: m.accountOwnerId, kind: 'STATUS_REPORT_MISSING', severity: 'WARNING',
      title: `گزارش هفتگی ${m.projectCode} ثبت نشده`,
      body: 'مشتری این هفته گزارشی دریافت نکرد. طبق بند ۱۴، گزارش وضعیت هفتگی الزامی است.',
      entityType: 'project', entityId: m.projectId,
    });
  }
  return { sent: plan.send.length, missing: plan.missing.length, unaddressed: plan.unaddressed.length };
}
