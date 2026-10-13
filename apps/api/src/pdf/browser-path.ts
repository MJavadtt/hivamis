import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../lib/errors.js';

// Apart from the renderer, which reads the environment: the icon and installability scripts need a
// browser without a database.

/**
 * Locate a Chromium binary without depending on Playwright's own revision bookkeeping:
 * an explicit override wins, then Playwright's browser cache, then a system Chrome.
 * Keeps dev (cached Chromium) and production (image-provided Chrome) on the same code path.
 */
export function resolveExecutable(): string | undefined {
  const override = process.env.PDF_BROWSER_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new AppError(500, 'PDF_BROWSER_MISSING', `مسیر مرورگر تعیین‌شده وجود ندارد: ${override}`);
    }
    return override;
  }

  const cacheRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
      : path.join(os.homedir(), '.cache/ms-playwright'));

  if (existsSync(cacheRoot)) {
    // Highest revision first, so an upgraded cache is picked up without code changes.
    const dirs = readdirSync(cacheRoot)
      .filter((d) => d.startsWith('chromium'))
      .sort((a, b) => (Number(b.split('-')[1]) || 0) - (Number(a.split('-')[1]) || 0));
    for (const dir of dirs) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
        'chrome-win/chrome.exe',
      ]) {
        const p = path.join(cacheRoot, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }

  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]) {
    if (existsSync(p)) return p;
  }
  return undefined; // let Playwright try its own default
}
