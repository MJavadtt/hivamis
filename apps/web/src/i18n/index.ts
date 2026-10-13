/**
 * The interface in the reader's language (Hivamis task 7). Persian is the source: every visible
 * string is written in Persian and passed through `tr`, which returns it as it is in Persian and its
 * English from the catalogue in English. Placeholders `{0}`, `{1}`… keep a sentence whole, so a
 * translation can put the values where English wants them.
 *
 * Two catalogues: this app's own words (./en.json), and what the API and the contracts put in front
 * of people — states, transitions, rule messages, form fields (@hiva/contracts/i18n/en.json). Text
 * that arrives already composed («فرم A01 ثبت شد») is read back against the second: see `trx`.
 *
 * The language is read once, when the app loads; switching it reloads the page. That is what lets
 * a label declared at module level — a tab list, a column header — be translated like any other.
 * The catalogues are loaded only for English, before the first render (main.tsx); a Persian reader
 * downloads none of them.
 */
import { createTranslator, translateTemplate, type Catalogue, type Translator } from '@hiva/contracts';

export type Locale = 'fa' | 'en';
export const LOCALE_KEY = 'hiva.locale';

function stored(): Locale {
  try { return localStorage.getItem(LOCALE_KEY) === 'en' ? 'en' : 'fa'; } catch { return 'fa'; }
}

let current: Locale = typeof window === 'undefined' ? 'fa' : stored();
let translator: Translator | null = null;

/** The language this page was loaded in. */
export const locale = (): Locale => current;
export const isEnglish = () => current === 'en';

/** Fetches the English catalogues. Resolves at once in Persian. */
export async function loadCatalogues(): Promise<void> {
  if (current !== 'en' || translator) return;
  const [web, shared] = await Promise.all([import('./en.json'), import('@hiva/contracts/i18n/en.json')]);
  translator = createTranslator(web.default as Catalogue, shared.default as Catalogue);
}

/** Tests only: render a component in a language without reloading anything. */
export async function setLocaleForTests(l: Locale): Promise<void> {
  current = l;
  translator = null;
  await loadCatalogues();
}

const missing = new Set<string>();

const fill = (template: string, args: readonly unknown[]) =>
  args.length ? template.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)] ?? '') : m)) : template;

/**
 * A visible string in the reader's language. In Persian, the string itself. In English, its
 * translation — and each value going into it read as well: a state or role name in its English, a
 * number in Latin digits. A person's name, which no catalogue holds, stays as written.
 */
export function tr(fa: string, ...args: unknown[]): string {
  if (current === 'fa' || !translator) return fill(fa, args);
  if (translator.exact(fa) === undefined && import.meta.env?.DEV && !missing.has(fa)) {
    missing.add(fa);
    console.warn(`[i18n] no English for «${fa}»`);
  }
  return translateTemplate(translator, fa, args);
}

/**
 * Text that arrives from the API or the contracts rather than being written here: a state label, a
 * rule message, a notification. In English it is matched against what the server composes from;
 * what nothing matches — a client's name, a brief someone typed — is returned unchanged.
 */
export function trx(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return current === 'en' && translator ? translator.translate(text) : faDigits(text);
}

const PERSIAN = /[؀-ۿ]/;
// A number standing in the sentence — not part of a code (PRJ-000016), a name (qwen3:8b) or an address.
const NUMBER = /(?<![A-Za-z_\-:@#\d.])\d+(?:[./]\d+)*(?![A-Za-z_\-:@\d])/g;

/**
 * Persian digits in Persian text from the server: a rule message, a finding, a note («دست‌کم 12 واژه»
 * read as «دست‌کم ۱۲ واژه»; audit UI-V). Text with no Persian in it is left as it is.
 */
export function faDigits(text: string): string {
  if (!PERSIAN.test(text) || !/\d/.test(text)) return text;
  return text.replace(NUMBER, (n, at: number) => {
    // An address (127.0.0.1) stays as written; so does a number whose nearest word is Latin («slide 34»).
    if (/^\d+(\.\d+){3}$/.test(n) || /[A-Za-z]\s*$/.test(text.slice(Math.max(0, at - 12), at))) return n;
    return n.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!).replace(/\./g, '٫');
  });
}

/**
 * One side of a bilingual record: `loc(role, 'name')` reads nameFa or nameEn. An English side that
 * is missing — or that someone filled with Persian — falls back to reading the Persian side.
 */
export function loc(source: object | null | undefined, base: string): string {
  if (!source) return '';
  const bag = source as Record<string, unknown>;
  const fa = bag[`${base}Fa`];
  if (current === 'fa') return faDigits(String(fa ?? ''));
  const en = bag[`${base}En`];
  if (typeof en === 'string' && en.trim() && !/[؀-ۿ]/.test(en)) return en;
  return trx(typeof fa === 'string' ? fa : '');
}

/** One side of a `{ fa, en }` pair — the shape ROLE_LABELS, DEPARTMENT_LABELS and MODULE_LABELS use. */
export function pair(p: { fa: string; en?: string } | null | undefined): string {
  if (!p) return '';
  return current === 'en' ? (p.en || trx(p.fa)) : p.fa;
}

/** The arrow for "then" in a sequence: right-to-left in Persian, left-to-right in English. */
export const flow = (): string => (current === 'en' ? '→' : '←');
