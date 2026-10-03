/**
 * A lead's source, checked against the organisation as it stands (Hivamis task 2), and the one
 * question its mobile number answers: is this person already a lead, or already a client's contact?
 */
import { Prisma } from '@prisma/client';
import {
  DIRECT_CHANNELS, LEAD_SOURCE_LABELS, LEGACY_LEAD_SOURCES, SALES_DEPARTMENT, leadSourceIssues, normalizeIranMobile,
  type DirectChannel, type LeadSourceKind,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { AppError, badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { persianLetters } from '../onboarding/sheet.js';

type Tx = Prisma.TransactionClient | typeof prisma;

export interface SourceInput {
  source?: string | null;
  sourceUserId?: string | null;
  sourceReferrerId?: string | null;
  sourceChannel?: string | null;
  sourcePartnerName?: string | null;
}

export interface ResolvedSource {
  source: LeadSourceKind;
  sourceUserId: string | null;
  sourceReferrerId: string | null;
  sourceChannel: DirectChannel | null;
}

/** A partner company's name as it is compared: Arabic letters made Persian, spaces collapsed. */
export const referrerName = (s: string) => persianLetters(s).replace(/\s+/g, ' ').trim();

const fail = (message: string) => badRequest('LEAD_SOURCE', message);

/**
 * The kind of source and exactly who or what it names — a seller must be in the sales unit, a
 * colleague outside it, a marketer or partner on the organisation's list and active. Only the
 * detail the kind has is kept. A partner company named for the first time is added to the list.
 */
export async function resolveLeadSource(tx: Tx, organizationId: string, actorId: string, input: SourceInput): Promise<ResolvedSource> {
  // A form saved before the two-step source (an older draft) may still carry the old single step.
  const legacy = input.source ? LEGACY_LEAD_SOURCES[input.source] : undefined;
  const v: SourceInput = legacy
    ? { source: legacy.source, sourceChannel: legacy.channel, sourceUserId: legacy.owner ? actorId : null }
    : input;
  const kind = v.source as LeadSourceKind;
  if (!kind || !LEAD_SOURCE_LABELS[kind]) throw fail('منبع ورودی سرنخ معتبر نیست.');
  const missing = leadSourceIssues({ ...v, source: kind, sourcePartnerName: v.sourcePartnerName ?? undefined });
  if (missing.length) throw fail(missing[0]!.message);

  if (kind === 'SALES_TEAM' || kind === 'STAFF') {
    const user = await tx.user.findFirst({
      where: { id: v.sourceUserId!, organizationId, isActive: true, deletedAt: null },
      select: { fullName: true, department: { select: { code: true } } },
    });
    if (!user) throw fail('کاربری که منبع سرنخ است پیدا نشد یا فعال نیست.');
    const inSales = user.department?.code === SALES_DEPARTMENT;
    if (kind === 'SALES_TEAM' && !inSales) throw fail(`«${user.fullName}» عضو تیم فروش نیست؛ منبع را «پرسنل شرکت» بگذارید.`);
    if (kind === 'STAFF' && inSales) throw fail(`«${user.fullName}» عضو تیم فروش است؛ منبع را «تیم فروش» بگذارید.`);
    return { source: kind, sourceUserId: v.sourceUserId!, sourceReferrerId: null, sourceChannel: null };
  }

  if (kind === 'DIRECT') {
    if (!DIRECT_CHANNELS.includes(v.sourceChannel as DirectChannel)) throw fail('کانال تماس مستقیم معتبر نیست.');
    return { source: kind, sourceUserId: null, sourceReferrerId: null, sourceChannel: v.sourceChannel as DirectChannel };
  }

  // MARKETER or PARTNER: someone on the list.
  const listKind = kind === 'MARKETER' ? 'MARKETER' : 'PARTNER';
  if (v.sourceReferrerId) {
    const r = await tx.leadReferrer.findFirst({ where: { id: v.sourceReferrerId, organizationId, kind: listKind } });
    if (!r) throw fail(kind === 'MARKETER' ? 'این بازاریاب در فهرست سازمان نیست.' : 'این شرکت همکار در فهرست سازمان نیست.');
    if (!r.isActive) throw fail(`«${r.name}» از فهرست کنار گذاشته شده است.`);
    return { source: kind, sourceUserId: null, sourceReferrerId: r.id, sourceChannel: null };
  }
  if (kind === 'MARKETER') throw fail('بازاریاب را از فهرست انتخاب کنید؛ فهرست بازاریابان را مدیر سیستم نگه می‌دارد.');
  // A partner named for the first time joins the list: a seller should not wait on an admin to
  // write down which company sent a client.
  const name = referrerName(v.sourcePartnerName!);
  const existing = await tx.leadReferrer.findFirst({ where: { organizationId, kind: 'PARTNER', name } });
  if (existing && !existing.isActive) throw fail(`«${existing.name}» از فهرست شرکت‌های همکار کنار گذاشته شده است.`);
  if (existing) return { source: kind, sourceUserId: null, sourceReferrerId: existing.id, sourceChannel: null };
  const partner = await tx.leadReferrer.create({ data: { organizationId, kind: 'PARTNER', name, createdById: actorId } });
  // Added to the list by naming it, but added all the same: the trail says by whom and how.
  await audit({ organizationId, actorId, action: 'CREATE', entityType: 'leadReferrer', entityId: partner.id, after: partner, reason: 'نام‌برده هنگام ثبت سرنخ' }, tx);
  return { source: kind, sourceUserId: null, sourceReferrerId: partner.id, sourceChannel: null };
}

export interface Duplicates {
  leads: { id: string; code: string; name: string; companyName: string; state: string; owner: string | null }[];
  contacts: { id: string; fullName: string; company: string; companyId: string }[];
}

/**
 * Who already has this mobile number: leads, and the contacts of clients. Stored numbers are
 * compared by their last ten digits, Persian digits read as Latin, so one typed before numbers
 * had a single form is still found.
 */
export async function findDuplicates(organizationId: string, phone: string, excludeLeadId?: string): Promise<Duplicates> {
  const mobile = normalizeIranMobile(phone);
  if (!mobile) return { leads: [], contacts: [] };
  const tail = mobile.slice(-10);
  const digits = (col: Prisma.Sql) => Prisma.sql`right(regexp_replace(translate(${col}, '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789'), '[^0-9]', '', 'g'), 10)`;
  const leads = await prisma.$queryRaw<Duplicates['leads']>`
    SELECT l.id, l.code, l.name, l."companyName", l.state, u."fullName" AS owner
    FROM leads l LEFT JOIN users u ON u.id = l."ownerId"
    WHERE l."organizationId" = ${organizationId} AND l."deletedAt" IS NULL AND l.phone IS NOT NULL
      AND ${digits(Prisma.sql`l.phone`)} = ${tail}
      ${excludeLeadId ? Prisma.sql`AND l.id <> ${excludeLeadId}` : Prisma.empty}
    ORDER BY l."createdAt" DESC LIMIT 5`;
  const contacts = await prisma.$queryRaw<Duplicates['contacts']>`
    SELECT c.id, c."fullName", co."legalName" AS company, co.id AS "companyId"
    FROM contacts c JOIN companies co ON co.id = c."companyId"
    WHERE co."organizationId" = ${organizationId} AND c."deletedAt" IS NULL AND c.phone IS NOT NULL
      AND ${digits(Prisma.sql`c.phone`)} = ${tail}
    LIMIT 5`;
  return { leads, contacts };
}

/** Refuses a repeated number unless the person said they meant it; the refusal names who has it. */
export async function refuseDuplicate(organizationId: string, phone: string, confirmed: boolean | undefined, excludeLeadId?: string) {
  if (confirmed) return;
  const found = await findDuplicates(organizationId, phone, excludeLeadId);
  if (!found.leads.length && !found.contacts.length) return;
  const who = [
    ...found.leads.map((l) => `سرنخ ${l.code} «${l.name}»${l.owner ? ` (${l.owner})` : ''}`),
    ...found.contacts.map((c) => `مخاطب «${c.fullName}» از ${c.company}`),
  ].join('، ');
  throw new AppError(409, 'DUPLICATE_LEAD', `این شمارهٔ همراه پیش‌تر ثبت شده است: ${who}. اگر سرنخ تازه‌ای است، «ثبت با وجود تکرار» را بزنید.`, found);
}
