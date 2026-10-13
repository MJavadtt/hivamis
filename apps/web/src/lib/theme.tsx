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
  paintBrowserBar(pref);
}

/** The page's canvas (`--color-canvas` in index.css), for the browser's own bar. */
export const CANVAS = { light: '#f5f3fb', dark: '#0d0c1a' } as const;

/**
 * index.html carries one theme-color meta per scheme, each behind its media query (audit UI-1). A
 * chosen theme gives both its colour, since the system's scheme no longer says which is on screen;
 * `system` puts each back to its own.
 */
function paintBrowserBar(pref: ThemePreference): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = (meta.getAttribute('media') ?? '').includes('dark') ? CANVAS.dark : CANVAS.light;
    meta.setAttribute('content', pref === 'system' ? own : CANVAS[pref]);
  }
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
