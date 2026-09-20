import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LocaleProvider, applyStoredLocaleEarly, pick, useLocale } from '../src/lib/locale';

function Probe() {
  const { locale, dir, setLocale, t } = useLocale();
  const field = { labelFa: 'عنوان بریف', labelEn: 'Brief title' };
  const partial = { labelFa: 'فقط فارسی' };
  return (
    <>
      <span>locale:{locale}</span>
      <span>dir:{dir}</span>
      <span>label:{t(field, 'label')}</span>
      <span>partial:{t(partial, 'label')}</span>
      <button onClick={() => setLocale('en')}>en</button>
      <button onClick={() => setLocale('fa')}>fa</button>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

describe('Locale', () => {
  it('defaults to Persian and RTL', () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByText('locale:fa')).toBeDefined();
    expect(screen.getByText('dir:rtl')).toBeDefined();
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
  });

  it('flips direction and language on the document when switched', () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    fireEvent.click(screen.getByText('en'));
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(localStorage.getItem('hiva.locale')).toBe('en');
  });

  it('reads the matching side of a bilingual label', () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByText('label:عنوان بریف')).toBeDefined();
    fireEvent.click(screen.getByText('en'));
    expect(screen.getByText('label:Brief title')).toBeDefined();
  });

  /** A pair missing its English side must not render blank. */
  it('falls back to Persian when there is no English string', () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    fireEvent.click(screen.getByText('en'));
    expect(screen.getByText('partial:فقط فارسی')).toBeDefined();
  });

  it('persists the choice to the server without blocking the switch', () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    fireEvent.click(screen.getByText('en'));
    // The client passes a URL instance, not a string, so read the recorded call directly.
    const [url, init] = (fetch as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]!;
    expect(String(url)).toContain('/auth/me/locale');
    expect(init.method).toBe('PATCH');
    expect(String(init.body)).toContain('"locale":"en"');
    // Applied locally regardless of what the server says.
    expect(screen.getByText('locale:en')).toBeDefined();
  });

  it('applies the stored direction before React mounts', () => {
    localStorage.setItem('hiva.locale', 'en');
    applyStoredLocaleEarly();
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('picks from a { fa, en } pair', () => {
    const dept = { fa: 'اکانت', en: 'Account' };
    expect(pick(dept, 'fa')).toBe('اکانت');
    expect(pick(dept, 'en')).toBe('Account');
    expect(pick(undefined, 'en')).toBe('');
  });
});
