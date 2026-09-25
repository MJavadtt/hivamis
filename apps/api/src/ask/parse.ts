/**
 * A Persian question → a plan against the catalogue (roadmap #27). Rule-based and deterministic.
 *
 * Every part of the question it uses is consumed from the text; what is left, less the words that
 * carry no meaning («چقدر», «بوده», «پروژه‌های»), is returned as `ignored` — because the failure
 * this feature must not have is a confident answer to a question it only half read. A filter the
 * person asked for and the parser did not apply is said out loud, never dropped.
 *
 * Names are resolved in order of how much they claim: full names of people, clients and projects
 * first (so «سپیده آذر» is a person before «آذر» can be a month, and «بازطراحی هویت دیجیتال» is a
 * project before «دیجیتال» can be a unit), then the window, then the metric, then partial names.
 * A name that fits two records is a question back, not a guess.
 */
import { normalisePersian } from '../memory/embed.js';
import { ALL_TIME, parsePeriod, type Period } from './periods.js';
import { ENTITY_WORDS, METRICS, type Dim, type Filters } from './catalog.js';

export interface Vocab {
  people: { id: string; fullName: string; departmentCode: string | null }[];
  companies: { id: string; legalName: string; brandName: string | null }[];
  projects: { id: string; code: string; name: string }[];
}
export interface Option { value: string; labelFa: string }
export interface Clarify { kind: 'metric' | 'client' | 'project' | 'person' | 'entity'; questionFa: string; options: Option[] }

export interface Parsed {
  metrics: string[];
  filters: Filters;
  period: Period;
  groupBy: Dim | null;
  compare: boolean;
  sort: 'desc' | 'asc' | null;
  ignored: string[];
  clarify: Clarify | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
/** Whole words, with the plural and ezafe endings Persian attaches without a space. */
const word = (phrase: string, suffixes = true) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(phrase)}${suffixes ? '(?:ها|های|هایی|ی|ای)?' : ''}(?![\\p{L}\\p{N}])`, 'u');

class Text {
  constructor(public rest: string) {}
  /** Find, remove, and return the match. */
  take(re: RegExp): RegExpMatchArray | null {
    const m = this.rest.match(re);
    if (!m || m.index === undefined) return null;
    this.rest = this.rest.slice(0, m.index) + ' '.repeat(m[0].length) + this.rest.slice(m.index + m[0].length);
    return m;
  }
  has(re: RegExp) { return re.test(this.rest); }
}

const UNIT_WORDS: [string, string[]][] = [
  ['DM', ['دیجیتال مارکتینگ', 'دیجیتال', 'digital']],
  ['A', ['مدیریت حساب', 'اکانت', 'account']],
  ['OP', ['کنترل پروژه', 'عملیات', 'pmo']],
  ['ME', ['رسانه', 'مدیا', 'media']],
  ['CR', ['خلاقیت', 'کریتیو', 'creative', 'تولید']],
  ['ST', ['استراتژی', 'استراتژیک', 'strategy']],
  ['S', ['فروش', 'sales']],
  ['FI', ['مالی', 'finance']],
  ['LG', ['حقوقی', 'legal']],
];

const DIM_WORDS: [Dim, string][] = [
  ['unit', 'واحد'], ['client', 'مشتری|مشتریان|کارفرما'], ['project', 'پروژه'], ['month', 'ماه'],
  ['person', 'نفر|شخص|فرد|همکار|کارمند|کارشناس|مسئول|فروشنده|مدیر حساب|مدیران حساب'],
  ['reason', 'دلیل|علت'], ['policy', 'سیاست|نوع sla|sla'], ['state', 'مرحله|وضعیت'],
];

/** Company-name words that identify nothing on their own. */
const GENERIC = new Set(['شرکت', 'گروه', 'صنعتی', 'صنایع', 'بازرگانی', 'تولیدی', 'سهامی', 'خاص', 'عام', 'موسسه', 'هلدینگ', 'بین', 'المللی', 'ایران', 'ایرانیان', 'و', 'co', 'ltd', 'group']);

/** Words a question needs and a filter never is. */
const STOP = new Set([
  'و', 'در', 'به', 'از', 'که', 'این', 'را', 'با', 'است', 'برای', 'آن', 'ان', 'یک', 'می', 'شد', 'شده', 'های', 'ها', 'هایی', 'تا', 'بر', 'هم', 'یا',
  'بود', 'باید', 'کرد', 'کند', 'شود', 'نیز', 'اگر', 'ی', 'ای', 'چقدر', 'چه', 'چند', 'چی', 'چطور', 'چگونه', 'کدام', 'کدوم', 'چیست', 'چیه',
  'بوده', 'بودن', 'هست', 'هستند', 'بودند', 'داشته', 'داشتیم', 'داشتند', 'داشتن', 'دارد', 'دارند', 'اند', 'ایم', 'کرده', 'کردیم', 'شدند', 'میشود',
  'کل', 'مجموع', 'جمع', 'میانگین', 'متوسط', 'درصد', 'نرخ', 'مقدار', 'میزان', 'عدد', 'رقم', 'تعداد', 'شمار', 'شاخص', 'گزارش', 'وضعیت',
  'پروژه', 'واحد', 'واحدهای', 'مشتری', 'مشتریان', 'سازمان', 'اژانس', 'ما', 'شرکت', 'لطفا', 'بگو', 'بگید', 'بده', 'بدهید', 'نشان', 'بفرمایید',
  'ببینم', 'بدانم', 'میخواهم', 'خواهم', 'الان', 'اکنون', 'فعلا', 'همه', 'تمام', 'کلی', 'جاری', 'اخیر', 'گذشته', 'قبل', 'طی', 'طول', 'مدت',
  'دوره', 'بازه', 'زمان', 'انجام', 'گرفته', 'هر', 'بین', 'مورد', 'کار', 'کارها', 'موجود', 'فعلی', 'بفرست', 'نمایش', 'جزییات', 'جزئیات',
  // «من» reaches here only when it was not «مال من» — «به من بگو» filters nothing.
  'من', 'تو', 'شما',
  'what', 'how', 'much', 'many', 'is', 'was', 'the', 'of', 'in', 'for', 'by', 'and', 'our',
]);

function distinctiveTokens(name: string): string[] {
  return normalisePersian(name).split(' ').filter((t) => t.length >= 3 && !GENERIC.has(t));
}

export function parseQuestion(question: string, now: Date, vocab: Vocab, actorId: string): Parsed {
  const t = new Text(` ${normalisePersian(question)} `);
  const filters: Filters = {};
  let clarify: Clarify | null = null;
  const ask = (c: Clarify) => { clarify ??= c; };

  // ── Project codes, exactly as they are printed (PRJ-000016 → «prj 000016» once normalised).
  const code = t.take(/(?<![\p{L}])prj\s*(\d{1,8})(?![\p{N}])/u);
  if (code) {
    const wanted = `PRJ-${code[1]!.padStart(6, '0')}`;
    const p = vocab.projects.find((x) => x.code.toUpperCase() === wanted);
    if (p) filters.projectId = p.id;
    else ask({ kind: 'project', questionFa: `پروژه‌ای با کد ${wanted} در دسترس شما نیست.`, options: [] });
  }

  // ── Full names first: they claim the most text, and hide the words inside them from later rules.
  const fullPeople = vocab.people.filter((p) => t.has(word(normalisePersian(p.fullName), false)));
  if (fullPeople.length === 1) { filters.personId = fullPeople[0]!.id; t.take(word(normalisePersian(fullPeople[0]!.fullName), false)); }
  else if (fullPeople.length > 1) {
    ask({ kind: 'person', questionFa: 'منظور کدام همکار است؟', options: fullPeople.map((p) => ({ value: p.id, labelFa: p.fullName })) });
    t.take(word(normalisePersian(fullPeople[0]!.fullName), false));
  }

  if (!filters.projectId) {
    const fullProjects = vocab.projects.filter((p) => t.has(word(normalisePersian(p.name), false)));
    if (fullProjects.length === 1) { filters.projectId = fullProjects[0]!.id; t.take(word(normalisePersian(fullProjects[0]!.name), false)); }
  }
  const companyNames = (c: Vocab['companies'][number]) => [c.legalName, c.brandName].filter(Boolean).map((n) => normalisePersian(n!));
  const fullCompanies = vocab.companies.filter((c) => companyNames(c).some((n) => t.has(word(n))));
  if (fullCompanies.length === 1) {
    filters.companyId = fullCompanies[0]!.id;
    for (const n of companyNames(fullCompanies[0]!)) t.take(word(n));
  }

  // ── "Compared with last month" before the window, or «ماه گذشته» would be read as the window.
  const compare = !!t.take(/(?:در\s+)?مقایسه(?:\s+با\s+(?:دوره|ماه|فصل|سال|هفته)(?:\s+(?:قبل|گذشته|پیش))?)?|نسبت\s+به\s+(?:دوره|ماه|فصل|سال|هفته)(?:\s+(?:قبل|گذشته|پیش))?|نسبت\s+به\s+قبل/);

  const found = parsePeriod(t.rest, now);
  if (found) t.take(new RegExp(escape(found.span)));
  const period = found?.period ?? ALL_TIME;

  let sort: 'desc' | 'asc' | null = null;
  // «بهترین» is not here: whether best is highest depends on the metric, and guessing is the one
  // thing this must not do — left unused, it is reported as such.
  if (t.take(/بیشترین|بیش\s+ترین|بالاترین|بالا\s+ترین/)) sort = 'desc';
  else if (t.take(/کمترین|کم\s+ترین|پایین\s*ترین/)) sort = 'asc';

  // ── Split: «به تفکیک واحد», «هر مشتری», «کدام واحد», «ماه به ماه».
  let groupBy: Dim | null = null;
  if (t.take(/ماه\s+به\s+ماه|ماهانه|ماهیانه/)) groupBy = 'month';
  for (const [dim, words] of DIM_WORDS) {
    if (groupBy) break;
    const m = t.take(new RegExp(`(?:به\\s+تفکیک|بر\\s+اساس|برحسب|بر\\s+حسب|به\\s+ازای|هر|کدام|کدوم|کدامیک|کدام\\s+یک)\\s+(?:${words.replace(/ /g, '\\s+')})(?:ها|های|ی)?(?![\\p{L}])`, 'u'));
    if (m) { groupBy = dim; if (/کدام|کدوم/.test(m[0]) && !sort) sort = 'desc'; }
  }
  if (!groupBy && t.take(/(?<![\p{L}])واحد\s*ها(?:ی)?(?![\p{L}])/u)) groupBy = 'unit';

  // ── The metric: every synonym that appears; a phrase beats the words inside it; a strong
  //    word beats a weak one; two strong metrics is a question back.
  const hits: { key: string; start: number; end: number; weak: boolean }[] = [];
  for (const spec of METRICS) {
    for (const syn of spec.synonyms) {
      const re = new RegExp(word(normalisePersian(syn)).source, 'gu');
      for (const m of t.rest.matchAll(re)) {
        hits.push({ key: spec.key, start: m.index!, end: m.index! + m[0].length, weak: (spec.weak ?? []).includes(syn) });
      }
    }
  }
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start));
  const strong = new Set(kept.filter((h) => !h.weak).map((h) => h.key));
  const chosen = kept.filter((h) => (strong.size ? strong.has(h.key) : true));
  const metrics = [...new Set(chosen.map((h) => h.key))];
  for (const h of chosen.sort((a, b) => b.start - a.start)) {
    t.rest = t.rest.slice(0, h.start) + ' '.repeat(h.end - h.start) + t.rest.slice(h.end);
  }
  if (metrics.length > 1) {
    ask({ kind: 'metric', questionFa: 'پرسش به بیش از یک شاخص می‌خورد؛ کدام منظور است؟', options: metrics.map((k) => ({ value: k, labelFa: METRICS.find((m) => m.key === k)!.labelFa })) });
  }

  // ── Which process, for cycle time.
  if (metrics.includes('cycle_time')) {
    for (const [entity, words] of ENTITY_WORDS) {
      if (words.some((w) => t.take(word(normalisePersian(w))))) { filters.entity = entity; break; }
    }
  }

  // ── A project by three of its words (before units: project names are full of unit words).
  if (!filters.projectId) {
    const scored = vocab.projects.map((p) => {
      const tokens = distinctiveTokens(p.name);
      return { p, tokens, hits: tokens.filter((w) => t.has(word(w))).length };
    }).filter((s) => s.hits >= Math.min(3, s.tokens.length) && s.hits >= 2);
    const best = Math.max(0, ...scored.map((s) => s.hits));
    const top = scored.filter((s) => s.hits === best);
    if (top.length === 1) { filters.projectId = top[0]!.p.id; for (const w of top[0]!.tokens) t.take(word(w)); }
    else if (top.length > 1) {
      ask({ kind: 'project', questionFa: 'منظور کدام پروژه است؟', options: top.map((s) => ({ value: s.p.id, labelFa: `${s.p.name} (${s.p.code})` })) });
      for (const s of top) for (const w of s.tokens) t.take(word(w));
    }
  }
  // ── Units named as filters.
  const units: string[] = [];
  for (const [code, words] of UNIT_WORDS) {
    for (const w of words) if (t.take(word(normalisePersian(w)))) { if (!units.includes(code)) units.push(code); }
  }
  if (units.length) filters.units = units;

  // A client by its distinctive words — after units, so «واحد رسانه» is never the client «رسانه نوین».
  if (!filters.companyId) {
    const scored = vocab.companies.map((c) => {
      const tokens = [...new Set(companyNames(c).flatMap((n) => n.split(' ')).filter((w) => w.length >= 3 && !GENERIC.has(w) && !STOP.has(w)))];
      return { c, tokens, hits: tokens.filter((w) => t.has(word(w))).length };
    }).filter((s) => s.hits > 0);
    const best = Math.max(0, ...scored.map((s) => s.hits));
    const top = scored.filter((s) => s.hits === best);
    if (top.length === 1) {
      filters.companyId = top[0]!.c.id;
      for (const n of companyNames(top[0]!.c)) for (const w of n.split(' ')) t.take(word(w));
    } else if (top.length > 1) {
      ask({ kind: 'client', questionFa: 'منظور کدام مشتری است؟', options: top.map((s) => ({ value: s.c.id, labelFa: s.c.legalName })) });
      // The shared word was used — to ask — so it is not reported as unused as well.
      for (const s of top) for (const w of s.tokens) t.take(word(w));
    }
  }

  // ── People: «من» / «خودم» is the asker (but not «به من بگو»); otherwise one unique name.
  if (!filters.personId) {
    if (t.take(/(?<![\p{L}])(?:خودم|خود\s+من)(?![\p{L}])/u) || t.take(/(?<![\p{L}]|به\s|برای\s|از\s)(?<![\p{L}])من(?![\p{L}])/u)) {
      filters.personId = actorId;
    } else {
      for (const pick of [(n: string[]) => n.at(-1)!, (n: string[]) => n[0]!]) {
        const byName = new Map<string, Vocab['people']>();
        for (const p of vocab.people) {
          const k = pick(normalisePersian(p.fullName).split(' '));
          if (k.length > 2) (byName.get(k) ?? byName.set(k, []).get(k)!).push(p);
        }
        const matched = [...byName.entries()].filter(([k]) => t.has(word(k, false)));
        if (matched.length !== 1) continue;
        const [k, people] = matched[0]!;
        if (people.length === 1) filters.personId = people[0]!.id;
        else ask({ kind: 'person', questionFa: 'منظور کدام همکار است؟', options: people.map((p) => ({ value: p.id, labelFa: p.fullName })) });
        t.take(word(k, false));
        break;
      }
    }
  }

  // Whatever is left and means something was not used, and the answer will say so.
  const ignored = t.rest.split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));

  return { metrics, filters, period, groupBy, compare, sort, ignored, clarify };
}
