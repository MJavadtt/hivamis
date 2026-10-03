/**
 * «هر قسمتی به نقشی داده نشد، آن کاربر حتی نباید آن را ببیند» (Hivamis task 6), checked rather than
 * assumed. Signs in as each demo account on a running dev stack, opens every page its navigation
 * offers, the first record of each list, and every tab on each — and reports every call the screen
 * made that the server refused with 403: a part of the screen shown to someone who may not use it.
 *
 *   AUDIT_API=http://localhost:4100 pnpm --filter @hiva/api exec tsx scripts/visibility-audit.ts [email …]
 *
 * Run it against a copy of the database with jobs off (AUDIT_API), not the one people use: it makes
 * refused requests on purpose, and those are what the security-alert detectors read. Development
 * only — it signs in with the published demo password, on localhost.
 */
import { chromium, type Page } from 'playwright-core';
import { resolveExecutable } from '../src/pdf/renderer.js';

const WEB = process.env.AUDIT_WEB ?? 'http://localhost:5173';
const API = process.env.AUDIT_API ?? 'http://localhost:4000';
const PASSWORD = process.env.AUDIT_PASSWORD ?? 'Hiva@Dev2026!';
const SETTLE_MS = Number(process.env.AUDIT_SETTLE_MS ?? 1200);
const DEFAULT_USERS = ['sales.manager', 'sales', 'account', 'creative', 'designer', 'pmo', 'finance', 'legal', 'admin'].map((u) => `${u}@hiva.local`);

for (const u of [WEB, API]) {
  if (!['localhost', '127.0.0.1'].includes(new URL(u).hostname)) throw new Error(`refusing to run against ${u}: development only`);
}

interface Finding { page: string; call: string; status: number }

const settle = (page: Page) => page.waitForTimeout(SETTLE_MS);

async function clickTabs(page: Page, where: string, visit: (label: string) => void) {
  const count = await page.locator('main [role="tab"]').count();
  for (let i = 0; i < count; i++) {
    const tab = page.locator('main [role="tab"]').nth(i);
    const label = (await tab.textContent().catch(() => ''))?.trim() ?? '';
    visit(`${where} › ${label}`);
    await tab.click({ timeout: 3000 }).catch(() => undefined);
    await settle(page);
  }
}

async function audit(email: string, browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const login = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!login.ok) return { email, error: `login ${login.status}`, findings: [] as Finding[], pages: 0 };
  const { refreshToken } = await login.json() as { refreshToken: string };

  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'fa-IR' });
  const page = await context.newPage();
  // The page's API calls go to the audit API (a copy of the data, jobs off) instead of the dev one.
  if (API !== 'http://localhost:4000') {
    await page.route('**/api/v1/**', (route) => route.continue({ url: route.request().url().replace(new URL(WEB).origin, new URL(API).origin) }));
  }
  let where = '/';
  const findings: Finding[] = [];
  const seen = new Map<string, number>();
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/v1/')) seen.set(where, (seen.get(where) ?? 0) + 1);
    if (r.status() === 403 && url.pathname.startsWith('/api/v1/')) {
      findings.push({ page: where, call: `${r.request().method()} ${url.pathname.replace(/[0-9a-f-]{36}/g, ':id')}`, status: 403 });
    }
  });

  await page.goto(`${WEB}/icon.svg`);
  await page.evaluate((t) => localStorage.setItem('hiva.refresh', t), refreshToken);
  await page.goto(`${WEB}/`);
  await settle(page);
  const routes = [...new Set(await page.$$eval('aside nav a[href^="/"]', (as) => as.map((a) => a.getAttribute('href')!)))];
  // No navigation means the signed-in screen was never reached — a failed run, not a clean one.
  if (!routes.length) {
    await context.close();
    return { email, error: 'the signed-in screen was not reached (rate limit, or the session was refused)', findings: [] as Finding[], pages: 0 };
  }
  let pages = 0;
  for (const route of routes) {
    where = route;
    await page.goto(`${WEB}${route}`).catch(() => undefined);
    await settle(page); pages++;
    await clickTabs(page, route, (w) => { where = w; });
    // The first record of a list, and its tabs — opened by a link, or by clicking its row.
    const link = await page.locator(`main a[href^="${route}/"]`).first().getAttribute('href', { timeout: 800 }).catch(() => null);
    const before = page.url();
    if (link) await page.goto(`${WEB}${link}`).catch(() => undefined);
    else await page.locator('main tbody tr').first().click({ timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(300);
    if (page.url() !== before && new URL(page.url()).pathname.startsWith(`${route}/`)) {
      where = `${route}/:id`;
      await settle(page); pages++;
      await clickTabs(page, `${route}/:id`, (w) => { where = w; });
    }
  }
  if (process.env.AUDIT_VERBOSE) for (const [w, n] of seen) console.log(`    ${w}: ${n} API response(s)`);
  // Sign out: the session this made is closed, not left to expire.
  const current = await page.evaluate(() => localStorage.getItem('hiva.refresh'));
  if (current) await fetch(`${API}/api/v1/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: current }) }).catch(() => undefined);
  await context.close();
  return { email, findings, pages };
}

async function main() {
  const users = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_USERS;
  const browser = await chromium.launch({ executablePath: resolveExecutable(), headless: true });
  const results = [];
  try {
    for (const email of users) {
      const r = await audit(email, browser);
      results.push(r);
      const distinct = new Map(r.findings.map((f) => [`${f.page} → ${f.call}`, f]));
      console.log(`\n${email}: ${r.pages} pages${'error' in r && r.error ? ` — ${r.error}` : ''}, ${distinct.size} refused call(s) shown on screen`);
      for (const key of distinct.keys()) console.log(`  ${key}`);
    }
  } finally {
    await browser.close();
  }
  const total = results.reduce((n, r) => n + new Set(r.findings.map((f) => `${f.page}|${f.call}`)).size, 0);
  console.log(`\n${total === 0 ? 'Nothing shown that the server refused.' : `${total} place(s) show something their viewer may not use.`}`);
  const failed = results.filter((r) => 'error' in r && r.error).length;
  if (failed) console.log(`${failed} account(s) could not be checked — the result above is incomplete.`);
  process.exitCode = total === 0 && !failed ? 0 : 1;
}

void main();
