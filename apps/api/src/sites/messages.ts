import { normalizeIranMobile } from '@hiva/contracts';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { sendText, textStatus } from '../auth/sms.js';
import { smsMode } from '../env.js';
import type { SiteActor } from './venues.js';

/**
 * Texts to the venues (ADR-103) — «اتصال به پنل پیامکی و ارسال متن برای مکان‌ها». Through the
 * installation's SMS provider (SMS_MODE); each message is logged with what the provider answered.
 * SENT means the provider took it; DELIVERED only what the provider later reports. A message that
 * failed is tried again, twice, by the job; nothing is ever called delivered on hope.
 */

const MAX_ATTEMPTS = 3;

export interface SmsRequest {
  venueIds: string[]; contactIds: string[]; siteProjectId?: string | null;
  templateKey?: string | null; text: string;
  values: { amount?: string | null; dueDate?: string | null; project?: string | null };
}

interface Recipient { venueId: string; venueName: string; contactId: string | null; contactName: string | null; phone: string }

export const fill = (text: string, v: Record<string, string | null | undefined>) =>
  text.replace(/\{(venue|contact|project|amount|dueDate|sender)\}/g, (_, k: string) => v[k] ?? '').replace(/\s{2,}/g, ' ').trim();

/** Who a venue is written to: its primary contact's mobile, else any contact's, else the venue's own if it is a mobile. */
async function recipientsFor(organizationId: string, req: SmsRequest) {
  const out: Recipient[] = [];
  const skipped: { venueId: string; name: string; reason: string }[] = [];
  if (req.contactIds.length) {
    const contacts = await prisma.venueContact.findMany({
      where: { organizationId, id: { in: req.contactIds }, archivedAt: null },
      select: { id: true, fullName: true, phone: true, venue: { select: { id: true, name: true } } },
    });
    for (const c of contacts) {
      const phone = normalizeIranMobile(c.phone);
      if (phone) out.push({ venueId: c.venue.id, venueName: c.venue.name, contactId: c.id, contactName: c.fullName, phone });
      else skipped.push({ venueId: c.venue.id, name: `${c.fullName} — ${c.venue.name}`, reason: 'NO_MOBILE' });
    }
  }
  if (req.venueIds.length) {
    const venues = await prisma.venue.findMany({
      where: { organizationId, id: { in: req.venueIds }, archivedAt: null },
      select: { id: true, name: true, phone: true, contacts: { where: { archivedAt: null }, select: { id: true, fullName: true, phone: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } },
    });
    for (const v of venues) {
      const c = v.contacts.find((x) => normalizeIranMobile(x.phone));
      if (c) out.push({ venueId: v.id, venueName: v.name, contactId: c.id, contactName: c.fullName, phone: normalizeIranMobile(c.phone)! });
      else if (normalizeIranMobile(v.phone)) out.push({ venueId: v.id, venueName: v.name, contactId: null, contactName: null, phone: normalizeIranMobile(v.phone)! });
      else skipped.push({ venueId: v.id, name: v.name, reason: 'NO_MOBILE' });
    }
  }
  // One message to a number, however many ways it was chosen.
  const seen = new Set<string>();
  return { recipients: out.filter((r) => (seen.has(r.phone) ? false : (seen.add(r.phone), true))), skipped };
}

export async function sendVenueMessages(actor: SiteActor, req: SmsRequest) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { name: true } });
  const project = req.siteProjectId ? await prisma.siteProject.findFirst({ where: { id: req.siteProjectId, organizationId: actor.organizationId }, select: { id: true, name: true } }) : null;
  const { recipients, skipped } = await recipientsFor(actor.organizationId, req);
  const counts = { SENT: 0, SANDBOX: 0, FAILED: 0 };
  const messages = [];
  for (const r of recipients) {
    const text = fill(req.text, {
      venue: r.venueName, contact: r.contactName ?? '', project: req.values.project ?? project?.name ?? '',
      amount: req.values.amount ?? '', dueDate: req.values.dueDate ?? '', sender: org.name,
    });
    const outcome = await sendText(r.phone, text);
    counts[outcome.status]++;
    messages.push(await prisma.venueMessage.create({
      data: {
        organizationId: actor.organizationId, venueId: r.venueId, contactId: r.contactId, siteProjectId: project?.id ?? null,
        phone: r.phone, text, templateKey: req.templateKey ?? null, provider: outcome.provider, status: outcome.status,
        providerRef: outcome.providerRef, error: outcome.error, sentById: actor.id, sentAt: outcome.status === 'FAILED' ? null : new Date(),
      },
      select: { id: true, venueId: true, phone: true, status: true, error: true },
    }));
  }
  await audit({
    organizationId: actor.organizationId, actorId: actor.id, ipAddress: actor.ipAddress ?? null, requestId: actor.requestId ?? null,
    action: 'SMS_SENT', entityType: 'venue', entityId: recipients.length === 1 ? recipients[0]!.venueId : null,
    after: { recipients: recipients.length, ...counts, skipped: skipped.length, templateKey: req.templateKey ?? null, siteProjectId: project?.id ?? null },
  });
  return { sent: counts.SENT, sandbox: counts.SANDBOX, failed: counts.FAILED, skipped, messages };
}

/** The job's part: failed messages tried again while they have attempts left, then what the provider says of the sent ones. */
export async function followUpMessages(now = new Date()): Promise<{ retried: number; delivered: number; undelivered: number }> {
  let retried = 0, delivered = 0, undelivered = 0;
  const failed = await prisma.venueMessage.findMany({
    where: { status: 'FAILED', attempts: { lt: MAX_ATTEMPTS }, createdAt: { gte: new Date(now.getTime() - 2 * 86_400_000) } },
    take: 100, orderBy: { createdAt: 'asc' },
  });
  // Nothing to retry against while the installation has no provider: they wait for one.
  for (const m of smsMode === 'off' || smsMode === 'sandbox' ? [] : failed) {
    const outcome = await sendText(m.phone, m.text);
    await prisma.venueMessage.update({
      where: { id: m.id },
      data: { attempts: { increment: 1 }, status: outcome.status, providerRef: outcome.providerRef, error: outcome.error, sentAt: outcome.status === 'SENT' ? now : null },
    });
    retried++;
  }
  const sent = await prisma.venueMessage.findMany({
    where: { status: 'SENT', providerRef: { not: null }, createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) }, OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now.getTime() - 3_600_000) } }] },
    take: 200,
  });
  for (const m of sent) {
    const status = await textStatus(m.providerRef!);
    await prisma.venueMessage.update({ where: { id: m.id }, data: { checkedAt: now, ...(status ? { status } : {}) } });
    if (status === 'DELIVERED') delivered++;
    if (status === 'UNDELIVERED') undelivered++;
  }
  return { retried, delivered, undelivered };
}
