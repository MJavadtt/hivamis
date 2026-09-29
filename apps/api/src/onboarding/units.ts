/**
 * An organisation's own unit names, mapped to Doc_H's ten units (roadmap #48).
 *
 * Nobody's org chart says «CR»: it says «واحد طراحی و گرافیک» or «استودیو». The users file carries
 * those names; the map, kept in the organisation's settings, turns each into one of the ten units
 * the rules are written for. Suggestions come from the words in the name, and are only suggestions
 * — a person confirms the map before any user is created.
 */
import { DEPARTMENT_CODES, type DepartmentCode } from '@hiva/contracts';
import type { Tx } from '../db.js';

/** The key a name is compared by: Persian letters, no half-spaces or spacing, lower case. */
export const nameKey = (s: string) => s.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[‌\s\-_.،,()]/g, '').toLowerCase();

/** In order: a more specific phrase («مدیریت مشتری») before the word it contains («مدیریت»). */
const SUGGEST: [DepartmentCode, string[]][] = [
  ['A', ['اکانت', 'مدیریتمشتری', 'مدیریتحساب', 'ارتباطبامشتری', 'امورمشتریان', 'خدماتمشتری', 'account', 'clientservice']],
  ['ST', ['استراتژی', 'راهبرد', 'برنامهریزی', 'تحقیقاتبازار', 'پژوهش', 'بینش', 'strategy', 'planning', 'insight', 'research']],
  ['DM', ['دیجیتال', 'سوشال', 'شبکههایاجتماعی', 'اینستاگرام', 'سئو', 'digital', 'social', 'performance', 'seo']],
  ['ME', ['رسانه', 'خریدرسانه', 'تبلیغاتمحیطی', 'media']],
  ['CR', ['خلاق', 'طراحی', 'گرافیک', 'تولیدمحتوا', 'تولید', 'کپیرایت', 'استودیو', 'ویدئو', 'ویدیو', 'انیمیشن', 'creative', 'design', 'studio', 'content', 'production']],
  ['S', ['فروش', 'بازرگانی', 'توسعهبازار', 'توسعهکسبوکار', 'sales', 'businessdevelopment', 'bizdev']],
  ['FI', ['مالی', 'حسابداری', 'خزانه', 'finance', 'accounting']],
  ['LG', ['حقوقی', 'قرارداد', 'legal']],
  ['OP', ['عملیات', 'کنترلپروژه', 'مدیریتپروژه', 'پروژه', 'pmo', 'operations', 'projectmanagement']],
  ['M', ['مدیرعامل', 'مدیریت', 'هیئتمدیره', 'هیاتمدیره', 'ریاست', 'دفترمدیریت', 'management', 'ceo', 'board']],
];

export function suggestUnit(name: string): DepartmentCode | null {
  const key = nameKey(name);
  if ((DEPARTMENT_CODES as readonly string[]).includes(name.trim().toUpperCase())) return name.trim().toUpperCase() as DepartmentCode;
  return SUGGEST.find(([, words]) => words.some((w) => key.includes(w)))?.[0] ?? null;
}

export type UnitMap = Record<string, DepartmentCode>;

export async function unitMapOf(tx: Tx, organizationId: string): Promise<UnitMap> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } });
  return ((org.settings as { unitMap?: UnitMap } | null)?.unitMap ?? {}) as UnitMap;
}

/**
 * A unit as a row names it: a Doc_H code, the organisation's own name from the map, or Doc_H's
 * own Persian name for the unit. Never a guess — an unmapped name is an issue for the row.
 */
export function resolveUnit(name: string, map: UnitMap, departments: { code: string; nameFa: string }[]): string | null {
  const code = name.trim().toUpperCase();
  if (departments.some((d) => d.code === code)) return code;
  const key = nameKey(name);
  const mapped = Object.entries(map).find(([k]) => nameKey(k) === key)?.[1];
  if (mapped) return mapped;
  return departments.find((d) => nameKey(d.nameFa) === key)?.code ?? null;
}
