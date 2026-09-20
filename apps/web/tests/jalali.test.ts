import { describe, it, expect } from 'vitest';
import {
  formatJalaliInput, isoToJalaliParts, jalaliDaysInMonth, jalaliPartsToValue,
  parseJalaliInput, toLatinDigits, toPersianDigits,
} from '../src/lib/format';

/**
 * These run with TZ=Asia/Tehran (vitest.config.ts). The conversion is only meaningful relative
 * to a timezone, and a CI runner in UTC would otherwise read a different calendar day than the
 * user whose deadline it is.
 */
describe('Jalali ↔ stored value', () => {
  it('converts a known pair in both directions', () => {
    // 31 شهریور 1405 is 22 September 2026.
    const parts = { jy: 1405, jm: 6, jd: 31, hh: 0, mm: 0 };
    expect(jalaliPartsToValue(parts, 'date')).toBe('2026-09-22');
    expect(isoToJalaliParts('2026-09-22')).toMatchObject({ jy: 1405, jm: 6, jd: 31 });
  });

  it('round-trips every day of a Jalali year without drifting', () => {
    for (let jm = 1; jm <= 12; jm++) {
      for (let jd = 1; jd <= jalaliDaysInMonth(1405, jm); jd++) {
        const stored = jalaliPartsToValue({ jy: 1405, jm, jd, hh: 0, mm: 0 }, 'date');
        const back = isoToJalaliParts(stored);
        expect(back, `1405/${jm}/${jd} → ${stored}`).toMatchObject({ jy: 1405, jm, jd });
      }
    }
  });

  /** Month length is where hand-rolled conversions usually break. */
  it('knows the length of every Jalali month, leap year included', () => {
    for (let jm = 1; jm <= 6; jm++) expect(jalaliDaysInMonth(1405, jm), `month ${jm}`).toBe(31);
    for (let jm = 7; jm <= 11; jm++) expect(jalaliDaysInMonth(1405, jm), `month ${jm}`).toBe(30);
    // اسفند: 30 days in a leap year, 29 otherwise.
    expect(jalaliDaysInMonth(1403, 12)).toBe(30);
    expect(jalaliDaysInMonth(1404, 12)).toBe(29);
    expect(jalaliDaysInMonth(1408, 12)).toBe(30);
  });

  it('accepts the 31st of a 31-day month and rejects it in a 30-day one', () => {
    expect(parseJalaliInput('1405/06/31', 'date')).toMatchObject({ jm: 6, jd: 31 });
    expect(parseJalaliInput('1405/07/31', 'date')).toBeNull();   // مهر has 30
    expect(parseJalaliInput('1404/12/30', 'date')).toBeNull();   // common year اسفند has 29
    expect(parseJalaliInput('1403/12/30', 'date')).toMatchObject({ jy: 1403, jm: 12, jd: 30 });
  });

  /**
   * A date is a calendar day and must not move; a datetime is an instant and must carry its
   * offset. Tehran is UTC+3:30, so an early-morning time crosses back into the previous UTC day.
   */
  it('keeps a date on its day but sends a datetime as a UTC instant', () => {
    expect(jalaliPartsToValue({ jy: 1405, jm: 6, jd: 31, hh: 0, mm: 0 }, 'date')).toBe('2026-09-22');

    const earlyMorning = jalaliPartsToValue({ jy: 1405, jm: 6, jd: 31, hh: 2, mm: 0 }, 'datetime');
    // 02:00 Tehran on 22 Sep is 22:30 UTC on the 21st.
    expect(earlyMorning).toBe('2026-09-21T22:30:00.000Z');
    // And it reads back as the same Jalali day for the user who entered it.
    expect(isoToJalaliParts(earlyMorning)).toMatchObject({ jy: 1405, jm: 6, jd: 31, hh: 2 });
  });

  it('matches what the native date input used to post for the same day', () => {
    // The old <input type="date"> posted YYYY-MM-DD; the wire format is unchanged.
    expect(jalaliPartsToValue({ jy: 1405, jm: 1, jd: 1, hh: 0, mm: 0 }, 'date')).toBe('2026-03-21');
    expect(jalaliPartsToValue({ jy: 1404, jm: 12, jd: 29, hh: 0, mm: 0 }, 'date')).toBe('2026-03-20');
  });
});

describe('Typed input', () => {
  it('accepts Persian, Arabic-Indic and Latin digits', () => {
    const expected = { jy: 1405, jm: 6, jd: 31 };
    expect(parseJalaliInput('۱۴۰۵/۰۶/۳۱', 'date')).toMatchObject(expected);
    expect(parseJalaliInput('١٤٠٥/٠٦/٣١', 'date')).toMatchObject(expected);
    expect(parseJalaliInput('1405/06/31', 'date')).toMatchObject(expected);
  });

  it('accepts the separators people actually type', () => {
    for (const s of ['1405/6/31', '1405-06-31', '1405.06.31', ' 1405/06/31 ']) {
      expect(parseJalaliInput(s, 'date'), s).toMatchObject({ jy: 1405, jm: 6, jd: 31 });
    }
  });

  it('reads a time only in datetime mode', () => {
    expect(parseJalaliInput('1405/06/31 14:30', 'datetime')).toMatchObject({ hh: 14, mm: 30 });
    // In date mode the time is ignored rather than rejected.
    expect(parseJalaliInput('1405/06/31 14:30', 'date')).toMatchObject({ jd: 31, hh: 0, mm: 0 });
  });

  it('rejects nonsense instead of guessing', () => {
    for (const s of ['', 'فردا', '1405', '1405/13/01', '1405/00/10', '1405/06/00', '1405/06/31 25:00']) {
      expect(parseJalaliInput(s, 'datetime'), s).toBeNull();
    }
  });

  it('renders Persian digits for display', () => {
    const p = { jy: 1405, jm: 6, jd: 31, hh: 9, mm: 5 };
    expect(formatJalaliInput(p, 'date')).toBe('۱۴۰۵/۰۶/۳۱');
    expect(formatJalaliInput(p, 'datetime')).toBe('۱۴۰۵/۰۶/۳۱ ۰۹:۰۵');
    expect(formatJalaliInput(null, 'date')).toBe('');
  });

  it('survives a display → parse → store → display cycle', () => {
    const shown = formatJalaliInput({ jy: 1405, jm: 6, jd: 31, hh: 0, mm: 0 }, 'date');
    const parsed = parseJalaliInput(shown, 'date')!;
    const stored = jalaliPartsToValue(parsed, 'date');
    expect(formatJalaliInput(isoToJalaliParts(stored), 'date')).toBe(shown);
  });

  it('converts digits in both directions', () => {
    expect(toLatinDigits('۱۴۰۵')).toBe('1405');
    expect(toPersianDigits('1405')).toBe('۱۴۰۵');
  });
});
