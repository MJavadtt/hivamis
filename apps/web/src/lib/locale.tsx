import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { apiPatch } from './api';

export type Locale = 'fa' | 'en';

interface LocaleState {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  setLocale: (l: Locale) => void;
  /**
   * Picks the right side of a bilingual label: t(field, 'label') reads labelFa or labelEn.
   * Typed structurally rather than as Record<string, unknown>, which the contracts interfaces
   * do not satisfy without an index signature.
   */
  t: (source: object, base: string) => string;
}

const STORAGE_KEY = 'hiva.locale';
const LocaleContext = createContext<LocaleState | null>(null);

function read(): Locale {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'en' ? 'en' : 'fa';
}

/**
 * Interface language.
 *
 * Persian is the product's first language and the default; English is additive, exactly as
 * ADR-009 describes. Every enum, role, department, module, form and field in contracts already
 * carries both sides — 327 label pairs — so this switches which side is read rather than
 * introducing a translation layer.
 *
 * NOT yet translated, and deliberately out of scope here: the Persian strings written directly
 * into page components, and STATE_LABELS, which carries `fa` only. Switching to English today
 * gives English navigation, roles, modules, form names and field labels, with Persian state
 * badges and page copy. See docs/decisions.md ADR-009.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    try { return read(); } catch { return 'fa'; }
  });

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('lang', locale);
    root.setAttribute('dir', locale === 'fa' ? 'rtl' : 'ltr');
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* private mode */ }
    // Persisted so the choice follows the user to another device; a failure here is not worth
    // blocking the switch, which has already taken effect locally.
    void apiPatch('/auth/me/locale', { locale: l }).catch(() => undefined);
  }, []);

  const value = useMemo<LocaleState>(() => ({
    locale,
    dir: locale === 'fa' ? 'rtl' : 'ltr',
    setLocale,
    t: (source, base) => {
      const bag = source as Record<string, unknown>;
      const key = locale === 'fa' ? `${base}Fa` : `${base}En`;
      // Falls back to Persian when a pair is missing its English side, so a label is never blank.
      return String(bag[key] ?? bag[`${base}Fa`] ?? '');
    },
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

/** Pick from a `{ fa, en }` pair — the shape DEPARTMENT_LABELS, ROLE_LABELS and MODULE_LABELS use. */
export function pick(pair: { fa: string; en: string } | undefined, locale: Locale): string {
  if (!pair) return '';
  return locale === 'en' ? pair.en : pair.fa;
}
