/**
 * Minutes from notes (roadmap #23).
 *
 * Doc_H §6: no verbal task is valid, and `MEETING_MINUTES` is one of the six sources a task may
 * trace to. The minutes forms (J94/J95) already collect action items — and store them as JSON
 * that never becomes a task, so decisions stay verbal. Writing each one up as a task by hand is
 * the chore that nobody does.
 *
 * This reads the notes (typed, or a transcript) and proposes: the decisions, and the actions with
 * an owner and a due date where the text names them. Proposes — the person who ran the meeting
 * confirms, corrects and chooses what becomes a task. Rule-based and deterministic, so the same
 * notes always give the same draft and every proposal points at the line it came from; anything
 * it could not resolve is marked as such rather than guessed.
 */
import { normalisePersian } from '../memory/embed.js';
import { JALALI_MONTHS, jalaliOf, jalaliToDate } from '../lib/jalali.js';

export { jalaliToDate };

export interface Person { id: string; fullName: string; departmentCode: string | null }

export interface ProposedAction {
  title: string;
  assigneeId: string | null;
  assigneeName: string | null;
  /** The name as written, when it matched nobody or more than one person — for the confirmer. */
  ownerRaw: string | null;
  /** Everyone the written name could mean, when it was ambiguous: offered, never picked. */
  candidates: { id: string; fullName: string }[];
  departmentCode: string | null;
  dueDate: Date | null;
  dueRaw: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  sourceLine: string;
}

export interface MinutesDraft {
  decisions: { text: string; sourceLine: string }[];
  actions: ProposedAction[];
  /** Lines that looked like commitments but named neither an owner nor a date. */
  unresolvedFa: string[];
}

const DECISION = /(تصمیم|مصوب شد|قرار شد|توافق شد|تأیید شد|نهایی شد|تصویب)/;
const ACTION = /(اقدام|مسئول|باید|پیگیری|ارسال کن|آماده کن|تهیه کن|بفرست|انجام د|تحویل د|هماهنگ کن|بررسی کن|تا\s|مهلت|ظرف)/;
const STRIP_MARKERS = /^(\s*[-•*]\s*|\s*\d+[.)]\s*|\s*(اقدام|تصمیم|مصوبه)\s*[:：]\s*)/;

/** JS getDay() for each Persian weekday name. */
const WEEKDAYS: [string, number][] = [
  ['پنجشنبه', 4], ['پنج‌شنبه', 4], ['چهارشنبه', 3], ['سه‌شنبه', 2], ['سه شنبه', 2], ['سهشنبه', 2],
  ['دوشنبه', 1], ['یکشنبه', 0], ['جمعه', 5], ['شنبه', 6],
];

const toLatinDigits = (v: string) =>
  v.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));

const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(17, 0, 0, 0); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function nextWeekday(from: Date, weekday: number): Date {
  const x = new Date(from);
  do x.setDate(x.getDate() + 1); while (x.getDay() !== weekday);
  return x;
}

/** A due date the text states, relative to when the meeting was held. */
export function parseDue(line: string, heldAt: Date): { date: Date; raw: string } | null {
  const text = toLatinDigits(line);
  // 1405/07/12 or 1405-7-12 (Jalali years start with 13/14)
  let m = text.match(/(1[34]\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (m) {
    const d = jalaliToDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) return { date: endOfDay(d), raw: m[0] };
  }
  // ISO 2026-10-05
  m = text.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return { date: endOfDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))), raw: m[0] };
  // «۱۲ مهر» — this year's, or next year's if it has already passed
  for (const [i, name] of JALALI_MONTHS.entries()) {
    const mm = text.match(new RegExp(`(\\d{1,2})\\s*${name}`));
    if (mm) {
      const held = jalaliOf(heldAt);
      let d = jalaliToDate(held.y, i + 1, Number(mm[1]));
      if (d && d < heldAt) d = jalaliToDate(held.y + 1, i + 1, Number(mm[1]));
      if (d) return { date: endOfDay(d), raw: mm[0] };
    }
  }
  if (/پس[\s‌]?فردا/.test(text)) return { date: endOfDay(addDays(heldAt, 2)), raw: 'پس‌فردا' };
  if (/فردا/.test(text)) return { date: endOfDay(addDays(heldAt, 1)), raw: 'فردا' };
  m = text.match(/(?:ظرف|طی|تا)\s*(\d{1,3})\s*روز/);
  if (m) return { date: endOfDay(addDays(heldAt, Number(m[1]))), raw: m[0] };
  m = text.match(/(?:ظرف|طی|تا)\s*(\d{1,2})\s*هفته/);
  if (m) return { date: endOfDay(addDays(heldAt, 7 * Number(m[1]))), raw: m[0] };
  // The Iranian working week ends on Wednesday.
  if (/(تا\s*)?(پایان|آخر)\s*(این\s*)?هفته/.test(text)) return { date: endOfDay(nextWeekday(addDays(heldAt, -1), 3)), raw: 'پایان هفته' };
  if (/هفته[‌\s]?(ی|ٔ)?\s*(آینده|بعد)/.test(text)) return { date: endOfDay(addDays(heldAt, 7)), raw: 'هفتهٔ آینده' };
  for (const [name, day] of WEEKDAYS) {
    if (new RegExp(`(تا|برای|روز)\\s*${name}`).test(line)) return { date: endOfDay(nextWeekday(heldAt, day)), raw: name };
  }
  return null;
}

/**
 * The person a line names: a full name first, then a family name, then a given name — the last
 * two only when exactly one person in the organisation answers to it. Ambiguity is not guessed.
 */
export function findOwner(line: string, people: Person[]): { person: Person | null; raw: string | null; candidates: Person[] } {
  const norm = normalisePersian(line);
  const hasWord = (w: string) => new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(norm);
  const full = people.filter((p) => norm.includes(normalisePersian(p.fullName)));
  if (full.length === 1) return { person: full[0]!, raw: null, candidates: [] };
  let ambiguous: { raw: string; people: Person[] } | null = null;
  for (const pick of [(p: Person) => normalisePersian(p.fullName).split(' ').at(-1)!, (p: Person) => normalisePersian(p.fullName).split(' ')[0]!]) {
    const byName = new Map<string, Person[]>();
    for (const p of people) { const k = pick(p); if (k.length > 2) (byName.get(k) ?? byName.set(k, []).get(k)!).push(p); }
    const hits = [...byName.entries()].filter(([k]) => hasWord(k));
    if (hits.length === 1 && hits[0]![1].length === 1) return { person: hits[0]![1][0]!, raw: null, candidates: [] };
    if (hits.length === 1 && !ambiguous) {
      // Keep the name as people write it («آرش»), not its normalised search key («ارش»).
      const key = hits[0]![0];
      const original = hits[0]![1][0]!.fullName.split(' ').find((w) => normalisePersian(w) === key) ?? key;
      ambiguous = { raw: original, people: hits[0]![1] };
    }
  }
  if (ambiguous) return { person: null, raw: ambiguous.raw, candidates: ambiguous.people };
  const written = line.match(/مسئول\s*[:：]?\s*([^\s،,؛;—-]+(?:\s[^\s،,؛;—-]+)?)/);
  return { person: null, raw: written ? written[1]!.trim() : null, candidates: [] };
}

const DEPT_WORDS: [RegExp, string][] = [
  [/استراتژی/, 'ST'], [/خلاقیت|گرافیک|تولید|طراحی/, 'CR'], [/رسانه/, 'ME'], [/دیجیتال/, 'DM'],
  [/مالی/, 'FI'], [/حقوقی|قرارداد/, 'LG'], [/اکانت/, 'A'], [/فروش/, 'S'], [/عملیات|pmo/i, 'OP'],
];

/** Strip bullets, numbering and «اقدام:» — however many are stacked at the start. */
function stripMarkers(line: string): string {
  let t = line; let prev = '';
  while (t !== prev) { prev = t; t = t.replace(STRIP_MARKERS, ''); }
  return t.trim();
}

/** A pattern for text that may be written with Latin, Persian or Arabic-Indic digits. */
const anyDigits = (raw: string) => raw
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  .replace(/\d/g, (d) => `[${d}${String.fromCharCode(0x06f0 + Number(d))}${String.fromCharCode(0x0660 + Number(d))}]`);

function titleOf(line: string, owner: Person | null, dueRaw: string | null, ownerRaw: string | null): string {
  let t = stripMarkers(line);
  if (owner) for (const part of [owner.fullName, ...owner.fullName.split(' ')]) t = t.replace(part, '');
  // Only an owner written after «مسئول» is lifted out of the title, and only as whole words: a
  // name is also a substring of ordinary words («ارش» in «گزارش»).
  if (ownerRaw) t = t.replace(new RegExp(`مسئول\\s*[:：]?\\s*${anyDigits(ownerRaw)}\\s*[—-]?`), '');
  // The due phrase goes with the word that introduced it: «تا شنبه», not a dangling «تا».
  if (dueRaw) t = t.replace(new RegExp(`((تا|برای|ظرف|طی|مهلت)\\s*[:：]?\\s*)?${anyDigits(dueRaw)}`), '');
  t = t.replace(/مسئول\s*[:：]?\s*/g, '').replace(/مهلت\s*[:：]?\s*/g, '');
  return t.replace(/\s{2,}/g, ' ').replace(/^[\s،,:؛—-]+|[\s،,:؛—-]+$/g, '').trim();
}

export function draftMinutes(notes: string, heldAt: Date, people: Person[]): MinutesDraft {
  const lines = notes.split(/\n|(?<=[.!؟?])\s+|؛/).map((l) => l.trim()).filter((l) => l.length > 3);
  const decisions: MinutesDraft['decisions'] = [];
  const actions: ProposedAction[] = [];
  const unresolvedFa: string[] = [];

  for (const line of lines) {
    const isAction = ACTION.test(line) || /^\s*(اقدام)\s*[:：]/.test(line);
    const isDecision = DECISION.test(line) && !/^\s*اقدام\s*[:：]/.test(line);
    if (isDecision && !isAction) {
      decisions.push({ text: stripMarkers(line), sourceLine: line });
      continue;
    }
    if (!isAction) continue;

    const owner = findOwner(line, people);
    const due = parseDue(line, heldAt);
    if (!owner.person && !due && !owner.raw) {
      // A commitment with nobody and no date is exactly how a decision stays verbal.
      if (isDecision) decisions.push({ text: stripMarkers(line), sourceLine: line });
      else unresolvedFa.push(stripMarkers(line));
      continue;
    }
    const dept = owner.person?.departmentCode ?? DEPT_WORDS.find(([re]) => re.test(line))?.[1] ?? null;
    actions.push({
      title: titleOf(line, owner.person, due?.raw ?? null, owner.person ? null : owner.raw) || stripMarkers(line),
      assigneeId: owner.person?.id ?? null,
      assigneeName: owner.person?.fullName ?? null,
      ownerRaw: owner.person ? null : owner.raw,
      candidates: owner.candidates.map((c) => ({ id: c.id, fullName: c.fullName })),
      departmentCode: dept,
      dueDate: due?.date ?? null,
      dueRaw: due?.raw ?? null,
      confidence: owner.person && due ? 'HIGH' : owner.person || due ? 'MEDIUM' : 'LOW',
      sourceLine: line,
    });
  }
  return { decisions, actions, unresolvedFa };
}
