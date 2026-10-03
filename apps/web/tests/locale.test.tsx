import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LocaleProvider, adoptAccountLocale, applyStoredLocaleEarly, page, pick, useLocale } from '../src/lib/locale';

function Probe() {
  const { locale, dir, setLocale, t } = useLocale();
  const field = { labelFa: 'عنوان بریف', labelEn: 'Brief title' };
  return (
    <>
      <span>locale:{locale}</span>
      <span>dir:{dir}</span>
      <span>label:{t(field, 'label')}</span>
      <button onClick={() => void setLocale('en')}>en</button>
    </>
  );
}

const reload = vi.fn();

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
  reload.mockReset();
  page.reload = reload;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

describe('Locale', () => {
  it('defaults to Persian and RTL', () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByText('locale:fa')).toBeDefined();
    expect(screen.getByText('dir:rtl')).toBeDefined();
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
  });

  it('reads the Persian side of a bilingual label in Persian', () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByText('label:عنوان بریف')).toBeDefined();
  });

  /**
   * Every label is translated when its module loads, so the language cannot change under a running
   * page: switching saves the choice, tells the server, and reloads (Hivamis task 7).
   */
  it('switching saves the choice, persists it to the server, and reloads', async () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    fireEvent.click(screen.getByText('en'));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('hiva.locale')).toBe('en');
    // The client passes a URL instance, not a string, so read the recorded call directly.
    const [url, init] = (fetch as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]!;
    expect(String(url)).toContain('/auth/me/locale');
    expect(init.method).toBe('PATCH');
    expect(String(init.body)).toContain('"locale":"en"');
  });

  it('switches even when the server does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<LocaleProvider><Probe /></LocaleProvider>);
    fireEvent.click(screen.getByText('en'));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(localStorage.getItem('hiva.locale')).toBe('en');
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

  it("adopts the account's language on a device that has not chosen one", () => {
    adoptAccountLocale('en');
    expect(localStorage.getItem('hiva.locale')).toBe('en');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps a choice made on this device, and does nothing when the languages agree', () => {
    localStorage.setItem('hiva.locale', 'fa');
    adoptAccountLocale('en');
    expect(localStorage.getItem('hiva.locale')).toBe('fa');
    localStorage.clear();
    adoptAccountLocale('fa');
    expect(localStorage.getItem('hiva.locale')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});
