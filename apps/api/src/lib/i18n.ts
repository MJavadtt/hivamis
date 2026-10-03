import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createTranslator, type Catalogue, type Translator } from '@hiva/contracts';

/**
 * The API's words in the language the request asks for (Hivamis task 7, ADR-056).
 *
 * Every message is written in Persian at the place it is raised — a guard, a validator, a route —
 * and stays that way in logs, the audit trail and anything stored. Only what goes back over the wire
 * as an error is read into English, when the request's Accept-Language puts English first: the
 * catalogue in @hiva/contracts recovers the template a message was composed from and translates the
 * values inside it. A message no catalogue knows goes out as it was written.
 */

export type Locale = 'fa' | 'en';

let translator: Translator | null = null;
function english(): Translator {
  if (!translator) {
    const file = createRequire(import.meta.url).resolve('@hiva/contracts/i18n/en.json');
    translator = createTranslator(JSON.parse(readFileSync(file, 'utf8')) as Catalogue);
  }
  return translator;
}

/** The first of Persian or English the header prefers; Persian when it names neither. */
export function requestLocale(header: string | string[] | undefined): Locale {
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  const ranked = raw
    .split(',')
    .map((part, i) => {
      const [tag = '', ...params] = part.trim().toLowerCase().split(';');
      const q = Number(params.find((p) => p.trim().startsWith('q='))?.split('=')[1] ?? 1);
      return { tag, q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
    if (tag === 'fa' || tag.startsWith('fa-')) return 'fa';
  }
  return 'fa';
}

export function translate(text: string, locale: Locale): string {
  return locale === 'en' ? english().translate(text) : text;
}

/** Keys in an error's details whose values are words for a person, not data. */
const WORDS = /^(message|messageFa|labelFa|titleFa|hintFa|reasonFa|verdictFa|rule)$/;

/** An error body's message, and the messages inside its details, in the request's language. */
export function localizeError<T extends { message: string; details?: unknown }>(error: T, locale: Locale): T {
  if (locale === 'fa') return error;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 6 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [
      k, typeof x === 'string' && WORDS.test(k) ? translate(x, locale) : walk(x, depth + 1),
    ]));
  };
  return { ...error, message: translate(error.message, locale), details: walk(error.details, 0) };
}
