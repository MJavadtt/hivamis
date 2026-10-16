// Traces the Hiva logo (black ink on white) into SVG paths, for packages/contracts/src/brand.ts:
//
//   node apps/api/scripts/brand-trace.mjs docs/brand/hiva-logo-light.webp /tmp/brand
//
// Marching squares on the anti-aliased luminance, so edges land between pixels; each contour
// simplified (Ramer–Douglas–Peucker), then drawn as smooth quadratic curves through midpoints except
// at real corners. Writes the mark, the wordmark, the tagline and the lockup, each cropped to its own
// ink in currentColor, and brand.json with each piece's place in the lockup.
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../package.json', import.meta.url))('sharp');
import { writeFileSync, mkdirSync } from 'node:fs';

const SRC = process.argv[2];
const OUT = process.argv[3];
mkdirSync(OUT, { recursive: true });

const { data, info } = await sharp(SRC).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
// Ink: 0 (paper) .. 255 (ink); a one-pixel paper border so every contour closes.
const ink = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : 255 - data[y * W + x]);
const LEVEL = 128;

// Marching squares over cells whose corners are pixel centres, from (-1,-1) to (W,H).
const segs = []; // [edgeA, edgeB, pA, pB]
const pt = new Map(); // edge key → [x, y]
const edgePoint = (key, ax, ay, bx, by) => {
  if (pt.has(key)) return key;
  const va = ink(ax, ay), vb = ink(bx, by);
  const t = va === vb ? 0.5 : (LEVEL - va) / (vb - va);
  pt.set(key, [ax + (bx - ax) * t, ay + (by - ay) * t]);
  return key;
};
for (let y = -1; y < H; y++) {
  for (let x = -1; x < W; x++) {
    const a = ink(x, y) >= LEVEL ? 1 : 0, b = ink(x + 1, y) >= LEVEL ? 1 : 0;
    const c = ink(x + 1, y + 1) >= LEVEL ? 1 : 0, d = ink(x, y + 1) >= LEVEL ? 1 : 0;
    const idx = a * 8 + b * 4 + c * 2 + d;
    if (idx === 0 || idx === 15) continue;
    const top = () => edgePoint(`h${x},${y}`, x, y, x + 1, y);
    const right = () => edgePoint(`v${x + 1},${y}`, x + 1, y, x + 1, y + 1);
    const bottom = () => edgePoint(`h${x},${y + 1}`, x, y + 1, x + 1, y + 1);
    const left = () => edgePoint(`v${x},${y}`, x, y, x, y + 1);
    const centre = (ink(x, y) + ink(x + 1, y) + ink(x + 1, y + 1) + ink(x, y + 1)) / 4 >= LEVEL;
    const add = (p, q) => segs.push([p(), q()]);
    switch (idx) {
      case 1: case 14: add(left, bottom); break;
      case 2: case 13: add(bottom, right); break;
      case 3: case 12: add(left, right); break;
      case 4: case 11: add(top, right); break;
      case 6: case 9: add(top, bottom); break;
      case 7: case 8: add(left, top); break;
      case 5: if (centre) { add(left, top); add(bottom, right); } else { add(left, bottom); add(top, right); } break;
      case 10: if (centre) { add(left, bottom); add(top, right); } else { add(left, top); add(bottom, right); } break;
    }
  }
}

// Link segments into closed loops.
const byEdge = new Map();
segs.forEach((s, i) => { for (const e of s) (byEdge.get(e) ?? byEdge.set(e, []).get(e)).push(i); });
const used = new Uint8Array(segs.length);
const loops = [];
for (let i = 0; i < segs.length; i++) {
  if (used[i]) continue;
  used[i] = 1;
  const loop = [segs[i][0], segs[i][1]];
  let cur = segs[i][1];
  for (;;) {
    const next = (byEdge.get(cur) ?? []).find((j) => !used[j]);
    if (next === undefined) break;
    used[next] = 1;
    const s = segs[next];
    cur = s[0] === cur ? s[1] : s[0];
    if (cur === loop[0]) break;
    loop.push(cur);
  }
  if (loop.length > 8) loops.push(loop.map((k) => pt.get(k)));
}

// Ramer–Douglas–Peucker on a closed loop.
function rdp(points, eps) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [x1, y1] = points[s], [x2, y2] = points[e];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    let far = -1, dmax = 0;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > dmax) { dmax = d; far = i; }
    }
    if (dmax > eps && far > 0) { keep[far] = 1; stack.push([s, far], [far, e]); }
  }
  return points.filter((_, i) => keep[i]);
}
const area = (p) => p.reduce((a, [x, y], i) => { const [x2, y2] = p[(i + 1) % p.length]; return a + x * y2 - x2 * y; }, 0) / 2;

const simplified = loops
  .map((l) => {
    // Split the loop at its farthest point so RDP sees two open halves.
    const half = Math.floor(l.length / 2);
    const a = rdp(l.slice(0, half + 1), 0.55), b = rdp([...l.slice(half), l[0]], 0.55);
    return [...a.slice(0, -1), ...b.slice(0, -1)];
  })
  .filter((l) => l.length >= 3 && Math.abs(area(l)) > 6);

const bbox = (l) => l.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
const r = (n) => Math.round(n * 10) / 10;

/**
 * A loop as smooth quadratic curves through the midpoints of its simplified edges — except at a real
 * corner (a sharp turn, or a turn between two long edges), which is kept sharp: smoothing there would
 * round a letter's joint into a blob.
 */
function pathOf(l, ox, oy) {
  const p = l.map(([x, y]) => [x - ox, y - oy]);
  const n = p.length;
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const turn = (i) => {
    const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
    const cos = (u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(...u) * Math.hypot(...v)) || 1);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  };
  const corner = p.map((_, i) => {
    const t = turn(i), shortest = Math.min(len(p[(i - 1 + n) % n], p[i]), len(p[i], p[(i + 1) % n]));
    return t > 50 || (t > 14 && shortest > 9);
  });
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const f = (q) => `${r(q[0])} ${r(q[1])}`;
  const first = corner.indexOf(true);
  if (first < 0) {
    let d = `M${f(mid(p[n - 1], p[0]))}`;
    for (let i = 0; i < n; i++) d += `Q${f(p[i])} ${f(mid(p[i], p[(i + 1) % n]))}`;
    return d + 'Z';
  }
  const q = [...p.slice(first), ...p.slice(0, first)];
  const c = [...corner.slice(first), ...corner.slice(0, first)];
  let d = `M${f(q[0])}`;
  let atCorner = true;
  for (let i = 1; i <= n; i++) {
    const v = q[i % n], prev = q[i - 1];
    if (i === n || c[i % n]) { d += `L${f(v)}`; atCorner = true; continue; }
    if (atCorner) d += `L${f(mid(prev, v))}`;
    d += `Q${f(v)} ${f(mid(v, q[(i + 1) % n]))}`;
    atCorner = false;
  }
  return d + 'Z';
}

function svg(name, select, pad = 4) {
  const chosen = simplified.filter((l) => select(bbox(l)));
  const b = chosen.map(bbox).reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])]);
  const ox = Math.floor(b[0]) - pad, oy = Math.floor(b[1]) - pad;
  const w = Math.ceil(b[2] - b[0]) + 2 * pad, h = Math.ceil(b[3] - b[1]) + 2 * pad;
  const d = chosen.map((l) => pathOf(l, ox, oy)).join('');
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><path fill="currentColor" fill-rule="evenodd" d="${d}"/></svg>\n`;
  writeFileSync(`${OUT}/${name}.svg`, out);
  console.log(name, `${w}×${h}`, chosen.length, 'loops', out.length, 'bytes');
  return { ox, oy, w, h, d };
}

// The mark (rings and key) sits left of x≈960; "Hiva" above y≈730 to its right; the tagline below.
const mark = svg('hiva-mark', ([x0]) => x0 < 960);
const word = svg('hiva-wordmark', ([x0, y0]) => x0 >= 960 && y0 < 735);
const tag = svg('hiva-tagline', ([x0, y0]) => x0 >= 960 && y0 >= 735);
const logo = svg('hiva-logo', () => true);
const at = (piece) => ({ x: piece.ox - logo.ox, y: piece.oy - logo.oy, w: piece.w, h: piece.h, d: piece.d });
writeFileSync(`${OUT}/brand.json`, JSON.stringify({ logo: { w: logo.w, h: logo.h }, mark: at(mark), wordmark: at(word), tagline: at(tag) }));
