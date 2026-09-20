import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

interface ThemeState {
  preference: ThemePreference;
  /** What is actually on screen once `system` is resolved. */
  resolved: 'light' | 'dark';
  setPreference: (p: ThemePreference) => void;
}

const STORAGE_KEY = 'hiva.theme';
const ThemeContext = createContext<ThemeState | null>(null);

function read(): ThemePreference {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

/**
 * Applies the preference as `data-theme` on <html>, which the token overrides in index.css key
 * off. `system` writes no attribute at all, so the prefers-color-scheme block takes over and
 * the interface follows the OS live.
 */
function apply(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPref] = useState<ThemePreference>(() => {
    try { return read(); } catch { return 'system'; }
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => { apply(preference); }, [preference]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPref(p);
    try { localStorage.setItem(STORAGE_KEY, p); } catch { /* private mode */ }
  }, []);

  const value = useMemo<ThemeState>(() => ({
    preference,
    resolved: preference === 'system' ? (systemDark ? 'dark' : 'light') : preference,
    setPreference,
  }), [preference, systemDark, setPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/**
 * Read and apply the stored preference before React mounts, so a dark-mode user does not get a
 * flash of the light interface on every load.
 */
export function applyStoredThemeEarly(): void {
  try { apply(read()); } catch { /* storage unavailable */ }
}
