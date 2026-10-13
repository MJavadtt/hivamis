/**
 * Text contrast on every screen, in the light and in the dark (audit UI-3): axe-core's
 * `color-contrast` rule run in Chrome, over the real glass, against WCAG AA (4.5:1, or 3:1 for large
 * text). Signs in as each account given, walks every page, tab and first record (lib/walk.ts), and
 * also checks the screens seen signed out.
 *
 *   pnpm --filter @hiva/api exec tsx scripts/contrast-audit.ts [email …] [--out report.json]
 *
 * Development only: a running dev stack on localhost and the seed's test accounts. Motion is reduced,
 * so nothing is measured half-way through fading in.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from 'playwright-core';
import { resolveExecutable } from '../src/pdf/browser-path.js';
import { assertLocal, SCRIPT_AGENT, signIn, signOut } from './lib/browser-session.js';
import { walk } from './lib/walk.js';

const WEB = process.env.AUDIT_WEB ?? 'http://localhost:5173';
assertLocal(WEB);
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const USERS = args.length ? args : ['admin@hiva.local', 'designer@hiva.local'];
const SIGNED_OUT = ['/', '/portal', '/signup'];
const THEMES = ['light', 'dark'] as const;

const axe = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

interface Failure { theme: string; where: string; target: string; html: string; fg: string; bg: string; ratio: number; needed: number; fontSize: string; fontWeight: string }

async function check(page: Page, theme: string, where: string, out: Failure[], unsure: Map<string, number>) {
  // Measured on the glass as designed, the harder case: a slow headless frame must not turn it solid first.
  await page.evaluate(() => { delete document.documentElement.dataset.power; });
  await page.addScriptTag({ content: axe });
  const r = await page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: { nodes: { target: string[]; html: string; any: { data: Record<string, unknown> }[] }[] }[]; incomplete: { nodes: { any: { data: { messageKey?: string } | null }[] }[] }[] }> } };
    const res = await w.axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, resultTypes: ['violations', 'incomplete'] });
    return {
      violations: res.violations.flatMap((v) => v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 200), data: n.any[0]?.data ?? {} }))),
      incomplete: res.incomplete.flatMap((v) => v.nodes.map((n) => n.any[0]?.data?.messageKey ?? 'unknown')),
    };
  });
  for (const v of r.violations) {
    const d = v.data as { fgColor: string; bgColor: string; contrastRatio: number; expectedContrastRatio: string; fontSize: string; fontWeight: string };
    out.push({ theme, where, target: v.target, html: v.html, fg: d.fgColor, bg: d.bgColor, ratio: d.contrastRatio, needed: Number.parseFloat(d.expectedContrastRatio), fontSize: d.fontSize, fontWeight: d.fontWeight });
  }
  for (const k of r.incomplete) unsure.set(k, (unsure.get(k) ?? 0) + 1);
}

async function run(browser: Browser, theme: typeof THEMES[number], email: string | null, out: Failure[], unsure: Map<string, number>) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', locale: 'fa-IR', userAgent: SCRIPT_AGENT });
  const page = await context.newPage();
  let screens = 0;
  try {
    if (!email) {
      for (const path of SIGNED_OUT) {
        await page.goto(`${WEB}${path}`);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(600);
        await check(page, theme, `(signed out) ${path}`, out, unsure); screens++;
      }
      return screens;
    }
    const signed = await signIn(context, WEB, email);
    if (!signed.ok) throw new Error(`${email}: sign-in answered ${signed.status}`);
    screens = await walk(page, WEB, { extra: ['/me', '/m'], visit: (where) => check(page, theme, where, out, unsure) });
    if (!screens) throw new Error(`${email}: the signed-in screen was not reached`);
    await signOut(context, WEB);
    return screens;
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ executablePath: resolveExecutable(), headless: true });
const failures: Failure[] = [];
const unsure = new Map<string, number>();
const incomplete: string[] = [];
try {
  for (const theme of THEMES) {
    for (const email of [null, ...USERS]) {
      const n = await run(browser, theme, email, failures, unsure).catch((e: Error) => { incomplete.push(`${theme} ${e.message}`); return 0; });
      console.log(`${theme}  ${email ?? '(signed out)'}: ${n} screens`);
    }
  }
} finally {
  await browser.close();
}

// The same element failing on many screens is one fault: grouped by what it looks like.
const groups = new Map<string, { sample: Failure; screens: Set<string> }>();
for (const f of failures) {
  const key = `${f.theme}|${f.fg}|${f.bg}|${f.html.replace(/>[^<]*</g, '><').slice(0, 120)}`;
  const g = groups.get(key) ?? { sample: f, screens: new Set<string>() };
  g.screens.add(f.where);
  groups.set(key, g);
}
for (const { sample: s, screens } of [...groups.values()].sort((a, b) => a.sample.ratio - b.sample.ratio)) {
  console.log(`\n${s.theme}  ${s.ratio}:1 (needs ${s.needed}:1)  ${s.fg} on ${s.bg}  ${s.fontSize} ${s.fontWeight}`);
  console.log(`  ${s.html}`);
  console.log(`  on ${screens.size} screen(s), e.g. ${[...screens].slice(0, 3).join(' | ')}`);
}
console.log(`\n${groups.size} distinct contrast failure(s), ${failures.length} in all.`);
console.log(`Not decidable by axe (needs a look): ${[...unsure].map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'}`);
if (OUT) writeFileSync(OUT, JSON.stringify({ failures, unsure: Object.fromEntries(unsure) }, null, 2));
if (incomplete.length) console.log(`Not checked — the result above is incomplete:\n  ${incomplete.join('\n  ')}`);
process.exitCode = groups.size || incomplete.length ? 1 : 0;
