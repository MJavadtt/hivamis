/**
 * Glass is a blur of whatever lies behind it, redrawn on every frame that moves (audit UI-3). On a
 * device with few cores, or one already missing frames, it costs more than it gives: there the blur
 * goes and the glass turns solid — the look `prefers-reduced-transparency` asks for (index.css,
 * `:root[data-power='low']`).
 */

/** A frame slower than this, at the median, is a device already struggling: 50 frames a second. */
export const FRAME_BUDGET_MS = 20;

export function fewCores(cores: number | undefined = navigator.hardwareConcurrency): boolean {
  return typeof cores === 'number' && cores > 0 && cores <= 4;
}

/**
 * The median time between `frames` consecutive frames. The median, so one long frame — a screen
 * mounting — does not decide it.
 */
export function medianFrameMs(frames = 30, raf: (cb: FrameRequestCallback) => number = requestAnimationFrame): Promise<number> {
  return new Promise((resolve) => {
    const stamps: number[] = [];
    const tick = (t: number) => {
      stamps.push(t);
      if (stamps.length <= frames) { raf(tick); return; }
      const gaps = stamps.slice(1).map((s, i) => s - stamps[i]!).sort((a, b) => a - b);
      resolve(gaps[Math.floor(gaps.length / 2)]!);
    };
    raf(tick);
  });
}

export function goLowPower(why: 'cores' | 'frames'): void {
  const root = document.documentElement;
  root.dataset.power = 'low';
  // Whoever wonders why the glass is solid on this device can read why.
  root.dataset.powerWhy = why;
}

/**
 * Decides once per load. Few cores decide at once, before the first paint. Otherwise the frames are
 * timed once the first screen has drawn, and only while the page is in view: a hidden tab draws no
 * frames, and the gap it leaves is not the device's speed.
 */
export function watchPower(): void {
  if (fewCores()) { goLowPower('cores'); return; }
  const probe = () => {
    if (document.visibilityState !== 'visible') {
      document.addEventListener('visibilitychange', probe, { once: true });
      return;
    }
    let hidden = false;
    const away = () => { hidden = true; };
    document.addEventListener('visibilitychange', away, { once: true });
    void medianFrameMs().then((ms) => {
      document.removeEventListener('visibilitychange', away);
      if (hidden) { probe(); return; }
      if (ms > FRAME_BUDGET_MS) goLowPower('frames');
    });
  };
  window.setTimeout(probe, 2000);
}
