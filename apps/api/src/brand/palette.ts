/**
 * From a colour sample to the few colours a design is made of, and how far each is from a brand
 * colour (roadmap #43).
 *
 * RGB colours are grouped in CIELAB — where distance follows the eye — and compared with CIEDE2000.
 * CMYK colours stay in ink percentages and are compared ink by ink, the way a print brand guide
 * states them.
 */
import type { Sample } from './pixels.js';

export interface Swatch { hex?: string; cmyk?: [number, number, number, number]; share: number }

/* ── colour science ──────────────────────────────────────────────────────────────────────── */

export type Lab = [number, number, number];

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** sRGB (D65) to CIELAB. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export const chroma = ([, a, b]: Lab) => Math.hypot(a, b);

/** CIEDE2000 — about 1 is the smallest difference an eye sees side by side. */
export function deltaE2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, a: number) => { const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
  const hp1 = Cp1 === 0 ? 0 : hue(b1, ap1), hp2 = Cp2 === 0 ? 0 : hue(b2, ap2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) { dh = hp2 - hp1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2, Cpm = (Cp1 + Cp2) / 2;
  let hm = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) hm = Math.abs(hp1 - hp2) > 180 ? (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2 : (hp1 + hp2) / 2;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2), Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** The largest ink difference between two CMYK colours, in percentage points. */
export const inkDistance = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

/* ── the palette of a sample ─────────────────────────────────────────────────────────────── */

/** Colours closer than this (ΔE76 in Lab, ink points in CMYK) are one colour of the design. */
const MERGE_LAB = 10, MERGE_INK = 8;
const MAX_COLOURS = 12, MIN_SHARE = 0.01;

/**
 * The design's main colours with their share of the area: a histogram on a coarse grid, then the
 * grid's cells merged greedily, largest first, into the colour they sit close to.
 */
export function dominantColours(sample: Sample): Swatch[] {
  const n = sample.space === 'CMYK' ? 4 : 3;
  const total = sample.values.length / n;
  if (!total) return [];
  const bins = new Map<number, { count: number; sum: number[] }>();
  for (let i = 0; i < sample.values.length; i += n) {
    const px = sample.values.slice(i, i + n);
    // RGB on 5 bits a channel; ink on 4-point steps.
    const key = n === 3 ? ((px[0]! >> 3) << 10) | ((px[1]! >> 3) << 5) | (px[2]! >> 3)
      : px.reduce((k, v) => k * 26 + Math.min(25, Math.floor(v / 4)), 0);
    const bin = bins.get(key) ?? { count: 0, sum: new Array(n).fill(0) };
    bin.count++;
    px.forEach((v, c) => { bin.sum[c]! += v; });
    bins.set(key, bin);
  }
  const clusters: { count: number; sum: number[]; lab: Lab | null }[] = [];
  const mean = (c: { count: number; sum: number[] }) => c.sum.map((v) => v / c.count);
  const labOf = (m: number[]): Lab | null => (n === 3 ? rgbToLab(m[0]!, m[1]!, m[2]!) : null);
  const distance = (m: number[], lab: Lab | null, c: (typeof clusters)[number]) =>
    n === 3 ? Math.hypot(lab![0] - c.lab![0], lab![1] - c.lab![1], lab![2] - c.lab![2]) : inkDistance(m, mean(c));
  for (const bin of [...bins.values()].sort((a, b) => b.count - a.count)) {
    const m = mean(bin), lab = labOf(m);
    let best: (typeof clusters)[number] | null = null, bestD = Infinity;
    for (const c of clusters) { const d = distance(m, lab, c); if (d < bestD) { best = c; bestD = d; } }
    if (best && (bestD < (n === 3 ? MERGE_LAB : MERGE_INK) || clusters.length >= MAX_COLOURS)) {
      best.count += bin.count;
      bin.sum.forEach((v, c) => { best!.sum[c]! += v; });
      best.lab = labOf(mean(best));
    } else {
      clusters.push({ count: bin.count, sum: [...bin.sum], lab });
    }
  }
  return clusters
    .map((c) => {
      const m = mean(c), share = Math.round((c.count / total) * 1000) / 1000;
      return n === 3 ? { hex: rgbToHex(m[0]!, m[1]!, m[2]!), share } : { cmyk: m.map((v) => Math.round(v)) as Swatch['cmyk'], share };
    })
    .filter((s) => s.share >= MIN_SHARE)
    .sort((a, b) => b.share - a.share);
}
