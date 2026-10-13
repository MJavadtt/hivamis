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
import { chromium } from 'playwright-core';
import { resolveExecutable } from '../src/pdf/browser-path.js';
import { assertLocal, SCRIPT_AGENT, signIn, signOut } from './lib/browser-session.js';
import { walk } from './lib/walk.js';

const WEB = process.env.AUDIT_WEB ?? 'http://localhost:5173';
const API = process.env.AUDIT_API ?? 'http://localhost:4000';
const SETTLE_MS = Number(process.env.AUDIT_SETTLE_MS ?? 1200);
const DEFAULT_USERS = ['sales.manager', 'sales', 'account', 'creative', 'designer', 'pmo', 'finance', 'legal', 'admin'].map((u) => `${u}@hiva.local`);

assertLocal(WEB, API);

interface Finding { page: string; call: string; status: number }

async function audit(email: string, browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'fa-IR', userAgent: SCRIPT_AGENT });
  // Signed in where the page's calls go; the cookie is the host's, whichever port answered.
  const signed = await signIn(context, API, email);
  if (!signed.ok) { await context.close(); return { email, error: `login ${signed.status}`, findings: [] as Finding[], pages: 0 }; }
  const page = await context.newPage();
  // The page's API calls go to the audit API (a copy of the data, jobs off) instead of the dev one.
  if (API !== 'http://localhost:4000') {
    await page.route('**/api/v1/**', (route) => route.continue({ url: route.request().url().replace(new URL(WEB).origin, new URL(API).origin) }));
  }
  // A screen's calls are made while it loads, before it is named: they wait, and take the name it gets.
  let pending: Omit<Finding, 'page'>[] = [];
  let calls = 0;
  const findings: Finding[] = [];
  const seen = new Map<string, number>();
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (!url.pathname.startsWith('/api/v1/')) return;
    calls++;
    if (r.status() === 403) pending.push({ call: `${r.request().method()} ${url.pathname.replace(/[0-9a-f-]{36}/g, ':id')}`, status: 403 });
  });
  const pages = await walk(page, WEB, {
    settleMs: SETTLE_MS,
    visit: (where) => {
      findings.push(...pending.map((f) => ({ ...f, page: where })));
      seen.set(where, calls);
      pending = []; calls = 0;
    },
  });
  // No navigation means the signed-in screen was never reached — a failed run, not a clean one.
  if (!pages) {
    await context.close();
    return { email, error: 'the signed-in screen was not reached (rate limit, or the session was refused)', findings: [] as Finding[], pages: 0 };
  }
  if (process.env.AUDIT_VERBOSE) for (const [w, n] of seen) console.log(`    ${w}: ${n} API response(s)`);
  // Sign out: the session this made is closed, not left to expire.
  await signOut(context, API);
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
