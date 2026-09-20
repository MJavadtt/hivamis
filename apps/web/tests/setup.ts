import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

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
