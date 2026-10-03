import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { apiPatch } from './api';
import { LOCALE_KEY, loc, locale as loadedLocale, tr, type Locale } from '../i18n';

export type { Locale };

interface LocaleState {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  /** Saves the choice and reloads the page in that language. */
  setLocale: (l: Locale) => Promise<void>;
  /**
   * Picks the right side of a bilingual label: t(field, 'label') reads labelFa or labelEn.
   * Typed structurally rather than as Record<string, unknown>, which the contracts interfaces
   * do not satisfy without an index signature.
   */
  t: (source: object, base: string) => string;
}

const LocaleContext = createContext<LocaleState | null>(null);

function read(): Locale {
  const v = localStorage.getItem(LOCALE_KEY);
  return v === 'en' ? 'en' : 'fa';
}

/** The page reload, behind a seam a test can replace (jsdom cannot reload). */
export const page = { reload: () => window.location.reload() };

/**
 * Interface language (ADR-009, Hivamis task 7 / ADR-056).
 *
 * Persian is the product's first language and the default; English is additive. The language is
 * fixed for the life of a page — every `tr()` reads it — so switching saves the choice, tells the
 * server (it follows the person to another device), and reloads.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = loadedLocale();

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('lang', locale);
    root.setAttribute('dir', locale === 'fa' ? 'rtl' : 'ltr');
    // index.html carries the Persian title; the tab reads it in the page's language.
    document.title = tr('هیوامیس — سیستم‌عامل سازمانی');
  }, [locale]);

  const setLocale = useCallback(async (l: Locale) => {
    try { localStorage.setItem(LOCALE_KEY, l); } catch { /* private mode */ }
    // Persisted so the choice follows the person; never allowed to hold the switch up for long.
    await Promise.race([apiPatch('/auth/me/locale', { locale: l }).catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
    if (l !== locale) page.reload();
  }, [locale]);

  const value = useMemo<LocaleState>(() => ({
    locale,
    dir: locale === 'fa' ? 'rtl' : 'ltr',
    setLocale,
    t: (source, base) => loc(source, base),
  }), [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleState {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>');
  return ctx;
}

/** Applies the stored direction before React mounts, so the layout does not flip on load. */
export function applyStoredLocaleEarly(): void {
  try {
    const l = read();
    document.documentElement.setAttribute('lang', l);
    document.documentElement.setAttribute('dir', l === 'fa' ? 'rtl' : 'ltr');
  } catch { /* storage unavailable */ }
}

/**
 * A signed-in person's saved language, on a device that has no choice of its own yet: adopt it.
 * A device that has chosen keeps its choice — the person made it there.
 */
export function adoptAccountLocale(account: string | null | undefined): void {
  if (account !== 'fa' && account !== 'en') return;
  let chosen: string | null = null;
  try { chosen = localStorage.getItem(LOCALE_KEY); } catch { return; }
  if (chosen || account === loadedLocale()) return;
  try { localStorage.setItem(LOCALE_KEY, account); } catch { return; }
  page.reload();
}

/** Pick from a `{ fa, en }` pair — the shape DEPARTMENT_LABELS, ROLE_LABELS and MODULE_LABELS use. */
export function pick(pair: { fa: string; en: string } | undefined, locale: Locale): string {
  if (!pair) return '';
  return locale === 'en' ? pair.en : pair.fa;
}
