/**
 * Brief quality, not just brief completeness (roadmap #25).
 *
 * `briefCompleteness()` asks whether six fields are non-empty, so «افزایش فروش» and three
 * precise paragraphs both score 100. Doc_H's cycle 1 — the incomplete brief sent back to Sales —
 * is one of the six recurring loops the document names, and most returned briefs were not empty:
 * they were vague. This measures the vagueness.
 *
 * Deterministic on purpose. Every deduction names the field and, where it can, quotes the phrase
 * it objects to, so a salesperson can see exactly what to fix and a manager can argue with the
 * rule rather than with a number. A language model can draft improvements (the AI assistant's
 * BRIEF_ANALYSIS); it does not get to *score* them.
 */
import { normalisePersian, tokenise } from '../memory/embed.js';

export type BriefBand = 'STRONG' | 'ADEQUATE' | 'WEAK' | 'INCOMPLETE';

export interface FieldQuality {
  key: string;
  labelFa: string;
  weight: number;
  score: number;          // 0–100 within the field
  words: number;
  findingsFa: string[];
}

export interface BriefQuality {
  score: number;          // 0–100 overall, weighted
  band: BriefBand;
  bandFa: string;
  fields: FieldQuality[];
  /** The most useful thing to fix first — the field losing the most weighted points. */
  fixFirst: { key: string; labelFa: string; lostPoints: number } | null;
}

/**
 * Words that sound like a requirement and specify nothing. Each one found costs its field
 * points and is quoted back, because «هرچه جذاب‌تر» is not a brief anyone can execute.
 */
export const VAGUE_PHRASES = [
  'در صورت امکان', 'هرچه بهتر', 'هر چه بهتر', 'هرچه جذاب', 'هر چه جذاب', 'جذاب', 'خلاقانه',
  'مناسب', 'حداکثر', 'بهترین', 'در اسرع وقت', 'مطابق نظر مشتری', 'طبق سلیقه', 'متفاوت', 'خاص',
  'به‌روز', 'مدرن', 'حرفه‌ای', 'کامل', 'همه', 'عموم مردم', 'همه اقشار',
];

const MEASURABLE = /\d|درصد|٪|%|نرخ|برابر|میلیون|میلیارد|هزار/;
const TIMEFRAME = /(ماه|فصل|سال|هفته|روز|تا پایان|تا انتهای|سه‌ماهه|نیمه)/;
const KPI = /(نرخ|درصد|فروش|بازدید|تعامل|لید|سرنخ|ثبت‌نام|دانلود|نصب|ctr|roi|cpa|cpc|افزایش|کاهش|رشد|سهم بازار|آگاهی از برند|برند اوئرنس)/i;
const DEMOGRAPHIC = /(\d+\s*(تا|-|–)\s*\d+|سال|زنان|مردان|خانم|آقا|نوجوان|جوان|میانسال|دانشجو|والدین|مادران|پدران|مدیران|کارمندان|کسب‌وکار|b2b|b2c)/i;
const GEOGRAPHY = /(تهران|اصفهان|مشهد|شیراز|تبریز|کرج|شهر|استان|کشور|منطقه|کلان‌شهر|روستا|سراسری|ملی|بین‌المللی)/;
const CONSTRAINT_TERMS = /(بودجه|زمان|مهلت|برند|هویت بصری|قانون|مجوز|ممنوع|نباید|الزام|گاید|لوگو|رنگ سازمانی)/;

const count = (v: unknown) => (typeof v === 'string' ? tokenise(v).length : 0);
/**
 * Numbers in a Persian brief are usually typed in Persian digits — «۳ ویدئو», «۲۰ درصد» — and
 * `\d` matches none of them. Every rule reads the text with its digits made Latin, and keeps its
 * punctuation, which the item counter needs.
 */
const toLatinDigits = (v: string) =>
  v.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
const text = (v: unknown) => (typeof v === 'string' ? toLatinDigits(v) : '');
/** Items a field lists: lines, bullets, Persian or Latin commas, numbered entries. */
const items = (v: string) =>
  v.split(/\n|،|,|؛|;|•|-\s|\d+[.)]\s/).map((s) => s.trim()).filter((s) => s.length > 2).length;

function vague(v: string): string[] {
  const norm = normalisePersian(v);
  return VAGUE_PHRASES.filter((p) => norm.includes(normalisePersian(p)));
}

interface Rule {
  key: string;
  labelFa: string;
  weight: number;
  minWords?: number;
  judge: (value: unknown, all: Record<string, unknown>) => { specificity: number; findingsFa: string[] };
}

const RULES: Rule[] = [
  {
    key: 'businessObjective', labelFa: 'هدف کسب‌وکار', weight: 22, minWords: 12,
    judge: (v) => {
      const t = text(v); const f: string[] = []; let s = 0;
      if (MEASURABLE.test(t)) s += 0.6; else f.push('هدف عدد ندارد — «افزایش فروش» قابل‌سنجش نیست؛ چقدر؟');
      if (TIMEFRAME.test(t)) s += 0.4; else f.push('بازهٔ زمانی هدف مشخص نیست — تا کی؟');
      return { specificity: s, findingsFa: f };
    },
  },
  {
    key: 'targetAudience', labelFa: 'مخاطب هدف', weight: 16, minWords: 8,
    judge: (v) => {
      const t = text(v); const f: string[] = []; let s = 0;
      if (DEMOGRAPHIC.test(t)) s += 0.6; else f.push('مخاطب بدون سن، جنسیت یا گروه مشخص تعریف شده است');
      if (GEOGRAPHY.test(t)) s += 0.4; else f.push('محدودهٔ جغرافیایی مخاطب گفته نشده است');
      if (/(عموم مردم|همه اقشار|همه)/.test(t)) f.push('«همه» مخاطب نیست — کمپینی که با همه حرف بزند با هیچ‌کس حرف نمی‌زند');
      return { specificity: s, findingsFa: f };
    },
  },
  {
    key: 'scope', labelFa: 'Scope درخواستی', weight: 16, minWords: 15,
    judge: (v) => {
      const t = text(v); const f: string[] = [];
      const n = items(t);
      if (n < 2) f.push('Scope یک جملهٔ کلی است — کارهای درخواستی را جدا فهرست کنید');
      return { specificity: Math.min(1, n / 3), findingsFa: f };
    },
  },
  {
    key: 'expectedDeliverables', labelFa: 'خروجی‌های مورد انتظار', weight: 14, minWords: 8,
    judge: (v) => {
      const t = text(v); const f: string[] = []; let s = 0;
      if (/\d/.test(t)) s += 0.5; else f.push('تعداد خروجی‌ها مشخص نیست — چند پوستر؟ چند ویدئو؟');
      if (items(t) >= 2) s += 0.5; else f.push('خروجی‌ها فهرست نشده‌اند');
      return { specificity: s, findingsFa: f };
    },
  },
  {
    key: 'successCriteria', labelFa: 'معیار موفقیت', weight: 16, minWords: 8,
    judge: (v, all) => {
      const t = text(v); const f: string[] = []; let s = 0;
      if (KPI.test(t)) s += 0.5; else f.push('معیار موفقیت به شاخصی (فروش، بازدید، لید، نرخ تبدیل…) اشاره نمی‌کند');
      if (MEASURABLE.test(t)) s += 0.5; else f.push('معیار موفقیت عدد ندارد — موفقیت را چطور خواهیم فهمید؟');
      if (MEASURABLE.test(text(all.businessObjective)) && !MEASURABLE.test(t)) {
        f.push('هدف عدد دارد اما معیار موفقیت ندارد — این دو باید با هم بخوانند');
      }
      return { specificity: s, findingsFa: f };
    },
  },
  {
    key: 'constraints', labelFa: 'محدودیت‌ها', weight: 6, minWords: 4,
    judge: (v) => {
      const t = text(v);
      return CONSTRAINT_TERMS.test(t)
        ? { specificity: 1, findingsFa: [] }
        : { specificity: 0.3, findingsFa: ['محدودیتی دربارهٔ بودجه، زمان، برند یا الزامات قانونی ذکر نشده است'] };
    },
  },
];

const NON_TEXT_WEIGHT = { budgetRange: 5, desiredDeadline: 5 } as const;

/**
 * Score a brief. Pure: the same brief always gets the same score, which is what lets a
 * returned-brief rate be compared against it over time.
 */
export function scoreBrief(brief: Record<string, unknown>, now = new Date()): BriefQuality {
  const fields: FieldQuality[] = [];

  for (const rule of RULES) {
    const value = brief[rule.key];
    const t = text(value).trim();
    const words = count(value);
    if (!t) {
      fields.push({ key: rule.key, labelFa: rule.labelFa, weight: rule.weight, score: 0, words: 0, findingsFa: ['خالی است'] });
      continue;
    }
    const { specificity, findingsFa } = rule.judge(value, brief);
    const substance = rule.minWords ? Math.min(1, words / rule.minWords) : 1;
    if (rule.minWords && words < rule.minWords) {
      findingsFa.unshift(`کوتاه است: ${words} واژه، در حالی که دست‌کم ${rule.minWords} واژه لازم است تا چیزی را مشخص کند`);
    }
    const phrases = vague(t);
    for (const p of phrases) findingsFa.push(`عبارت مبهم: «${p}» — به‌جایش بگویید دقیقاً چه چیزی`);
    const raw = 0.4 + 0.3 * substance + 0.3 * specificity - 0.1 * phrases.length;
    fields.push({
      key: rule.key, labelFa: rule.labelFa, weight: rule.weight,
      score: Math.round(Math.max(0, Math.min(1, raw)) * 100), words, findingsFa,
    });
  }

  // Budget and deadline: present, and plausible.
  const budget = Number(brief.budgetRange ?? 0);
  fields.push({
    key: 'budgetRange', labelFa: 'بودجه تقریبی', weight: NON_TEXT_WEIGHT.budgetRange, words: 0,
    score: budget > 0 ? 100 : 0, findingsFa: budget > 0 ? [] : ['بودجه تعیین نشده است — بدون آن پروپوزال حدس است'],
  });
  const deadline = brief.desiredDeadline ? new Date(String(brief.desiredDeadline)) : null;
  const deadlineFindings: string[] = [];
  let deadlineScore = 0;
  if (!deadline || Number.isNaN(deadline.getTime())) deadlineFindings.push('زمان مورد انتظار تعیین نشده است');
  else if (deadline < now) { deadlineScore = 40; deadlineFindings.push('زمان مورد انتظار گذشته است'); }
  else if (deadline.getTime() - now.getTime() < 7 * 86_400_000) { deadlineScore = 70; deadlineFindings.push('کمتر از یک هفته تا زمان مورد انتظار مانده — برای بریف، پروپوزال و اجرا بسیار فشرده است'); }
  else deadlineScore = 100;
  fields.push({ key: 'desiredDeadline', labelFa: 'زمان مورد انتظار', weight: NON_TEXT_WEIGHT.desiredDeadline, score: deadlineScore, words: 0, findingsFa: deadlineFindings });

  const total = fields.reduce((s, f) => s + f.weight, 0);
  const score = Math.round(fields.reduce((s, f) => s + (f.score * f.weight) / 100, 0) / total * 100);
  const anyEmpty = fields.some((f) => f.score === 0 && ['businessObjective', 'targetAudience', 'scope', 'expectedDeliverables', 'budgetRange', 'desiredDeadline'].includes(f.key));
  const band: BriefBand = anyEmpty ? 'INCOMPLETE' : score >= 80 ? 'STRONG' : score >= 60 ? 'ADEQUATE' : 'WEAK';

  const lost = fields.map((f) => ({ key: f.key, labelFa: f.labelFa, lostPoints: Math.round(((100 - f.score) * f.weight) / 100) }))
    .sort((a, b) => b.lostPoints - a.lostPoints)[0];

  return {
    score, band,
    bandFa: { STRONG: 'قوی', ADEQUATE: 'قابل قبول', WEAK: 'ضعیف', INCOMPLETE: 'ناقص' }[band],
    fields,
    fixFirst: lost && lost.lostPoints > 0 ? lost : null,
  };
}
