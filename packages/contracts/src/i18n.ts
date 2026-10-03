/**
 * Hivamis task 7 — reading Persian text in English.
 *
 * Persian is the source language everywhere: the web's own words, the contracts' labels, and what
 * the API composes («فرم {0} ثبت شد»). A catalogue maps each Persian source — with `{0}`, `{1}`
 * where a value goes — to its English. Text that was composed from a known source can be read
 * back: the template is matched, the values recovered, and each value translated in its turn
 * (a state name inside a sentence) or, if it is only a number, given Latin digits.
 *
 * What no catalogue knows — a person's name, a client's brief — stays as it was written.
 */

export type Catalogue = Readonly<Record<string, string>>;

const PERSIAN = /[؀-ۿ]/;
const PERSIAN_DIGITS = /[۰-۹٠-٩]/g;
const HAS_PERSIAN_DIGIT = /[۰-۹٠-٩]/;
/** A value that is only a number as Persian writes it: digits, separators, a sign, a percent. */
const NUMERIC = /^[\s۰-۹٠-٩0-9٫٬,.\-+−٪%/:]+$/;

export const hasPersian = (s: string): boolean => PERSIAN.test(s);

/** Persian or Arabic-Indic digits and separators → Latin. */
export function latinDigits(s: string): string {
  return s
    .replace(PERSIAN_DIGITS, (d) => {
      const c = d.charCodeAt(0);
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    })
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/٪/g, '%')
    .replace(/−/g, '-');
}

/** How composed labels are joined, and how the English joins them. */
const SEPARATORS: [string, string][] = [[' — ', ' — '], [' · ', ' · '], ['، ', ', '], [' / ', ' / '], [' ← ', ' → ']];

const fill = (template: string, args: readonly string[]) =>
  template.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? args[Number(i)]! : m));

interface Pattern {
  re: RegExp; english: string; order: number[]; weight: number;
  /** For each pair of neighbouring values, whether only whitespace separates them in the source. */
  touching: boolean[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Turns «فرم {0} برای {1}» into a regex with one lazy group per placeholder. */
function compile(source: string, english: string): Pattern | null {
  const parts = source.split(/\{(\d+)\}/);
  if (parts.length === 1) return null;
  const literal = parts.filter((_, i) => i % 2 === 0).join('');
  // A template with no Persian of its own («{0} — {1}») would match anything.
  if (!PERSIAN.test(literal)) return null;
  let re = '^';
  const order: number[] = [];
  parts.forEach((p, i) => {
    if (i % 2 === 0) re += escape(p);
    else { re += '([\\s\\S]*?)'; order.push(Number(p)); }
  });
  const touching = order.slice(1).map((_, k) => /^\s+$/.test(parts[2 * k + 2] ?? ''));
  return { re: new RegExp(`${re}$`), english, order, weight: literal.length, touching };
}

export interface Translator {
  /** The English of a known source, or undefined. */
  exact(fa: string): string | undefined;
  /**
   * Best English for a piece of text: the catalogue's own entry, else a template it was composed
   * from (values translated in turn), else the text with Latin digits if it is only a number.
   * Text that is not Persian, or that nothing matches, is returned unchanged.
   */
  translate(text: string): string;
  /** One value going into a sentence: translated if Persian, Latin digits if a number. */
  value(v: unknown): string;
}

export function createTranslator(...catalogues: Catalogue[]): Translator {
  const table = new Map<string, string>();
  for (const c of catalogues) for (const [k, v] of Object.entries(c)) if (!table.has(k)) table.set(k, v);
  let patterns: Pattern[] | null = null;
  const cache = new Map<string, string>();

  /** 1 when the catalogue knows a value outright, or it is a number; 0 otherwise. */
  const known = (v: string) => (table.has(v.trim()) || NUMERIC.test(v) ? 1 : 0);

  const compiled = () => {
    if (!patterns) {
      patterns = [];
      for (const [k, v] of table) { const p = compile(k, v); if (p) patterns.push(p); }
      // The most specific template first: more fixed text means less left to guess.
      patterns.sort((a, b) => b.weight - a.weight);
    }
    return patterns;
  };

  const translate = (text: string, depth = 0): string => {
    if (!text || (!PERSIAN.test(text) && !HAS_PERSIAN_DIGIT.test(text))) return text;
    const hit = table.get(text);
    if (hit !== undefined) return hit;
    const trimmed = text.trim();
    if (trimmed !== text && trimmed) {
      const inner = translate(trimmed, depth);
      if (inner !== trimmed) return text.replace(trimmed, inner);
    }
    if (NUMERIC.test(text)) return latinDigits(text);
    if (depth > 3) return text;
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    let out = text;
    for (const p of compiled()) {
      const m = p.re.exec(text);
      if (!m) continue;
      const raw = p.order.map((_, i) => m[i + 1] ?? '');
      // Two values with only a space between them («کوچک‌تر از ۲۰»): the first match is the shortest
      // left value; try every split and keep the one whose parts the catalogue knows best.
      p.touching.forEach((touch, k) => {
        if (!touch) return;
        const joined = `${raw[k]} ${raw[k + 1]}`;
        const words = joined.split(/\s+/);
        let best = { score: known(raw[k]!) + known(raw[k + 1]!), left: raw[k]!, right: raw[k + 1]! };
        for (let cut = 1; cut < words.length; cut++) {
          const left = words.slice(0, cut).join(' '), right = words.slice(cut).join(' ');
          const score = known(left) + known(right);
          if (score > best.score) best = { score, left, right };
        }
        raw[k] = best.left; raw[k + 1] = best.right;
      });
      const args: string[] = [];
      p.order.forEach((slot, i) => { args[slot] = translate(raw[i]!, depth + 1); });
      out = fill(p.english, args);
      break;
    }
    // A phrase joined from known parts — «تماس مستقیم — رویداد», «مدیر فروش · فروش» — part by part.
    if (out === text) {
      for (const [sep, joined] of SEPARATORS) {
        if (!text.includes(sep)) continue;
        const parts = text.split(sep);
        const read = parts.map((p) => translate(p, depth + 1));
        if (read.some((r, i) => r !== parts[i])) { out = read.join(joined); break; }
      }
    }
    // A month and its year — «آبان ۱۴۰۴» — word by word: only with a number in it, so a name made of
    // common words («فروش ویژه») is never taken apart.
    if (out === text && /\s/.test(text.trim())) {
      const words = text.trim().split(/\s+/);
      if (words.length <= 4 && words.some((w) => NUMERIC.test(w)) && words.every((w) => table.has(w) || NUMERIC.test(w))) {
        out = text.replace(text.trim(), words.map((w) => table.get(w) ?? latinDigits(w)).join(' '));
      }
    }
    // Unmatched, but its only Persian is digits (a code, a date): the digits at least.
    if (out === text && !PERSIAN.test(text.replace(PERSIAN_DIGITS, ''))) out = latinDigits(text);
    if (cache.size > 5000) cache.clear();
    cache.set(text, out);
    return out;
  };

  return {
    exact: (fa) => table.get(fa),
    translate: (text) => translate(text),
    value: (v) => (v === null || v === undefined ? '' : translate(String(v))),
  };
}

/** Fills a Persian source's English, each value read as above. */
export function translateTemplate(t: Translator, fa: string, args: readonly unknown[]): string {
  const english = t.exact(fa);
  const values = args.map((a) => t.value(a));
  return fill(english ?? fa, values);
}
