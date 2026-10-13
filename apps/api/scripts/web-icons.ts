/**
 * The web app's PNG icons, drawn from `apps/web/public/icon.svg` by the same Chrome that renders
 * PDFs (audit UI-1). An SVG alone installs without a proper icon on iOS and on part of Android.
 *
 *   pnpm icons
 *
 * One source, five shapes:
 *   - `any`: the rounded tile as drawn, 192 and 512 (and 32 for a tab).
 *   - `maskable`: the tile's fill to every edge and the mark inside the safe zone (a circle of 40%
 *     radius — the launcher cuts its own shape), 192 and 512.
 *   - Apple's touch icon: 180, full-bleed — iOS rounds the corners itself and fills transparency black.
 *   - The notification badge: the mark alone in white; Android paints it in one colour and shows no SVG.
 *
 * The PNGs are committed; `icons.lock.json` keeps the SVG's hash, so a test notices when the source
 * changed and the PNGs did not.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveExecutable } from '../src/pdf/browser-path.js';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const source = readFileSync(path.join(web, 'public/icon.svg'), 'utf8');

const part = (re: RegExp, what: string) => {
  const m = source.match(re);
  if (!m) throw new Error(`icon.svg has no ${what}`);
  return m[0];
};
const defs = source.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? '';
const tile = part(/<rect[^>]*\/>/, '<rect> tile');
const mark = part(/<path[^>]*\/>/, '<path> mark');
const fill = tile.match(/fill="([^"]+)"/)?.[1] ?? '#000';
const svg = (viewBox: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${defs}${body}</svg>`;

// The mark spans a circle of 32% of the tile; at 85% it sits at 27%, inside even the tightest launcher mask.
const fullBleed = svg('0 0 192 192', `<rect width="192" height="192" fill="${fill}"/><g transform="translate(96 96) scale(.85) translate(-96 -96)">${mark}</g>`);
const badge = svg('30 30 132 132', mark.replace(/stroke="[^"]*"/, 'stroke="#ffffff"'));

const outputs: { file: string; size: number; svg: string }[] = [
  { file: 'icon-192.png', size: 192, svg: source },
  { file: 'icon-512.png', size: 512, svg: source },
  { file: 'favicon-32.png', size: 32, svg: source },
  { file: 'icon-maskable-192.png', size: 192, svg: fullBleed },
  { file: 'icon-maskable-512.png', size: 512, svg: fullBleed },
  { file: 'apple-touch-icon.png', size: 180, svg: fullBleed },
  { file: 'badge-96.png', size: 96, svg: badge },
];

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const outDir = path.join(web, 'public/icons');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: resolveExecutable(), headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const files: Record<string, string> = {};
  for (const o of outputs) {
    await page.setViewportSize({ width: o.size, height: o.size });
    const src = `data:image/svg+xml;base64,${Buffer.from(o.svg).toString('base64')}`;
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${src}" width="${o.size}" height="${o.size}" style="display:block"></body></html>`);
    await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: o.size, height: o.size } });
    writeFileSync(path.join(outDir, o.file), png);
    files[o.file] = sha(png);
    console.log(`${o.file}  ${o.size}×${o.size}  ${png.length} bytes`);
  }
  writeFileSync(path.join(web, 'scripts/icons.lock.json'), `${JSON.stringify({ source: sha(source), files }, null, 2)}\n`);
} finally {
  await browser.close();
}
