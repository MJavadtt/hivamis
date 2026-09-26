/**
 * Reporting an invoice to سامانهٔ مؤدیان, and following it until the authority answers (roadmap #32).
 *
 * An ORIGINAL is reported once; after the authority accepts it, the invoice can only be corrected
 * (CORRECTION) or cancelled (CANCELLATION), each a new submission with its own tax number that names
 * the accepted one it replaces. A submission is prepared — validated, numbered, its payload fixed —
 * before anything is sent, so what the authority received can always be shown. Sending and
 * inquiring run on a job; a transport failure is retried, a refusal from the authority is kept with
 * its reasons.
 */
import type { Tx } from '../db.js';
import { prisma } from '../db.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { nextNumber } from '../lib/codes.js';
import { configuredGateway, type TaxGateway } from './gateway.js';
import { buildTaxInvoice, validateForTax, type Buyer, type Problem, type SellerProfile, type TaxSubject } from './invoice.js';
import { taxIdFor } from './taxid.js';

export const MAX_SEND_ATTEMPTS = 5;
const LIVE_STATUSES = ['QUEUED', 'SENT', 'ACCEPTED'];

async function load(tx: Tx, organizationId: string, invoiceId: string) {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, organizationId },
    include: { company: { select: { legalName: true, nationalId: true, economicCode: true, postalCode: true } }, taxSubmissions: { orderBy: { createdAt: 'asc' } } },
  });
  if (!invoice) throw notFound('فاکتور');
  const profile = await tx.taxProfile.findUnique({ where: { organizationId } });
  return { invoice, profile: profile as SellerProfile | null, buyer: invoice.company as Buyer };
}

/** What may be reported next, and against which accepted tax number. */
export function nextSubjects(subs: { subject: string; status: string; taxId: string }[]) {
  const accepted = subs.filter((s) => s.status === 'ACCEPTED');
  const cancelled = accepted.some((s) => s.subject === 'CANCELLATION');
  const inFlight = subs.some((s) => ['QUEUED', 'SENT'].includes(s.status));
  const latestAccepted = [...accepted].reverse().find((s) => s.subject !== 'CANCELLATION') ?? null;
  const subjects: TaxSubject[] = cancelled || inFlight ? [] : latestAccepted ? ['CORRECTION', 'CANCELLATION'] : ['ORIGINAL'];
  return { subjects, referenceTaxId: latestAccepted?.taxId ?? null, cancelled, inFlight };
}

export async function preview(tx: Tx, organizationId: string, invoiceId: string) {
  const { invoice, profile, buyer } = await load(tx, organizationId, invoiceId);
  const next = nextSubjects(invoice.taxSubmissions);
  const subject = next.subjects[0] ?? 'ORIGINAL';
  const problems = validateForTax(invoice, buyer, profile, subject, next.referenceTaxId);
  return {
    ...next, problems,
    payload: profile ? buildTaxInvoice(invoice, buyer, profile, subject, next.referenceTaxId, '—', 0) : null,
    submissions: invoice.taxSubmissions,
  };
}

export async function prepare(tx: Tx, organizationId: string, invoiceId: string, subject: TaxSubject, actorId: string) {
  const { invoice, profile, buyer } = await load(tx, organizationId, invoiceId);
  const next = nextSubjects(invoice.taxSubmissions);
  if (next.cancelled) throw conflict('TAX_ALREADY_CANCELLED', 'این فاکتور در سامانهٔ مؤدیان ابطال شده است؛ گزارش دیگری نمی‌پذیرد.');
  if (next.inFlight) throw conflict('TAX_IN_FLIGHT', 'گزارش پیشین این فاکتور هنوز در صف یا در انتظار پاسخ سامانه است.');
  if (!next.subjects.includes(subject)) {
    throw new AppError(422, 'TAX_SUBJECT_NOT_ALLOWED', subject === 'ORIGINAL'
      ? 'این فاکتور پیش‌تر پذیرفته شده است؛ اکنون فقط اصلاحی یا ابطالی ممکن است.'
      : 'اصلاحی و ابطالی فقط پس از پذیرش فاکتور اصلی در سامانه ممکن است.');
  }
  const problems: Problem[] = validateForTax(invoice, buyer, profile, subject, next.referenceTaxId);
  if (problems.length) throw new AppError(422, 'TAX_INVOICE_INVALID', 'فاکتور هنوز آمادهٔ گزارش به سامانهٔ مؤدیان نیست', { problems });

  const serial = await nextNumber(tx, `moadian:${organizationId}`);
  const taxId = taxIdFor(profile!.memoryId, invoice.issueDate, serial);
  const payload = buildTaxInvoice(invoice, buyer, profile!, subject, next.referenceTaxId, taxId, serial);
  return tx.taxSubmission.create({
    data: { organizationId, invoiceId, subject, serial, taxId, referenceTaxId: next.referenceTaxId, payload: payload as object, createdById: actorId },
  });
}

/** Send what is queued. A transport failure stays queued and is retried; the fifth is given up. */
export async function sendQueued(gw: TaxGateway | null = configuredGateway(), onlyId?: string) {
  if (!gw) return { sent: 0, failed: 0, skipped: true };
  const queued = await prisma.taxSubmission.findMany({ where: { status: 'QUEUED', ...(onlyId ? { id: onlyId } : {}) }, orderBy: { createdAt: 'asc' }, take: 100 });
  let sent = 0, failed = 0;
  const byOrg = new Map<string, typeof queued>();
  for (const q of queued) (byOrg.get(q.organizationId) ?? byOrg.set(q.organizationId, []).get(q.organizationId)!).push(q);
  for (const [org, items] of byOrg) {
    const profile = await prisma.taxProfile.findUnique({ where: { organizationId: org } });
    if (!profile) continue;
    let results: Awaited<ReturnType<TaxGateway['submit']>>;
    try {
      results = await gw.submit(profile.memoryId, items.map((i) => ({ taxId: i.taxId, payload: i.payload as object })));
    } catch (e) {
      results = items.map((i) => ({ taxId: i.taxId, referenceNumber: null, error: e instanceof Error ? e.message : String(e) }));
    }
    for (const r of results) {
      const item = items.find((i) => i.taxId === r.taxId)!;
      const attempts = item.attempts + 1;
      if (r.referenceNumber) {
        await prisma.taxSubmission.update({ where: { id: item.id }, data: { status: 'SENT', referenceNumber: r.referenceNumber, attempts, channel: gw.channel, submittedAt: new Date(), errors: undefined } });
        sent++;
      } else {
        await prisma.taxSubmission.update({ where: { id: item.id }, data: { status: attempts >= MAX_SEND_ATTEMPTS ? 'FAILED' : 'QUEUED', attempts, channel: gw.channel, errors: [{ transport: r.error }] } });
        failed++;
      }
    }
  }
  return { sent, failed, skipped: false };
}

/** Ask what became of what was sent. */
export async function inquireSent(gw: TaxGateway | null = configuredGateway(), onlyId?: string) {
  if (!gw) return { accepted: 0, rejected: 0, pending: 0 };
  const sent = await prisma.taxSubmission.findMany({ where: { status: 'SENT', referenceNumber: { not: null }, ...(onlyId ? { id: onlyId } : {}) }, take: 100 });
  let accepted = 0, rejected = 0, pending = 0;
  const byOrg = new Map<string, typeof sent>();
  for (const s of sent) (byOrg.get(s.organizationId) ?? byOrg.set(s.organizationId, []).get(s.organizationId)!).push(s);
  for (const [org, items] of byOrg) {
    const profile = await prisma.taxProfile.findUnique({ where: { organizationId: org } });
    if (!profile) continue;
    const answers = await gw.inquire(profile.memoryId, items.map((i) => i.referenceNumber!)).catch(() => []);
    for (const a of answers) {
      const item = items.find((i) => i.referenceNumber === a.referenceNumber);
      if (!item || a.status === 'PENDING') { pending++; continue; }
      await prisma.taxSubmission.update({ where: { id: item.id }, data: { status: a.status, respondedAt: new Date(), errors: a.errors.length ? (a.errors as object) : undefined } });
      a.status === 'ACCEPTED' ? accepted++ : rejected++;
    }
  }
  return { accepted, rejected, pending };
}

export async function runMoadian() {
  const gw = configuredGateway();
  return { ...(await sendQueued(gw)), ...(await inquireSent(gw)) };
}
