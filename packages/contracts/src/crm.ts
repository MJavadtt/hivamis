/**
 * Where a lead came from, in two steps (Hivamis task 2): the kind of source, then who or what
 * exactly — the seller, the marketer, the colleague, the channel, the partner company. A lead's
 * source is what a commission, a campaign's return and a partner's worth are later read from, so
 * "referral" with no name is no longer something a person can enter.
 */
export const LEAD_SOURCE_KINDS = ['SALES_TEAM', 'MARKETER', 'STAFF', 'DIRECT', 'PARTNER'] as const;
export type LeadSourceKind = (typeof LEAD_SOURCE_KINDS)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSourceKind, { fa: string; en: string; detailFa: string; detailEn: string }> = {
  SALES_TEAM: { fa: 'تیم فروش', en: 'Sales team', detailFa: 'عضو تیم فروش', detailEn: 'Sales team member' },
  MARKETER: { fa: 'بازاریابان', en: 'Marketers', detailFa: 'بازاریاب', detailEn: 'Marketer' },
  STAFF: { fa: 'پرسنل شرکت', en: 'Company staff', detailFa: 'همکار (خارج از تیم فروش)', detailEn: 'Colleague outside sales' },
  DIRECT: { fa: 'تماس مستقیم', en: 'Direct contact', detailFa: 'کانال', detailEn: 'Channel' },
  PARTNER: { fa: 'شرکت‌های همکار', en: 'Partner companies', detailFa: 'شرکت همکار', detailEn: 'Partner company' },
};

export const DIRECT_CHANNELS = ['PHONE', 'EXHIBITION', 'EVENT', 'CAMPAIGN'] as const;
export type DirectChannel = (typeof DIRECT_CHANNELS)[number];
export const DIRECT_CHANNEL_LABELS: Record<DirectChannel, { fa: string; en: string }> = {
  PHONE: { fa: 'تلفن', en: 'Phone' },
  EXHIBITION: { fa: 'نمایشگاه', en: 'Exhibition' },
  EVENT: { fa: 'رویداد', en: 'Event' },
  CAMPAIGN: { fa: 'کمپین', en: 'Campaign' },
};

/** People outside the system a lead can name: marketers (kept by the admin) and partner companies. */
export const LEAD_REFERRER_KINDS = ['MARKETER', 'PARTNER'] as const;
export type LeadReferrerKind = (typeof LEAD_REFERRER_KINDS)[number];

/** The department whose members are "the sales team". */
export const SALES_DEPARTMENT = 'S';

/**
 * The single-step sources leads had before, and what each became when they were migrated
 * (apps/api/prisma/migrations/20261008120000_lead_sources). Kept for the form engine, whose older
 * submissions may still carry them.
 */
export const LEGACY_LEAD_SOURCES: Record<string, { source: LeadSourceKind; channel: DirectChannel | null; owner?: true }> = {
  REFERRAL: { source: 'PARTNER', channel: null },
  INBOUND: { source: 'DIRECT', channel: null },
  OUTBOUND: { source: 'SALES_TEAM', channel: null, owner: true },
  EVENT: { source: 'DIRECT', channel: 'EVENT' },
  CAMPAIGN: { source: 'DIRECT', channel: 'CAMPAIGN' },
  OTHER: { source: 'DIRECT', channel: null },
};

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/**
 * An Iranian mobile number in its one written form, 09xxxxxxxxx — whatever way it was typed:
 * Persian or Arabic digits, spaces and dashes, +98, 0098, 98 or no leading zero. Null when it is
 * not a mobile number at all. One form is what makes "this number is already a lead" answerable.
 */
export function normalizeIranMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = '';
  for (const ch of String(raw)) {
    const p = PERSIAN_DIGITS.indexOf(ch), a = ARABIC_DIGITS.indexOf(ch);
    if (p >= 0) d += String(p);
    else if (a >= 0) d += String(a);
    else if (/[0-9+]/.test(ch)) d += ch;
    else if (!/[\s\-().‌]/.test(ch)) return null;
  }
  if (d.startsWith('+98')) d = `0${d.slice(3)}`;
  else if (d.startsWith('0098')) d = `0${d.slice(4)}`;
  else if (d.startsWith('98') && d.length === 12) d = `0${d.slice(2)}`;
  else if (d.startsWith('9') && d.length === 10) d = `0${d}`;
  return /^09\d{9}$/.test(d) ? d : null;
}

/** "Sales team — Elham Karimi", "Direct contact — Exhibition": a lead's source as one phrase. */
export function leadSourceFa(lead: {
  source: string; sourceChannel?: string | null;
  sourceUser?: { fullName: string } | null; sourceReferrer?: { name: string } | null;
}): string {
  const kind = LEAD_SOURCE_LABELS[lead.source as LeadSourceKind]?.fa ?? lead.source;
  const detail = lead.sourceUser?.fullName ?? lead.sourceReferrer?.name
    ?? (lead.sourceChannel ? DIRECT_CHANNEL_LABELS[lead.sourceChannel as DirectChannel]?.fa : null);
  return detail ? `${kind} — ${detail}` : kind;
}
