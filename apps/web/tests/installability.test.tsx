import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { act, render } from '@testing-library/react';
import { CANVAS, ThemeProvider, useTheme, type ThemePreference } from '../src/lib/theme';

/**
 * Audit UI-1: the app installed with only an SVG icon, its purposes run together, no Apple touch
 * icon, and a near-black bar over a pastel interface. Each of Chrome's install requirements, and
 * iOS's, is checked here against the files that ship. (Lighthouse dropped its PWA category in
 * version 12; Chrome's own verdict is `pnpm check:installable` against a running build.)
 */

const web = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(web, p), 'utf8');
const css = read('src/index.css');
const html = read('index.html');

/** Width and height from a PNG's header — the file must be what its `sizes` claims. */
function pngSize(file: string): string {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1'), `${file} is not a PNG`).toBe('PNG');
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}
const pub = (src: string) => path.join(web, 'public', src.replace(/^\//, ''));

interface Icon { src: string; sizes: string; type: string; purpose?: string }
interface Manifest { name: string; short_name: string; id?: string; start_url: string; scope: string; display: string; theme_color: string; background_color: string; icons: Icon[] }

describe('Installable on every platform (audit UI-1)', () => {
  for (const file of ['manifest.webmanifest', 'manifest-m.webmanifest']) {
    it(`${file}: PNG icons at 192 and 512, «any» and «maskable» kept apart, colours from the light canvas`, () => {
      const m = JSON.parse(read(`public/${file}`)) as Manifest;
      expect(m.name && m.short_name && m.id).toBeTruthy();
      expect(m.display).toBe('standalone');
      expect(m.start_url.startsWith(m.scope)).toBe(true);

      for (const icon of m.icons) {
        // One purpose each: an icon used as both is either padded too much or cropped.
        expect(icon.purpose === 'any' || icon.purpose === 'maskable', `${icon.src}: ${icon.purpose}`).toBe(true);
        expect(existsSync(pub(icon.src)), icon.src).toBe(true);
        if (icon.type === 'image/png') expect(pngSize(pub(icon.src)), icon.src).toBe(icon.sizes);
      }
      const has = (purpose: string, sizes: string) => m.icons.some((i) => i.type === 'image/png' && i.purpose === purpose && i.sizes === sizes);
      for (const sizes of ['192x192', '512x512']) {
        expect(has('any', sizes), `any ${sizes}`).toBe(true);
        expect(has('maskable', sizes), `maskable ${sizes}`).toBe(true);
      }

      expect(m.theme_color).toBe(CANVAS.light);
      expect(m.background_color).toBe(CANVAS.light);
    });
  }

  it('the light and dark canvas the bar takes are the stylesheet’s own', () => {
    expect(css).toContain(`--color-canvas: ${CANVAS.light};`);
    expect(css).toContain(`--color-canvas: ${CANVAS.dark};`);
  });

  it('index.html: Apple’s touch icon at 180, the home-screen metas, and a bar colour for each scheme', () => {
    const touch = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1];
    expect(touch).toBeTruthy();
    expect(pngSize(pub(touch!))).toBe('180x180');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
    expect(html).toMatch(/<meta name="apple-mobile-web-app-status-bar-style" content="(default|black|black-translucent)" \/>/);
    expect(html).toContain(`<meta name="theme-color" content="${CANVAS.light}" media="(prefers-color-scheme: light)" />`);
    expect(html).toContain(`<meta name="theme-color" content="${CANVAS.dark}" media="(prefers-color-scheme: dark)" />`);
    expect(html).not.toContain('#010101');
  });

  it('the PNGs were drawn from the current icon.svg (pnpm icons), and none was swapped by hand', () => {
    const lock = JSON.parse(read('scripts/icons.lock.json')) as { source: string; small: string; files: Record<string, string> };
    const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
    // The tab's mark is drawn for 16–32px (the Hiva mark, 2026-10-16); its PNG comes from it too.
    expect(lock.small, 'icon-small.svg changed: run `pnpm icons` and commit the PNGs').toBe(sha(read('public/icon-small.svg')));
    expect(lock.source, 'icon.svg changed: run `pnpm icons` and commit the PNGs').toBe(sha(read('public/icon.svg')));
    for (const [file, hash] of Object.entries(lock.files)) {
      expect(sha(readFileSync(pub(`icons/${file}`))), file).toBe(hash);
    }
  });

  it('a notification carries PNGs: Android shows no SVG icon or badge', () => {
    const sw = read('public/sw.js');
    const icon = sw.match(/icon: '([^']+)'/)?.[1];
    const badge = sw.match(/badge: '([^']+)'/)?.[1];
    expect(icon).toMatch(/\.png$/);
    expect(badge).toMatch(/\.png$/);
    expect(pngSize(pub(badge!))).toBe('96x96');
    expect(existsSync(pub(icon!))).toBe(true);
  });
});

describe('The browser’s bar follows the theme chosen, not only the system’s', () => {
  afterEach(() => { document.head.innerHTML = ''; localStorage.clear(); });

  it('a chosen theme paints both metas its colour; «system» gives each back its own', () => {
    document.head.innerHTML = html.match(/<meta name="theme-color"[^>]*\/>/g)!.join('');
    const metas = () => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content'));
    let choose: (p: ThemePreference) => void = () => undefined;
    const Probe = () => { choose = useTheme().setPreference; return null; };
    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(metas()).toEqual([CANVAS.light, CANVAS.dark]);
    act(() => choose('dark'));
    expect(metas()).toEqual([CANVAS.dark, CANVAS.dark]);
    act(() => choose('light'));
    expect(metas()).toEqual([CANVAS.light, CANVAS.light]);
    act(() => choose('system'));
    expect(metas()).toEqual([CANVAS.light, CANVAS.dark]);
  });
});
