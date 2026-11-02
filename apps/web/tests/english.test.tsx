import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { allKeys } from '../scripts/i18n-keys.mts';
import en from '../src/i18n/en.json';
import shared from '@hiva/contracts/i18n/en.json';
import { loc, pair, setLocaleForTests, tr, trx } from '../src/i18n';
import { formatCurrency, formatDate, formatDateTime, formatNumber, formatPercent, formatRelative, localDigits } from '../src/lib/format';

/**
 * Hivamis task 7: the English interface. The catalogue covers every string the app writes, each
 * translation keeps its placeholders, and in English the app reads numbers, dates and the labels the
 * API sends in English too.
 */

const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(',');

describe('the English catalogue', () => {
  it('has English for every string the app passes to tr()', () => {
    const catalogue = en as Record<string, string>;
    const missing = [...allKeys()].filter(([k]) => catalogue[k] === undefined).map(([k, files]) => `${files[0]}: ${k}`);
    expect(missing).toEqual([]);
  });

  it('keeps every placeholder, and adds none', () => {
    for (const cat of [en, shared] as Record<string, string>[]) {
      const broken = Object.entries(cat).filter(([fa, english]) => placeholders(fa) !== placeholders(english));
      expect(broken).toEqual([]);
    }
  });

  it('has no Persian left on the English side', () => {
    // Except the brand library's font sample, which must show Persian letters to preview a Persian font.
    const persian = Object.entries(en as Record<string, string>).filter(([fa, v]) => /[ء-ي]/.test(v) && !fa.startsWith('نمونهٔ متن برند'));
    expect(persian).toEqual([]);
  });
});

describe('in English', () => {
  beforeAll(async () => { await setLocaleForTests('en'); });
  afterAll(async () => { await setLocaleForTests('fa'); });

  it('translates the words written here', () => {
    expect(tr('وظایف تاخیردار')).toBe('Overdue tasks');
    expect(tr('سلام، {0}', 'Sara')).toBe('Hello, Sara');
  });

  it('reads the values going into a sentence: a role in English, a number in Latin digits', () => {
    expect(tr('دسترسی «{0}» ثبت شد — {1} داده، {2} گرفته.', 'مدیر فروش', '۳', '۰'))
      .toBe('Access for “Sales manager” recorded — 3 given, 0 taken.');
  });

  it('reads back a message the server composed, with the states inside it', () => {
    expect(trx('انتقال «ارسال» از وضعیت «پیش‌نویس» مجاز نیست.')).toMatch(/^Transition “.+” isn't allowed from state “Draft”\.$/);
    expect(trx('برای این عملیات به دسترسی «crm.lead.write» نیاز دارید')).toBe('This operation requires the “crm.lead.write” permission');
  });

  it("leaves what no catalogue knows — a person's name — as it was written", () => {
    expect(trx('رضا شریفی')).toBe('رضا شریفی');
    expect(trx(null)).toBe('');
  });

  it("prefers a record's own English side, and reads the Persian one back when there is none", () => {
    expect(loc({ labelFa: 'عنوان بریف', labelEn: 'Brief title' }, 'label')).toBe('Brief title');
    expect(loc({ nameFa: 'مدیر فروش' }, 'name')).toBe('Sales manager');
    expect(loc({ nameFa: 'تیم ویژه', nameEn: 'تیم ویژه' }, 'name')).toBe('تیم ویژه');
    expect(pair({ fa: 'پیش‌نویس' })).toBe('Draft');
  });

  it('writes numbers, money and dates for an English reader', () => {
    expect(localDigits(1405)).toBe('1405');
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatCurrency(4_300_000_000)).toBe('4.3 billion Rials');
    expect(formatCurrency(12_000, false)).toBe('12,000 Rials');
    expect(formatPercent(12.34)).toBe('12.3%');
    expect(formatDate('2026-10-03T08:00:00Z')).toBe('3 Oct 2026');
    expect(formatDateTime('2026-10-03T08:00:00Z')).toMatch(/^3 Oct 2026, \d\d:\d\d$/);
    expect(formatRelative(new Date())).toBe('today');
  });

  it('reads the guide in English, headed with its own English section titles', async () => {
    const { findSection } = await import('../src/lib/help');
    expect(findSection('Your workspace — «میز کار من»')?.heading).toBe('Your workspace');
    expect(findSection('Sales')?.heading).toBe('Sales');
    expect(findSection('Sales')?.body).toMatch(/^\*\*Your loop/);
  });

  it('shows a state badge in English', async () => {
    const { StateBadge } = await import('../src/components/ui');
    render(<StateBadge state="DRAFT" />);
    expect(screen.getByText('Draft')).toBeDefined();
  });

  it('enters dates with the browser’s Gregorian picker, emitting the same value as the Solar Hijri one', async () => {
    const { JalaliDateInput } = await import('../src/components/JalaliDateInput');
    const seen: string[] = [];
    const { container } = render(<JalaliDateInput value="2026-10-01" onChange={(v) => seen.push(v)} />);
    const input = container.querySelector('input')!;
    expect(input.type).toBe('date');
    expect(input.value).toBe('2026-10-01');
    fireEvent.change(input, { target: { value: '2026-10-03' } });
    expect(seen).toEqual(['2026-10-03']);
  });

  it('sends a datetime as the instant the reader meant', async () => {
    const { JalaliDateInput } = await import('../src/components/JalaliDateInput');
    const seen: string[] = [];
    const { container } = render(<JalaliDateInput mode="datetime" value={null} onChange={(v) => seen.push(v)} />);
    fireEvent.change(container.querySelector('input')!, { target: { value: '2026-10-03T14:30' } });
    expect(seen).toEqual([new Date('2026-10-03T14:30').toISOString()]);
  });
});

describe('reading composed text in English', () => {
  beforeAll(async () => { await setLocaleForTests('en'); });
  afterAll(async () => { await setLocaleForTests('fa'); });

  it('joins a phrase from its parts, and turns a Persian sequence arrow around', () => {
    expect(trx('تماس مستقیم — رویداد')).toBe('Direct contact — Event');
    expect(trx('جدید ← تماس گرفته‌شده')).toBe('New → Contacted');
  });

  it('reads a month and its year, but never takes a name apart', () => {
    expect(trx('آبان ۱۴۰۴')).toBe('Aban 1404');
    expect(trx('فروش ویژه')).toBe('فروش ویژه');
  });

  it('splits two neighbouring values where the catalogue knows both', () => {
    expect(trx('«درصد Margin» کوچک‌تر از ۲۰ باشد')).toBe('“Margin percentage” is less than 20');
  });
});
