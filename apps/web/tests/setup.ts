import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom implements no layout, so it has no matchMedia. Both the theme provider and the Shell's
 * desktop/drawer switch depend on it; this stub reports "no match" and records listeners so a
 * test can drive a change if it needs to.
 */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

/**
 * Each test starts from a clean client. RTL's auto-cleanup only engages when the test
 * framework exposes a global afterEach, which vitest does not by default — without this,
 * rendered trees accumulate and queries match elements from earlier tests.
 */
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
