import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Audit UI-3: text on the glass, measured where it is hardest to read — over the strongest of the
 * glows behind it, which axe cannot see (they are a pseudo-element's gradient). Every text shade,
 * and white on every stop of the accent gradient, must hold WCAG AA (4.5:1) there, in both themes.
 * The sweep in the running app is `apps/api/scripts/contrast-audit.ts`; this keeps the tokens honest
 * between sweeps.
 */

const css = readFileSync(path.resolve(__dirname, '../src/index.css'), 'utf8');
type RGB = [number, number, number];

const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const lum = ([r, g, b]: RGB) => {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };
const over = (fg: RGB, alpha: number, bg: RGB): RGB => fg.map((c, i) => c * alpha + bg[i]! * (1 - alpha)) as RGB;
const rgba = (v: string): [RGB, number] => {
  const m = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(v)!;
  return [[+m[1]!, +m[2]!, +m[3]!], +m[4]!];
};

/** A theme's tokens: the light ones from @theme and :root, the dark ones from the data-theme block. */
function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const light = tokens(css.slice(css.indexOf('@theme {'), css.indexOf("[data-theme='dark'] {")));
const dark = { ...light, ...tokens(css.slice(css.indexOf("[data-theme='dark'] {"), css.indexOf('@media (prefers-color-scheme: dark)'))) };

/** The glass at its darkest (light) or lightest (dark): over whichever glow moves it most. */
function worstGlass(t: Record<string, string>, darkTheme: boolean): RGB {
  const canvas = hex(t['--color-canvas']!);
  const [surface, alpha] = rgba(t['--color-surface']!);
  const glasses = [1, 2, 3, 4, 5].map((i) => {
    const [glow, a] = rgba(t[`--glow-${i}`]!);
    return over(surface, alpha, over(glow, a, canvas));
  });
  return glasses.reduce((w, g) => ((darkTheme ? lum(g) > lum(w) : lum(g) < lum(w)) ? g : w));
}

describe('Text holds its contrast on the glass at its hardest (audit UI-3)', () => {
  for (const [name, t, isDark] of [['light', light, false], ['dark', dark, true]] as const) {
    const bg = worstGlass(t, isDark);
    it(`${name}: every ink shade used for text, 400 and up, keeps 4.5:1`, () => {
      for (const step of [400, 500, 600, 700, 800, 900]) {
        const fg = hex(t[`--color-ink-${step}`]!);
        expect(ratio(fg, bg), `ink-${step} ${t[`--color-ink-${step}`]}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('light: amber’s text shade keeps 4.5:1 (Tailwind’s own did not)', () => {
    expect(ratio(hex(light['--color-amber-700']!), worstGlass(light, false))).toBeGreaterThanOrEqual(4.5);
  });

  it('dark: each status palette’s text shades keep 4.5:1', () => {
    const bg = worstGlass(dark, true);
    for (const c of ['rose', 'amber', 'emerald', 'sky']) for (const s of [700, 800, 900]) {
      expect(ratio(hex(dark[`--color-${c}-${s}`]!), bg), `${c}-${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('white text keeps 4.5:1 on every stop of the accent gradient, resting and hovered', () => {
    const stops = [...`${light['--grad-accent']} ${light['--grad-accent-hover']}`.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]);
    expect(stops).toHaveLength(6);
    for (const s of stops) expect(ratio([255, 255, 255], hex(s)), s).toBeGreaterThanOrEqual(4.5);
  });
});
