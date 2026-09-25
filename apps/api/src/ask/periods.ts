/**
 * Time windows as people say them in Persian (roadmap #27), on the Jalali calendar.
 *
 * Works on text already passed through `normalisePersian` (Latin digits, no ZWNJ, «ا» for «آ»),
 * and reports the span it consumed so the caller can tell what in a question was *not* used.
 * Every window carries its own Persian label with the exact dates, because "the last three
 * months" is only checkable once it says which three.
 */
import { normalisePersian } from '../memory/embed.js';
import { JALALI_MONTHS, formatJalali, jalaliMonthLabel, jalaliOf, jalaliStart } from '../lib/jalali.js';

export type PeriodKind = 'ALL' | 'ROLLING' | 'MONTH' | 'QUARTER' | 'YEAR' | 'WEEK' | 'RANGE' | 'DAY';

export interface Period {
  kind: PeriodKind;
  from: Date | null;
  /** Exclusive. */
  to: Date | null;
  labelFa: string;
  /** True when the window is a whole calendar unit (a finished month, quarter, year or week). */
  complete: boolean;
}

export const ALL_TIME: Period = { kind: 'ALL', from: null, to: null, labelFa: 'از ابتدا تا امروز', complete: false };

const NUMBER_WORDS: Record<string, number> = {
  یک: 1, دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, هفت: 7, هشت: 8, نه: 9, ده: 10, یازده: 11, دوازده: 12,
};
const MONTHS_N = JALALI_MONTHS.map((m) => normalisePersian(m));
const FA = '۰۱۲۳۴۵۶۷۸۹';
const fa = (v: string | number) => String(v).replace(/\d/g, (c) => FA[Number(c)]!);

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const range = (from: Date, to: Date) => `${formatJalali(from)} تا ${formatJalali(addDays(to, -1))}`;

function month(jy: number, jm: number, now: Date): Period {
  const from = jalaliStart(jy, jm);
  const next = jalaliStart(jy, jm + 1);
  const complete = next <= now;
  return { kind: 'MONTH', from, to: complete ? next : startOfDay(addDays(now, 1)), labelFa: jalaliMonthLabel(jy, jm) + (complete ? '' : ' (تا امروز)'), complete };
}
function quarter(jy: number, q: number, now: Date, labelFa: string): Period {
  const from = jalaliStart(jy, (q - 1) * 3 + 1);
  const next = jalaliStart(jy, q * 3 + 1);
  const complete = next <= now;
  const to = complete ? next : startOfDay(addDays(now, 1));
  return { kind: 'QUARTER', from, to, labelFa: `${labelFa} (${range(from, to)})`, complete };
}
function year(jy: number, now: Date, labelFa: string): Period {
  const from = jalaliStart(jy, 1);
  const next = jalaliStart(jy + 1, 1);
  const complete = next <= now;
  const to = complete ? next : startOfDay(addDays(now, 1));
  return { kind: 'YEAR', from, to, labelFa: `${labelFa} (${range(from, to)})`, complete };
}
/** The Iranian week starts on Saturday. */
function weekStart(d: Date): Date { const x = startOfDay(d); while (x.getDay() !== 6) x.setDate(x.getDate() - 1); return x; }

/**
 * The first time window the text names, or null. `n` must be normalised; `now` is injectable so
 * tests do not depend on the day they run.
 */
export function parsePeriod(n: string, now: Date): { period: Period; span: string } | null {
  const j = jalaliOf(now);
  const tomorrow = startOfDay(addDays(now, 1));
  let m: RegExpMatchArray | null;

  // Said outright: all of it.
  m = n.match(/از\s+(?:ابتدا|اول|شروع)(?:\s+تا\s+(?:امروز|حالا|الان))?|(?:در\s+)?کل\s+(?:دوره|سابقه|تاریخچه)|تا\s+امروز|تاکنون|تا\s+کنون|همیشه/);
  if (m) return { period: ALL_TIME, span: m[0] };

  // از 1405 01 01 تا 1405 06 31 — the slashes are gone after normalisation.
  m = n.match(/(?:از\s+)?(1[34]\d\d)\s+(\d{1,2})\s+(\d{1,2})\s+(?:تا|الی)\s+(1[34]\d\d)\s+(\d{1,2})\s+(\d{1,2})/);
  if (m) {
    const from = jalaliStart(+m[1]!, +m[2]!, +m[3]!);
    const to = addDays(jalaliStart(+m[4]!, +m[5]!, +m[6]!), 1);
    if (to > from) return { period: { kind: 'RANGE', from, to, labelFa: range(from, to), complete: to <= now }, span: m[0] };
  }

  // «سه ماه گذشته»، «۹۰ روز اخیر»، «۲ هفته قبل»، «دو فصل گذشته»
  m = n.match(/(\d{1,3}|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|یازده|دوازده)\s+(ماه|روز|هفته|سال|فصل)(?:ه)?\s+(گذشته|اخیر|قبل|پیش|اخر)/);
  if (m) {
    const count = /\d/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!]!;
    const unit = m[2]!;
    let from: Date;
    if (unit === 'روز') from = startOfDay(addDays(now, -count));
    else if (unit === 'هفته') from = startOfDay(addDays(now, -7 * count));
    else {
      const months = unit === 'ماه' ? count : unit === 'فصل' ? count * 3 : count * 12;
      from = jalaliStart(j.y, j.m - months, j.d);
    }
    const unitFa = { روز: 'روز', هفته: 'هفته', ماه: 'ماه', فصل: 'فصل', سال: 'سال' }[unit]!;
    return { period: { kind: 'ROLLING', from, to: tomorrow, labelFa: `${fa(count)} ${unitFa} گذشته (${range(from, tomorrow)})`, complete: false }, span: m[0] };
  }

  // Month names: «مهر»، «مهر ۱۴۰۴»، «شهریور امسال»، «خرداد پارسال»
  for (const [i, name] of MONTHS_N.entries()) {
    m = n.match(new RegExp(`(?<![\\p{L}\\p{N}])${name}(?:\\s+ماه)?(?:\\s+(1[34]\\d\\d|امسال|پارسال|سال گذشته|سال قبل))?(?![\\p{L}\\p{N}])`, 'u'));
    if (!m) continue;
    let jy = j.y;
    if (m[1] && /\d/.test(m[1])) jy = Number(m[1]);
    else if (m[1] && m[1] !== 'امسال') jy = j.y - 1;
    else if (!m[1] && i + 1 > j.m) jy = j.y - 1;                // «اسفند» asked in مهر means last Esfand
    return { period: month(jy, i + 1, now), span: m[0] };
  }

  if ((m = n.match(/(?:این|همین)\s+ماه|ماه\s+(?:جاری|فعلی)/))) return { period: month(j.y, j.m, now), span: m[0] };
  if ((m = n.match(/ماه\s+(?:گذشته|قبل|پیش)/))) {
    const prev = j.m === 1 ? { y: j.y - 1, m: 12 } : { y: j.y, m: j.m - 1 };
    return { period: month(prev.y, prev.m, now), span: m[0] };
  }

  const q = Math.ceil(j.m / 3);
  if ((m = n.match(/(?:این|همین)\s+(?:فصل|سه\s*ماهه)|(?:فصل|سه\s*ماهه)\s+(?:جاری|فعلی)/))) return { period: quarter(j.y, q, now, 'فصل جاری'), span: m[0] };
  if ((m = n.match(/(?:فصل|سه\s*ماهه)\s+(?:گذشته|قبل|پیش)/))) {
    const pq = q === 1 ? { y: j.y - 1, q: 4 } : { y: j.y, q: q - 1 };
    return { period: quarter(pq.y, pq.q, now, 'فصل گذشته'), span: m[0] };
  }

  if ((m = n.match(/(?:این|همین)\s+هفته|هفته\s+(?:جاری|فعلی)/))) {
    const from = weekStart(now);
    return { period: { kind: 'WEEK', from, to: tomorrow, labelFa: `این هفته (${range(from, tomorrow)})`, complete: false }, span: m[0] };
  }
  if ((m = n.match(/هفته\s+(?:گذشته|قبل|پیش)/))) {
    const to = weekStart(now);
    const from = addDays(to, -7);
    return { period: { kind: 'WEEK', from, to, labelFa: `هفتهٔ گذشته (${range(from, to)})`, complete: true }, span: m[0] };
  }

  if ((m = n.match(/امسال|(?:این|همین)\s+سال|سال\s+(?:جاری|فعلی)|از\s+ابتدای\s+سال/))) return { period: year(j.y, now, 'امسال'), span: m[0] };
  if ((m = n.match(/پارسال|سال\s+(?:گذشته|قبل|پیش)/))) return { period: year(j.y - 1, now, 'سال گذشته'), span: m[0] };
  if ((m = n.match(/(?:سال\s+)?(?<![\d])(1[34]\d\d)(?![\d])/))) return { period: year(Number(m[1]), now, `سال ${fa(m[1]!)}`), span: m[0] };

  if ((m = n.match(/(?<![\p{L}])امروز(?![\p{L}])/u))) {
    const from = startOfDay(now);
    return { period: { kind: 'DAY', from, to: tomorrow, labelFa: `امروز (${formatJalali(now)})`, complete: false }, span: m[0] };
  }
  if ((m = n.match(/(?<![\p{L}])دیروز(?![\p{L}])/u))) {
    const from = startOfDay(addDays(now, -1));
    return { period: { kind: 'DAY', from, to: startOfDay(now), labelFa: `دیروز (${formatJalali(from)})`, complete: true }, span: m[0] };
  }
  return null;
}

/**
 * The window to compare against: the previous calendar unit when the window is a whole one
 * (مهر against شهریور), otherwise the stretch of equal length immediately before it.
 */
export function previousPeriod(p: Period, now: Date): Period | null {
  if (!p.from || !p.to) return null;
  if (p.complete && p.kind === 'MONTH') {
    const j = jalaliOf(p.from);
    return month(j.m === 1 ? j.y - 1 : j.y, j.m === 1 ? 12 : j.m - 1, now);
  }
  if (p.complete && p.kind === 'YEAR') { const j = jalaliOf(p.from); return year(j.y - 1, now, `سال ${fa(j.y - 1)}`); }
  if (p.complete && p.kind === 'QUARTER') {
    const j = jalaliOf(p.from); const q = Math.ceil(j.m / 3);
    return q === 1 ? quarter(j.y - 1, 4, now, 'فصل قبل') : quarter(j.y, q - 1, now, 'فصل قبل');
  }
  const length = p.to.getTime() - p.from.getTime();
  const from = new Date(p.from.getTime() - length);
  return { kind: 'RANGE', from, to: p.from, labelFa: `دورهٔ هم‌طول قبل (${range(from, p.from)})`, complete: true };
}

/** Presets the page offers when a person corrects the window by hand. */
export const PERIOD_PRESETS: Record<string, { labelFa: string; text: string }> = {
  ALL: { labelFa: 'از ابتدا', text: '' },
  LAST_30_DAYS: { labelFa: '۳۰ روز گذشته', text: '30 روز گذشته' },
  LAST_3_MONTHS: { labelFa: 'سه ماه گذشته', text: '3 ماه گذشته' },
  LAST_6_MONTHS: { labelFa: 'شش ماه گذشته', text: '6 ماه گذشته' },
  LAST_12_MONTHS: { labelFa: 'دوازده ماه گذشته', text: '12 ماه گذشته' },
  THIS_MONTH: { labelFa: 'این ماه', text: 'این ماه' },
  LAST_MONTH: { labelFa: 'ماه گذشته', text: 'ماه گذشته' },
  THIS_QUARTER: { labelFa: 'فصل جاری', text: 'این فصل' },
  LAST_QUARTER: { labelFa: 'فصل گذشته', text: 'فصل گذشته' },
  THIS_YEAR: { labelFa: 'امسال', text: 'امسال' },
  LAST_YEAR: { labelFa: 'سال گذشته', text: 'پارسال' },
};

/** A window from a preset or explicit dates (the page's correction path), with its label rebuilt here. */
export function resolvePeriod(input: { preset?: string | null; from?: Date | null; to?: Date | null }, now: Date): Period {
  if (input.from && input.to && input.to > input.from) {
    return { kind: 'RANGE', from: input.from, to: input.to, labelFa: range(input.from, input.to), complete: input.to <= now };
  }
  const preset = input.preset ? PERIOD_PRESETS[input.preset] : null;
  if (!preset || !preset.text) return ALL_TIME;
  return parsePeriod(normalisePersian(preset.text), now)?.period ?? ALL_TIME;
}
