/**
 * Every screen a signed-in person can reach: each page their navigation offers, every tab on it,
 * the first record of each list and every tab on that. Shared by the sweeps that look at the running
 * app, so they agree on what "every page" means.
 */
import type { Page } from 'playwright-core';

export interface WalkOptions {
  /** How long a screen is given to load and settle before it is looked at. */
  settleMs?: number;
  /** Pages to visit besides the navigation's — ones it does not link, such as /me or /m. */
  extra?: string[];
  /** Called on each screen as it stands; `where` names it, e.g. `/projects/:id › زمان‌بندی`. */
  visit: (where: string) => Promise<void> | void;
}

/**
 * Moves inside the app, as a click on a link does, rather than loading the page afresh: a fresh load
 * restores the session (one refresh each), and sixty of those in a few minutes is not how anyone
 * uses it — the refresh budget says so.
 */
const go = (page: Page, route: string) => page.evaluate((r) => {
  window.history.pushState(null, '', r);
  window.dispatchEvent(new PopStateEvent('popstate'));
}, route);

/**
 * Requests in flight, per page — all but the live stream (/api/v1/events), which stays open for as
 * long as the page does, so "the network is quiet" never comes while it counts.
 */
const inFlight = new WeakMap<Page, Set<unknown>>();
function track(page: Page) {
  if (inFlight.has(page)) return inFlight.get(page)!;
  const open = new Set<unknown>();
  const done = (r: unknown) => open.delete(r);
  page.on('request', (r) => { if (!r.url().includes('/api/v1/events')) open.add(r); });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  inFlight.set(page, open);
  return open;
}

/** Until nothing has been in flight for a moment (at most `ms` × 4), then `ms` more for drawing. */
const settle = async (page: Page, ms: number) => {
  const open = track(page);
  const until = Date.now() + ms * 4;
  let quietSince = 0;
  while (Date.now() < until) {
    if (open.size) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince >= 250) break;
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(ms);
};

async function tabs(page: Page, where: string, o: Required<Pick<WalkOptions, 'settleMs' | 'visit'>>) {
  const count = await page.locator('main [role="tab"]').count();
  for (let i = 0; i < count; i++) {
    const tab = page.locator('main [role="tab"]').nth(i);
    const label = (await tab.textContent().catch(() => ''))?.trim() ?? '';
    // The first tab is the one already open.
    if (i > 0) {
      await tab.click({ timeout: 3000 }).catch(() => undefined);
      await settle(page, o.settleMs);
    }
    await o.visit(`${where} › ${label}`);
  }
  if (!count) await o.visit(where);
}

/** Returns the number of screens visited; 0 means the signed-in screen was never reached. */
export async function walk(page: Page, web: string, options: WalkOptions): Promise<number> {
  const o = { settleMs: 500, ...options };
  track(page);
  await page.goto(`${web}/`);
  await settle(page, o.settleMs);
  const routes = [...new Set(await page.$$eval('aside nav a[href^="/"]', (as) => as.map((a) => a.getAttribute('href')!)))];
  if (!routes.length) return 0;
  let screens = 0;
  const visit = async (where: string) => { screens++; await o.visit(where); };
  for (const route of [...routes, ...(o.extra ?? [])]) {
    await go(page, route);
    await settle(page, o.settleMs);
    await tabs(page, route, { settleMs: o.settleMs, visit });
    // The first record of a list — opened by its link, or by clicking its row.
    const link = await page.locator(`main a[href^="${route}/"]`).first().getAttribute('href', { timeout: 800 }).catch(() => null);
    const before = page.url();
    if (link) await go(page, link);
    else await page.locator('main tbody tr').first().click({ timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(300);
    if (page.url() !== before && new URL(page.url()).pathname.startsWith(`${route}/`) && route !== '/') {
      await settle(page, o.settleMs);
      await tabs(page, `${route}/:id`, { settleMs: o.settleMs, visit });
    }
  }
  return screens;
}
