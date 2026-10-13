/**
 * The visual pass (audit UI-V): every page, as each role, on a desktop (1440×900) and a phone
 * (390×844), the phone app included. On each screen it records what a person would trip over:
 *
 *   - console errors and uncaught exceptions;
 *   - requests that failed, or that the server answered 5xx (4xx is the visibility sweep's);
 *   - a page wider than the window (a sideways scroll on a phone);
 *   - visible controls cut off at the window's edge;
 *   - in English, chrome — buttons, headings, labels, tabs, column heads — still in Persian.
 *
 * One screenshot per page and size goes to docs/screens/ (the dashboard, My Work and the phone app
 * once per role, since they differ by role); the findings to a JSON report.
 *
 *   pnpm --filter @hiva/api exec tsx scripts/screen-sweep.ts [email …] [--out report.json] [--shots dir]
 *
 * Development only: the dev stack on localhost and the seed's test accounts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { resolveExecutable } from '../src/pdf/browser-path.js';
import { assertLocal, SCRIPT_AGENT, signIn, signOut } from './lib/browser-session.js';
import { walk } from './lib/walk.js';

const WEB = process.env.AUDIT_WEB ?? 'http://localhost:5173';
assertLocal(WEB);
const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args.splice(at, 2)[1]! : null; };
const OUT = flag('--out');
const SHOTS = flag('--shots') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/screens');
const LOCALE = (flag('--locale') ?? 'fa') as 'fa' | 'en';
/** One account for each role the seed has. */
const USERS = args.length ? args : ['admin', 'ceo', 'deputy', 'sales.manager', 'sales', 'account.manager', 'account', 'creative', 'designer', 'pmo', 'finance', 'legal'].map((u) => `${u}@hiva.local`);
const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;
/** These differ by who is looking; every other page is shot once, by the first role to reach it. */
const PER_ROLE = new Set(['/', '/my-work', '/m']);

export interface Finding { email: string; size: string; where: string; kind: 'console' | 'exception' | 'request' | 'overflow' | 'clipped' | 'untranslated'; detail: string }

const slug = (where: string) => where.replace(/^\//, '').replace(/[\s›]+/g, '_').replace(/[/:]+/g, '-').replace(/[^\p{L}\p{N}_.-]/gu, '') || 'home';

/** What the eye would catch on the screen as it stands. */
async function inspect(page: Page, english: boolean) {
  return page.evaluate((english) => {
    const out: { kind: 'overflow' | 'clipped' | 'untranslated'; detail: string }[] = [];
    const w = window.innerWidth;
    const doc = document.documentElement;
    if (doc.scrollWidth > w + 1) out.push({ kind: 'overflow', detail: `page is ${doc.scrollWidth}px wide in a ${w}px window` });
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return null;
      // The off-canvas menu on a phone is out of view on purpose.
      if (el.closest('aside') && (el.closest('aside')!.getBoundingClientRect().left >= w || el.closest('aside')!.getBoundingClientRect().right <= 0)) return null;
      return r;
    };
    for (const el of document.querySelectorAll('main button, main a, main input, main select, main [role="tab"], header button')) {
      const r = visible(el);
      if (!r) continue;
      // Inside something that scrolls sideways (a wide table, a tab strip), it is reachable.
      let p = el.parentElement, scrolls = false;
      while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') { scrolls = true; break; } p = p.parentElement; }
      if (scrolls) continue;
      if (r.right > w + 1 || r.left < -1) out.push({ kind: 'clipped', detail: `${el.tagName.toLowerCase()} «${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 40)}» at ${Math.round(r.left)}–${Math.round(r.right)}px` });
    }
    // A record's code broken across lines (PRJ-000016, F-1404-118): read as two codes, or none.
    const CODE = /^[A-Z]{1,6}(?:-\d+)+$/;
    // An enum shown as the API spells it (TRANSFER, PENDING_REVIEW) instead of in words.
    const KNOWN = new Set(['PDF', 'SLA', 'CRM', 'PMO', 'KPI', 'ROI', 'VAT', 'API', 'URL', 'CSV', 'USD', 'EUR', 'IRR', 'AED', 'GBP', 'TRY', 'CNY', 'GPU', 'CPU', 'HTML', 'JSON', 'OTP', 'SMS', 'ICS', 'PNG', 'JPG', 'JPEG', 'SVG', 'MP4', 'ZIP', 'RACI', 'BOQ', 'QC', 'PRJ', 'EN', 'FA', 'TSK', 'WO', 'NDA', 'CEO', 'IBAN', 'SHEBA', 'GMT', 'UTC', 'TIFF', 'WEBP', 'GIF', 'XLSX', 'DOCX', 'PPTX', 'RGB', 'CMYK', 'DPI', 'PPI', 'CODE']);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent ?? '').trim();
      const el = n.parentElement;
      if (!t || !el || !visible(el)) continue;
      if (CODE.test(t)) {
        const range = document.createRange();
        range.selectNodeContents(n);
        const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
        if (lines.size > 1) out.push({ kind: 'clipped', detail: `code «${t}» broken over ${lines.size} lines` });
      }
      if (!english && !el.closest('.ltr, code, kbd, pre, [data-user-content], input, textarea, svg')) {
        // Latin digits in a Persian sentence («دست‌کم 12 واژه»), outside codes, names and addresses.
        if (/[\u0600-\u06FF]/.test(t) && /(?<![A-Za-z_\-:@#\d.])\d+(?:[./]\d+)*(?![A-Za-z_\-:@\d])/.test(t)) {
          out.push({ kind: 'untranslated', detail: `Latin digits in «${t.slice(0, 60)}»` });
        }
        // A value on its own (TRANSFER), not a term inside a sentence (signed with HMAC).
        if (/^[A-Z][A-Z_]{3,}$/.test(t) && !KNOWN.has(t)) out.push({ kind: 'untranslated', detail: `«${t}» shown as the API spells it` });
      }
    }
    if (english) {
      for (const el of document.querySelectorAll('button, th, label, h1, h2, h3, [role="tab"], nav a')) {
        if (!visible(el) || el.closest('.ltr, [data-user-content]')) continue;
        const t = (el.textContent ?? '').trim();
        if (/[؀-ۿ]{2,}/.test(t)) out.push({ kind: 'untranslated', detail: `${el.tagName.toLowerCase()} «${t.slice(0, 50)}»` });
      }
    }
    return out;
  }, english);
}

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * One role at one size. The first size signs in; the next carries the same session over, so a role
 * costs one sign-in (the login limit is per address), and the last signs it out.
 */
async function sweep(browser: Browser, email: string, size: keyof typeof SIZES, shot: Set<string>, findings: Finding[], session: Session | null, last: boolean): Promise<{ screens: number; session: Session }> {
  const phone = size === 'phone';
  const context = await browser.newContext({
    ...(session ? { storageState: session } : {}),
    viewport: SIZES[size], isMobile: phone, hasTouch: phone, locale: LOCALE === 'en' ? 'en-US' : 'fa-IR',
    userAgent: SCRIPT_AGENT, reducedMotion: 'reduce',
  });
  // tsx names the functions declared inside page.evaluate with a helper the page does not have.
  await context.addInitScript({ content: 'window.__name = (f) => f;' });
  // The owl's first-visit greeting covers a third of a phone's screen until dismissed: dismissed here,
  // as a person does once, so the shots show the page. Its own screen is the guide test's.
  await context.addInitScript({ content: "try { localStorage.setItem('hiva.owl.greeted', '1'); } catch {}" });
  if (LOCALE === 'en') await context.addInitScript(() => { try { localStorage.setItem('hiva.locale', 'en'); } catch { /* none */ } });
  const page = await context.newPage();
  let since: { kind: Finding['kind']; detail: string }[] = [];
  page.on('console', (m) => { if (m.type() === 'error') since.push({ kind: 'console', detail: m.text().slice(0, 300) }); });
  page.on('pageerror', (e) => since.push({ kind: 'exception', detail: e.message.slice(0, 300) }));
  page.on('requestfailed', (r) => {
    // A request cut short because the page moved on is not a failure anyone sees.
    if (r.failure()?.errorText === 'net::ERR_ABORTED') return;
    since.push({ kind: 'request', detail: `${r.method()} ${new URL(r.url()).pathname} — ${r.failure()?.errorText}` });
  });
  page.on('response', (r) => { if (r.status() >= 500) since.push({ kind: 'request', detail: `${r.request().method()} ${new URL(r.url()).pathname} — ${r.status()}` }); });

  try {
    if (!session) {
      const signed = await signIn(context, WEB, email);
      if (!signed.ok) throw new Error(`${email}: sign-in answered ${signed.status}`);
    }
    const screens = await walk(page, WEB, {
      extra: ['/me', '/delegations', '/m'],
      visit: async (where) => {
        for (const f of [...since, ...await inspect(page, LOCALE === 'en')]) findings.push({ email, size, where, ...f });
        since = [];
        const route = where.split(' › ')[0]!;
        // The page as it opens — its first visit, whichever tab that shows.
        const key = PER_ROLE.has(route) ? `${email}|${route}` : route;
        if (!shot.has(`${size}|${key}`)) {
          shot.add(`${size}|${key}`);
          const dir = path.join(SHOTS, LOCALE === 'en' ? `${size}-en` : size);
          mkdirSync(dir, { recursive: true });
          const name = PER_ROLE.has(route) ? `${slug(route)}--${email.split('@')[0]}` : slug(route);
          await page.screenshot({ path: path.join(dir, `${name}.jpg`), type: 'jpeg', quality: 70, fullPage: false });
        }
      },
    });
    if (!screens) throw new Error(`${email}: the signed-in screen was not reached`);
    const kept = await context.storageState();
    if (last) await signOut(context, WEB);
    return { screens, session: kept };
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ executablePath: resolveExecutable(), headless: true });
const findings: Finding[] = [];
const shot = new Set<string>();
try {
  for (const email of USERS) {
    let session: Session | null = null;
    const sizes = Object.keys(SIZES) as (keyof typeof SIZES)[];
    for (const size of sizes) {
      const n = await sweep(browser, email, size, shot, findings, session, size === sizes.at(-1))
        .then((r) => { session = r.session; return r.screens; })
        .catch((e: Error) => { findings.push({ email, size, where: '-', kind: 'exception', detail: e.message }); return 0; });
      console.log(`${email} ${size}: ${n} screens`);
      // Kept as it goes: a sweep stopped part-way still has what it found.
      if (OUT) writeFileSync(OUT, JSON.stringify(findings, null, 2));
    }
  }
} finally {
  await browser.close();
}

const groups = new Map<string, { f: Finding; where: Set<string> }>();
for (const f of findings) {
  const key = `${f.kind}|${f.size}|${f.detail}`;
  const g = groups.get(key) ?? { f, where: new Set<string>() };
  g.where.add(`${f.email.split('@')[0]} ${f.where}`);
  groups.set(key, g);
}
for (const { f, where } of [...groups.values()].sort((a, b) => a.f.kind.localeCompare(b.f.kind))) {
  console.log(`\n[${f.kind}] ${f.size}  ${f.detail}\n  ${where.size} screen(s), e.g. ${[...where].slice(0, 3).join(' | ')}`);
}
console.log(`\n${groups.size} distinct finding(s); ${shot.size} screenshot(s) in ${SHOTS}`);
if (OUT) writeFileSync(OUT, JSON.stringify(findings, null, 2));
process.exitCode = groups.size ? 1 : 0;
