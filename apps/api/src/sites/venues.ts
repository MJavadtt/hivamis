import {
  nameKey, phoneKey, VENUE_EXPECTED_FIELDS, VENUE_FIELD_LABELS,
  type SiteSettings, type VenueExpectedField, type VenueInput,
} from '@hiva/contracts';
import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { nextCode } from '../lib/codes.js';
import { audit } from '../lib/audit.js';
import { assertOptions } from './options.js';

/**
 * The venue database (ADR-103, module A): a venue, its people and the ways to reach them, the
 * duplicates it might be, and how complete it is.
 */

export interface SiteActor {
  id: string;
  organizationId: string;
  permissions: readonly string[];
  ipAddress?: string | null;
  requestId?: string | null;
}

const ctx = (a: SiteActor) => ({ organizationId: a.organizationId, actorId: a.id, ipAddress: a.ipAddress ?? null, requestId: a.requestId ?? null });

/** An address reduced like a name — what makes two spellings of one address equal. */
const addressKey = (a: string | null | undefined) => (a ? nameKey(a) : '');

export interface DuplicateCandidate {
  id: string; code: string; name: string; city: string; province: string; isActive: boolean; archived: boolean;
  /** Why it looks like this one: NAME_CITY, PHONE, ADDRESS. */
  reasons: string[];
}

/**
 * Venues that look like this one, by the organisation's rules (settings.venues.duplicateBy): the same
 * name in the same city, a telephone number one of them or one of their people has, the same address.
 * A merged venue is not a candidate, nor one an authorised person said is another place.
 */
export async function findDuplicates(
  organizationId: string,
  v: { name: string; city: string; phone?: string | null; address?: string | null; contactPhones?: (string | null | undefined)[] },
  settings: SiteSettings,
  excludeId?: string,
  db: Tx | typeof prisma = prisma,
): Promise<DuplicateCandidate[]> {
  const rules = new Set(settings.venues.duplicateBy);
  const phones = [...new Set([v.phone, ...(v.contactPhones ?? [])].map(phoneKey).filter((p): p is string => !!p))];
  const or: Prisma.VenueWhereInput[] = [];
  if (rules.has('NAME_CITY')) or.push({ nameKey: nameKey(v.name), city: v.city.trim() });
  if (rules.has('PHONE') && phones.length) or.push({ phoneKey: { in: phones } }, { contacts: { some: { phoneKey: { in: phones }, archivedAt: null } } });
  if (rules.has('ADDRESS') && addressKey(v.address).length >= 8) or.push({ city: v.city.trim(), address: { not: null } });
  if (!or.length) return [];

  const rows = await db.venue.findMany({
    where: { organizationId, mergedIntoId: null, ...(excludeId ? { id: { not: excludeId } } : {}), OR: or },
    select: {
      id: true, code: true, name: true, nameKey: true, city: true, province: true, address: true, phoneKey: true, isActive: true, archivedAt: true, distinctFrom: true,
      contacts: { where: { archivedAt: null, phoneKey: { not: null } }, select: { phoneKey: true } },
    },
    take: 50,
  });
  const own = excludeId ? (await db.venue.findFirst({ where: { id: excludeId, organizationId }, select: { distinctFrom: true } }))?.distinctFrom ?? [] : [];
  const out: DuplicateCandidate[] = [];
  for (const r of rows) {
    if (own.includes(r.id) || (excludeId && r.distinctFrom.includes(excludeId))) continue;
    const reasons: string[] = [];
    if (rules.has('NAME_CITY') && r.nameKey === nameKey(v.name) && r.city === v.city.trim()) reasons.push('NAME_CITY');
    const theirs = [r.phoneKey, ...r.contacts.map((c) => c.phoneKey)].filter(Boolean);
    if (rules.has('PHONE') && phones.some((p) => theirs.includes(p))) reasons.push('PHONE');
    if (rules.has('ADDRESS') && addressKey(v.address).length >= 8 && addressKey(r.address) === addressKey(v.address)) reasons.push('ADDRESS');
    if (reasons.length) out.push({ id: r.id, code: r.code, name: r.name, city: r.city, province: r.province, isActive: r.isActive, archived: !!r.archivedAt, reasons });
  }
  return out;
}

export interface Completeness { score: number; missing: VenueExpectedField[] }

/** How complete a venue is: each expected field present or not — explicit, never guessed at. */
export function completenessOf(v: { address: string | null; phone: string | null; gradeCode: string | null; audienceCodes: string[] }, contacts: number, photos: number): Completeness {
  const present: Record<VenueExpectedField, boolean> = {
    address: !!v.address?.trim(), phone: !!v.phone?.trim(), gradeCode: !!v.gradeCode, audienceCodes: v.audienceCodes.length > 0,
    contacts: contacts > 0, photos: photos > 0,
  };
  const missing = VENUE_EXPECTED_FIELDS.filter((f) => !present[f]);
  return { score: Math.round(((VENUE_EXPECTED_FIELDS.length - missing.length) / VENUE_EXPECTED_FIELDS.length) * 100), missing };
}

/**
 * The fields the organisation requires a venue typed in by hand to have. Contacts and photos are added
 * once the venue exists, so they count towards completeness, not here; an import may bring a venue in
 * incomplete, marked as such.
 */
export function assertRequired(settings: SiteSettings, v: Partial<Pick<VenueInput, 'address' | 'phone' | 'gradeCode' | 'audienceCodes'>>) {
  const missing = settings.venues.required.filter((f) => {
    if (f === 'contacts' || f === 'photos') return false;
    const value = v[f];
    return Array.isArray(value) ? value.length === 0 : !value || !String(value).trim();
  });
  if (missing.length) {
    throw badRequest('VALIDATION_ERROR', `این موارد برای مکان لازم است: ${missing.map((f) => VENUE_FIELD_LABELS[f].fa).join('، ')}.`, {
      issues: missing.map((f) => ({ path: f, message: `«${VENUE_FIELD_LABELS[f].fa}» الزامی است` })),
    });
  }
}

/** The lists a venue's codes must come from. */
export async function assertVenueOptions(organizationId: string, v: Partial<VenueInput>, kept: { typeCode?: string | null; gradeCode?: string | null; audienceCodes?: string[] } = {}, db: Tx | typeof prisma = prisma) {
  await assertOptions(organizationId, [
    { list: 'VENUE_TYPE', codes: [v.typeCode], field: 'typeCode', kept: [kept.typeCode] },
    { list: 'VENUE_GRADE', codes: [v.gradeCode], field: 'gradeCode', kept: [kept.gradeCode] },
    { list: 'AUDIENCE', codes: v.audienceCodes ?? [], field: 'audienceCodes', kept: kept.audienceCodes ?? [] },
    { list: 'CONTACT_ROLE', codes: (v.contacts ?? []).map((c) => c.roleCode), field: 'contacts' },
    { list: 'CHANNEL', codes: [...(v.channels ?? []), ...(v.contacts ?? []).flatMap((c) => c.channels)].map((c) => c.typeCode), field: 'channels' },
  ], db);
}

export interface VenueOrigin { source?: 'MANUAL' | 'IMPORT'; importId?: string | null; importedValues?: unknown }

/** A new venue with its contacts and channels, in the caller's transaction. Duplicates are the caller's to check. */
export async function createVenue(tx: Tx, actor: SiteActor, input: VenueInput, origin: VenueOrigin = {}) {
  const venue = await tx.venue.create({
    data: {
      organizationId: actor.organizationId, code: await nextCode(tx, 'venue'),
      name: input.name, nameKey: nameKey(input.name), province: input.province, city: input.city,
      address: input.address ?? null, typeCode: input.typeCode, gradeCode: input.gradeCode ?? null, audienceCodes: input.audienceCodes,
      phone: input.phone ?? null, phoneKey: phoneKey(input.phone), email: input.email ?? null, website: input.website ?? null,
      notes: input.notes ?? null, isActive: input.isActive,
      source: origin.source ?? 'MANUAL', importId: origin.importId ?? null,
      importedValues: (origin.importedValues ?? undefined) as Prisma.InputJsonValue | undefined,
      createdById: actor.id,
    },
  });
  for (const ch of input.channels ?? []) {
    await tx.venueChannel.create({ data: { organizationId: actor.organizationId, venueId: venue.id, typeCode: ch.typeCode, value: ch.value, note: ch.note ?? null } });
  }
  let primaryTaken = false;
  for (const c of input.contacts ?? []) {
    const isPrimary: boolean = c.isPrimary && !primaryTaken;
    primaryTaken ||= isPrimary;
    await addContact(tx, actor.organizationId, venue.id, { ...c, isPrimary });
  }
  await audit({ ...ctx(actor), action: origin.source === 'IMPORT' ? 'IMPORT' : 'CREATE', entityType: 'venue', entityId: venue.id, after: { ...venue, contacts: input.contacts?.length ?? 0 } }, tx);
  return venue;
}

export async function addContact(tx: Tx, organizationId: string, venueId: string, c: {
  fullName: string; roleCode: string; jobTitle?: string | null; phone?: string | null; email?: string | null; notes?: string | null; isPrimary: boolean;
  channels?: { typeCode: string; value: string; note?: string | null }[];
}) {
  // One primary contact per venue: naming a new one hands the title over (the database holds it to one).
  if (c.isPrimary) await tx.venueContact.updateMany({ where: { organizationId, venueId, isPrimary: true }, data: { isPrimary: false } });
  const contact = await tx.venueContact.create({
    data: {
      organizationId, venueId, fullName: c.fullName, roleCode: c.roleCode, jobTitle: c.jobTitle ?? null,
      phone: c.phone ?? null, phoneKey: phoneKey(c.phone), email: c.email ?? null, notes: c.notes ?? null, isPrimary: c.isPrimary,
    },
  });
  for (const ch of c.channels ?? []) {
    await tx.venueChannel.create({ data: { organizationId, venueId, contactId: contact.id, typeCode: ch.typeCode, value: ch.value, note: ch.note ?? null } });
  }
  return contact;
}

/** Refuses a venue that looks like another, unless the person saw the candidates and said it is not one of them. */
export function assertNotDuplicate(candidates: DuplicateCandidate[], confirmed: boolean) {
  if (candidates.length && !confirmed) {
    throw conflict('POSSIBLE_DUPLICATE', `این مکان شبیه ${candidates.length === 1 ? 'مکان' : `${candidates.length} مکان`} ثبت‌شده است: ${candidates.slice(0, 3).map((c) => `${c.name} (${c.city})`).join('، ')}. اگر مکان دیگری است، با تأیید «تکراری نیست» ثبتش کنید.`, { candidates });
  }
}
