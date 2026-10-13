/**
 * Chrome's own verdict on whether the web app installs (audit UI-1), for both manifests: the full
 * interface's and the phone app's (/m). Lighthouse removed its PWA category in version 12, so this
 * asks the browser directly — the same check that decides whether "Install" is offered.
 *
 *   pnpm check:installable [http://localhost:5173]
 *
 * Needs the web app served (`pnpm dev`, or `vite preview` after a build); the API need not be up.
 * Exits non-zero on any installability error or manifest warning.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { resolveExecutable } from '../src/pdf/browser-path.js';

const WEB = process.argv[2] ?? process.env.INSTALLABLE_WEB ?? 'http://localhost:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(WEB).hostname)) throw new Error(`refusing to run against ${WEB}: a local build only`);

interface ManifestAnswer { url: string; errors: { message: string; critical: number }[] }
interface InstallAnswer { installabilityErrors: { errorId: string; errorArguments: { name: string; value: string }[] }[] }

// A real profile, however short-lived: Chrome never offers to install from an incognito window.
const profile = mkdtempSync(path.join(os.tmpdir(), 'hiva-installable-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: resolveExecutable(), headless: true });
let failed = false;
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(WEB, { waitUntil: 'load' });
  const cdp = await context.newCDPSession(page);
  for (const manifest of ['/manifest.webmanifest', '/manifest-m.webmanifest']) {
    // The phone app swaps this link when /m opens; here it is swapped by hand, before asking.
    await page.evaluate((href) => document.querySelector('link[rel="manifest"]')?.setAttribute('href', href), manifest);
    const m = await cdp.send('Page.getAppManifest') as ManifestAnswer;
    const i = await cdp.send('Page.getInstallabilityErrors') as InstallAnswer;
    const problems = [
      ...m.errors.map((e) => `${e.critical ? 'error' : 'warning'}: ${e.message}`),
      ...i.installabilityErrors.map((e) => `not installable: ${e.errorId}${e.errorArguments.length ? ` (${e.errorArguments.map((a) => `${a.name}=${a.value}`).join(', ')})` : ''}`),
    ];
    console.log(`${manifest}  ${problems.length ? 'FAIL' : 'installable'}  (${m.url})`);
    for (const p of problems) console.log(`  - ${p}`);
    if (problems.length || !m.url.endsWith(manifest)) failed = true;
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
