/**
 * What a file says about itself (roadmap #42), read from its headers — no decoding library.
 *
 *   images  pixel size, colour space and bit depth (PNG IHDR, JPEG start-of-frame and Adobe
 *           marker, GIF logical screen, WebP VP8/VP8L/VP8X) — a CMYK JPEG is print artwork
 *   video   duration and frame size, from the MP4/MOV boxes (mvhd, tkhd)
 *   PDF     page count and the first page's size in millimetres (pdf-lib)
 *   fonts   the family name, from a TrueType/OpenType `name` table
 *
 * Anything malformed or unrecognised answers null — never a guess.
 */
import { open, readFile, stat } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { imageBrandScan, pdfBrandScan, tooLargeScan, type BrandScan } from '../brand/scan.js';
import { fitsInMemory } from './storage.js';

export type ColorSpace = 'RGB' | 'RGBA' | 'GRAYSCALE' | 'GRAYSCALE_ALPHA' | 'INDEXED' | 'CMYK' | 'YCCK';
export interface FileMetadata {
  width?: number; height?: number; colorSpace?: ColorSpace; bitDepth?: number;
  durationSec?: number; pageCount?: number; pageSizeMm?: { w: number; h: number }; fontFamily?: string;
  /** Colours, and a PDF's typefaces, for the brand check (roadmap #43). */
  brand?: BrandScan;
}

async function head(path: string, bytes: number) {
  const h = await open(path, 'r');
  try {
    const b = Buffer.alloc(bytes);
    const { bytesRead } = await h.read(b, 0, bytes, 0);
    return b.subarray(0, bytesRead);
  } finally { await h.close(); }
}

const PNG_COLOR: Record<number, ColorSpace> = { 0: 'GRAYSCALE', 2: 'RGB', 3: 'INDEXED', 4: 'GRAYSCALE_ALPHA', 6: 'RGBA' };

export function imageMetadata(b: Buffer): FileMetadata | null {
  if (b.length > 26 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24], colorSpace: PNG_COLOR[b[25]!] };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2, adobeTransform: number | null = null;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      const length = b.readUInt16BE(i + 2);
      // APP14 "Adobe": its transform byte says whether four components are CMYK (0) or YCCK (2).
      if (marker === 0xee && b.toString('ascii', i + 4, i + 9) === 'Adobe') adobeTransform = b[i + 15] ?? null;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const components = b[i + 9]!;
        const colorSpace: ColorSpace = components === 1 ? 'GRAYSCALE' : components === 4 ? (adobeTransform === 2 ? 'YCCK' : 'CMYK') : 'RGB';
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), bitDepth: b[i + 4], colorSpace };
      }
      i += 2 + length;
    }
    return null;
  }
  if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), colorSpace: 'INDEXED' };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, colorSpace: 'RGB' };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, colorSpace: (bits >> 28) & 1 ? 'RGBA' : 'RGB' };
    }
    if (chunk === 'VP8X') {
      const alpha = (b[20]! & 0x10) !== 0;
      return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1, colorSpace: alpha ? 'RGBA' : 'RGB' };
    }
  }
  return null;
}

/** ISO BMFF boxes: [size][type] — size 1 means a 64-bit size follows, 0 means "to the end". */
function* boxes(b: Buffer, start: number, end: number): Generator<{ type: string; body: number; end: number }> {
  let i = start;
  while (i + 8 <= end) {
    let size = b.readUInt32BE(i);
    const type = b.toString('ascii', i + 4, i + 8);
    let body = i + 8;
    if (size === 1) { if (i + 16 > end) return; size = Number(b.readBigUInt64BE(i + 8)); body = i + 16; }
    if (size === 0) size = end - i;
    if (size < 8 || i + size > end) return;
    yield { type, body, end: i + size };
    i += size;
  }
}

export function mp4Metadata(moov: Buffer): FileMetadata | null {
  const out: FileMetadata = {};
  for (const box of boxes(moov, 0, moov.length)) {
    if (box.type === 'mvhd') {
      const v = moov[box.body]!;
      const timescale = moov.readUInt32BE(box.body + (v === 1 ? 20 : 12));
      const duration = v === 1 ? Number(moov.readBigUInt64BE(box.body + 24)) : moov.readUInt32BE(box.body + 16);
      if (timescale) out.durationSec = Math.round((duration / timescale) * 100) / 100;
    }
    if (box.type === 'trak' && out.width == null) {
      for (const t of boxes(moov, box.body, box.end)) {
        if (t.type !== 'tkhd') continue;
        const v = moov[t.body]!;
        const at = t.body + (v === 1 ? 88 : 76);
        const width = moov.readUInt32BE(at) / 65536, height = moov.readUInt32BE(at + 4) / 65536;
        if (width > 0 && height > 0) { out.width = Math.round(width); out.height = Math.round(height); }
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Find the top-level `moov` box without reading the whole file — it may sit at the end. */
async function readMoov(path: string): Promise<Buffer | null> {
  const h = await open(path, 'r');
  try {
    const { size } = await h.stat();
    let pos = 0;
    const header = Buffer.alloc(16);
    while (pos + 8 <= size) {
      await h.read(header, 0, 16, pos);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      let bodyAt = pos + 8;
      if (boxSize === 1) { boxSize = Number(header.readBigUInt64BE(8)); bodyAt = pos + 16; }
      if (boxSize === 0) boxSize = size - pos;
      if (boxSize < 8) return null;
      if (type === 'moov') {
        const len = Math.min(boxSize - (bodyAt - pos), 64 * 1024 * 1024);
        const body = Buffer.alloc(len);
        await h.read(body, 0, len, bodyAt);
        return body;
      }
      pos += boxSize;
    }
    return null;
  } finally { await h.close(); }
}

export async function pdfMetadata(bytes: Buffer, withBrand = false): Promise<FileMetadata | null> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const first = doc.getPages()[0];
    const mm = (pt: number) => Math.round((pt * 25.4) / 72);
    return {
      pageCount: doc.getPageCount(), ...(first ? { pageSizeMm: { w: mm(first.getWidth()), h: mm(first.getHeight()) } } : {}),
      ...(withBrand ? { brand: pdfBrandScan(doc) } : {}),
    };
  } catch {
    return null;
  }
}

/** The family name (nameID 1) from a TrueType/OpenType font's `name` table. */
export function fontFamily(b: Buffer): string | null {
  if (b.length < 12) return null;
  const tag = b.toString('latin1', 0, 4);
  if (!(tag === 'OTTO' || tag === 'true' || b.readUInt32BE(0) === 0x00010000)) return null;
  const numTables = b.readUInt16BE(4);
  for (let t = 0; t < numTables; t++) {
    const rec = 12 + t * 16;
    if (rec + 16 > b.length) return null;
    if (b.toString('latin1', rec, rec + 4) !== 'name') continue;
    const offset = b.readUInt32BE(rec + 8);
    if (offset + 6 > b.length) return null;
    const count = b.readUInt16BE(offset + 2), strings = offset + b.readUInt16BE(offset + 4);
    let mac: string | null = null;
    for (let n = 0; n < count; n++) {
      const r = offset + 6 + n * 12;
      if (r + 12 > b.length) break;
      const platform = b.readUInt16BE(r), nameId = b.readUInt16BE(r + 6), len = b.readUInt16BE(r + 8), at = strings + b.readUInt16BE(r + 10);
      if (nameId !== 1 || at + len > b.length) continue;
      if (platform === 3 || platform === 0) {
        const chars = [];
        for (let k = 0; k + 1 < len; k += 2) chars.push(b.readUInt16BE(at + k));
        return String.fromCharCode(...chars);
      }
      if (platform === 1) mac ??= b.toString('latin1', at, at + len);
    }
    return mac;
  }
  return null;
}

export const FONT_TYPES = new Set(['font/ttf', 'font/otf', 'font/woff', 'font/woff2']);

export async function extractMetadata(path: string, mimeType: string): Promise<FileMetadata | null> {
  try {
    // Colours and pages are read from the whole file; one too large to hold keeps what its headers say (ADR-124).
    const whole = fitsInMemory((await stat(path)).size);
    if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
      if (!whole) {
        const header = imageMetadata(await head(path, 256 * 1024));
        return header ? { ...header, brand: tooLargeScan('image') } : null;
      }
      const bytes = await readFile(path);
      const header = imageMetadata(bytes.subarray(0, 256 * 1024));
      return header ? { ...header, brand: imageBrandScan(bytes, mimeType) } : null;
    }
    if (mimeType.startsWith('image/')) return imageMetadata(await head(path, 256 * 1024));
    if (mimeType === 'video/mp4') { const moov = await readMoov(path); return moov ? mp4Metadata(moov) : null; }
    if (mimeType === 'application/pdf') return whole ? pdfMetadata(await readFile(path), true) : { brand: tooLargeScan('pdf') };
    if (mimeType === 'font/ttf' || mimeType === 'font/otf') {
      const family = fontFamily(await head(path, 2 * 1024 * 1024));
      return family ? { fontFamily: family } : null;
    }
    return null;
  } catch {
    return null;
  }
}
