import {
  SITE_OPTION_DEFAULTS, SITE_OPTION_LISTS, SITE_OPTION_LIST_LABELS, siteSettingsSchema,
  type SiteOptionList, type SiteOptionMeta, type SiteSettings,
} from '@hiva/contracts';
import { prisma, type Tx } from '../db.js';
import { badRequest } from '../lib/errors.js';

/**
 * The organisation's own lists and settings for venues and rentals (ADR-103).
 *
 * An organisation starts with the document's examples — mall, metro, amusement park; A+, A, B; formal,
 * informal, invoice — written the first time it reads them, and edits them from there. Nothing in the
 * code names a type or a grade: what a rule needs to know of an option is in its `meta`.
 */

export interface SiteOptionRow {
  id: string; list: string; code: string; labelFa: string; labelEn: string | null;
  sortOrder: number; isActive: boolean; meta: SiteOptionMeta;
}

/** Writes the defaults an organisation does not have yet. Once per list: an option it retired stays retired. */
export async function ensureOptions(organizationId: string, db: Tx | typeof prisma = prisma): Promise<void> {
  const have = await db.siteOption.groupBy({ by: ['list'], where: { organizationId }, _count: { _all: true } });
  const seeded = new Set(have.map((h) => h.list));
  const missing = SITE_OPTION_LISTS.filter((l) => !seeded.has(l));
  if (!missing.length) return;
  await db.siteOption.createMany({
    data: missing.flatMap((list) => SITE_OPTION_DEFAULTS[list].map((o, i) => ({
      organizationId, list, code: o.code, labelFa: o.fa, labelEn: o.en, sortOrder: (i + 1) * 10, meta: (o.meta ?? {}) as object,
    }))),
    skipDuplicates: true,
  });
}

export async function optionsOf(organizationId: string, db: Tx | typeof prisma = prisma): Promise<SiteOptionRow[]> {
  await ensureOptions(organizationId, db);
  const rows = await db.siteOption.findMany({ where: { organizationId }, orderBy: [{ list: 'asc' }, { sortOrder: 'asc' }, { labelFa: 'asc' }] });
  return rows.map((r) => ({ ...r, meta: (r.meta ?? {}) as SiteOptionMeta }));
}

/** A list's options by code — the retired too, so a record written under one still reads. */
export async function optionMap(organizationId: string, list: SiteOptionList, db: Tx | typeof prisma = prisma) {
  const rows = (await optionsOf(organizationId, db)).filter((o) => o.list === list);
  return new Map(rows.map((r) => [r.code, r]));
}

/**
 * Refuses a code that is not an active option of the list. A record keeps a retired code it already
 * has (`kept`), but nothing new is written with one.
 */
export async function assertOptions(
  organizationId: string,
  checks: { list: SiteOptionList; codes: readonly (string | null | undefined)[]; field: string; kept?: readonly (string | null | undefined)[] }[],
  db: Tx | typeof prisma = prisma,
): Promise<void> {
  const all = await optionsOf(organizationId, db);
  for (const c of checks) {
    for (const value of c.codes) {
      if (!value) continue;
      const o = all.find((x) => x.list === c.list && x.code === value);
      if (o?.isActive || (o && c.kept?.includes(value))) continue;
      throw badRequest('UNKNOWN_OPTION', `«${value}» در فهرست «${SITE_OPTION_LIST_LABELS[c.list].fa}» نیست یا کنار گذاشته شده است.`, { field: c.field, list: c.list });
    }
  }
}

/** The organisation's settings, every part filled from its default. */
export async function settingsOf(organizationId: string, db: Tx | typeof prisma = prisma): Promise<SiteSettings> {
  const row = await db.siteSettings.findUnique({ where: { organizationId } });
  const parsed = siteSettingsSchema.safeParse(row?.settings ?? {});
  // A row an older version wrote and this one cannot read falls back to the defaults, never to an error.
  return parsed.success ? parsed.data : siteSettingsSchema.parse({});
}

/** Whether a reminder event is on: every event is, unless the organisation turned it off. */
export const eventOn = (s: SiteSettings, event: string) => s.reminders.enabled && (s.reminders.events as Record<string, boolean>)[event] !== false;
