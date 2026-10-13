import type { ChatMessage } from './ollama.js';

/**
 * Writing with the assistant (audit F-2): a draft from an instruction, or a rewrite of what the
 * person has written, in Persian or English. The model is given only what the person gives it — no
 * tools, no records — so it writes; it does not look anything up, and cannot show what it may not.
 */
export const WRITE_KINDS = ['brief', 'proposal', 'email', 'minutes', 'other'] as const;
export type WriteKind = (typeof WRITE_KINDS)[number];

const WHAT: Record<WriteKind, { fa: string; en: string }> = {
  brief: { fa: 'بریف کاری برای یک پروژهٔ تبلیغاتی: هدف، مخاطب، پیام اصلی، تحویل‌دادنی‌ها، محدودیت‌ها و مهلت', en: 'a creative brief for an advertising project: objective, audience, key message, deliverables, constraints and deadline' },
  proposal: { fa: 'متن پروپوزال برای مشتری: درک نیاز، راه‌حل، دامنهٔ کار، زمان‌بندی، و آنچه در دامنه نیست', en: 'proposal text for a client: understanding of the need, approach, scope, timeline, and what is out of scope' },
  email: { fa: 'ایمیل کاری کوتاه، مؤدب و روشن', en: 'a short, courteous, clear business email' },
  minutes: { fa: 'صورت‌جلسه: دستور جلسه، تصمیم‌ها، و اقدام‌ها با مسئول و مهلت', en: 'meeting minutes: agenda, decisions, and actions with owner and due date' },
  other: { fa: 'متن کاری', en: 'business text' },
};

export function writeMessages(input: { kind: WriteKind; instruction: string; text?: string | null; locale: 'fa' | 'en' }): ChatMessage[] {
  const what = WHAT[input.kind][input.locale];
  const system = input.locale === 'fa'
    ? `تو نویسندهٔ یک آژانس تبلیغاتی هستی و ${what} می‌نویسی. فارسی معیار و روان بنویس، بی‌مقدمه و بی‌توضیح دربارهٔ خودت؛ فقط متن نهایی را بده. چیزی را که داده نشده — نام، عدد، تاریخ — از خودت نساز؛ جای خالی را با [ ] نشان بده.`
    : `You write for an advertising agency: ${what}. Write plain, natural English. Give only the finished text, with no preamble or notes about yourself. Do not invent names, figures or dates that were not given; mark gaps with [ ].`;
  const user = input.text
    ? (input.locale === 'fa'
      ? `این متن را بازنویسی کن. خواسته: ${input.instruction}\n\n«««\n${input.text}\n»»»`
      : `Rewrite this text. What is wanted: ${input.instruction}\n\n"""\n${input.text}\n"""`)
    : input.instruction;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}
