/**
 * What a file is made of, for the brand check (roadmap #43): its main colours with their share,
 * and — for a PDF — the typefaces and spot inks it uses. Read once, at upload (or by the metadata
 * job for older files), and kept with the file's metadata: the bytes of a version never change,
 * and the comparison with the client's brand is made when it is asked for, against the brand as
 * it is then.
 */
import type { PDFDocument } from 'pdf-lib';
import { jpegSample, pngSample, TooLarge } from './pixels.js';
import { dominantColours } from './palette.js';
import { scanPdf } from './pdf.js';

/** Raised when the reading changes, so the metadata job reads every file again. */
export const BRAND_SCAN_VERSION = 1;
export const BRAND_SCANNABLE = ['image/png', 'image/jpeg', 'application/pdf'];

type Cmyk = [number, number, number, number];
export interface BrandScan {
  v: number;
  kind: 'image' | 'pdf';
  /** Share of the image's area, or of the colour settings in a PDF. */
  colours: { hex: string; share: number }[];
  inks: { cmyk: Cmyk; share: number }[];
  spots?: { name: string; share: number }[];
  fonts?: { name: string; share: number }[];
  skipped?: 'TOO_LARGE' | 'UNREADABLE';
}

const KEEP = 16;
const round = (v: number) => Math.round(v * 1000) / 1000;

/** A file too large to read whole: nothing is known of its colours. */
export const tooLargeScan = (kind: BrandScan['kind']): BrandScan => ({ v: BRAND_SCAN_VERSION, kind, colours: [], inks: [], skipped: 'TOO_LARGE' });

export function imageBrandScan(bytes: Buffer, mimeType: string): BrandScan {
  try {
    const sample = mimeType === 'image/png' ? pngSample(bytes) : jpegSample(bytes);
    // No colour at all — a file cut short before its image data — is unreadable, not colourless.
    if (!sample?.values.length) return { v: BRAND_SCAN_VERSION, kind: 'image', colours: [], inks: [], skipped: 'UNREADABLE' };
    const swatches = dominantColours(sample);
    return {
      v: BRAND_SCAN_VERSION, kind: 'image',
      colours: swatches.filter((s) => s.hex).map((s) => ({ hex: s.hex!, share: s.share })),
      inks: swatches.filter((s) => s.cmyk).map((s) => ({ cmyk: s.cmyk!, share: s.share })),
    };
  } catch (e) {
    return { v: BRAND_SCAN_VERSION, kind: 'image', colours: [], inks: [], skipped: e instanceof TooLarge ? 'TOO_LARGE' : 'UNREADABLE' };
  }
}

export function pdfBrandScan(doc: PDFDocument): BrandScan {
  try {
    const found = scanPdf(doc);
    const total = [...found.rgb.values(), ...found.cmyk.values(), ...found.spots.values()].reduce((s, n) => s + n, 0) || 1;
    const fontTotal = [...found.fonts.values()].reduce((s, n) => s + n, 0) || 1;
    const top = <T>(m: Map<string, number>, of: number, make: (k: string, share: number) => T) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, KEEP).map(([k, n]) => make(k, round(n / of)));
    return {
      v: BRAND_SCAN_VERSION, kind: 'pdf',
      colours: top(found.rgb, total, (hex, share) => ({ hex, share })),
      inks: top(found.cmyk, total, (k, share) => ({ cmyk: k.split(',').map(Number) as Cmyk, share })),
      spots: top(found.spots, total, (name, share) => ({ name, share })),
      fonts: top(found.fonts, fontTotal, (name, share) => ({ name, share })),
    };
  } catch {
    return { v: BRAND_SCAN_VERSION, kind: 'pdf', colours: [], inks: [], skipped: 'UNREADABLE' };
  }
}
