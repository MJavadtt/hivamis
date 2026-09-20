import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider, applyStoredThemeEarly, useTheme } from '../src/lib/theme';

function Probe() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <>
      <span>pref:{preference}</span>
      <span>resolved:{resolved}</span>
      <button onClick={() => setPreference('dark')}>dark</button>
      <button onClick={() => setPreference('system')}>system</button>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('Theme', () => {
  it('defaults to following the system', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByText('pref:system')).toBeDefined();
    // No attribute at all, so the prefers-color-scheme block in CSS governs.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('stamps the attribute and persists an explicit choice', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    fireEvent.click(screen.getByText('dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('hiva.theme')).toBe('dark');
    expect(screen.getByText('resolved:dark')).toBeDefined();
  });

  it('removes the attribute again when handed back to the system', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    fireEvent.click(screen.getByText('dark'));
    fireEvent.click(screen.getByText('system'));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('hiva.theme')).toBe('system');
  });

  it('restores a stored preference on mount', () => {
    localStorage.setItem('hiva.theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByText('pref:dark')).toBeDefined();
  });

  /** Runs before React mounts, so a dark-mode user never sees a flash of the light interface. */
  it('applies the stored preference before React mounts', () => {
    localStorage.setItem('hiva.theme', 'dark');
    applyStoredThemeEarly();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('ignores a corrupted stored value rather than throwing', () => {
    localStorage.setItem('hiva.theme', 'chartreuse');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByText('pref:system')).toBeDefined();
  });
});
