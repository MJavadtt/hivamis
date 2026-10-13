import { describe, it, expect } from 'vitest';
import { faDigits } from '../src/i18n';

/** Audit UI-V: server text in Persian arrived with Latin digits in the middle of a sentence. */
describe('Persian digits in Persian text', () => {
  it('turns the numbers of a Persian sentence into Persian digits', () => {
    expect(faDigits('کوتاه است: 1 واژه، در حالی که دست‌کم 12 واژه لازم است')).toBe('کوتاه است: ۱ واژه، در حالی که دست‌کم ۱۲ واژه لازم است');
    expect(faDigits('بر پایهٔ 5 بریف که به قرارداد رسیدند')).toBe('بر پایهٔ ۵ بریف که به قرارداد رسیدند');
    expect(faDigits('میانگین 3.5 روز، از 1404/06/16')).toBe('میانگین ۳٫۵ روز، از ۱۴۰۴/۰۶/۱۶');
  });

  it('leaves codes, names, addresses and Latin-only text as they are', () => {
    expect(faDigits('پروژهٔ PRJ-000016 در 3 روز')).toBe('پروژهٔ PRJ-000016 در ۳ روز');
    expect(faDigits('مدل qwen3:8b روی سرور نیست')).toBe('مدل qwen3:8b روی سرور نیست');
    expect(faDigits('نشانی a1@x.ir و شرکت 3M')).toBe('نشانی a1@x.ir و شرکت 3M');
    expect(faDigits('Brief 12 is short')).toBe('Brief 12 is short');
  });
});
