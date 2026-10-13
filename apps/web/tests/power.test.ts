import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { FRAME_BUDGET_MS, fewCores, medianFrameMs, watchPower } from '../src/lib/power';

/**
 * Audit UI-3: three overlays blurred the page behind them with no regard for
 * `prefers-reduced-transparency`, and nothing spared a slow device the blur. Every blur now goes
 * through a token that each fallback turns off.
 */

const src = path.resolve(__dirname, '../src');
const css = readFileSync(path.join(src, 'index.css'), 'utf8');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = path.join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(f) ? [p] : [];
});
const block = (opening: string) => {
  const at = css.indexOf(opening);
  expect(at, opening).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.power;
  delete document.documentElement.dataset.powerWhy;
});

describe('Every blur can be turned off (audit UI-3)', () => {
  it('no blur is written outside a token: no Tailwind backdrop-blur class, no literal backdrop-filter', () => {
    for (const f of files(src)) {
      const text = readFileSync(f, 'utf8');
      expect(text, path.relative(src, f)).not.toMatch(/\bbackdrop-blur(-|\b)/);
      for (const m of text.matchAll(/^\s*(?:-webkit-)?backdrop-filter:\s*([^;]+);/gm)) expect(m[1], path.relative(src, f)).toMatch(/^var\(--[\w-]+-blur\)$/);
    }
  });

  it('each blur token is turned off, and the glass made solid, where transparency is unwelcome and on a slow device', () => {
    const tokens = [...new Set([...css.matchAll(/backdrop-filter:\s*var\((--[\w-]+-blur)\)/g)].map((m) => m[1]!))];
    expect(tokens.sort()).toEqual(['--glass-blur', '--scrim-blur']);
    for (const opening of ['@media (prefers-reduced-transparency: reduce) {', ":root[data-power='low'] {"]) {
      const b = block(opening);
      for (const t of tokens) expect(b, `${opening} ${t}`).toContain(`${t}: none;`);
      expect(b).toContain('--color-surface: var(--color-panel);');
    }
  });
});

describe('The low-power fallback', () => {
  it('four cores or fewer is a low-power device; an unknown count is not', () => {
    expect([1, 2, 4].map((c) => fewCores(c))).toEqual([true, true, true]);
    expect([6, 8, 16].map((c) => fewCores(c))).toEqual([false, false, false]);
    expect(fewCores(undefined)).toBe(false);
    expect(fewCores(0)).toBe(false);
  });

  it('times frames by their median, so one long frame does not decide', async () => {
    const at = (gaps: number[]) => {
      let t = 0, i = 0;
      return (cb: FrameRequestCallback) => { t += gaps[Math.min(i++, gaps.length - 1)]!; queueMicrotask(() => cb(t)); return i; };
    };
    expect(await medianFrameMs(30, at([16.7]))).toBeCloseTo(16.7);
    expect(await medianFrameMs(30, at([16.7, 16.7, 400, 16.7]))).toBeCloseTo(16.7);
    expect(await medianFrameMs(30, at([25]))).toBeGreaterThan(FRAME_BUDGET_MS);
  });

  it('few cores drop the blur before anything is drawn', () => {
    vi.stubGlobal('navigator', { ...navigator, hardwareConcurrency: 4 });
    watchPower();
    expect(document.documentElement.dataset.power).toBe('low');
    expect(document.documentElement.dataset.powerWhy).toBe('cores');
  });

  for (const [gap, low] of [[33, true], [16.7, false]] as const) {
    it(`more cores: frames ${gap} ms apart, once the first screen has drawn, ${low ? 'drop' : 'keep'} the blur`, async () => {
      vi.useFakeTimers();
      vi.stubGlobal('navigator', { ...navigator, hardwareConcurrency: 8 });
      let t = 0;
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { t += gap; queueMicrotask(() => cb(t)); return 1; });
      watchPower();
      expect(document.documentElement.dataset.power).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(document.documentElement.dataset.power === 'low').toBe(low));
      if (low) expect(document.documentElement.dataset.powerWhy).toBe('frames');
    });
  }
});
