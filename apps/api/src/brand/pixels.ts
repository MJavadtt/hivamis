/**
 * Colour samples from an image, for the brand check (roadmap #43) — no decoding library.
 *
 *   PNG   inflated with zlib and un-filtered; every colour type and bit depth. An interlaced
 *         (Adam7) file is read from its first pass, which is already an even 1-in-64 sample.
 *   JPEG  only the DC coefficient of each 8×8 block — the block's average colour. That skips the
 *         inverse DCT entirely and is exactly the resolution a palette needs. Baseline and
 *         progressive (its first DC scan); arithmetic-coded files are not read.
 *
 * A sample is colours with a weight each, in RGB or — for a four-channel JPEG — in CMYK ink
 * percentages, which are kept as CMYK: without the file's colour profile, turning them into RGB
 * would be a guess, and the check compares them with the brand's own CMYK values instead.
 */
import { inflateSync } from 'node:zlib';

export interface Sample {
  space: 'RGB' | 'CMYK';
  /** Flat channel values: RGB 0–255, or CMYK ink 0–100. */
  values: number[];
  width: number;
  height: number;
}

/** Past this, decoding costs more than a palette is worth; the file is reported as not checked. */
export const MAX_PIXELS = 60_000_000;
/** Enough points for a stable palette; more only costs time. */
const TARGET_SAMPLES = 60_000;

export class TooLarge extends Error {}

/* ── PNG ─────────────────────────────────────────────────────────────────────────────────── */

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function pngSample(b: Buffer): Sample | null {
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let palette: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let i = 8; i + 8 <= b.length;) {
    const len = b.readUInt32BE(i), kind = b.toString('latin1', i + 4, i + 8), body = b.subarray(i + 8, i + 8 + len);
    if (kind === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]!; type = body[9]!; interlace = body[12]!; }
    else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    i += 12 + len;
  }
  const channels = CHANNELS[type];
  if (!width || !height || !channels || !idat.length || (type === 3 && !palette)) return null;
  if (width * height > MAX_PIXELS) throw new TooLarge();
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }

  // Adam7's first pass is every 8th pixel of every 8th row, stored first: a ready-made sample.
  const w = interlace ? Math.ceil(width / 8) : width, h = interlace ? Math.ceil(height / 8) : height;
  const bitsPerPixel = channels * depth;
  const rowBytes = Math.ceil((w * bitsPerPixel) / 8), bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < (rowBytes + 1) * h) return null;

  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / TARGET_SAMPLES)));
  const values: number[] = [];
  let prev = Buffer.alloc(rowBytes), row = Buffer.alloc(rowBytes);
  const max = (1 << depth) - 1;
  const read = (r: Buffer, x: number, c: number): number => {
    if (depth === 8) return r[x * channels + c]!;
    if (depth === 16) return r[(x * channels + c) * 2]!;        // the high byte is enough for colour
    const bit = (x * channels + c) * depth;
    return (r[bit >> 3]! >> (8 - depth - (bit & 7))) & max;
  };
  const scale = (v: number) => (depth === 16 || depth === 8 ? v : Math.round((v * 255) / max));
  for (let y = 0; y < h; y++) {
    const at = y * (rowBytes + 1), filter = raw[at]!;
    const line = raw.subarray(at + 1, at + 1 + rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0, up = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      row[i] = v & 0xff;
    }
    if (y % step === 0) {
      for (let x = 0; x < w; x += step) {
        let r: number, g: number, bl: number, alpha = 255;
        if (type === 3) {
          const idx = read(row, x, 0);
          r = palette![idx * 3]!; g = palette![idx * 3 + 1]!; bl = palette![idx * 3 + 2]!;
          if (trns && idx < trns.length) alpha = trns[idx]!;
        } else if (type === 0 || type === 4) {
          r = g = bl = scale(read(row, x, 0));
          if (type === 4) alpha = scale(read(row, x, 1));
          else if (trns && trns.length >= 2 && read(row, x, 0) === (depth === 16 ? trns[0]! : trns.readUInt16BE(0))) alpha = 0;
        } else {
          r = read(row, x, 0); g = read(row, x, 1); bl = read(row, x, 2);
          if (type === 6) alpha = read(row, x, 3);
        }
        // Transparent pixels are no colour at all: the page behind them is not the design's.
        if (alpha >= 128) values.push(r, g, bl);
      }
    }
    [prev, row] = [row, prev];
  }
  return { space: 'RGB', values, width, height };
}

/* ── JPEG, DC only ───────────────────────────────────────────────────────────────────────── */

interface Huffman { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array }

function huffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k; mincode[l] = code;
    code += counts[l - 1]!; k += counts[l - 1]!;
    if (counts[l - 1]) maxcode[l] = code - 1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, values };
}

/** The entropy-coded bytes of one scan: stuffed 0xFF00 read as 0xFF, restart markers as boundaries. */
class Bits {
  private bit = 0; private byte = 0; pos: number;
  constructor(private b: Buffer, start: number) { this.pos = start; }
  private next(): number {
    const v = this.b[this.pos];
    if (v === undefined) throw new RangeError('end of data');
    if (v === 0xff) {
      // Stuffed data byte; anything else is a marker the data may not run into — a restart is
      // stepped over by restart(), the end of the scan ends the reading.
      if (this.b[this.pos + 1] === 0) { this.pos += 2; return 0xff; }
      throw new RangeError('marker');
    }
    this.pos++;
    return v;
  }
  read(): number {
    if (this.bit === 0) { this.byte = this.next(); this.bit = 8; }
    this.bit--;
    return (this.byte >> this.bit) & 1;
  }
  receive(n: number): number { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.read(); return v; }
  decode(h: Huffman): number {
    let code = this.read(), l = 1;
    while (code > h.maxcode[l]!) { code = (code << 1) | this.read(); if (++l > 16) throw new RangeError('bad code'); }
    return h.values[h.valptr[l]! + code - h.mincode[l]!]!;
  }
  /** At a restart marker: drop the partial byte and step over RSTn. */
  restart() {
    this.bit = 0;
    while (this.pos + 1 < this.b.length && !(this.b[this.pos] === 0xff && this.b[this.pos + 1]! >= 0xd0 && this.b[this.pos + 1]! <= 0xd7)) this.pos++;
    this.pos += 2;
  }
}

const extend = (v: number, n: number) => (n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v);

interface Component { id: number; h: number; v: number; q: number; dc: Float64Array | null; bw: number; bh: number }

export function jpegSample(b: Buffer): Sample | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const quant: (Uint16Array | undefined)[] = [];
  const dcTables: (Huffman | undefined)[] = [], acTables: (Huffman | undefined)[] = [];
  let comps: Component[] = [], width = 0, height = 0, progressive = false, restartInterval = 0;
  let adobe: number | null = null;
  let i = 2;
  const hmax = () => Math.max(...comps.map((c) => c.h)), vmax = () => Math.max(...comps.map((c) => c.v));
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xd9) break;
    const len = b.readUInt16BE(i + 2), seg = b.subarray(i + 4, i + 2 + len);
    if (marker === 0xdb) {
      for (let p = 0; p < seg.length;) {
        const pq = seg[p]! >> 4, tq = seg[p]! & 15, table = new Uint16Array(64);
        for (let k = 0; k < 64; k++) table[k] = pq ? seg.readUInt16BE(p + 1 + k * 2) : seg[p + 1 + k]!;
        quant[tq] = table; p += 1 + (pq ? 128 : 64);
      }
    } else if (marker === 0xc4) {
      for (let p = 0; p < seg.length;) {
        const tc = seg[p]! >> 4, th = seg[p]! & 15, counts = seg.subarray(p + 1, p + 17);
        const total = counts.reduce((s, n) => s + n, 0);
        const table = huffman(new Uint8Array(counts), new Uint8Array(seg.subarray(p + 17, p + 17 + total)));
        (tc === 0 ? dcTables : acTables)[th] = table; p += 17 + total;
      }
    } else if (marker === 0xdd) {
      restartInterval = seg.readUInt16BE(0);
    } else if (marker === 0xee && seg.toString('latin1', 0, 5) === 'Adobe') {
      adobe = seg[11] ?? null;
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      progressive = marker === 0xc2;
      height = seg.readUInt16BE(1); width = seg.readUInt16BE(3);
      if (width * height > MAX_PIXELS) throw new TooLarge();
      comps = [];
      for (let c = 0; c < seg[5]!; c++) comps.push({ id: seg[6 + c * 3]!, h: seg[7 + c * 3]! >> 4, v: seg[7 + c * 3]! & 15, q: seg[8 + c * 3]!, dc: null, bw: 0, bh: 0 });
      if (![1, 3, 4].includes(comps.length)) return null;
      for (const c of comps) {
        c.bw = Math.ceil(Math.ceil((width * c.h) / hmax()) / 8);
        c.bh = Math.ceil(Math.ceil((height * c.v) / vmax()) / 8);
        c.dc = new Float64Array(c.bw * c.bh).fill(NaN);
      }
    } else if (marker >= 0xc3 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return null;                                                  // lossless, hierarchical, arithmetic
    } else if (marker === 0xda) {
      if (!comps.length) return null;
      const ns = seg[0]!, inScan: { c: Component; dc: Huffman | undefined; ac: Huffman | undefined }[] = [];
      for (let s = 0; s < ns; s++) {
        const c = comps.find((x) => x.id === seg[1 + s * 2]);
        if (!c) return null;
        inScan.push({ c, dc: dcTables[seg[2 + s * 2]! >> 4], ac: acTables[seg[2 + s * 2]! & 15] });
      }
      const ss = seg[1 + ns * 2]!, ah = seg[3 + ns * 2]! >> 4, al = seg[3 + ns * 2]! & 15;
      const start = i + 2 + len;
      // A progressive file's first DC scan is all a palette needs; every other scan is skipped.
      if (!progressive || (ss === 0 && ah === 0)) {
        try { dcScan(b, start, inScan, progressive, al, restartInterval, width, height, hmax(), vmax()); }
        catch { /* a damaged tail leaves the blocks read so far */ }
      }
      // Step over the entropy-coded data to the next real marker.
      let p = start;
      while (p + 1 < b.length && !(b[p] === 0xff && b[p + 1] !== 0 && !(b[p + 1]! >= 0xd0 && b[p + 1]! <= 0xd7))) p++;
      i = p;
      continue;
    }
    i += 2 + len;
  }
  if (!comps.length || !comps[0]!.dc) return null;

  const levels = (c: Component) => {
    const q0 = quant[c.q]?.[0] ?? 1;
    return (bx: number, by: number) => {
      const v = c.dc![Math.min(by, c.bh - 1) * c.bw + Math.min(bx, c.bw - 1)]!;
      return Number.isNaN(v) ? NaN : Math.min(255, Math.max(0, (v * q0) / 8 + 128));
    };
  };
  const at = comps.map(levels);
  const hm = hmax(), vm = vmax();
  // Walk the finest block grid; each component is read at its own (subsampled) block.
  const gw = Math.ceil(width / 8), gh = Math.ceil(height / 8);
  const step = Math.max(1, Math.floor(Math.sqrt((gw * gh) / TARGET_SAMPLES)));
  const values: number[] = [];
  const cmyk = comps.length === 4;
  for (let gy = 0; gy < gh; gy += step) {
    for (let gx = 0; gx < gw; gx += step) {
      const ch = comps.map((c, n) => at[n]!(Math.floor((gx * c.h) / hm), Math.floor((gy * c.v) / vm)));
      if (ch.some(Number.isNaN)) continue;
      if (comps.length === 1) { values.push(ch[0]!, ch[0]!, ch[0]!); continue; }
      const [y, cb, cr, k] = ch as [number, number, number, number];
      // JFIF three-channel files are YCbCr unless an Adobe marker says RGB (transform 0).
      const ycc = cmyk ? adobe === 2 : adobe !== 0;
      let r = y, g = cb, bl = cr;
      if (ycc) {
        r = y + 1.402 * (cr - 128);
        g = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
        bl = y + 1.772 * (cb - 128);
      }
      const clamp = (v: number) => Math.min(255, Math.max(0, v));
      if (!cmyk) { values.push(clamp(r), clamp(g), clamp(bl)); continue; }
      // Four channels: CMYK, or YCCK (whose colour part decodes to inverted CMY). Adobe
      // applications write ink inverted — 255 is no ink.
      let inks = ycc ? [255 - clamp(r), 255 - clamp(g), 255 - clamp(bl), k] : [r, g, bl, k];
      if (adobe !== null) inks = inks.map((v) => 255 - v);
      values.push(...inks.map((v) => Math.round((clamp(v) / 255) * 1000) / 10));
    }
  }
  return { space: cmyk ? 'CMYK' : 'RGB', values, width, height };
}

function dcScan(
  b: Buffer, start: number, scan: { c: Component; dc: Huffman | undefined; ac: Huffman | undefined }[],
  progressive: boolean, al: number, restartInterval: number, width: number, height: number, hm: number, vm: number,
) {
  const bits = new Bits(b, start);
  const pred = new Array<number>(scan.length).fill(0);
  const block = (n: number, bx: number, by: number) => {
    const s = scan[n]!;
    if (!s.dc) throw new RangeError('no table');
    const t = bits.decode(s.dc);
    pred[n]! += extend(bits.receive(t), t);
    if (bx < s.c.bw && by < s.c.bh) s.c.dc![by * s.c.bw + bx] = progressive ? pred[n]! << al : pred[n]!;
    if (progressive) return;
    // Baseline: the 63 AC coefficients are decoded only to be stepped over.
    if (!s.ac) throw new RangeError('no table');
    for (let k = 1; k < 64;) {
      const rs = bits.decode(s.ac), r = rs >> 4, sz = rs & 15;
      if (sz === 0) { if (r !== 15) break; k += 16; continue; }
      bits.receive(sz); k += r + 1;
    }
  };
  let unit = 0;
  const restart = () => {
    if (restartInterval && unit > 0 && unit % restartInterval === 0) { bits.restart(); pred.fill(0); }
  };
  if (scan.length === 1) {
    // Not interleaved: the component's own blocks, in raster order, one per unit.
    const c = scan[0]!.c;
    const bw = Math.ceil(Math.ceil((width * c.h) / hm) / 8), bh = Math.ceil(Math.ceil((height * c.v) / vm) / 8);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) { restart(); block(0, bx, by); unit++; }
    return;
  }
  const mx = Math.ceil(width / (8 * hm)), my = Math.ceil(height / (8 * vm));
  for (let y = 0; y < my; y++) {
    for (let x = 0; x < mx; x++) {
      restart();
      scan.forEach((s, n) => {
        for (let v = 0; v < s.c.v; v++) for (let h = 0; h < s.c.h; h++) block(n, x * s.c.h + h, y * s.c.v + v);
      });
      unit++;
    }
  }
}
