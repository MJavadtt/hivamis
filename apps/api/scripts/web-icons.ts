/**
 * The web app's icons (audit UI-1), drawn from the owner's Hiva mark (packages/contracts/src/brand.ts,
 * ADR-094) by the same Chrome that renders PDFs. An SVG alone installs without a proper icon on iOS
 * and on part of Android.
 *
 *   pnpm icons
 *
 * First it writes the two sources from the mark, white on a near-black tile, as the owner's dark
 * artwork has it:
 *   - `public/hiva-icon.svg`: the mark as drawn, for 48px and up;
 *   - `public/hiva-icon-small.svg`: the same mark, larger on the tile and its lines a little heavier,
 *     for a browser tab's 16–32px, where the thin rings would otherwise blur away.
 *
 * Then five shapes:
 *   - `any`: the rounded tile as drawn, 192 and 512 (and 32 for a tab, from the small source).
 *   - `maskable`: the tile's fill to every edge and the mark inside the safe zone (a circle of 40%
 *     radius — the launcher cuts its own shape), 192 and 512.
 *   - Apple's touch icon: 180, full-bleed — iOS rounds the corners itself and fills transparency black.
 *   - The notification badge: the mark alone in white; Android paints it in one colour and shows no SVG.
 *
 * And the whole logo for emails, which show no SVG: `public/brand/hiva-logo-email.png`, ink on clear.
 *
 * The files carry `hiva-` names: a browser and an installed app keep an icon by its address, so the
 * new mark reached them only under a new one. The PNGs are committed; `icons.lock.json` keeps the
 * sources' hashes, so a test notices when a source changed and the PNGs did not.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { HIVA_MARK, hivaSvg } from '@hiva/contracts';
import { resolveExecutable } from '../src/pdf/browser-path.js';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

/** The mark, white, centred in a box of `box` units on the 192-unit tile; `stroke` thickens its lines. */
const markTile = (box: number, stroke = 0) => {
  const o = (192 - box) / 2, s = box / HIVA_MARK.w, ty = o + (box - HIVA_MARK.h * s) / 2;
  const heavier = stroke ? ` stroke="#ffffff" stroke-width="${stroke}" stroke-linejoin="round"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" role="img" aria-label="هیوامیس">
  <defs></defs>
  <rect width="192" height="192" rx="40" fill="#111111"/>
  <path fill="#ffffff" fill-rule="evenodd"${heavier} transform="translate(${o} ${ty.toFixed(2)}) scale(${s.toFixed(5)})" d="${HIVA_MARK.d}"/>
</svg>
`;
};
const source = markTile(150);
const small = markTile(164, 14);
writeFileSync(path.join(web, 'public/hiva-icon.svg'), source);
writeFileSync(path.join(web, 'public/hiva-icon-small.svg'), small);

const part = (re: RegExp, what: string) => {
  const m = source.match(re);
  if (!m) throw new Error(`hiva-icon.svg has no ${what}`);
  return m[0];
};
const defs = source.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? '';
const tile = part(/<rect[^>]*\/>/, '<rect> tile');
const mark = part(/<path[^>]*\/>/, '<path> mark');
const fill = tile.match(/fill="([^"]+)"/)?.[1] ?? '#000';
const svg = (viewBox: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${defs}${body}</svg>`;

// The mark fills a 150-unit box at the tile's centre; at 85% its farthest ink stays inside even the
// tightest launcher mask.
const fullBleed = svg('0 0 192 192', `<rect width="192" height="192" fill="${fill}"/><g transform="translate(96 96) scale(.85) translate(-96 -96)">${mark}</g>`);
const badge = svg('21 21 150 150', mark.replace(/fill="[^"]*"/, 'fill="#ffffff"'));
// 360 wide, shown at 180 in a mail: sharp on a phone's screen.
const logo = hivaSvg('logo', { color: '#111111' });

const outputs: { file: string; size: number; height?: number; svg: string }[] = [
  { file: 'hiva-192.png', size: 192, svg: source },
  { file: 'hiva-512.png', size: 512, svg: source },
  { file: 'hiva-favicon-32.png', size: 32, svg: small },
  { file: 'hiva-maskable-192.png', size: 192, svg: fullBleed },
  { file: 'hiva-maskable-512.png', size: 512, svg: fullBleed },
  { file: 'hiva-apple-touch.png', size: 180, svg: fullBleed },
  { file: 'hiva-badge-96.png', size: 96, svg: badge },
  { file: '../brand/hiva-logo-email.png', size: 360, height: 181, svg: logo },
];

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const outDir = path.join(web, 'public/icons');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: resolveExecutable(), headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const files: Record<string, string> = {};
  for (const o of outputs) {
    const height = o.height ?? o.size;
    await page.setViewportSize({ width: o.size, height });
    const src = `data:image/svg+xml;base64,${Buffer.from(o.svg).toString('base64')}`;
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${src}" width="${o.size}" height="${height}" style="display:block"></body></html>`);
    await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: o.size, height } });
    mkdirSync(path.dirname(path.join(outDir, o.file)), { recursive: true });
    writeFileSync(path.join(outDir, o.file), png);
    files[o.file] = sha(png);
    console.log(`${o.file}  ${o.size}×${height}  ${png.length} bytes`);
  }
  writeFileSync(path.join(web, 'scripts/icons.lock.json'), `${JSON.stringify({ source: sha(source), small: sha(small), files }, null, 2)}\n`);
} finally {
  await browser.close();
}
