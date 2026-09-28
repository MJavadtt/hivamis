/**
 * The colours and typefaces a PDF sets, read from its page content (roadmap #43).
 *
 * A PDF says its colours in numbers: `r g b rg` for a fill, `c m y k K` for a stroke, a named
 * colour space and `scn` for ICC colours and spot inks. These are counted as the content sets
 * them — one use per setting — along with the fonts its text selects (`Tf`), through nested form
 * XObjects as well. Images placed in the PDF are not decoded here.
 */
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFDocument, type PDFObject,
} from 'pdf-lib';
import { rgbToHex } from './palette.js';

export interface PdfColours {
  rgb: Map<string, number>;            // "#RRGGBB" → uses
  cmyk: Map<string, number>;           // "c,m,y,k" in ink percent → uses
  spots: Map<string, number>;          // spot ink name → uses
  fonts: Map<string, number>;          // BaseFont without its subset prefix → uses
  pages: number;
}

type Space = { kind: 'RGB' | 'CMYK' | 'GRAY' } | { kind: 'SPOT'; name: string } | { kind: 'OTHER' };

const DEVICE: Record<string, Space> = {
  DeviceRGB: { kind: 'RGB' }, CalRGB: { kind: 'RGB' }, DeviceCMYK: { kind: 'CMYK' }, DeviceGray: { kind: 'GRAY' }, CalGray: { kind: 'GRAY' },
};
const MAX_DEPTH = 8;
const MAX_CONTENT_BYTES = 40 * 1024 * 1024;

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const pct = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100);

function streamBytes(obj: PDFObject | undefined): Uint8Array | null {
  if (obj instanceof PDFRawStream) {
    try { return decodePDFRawStream(obj).decode(); } catch { return null; }
  }
  if (obj instanceof PDFStream) {
    try { return obj.getContents(); } catch { return null; }
  }
  return null;
}

function colourSpace(doc: PDFDocument, resources: PDFDict | undefined, name: string): Space {
  if (DEVICE[name]) return DEVICE[name]!;
  const cs = resources?.lookupMaybe(PDFName.of('ColorSpace'), PDFDict)?.get(PDFName.of(name));
  const value = cs ? doc.context.lookup(cs) : undefined;
  if (value instanceof PDFName) return DEVICE[value.decodeText()] ?? { kind: 'OTHER' };
  if (!(value instanceof PDFArray) || value.size() === 0) return { kind: 'OTHER' };
  const family = value.lookup(0);
  const kind = family instanceof PDFName ? family.decodeText() : '';
  if (kind === 'ICCBased') {
    const stream = value.lookup(1);
    const n = stream instanceof PDFStream ? stream.dict.lookupMaybe(PDFName.of('N'), PDFNumber)?.asNumber() : undefined;
    return n === 3 ? { kind: 'RGB' } : n === 4 ? { kind: 'CMYK' } : n === 1 ? { kind: 'GRAY' } : { kind: 'OTHER' };
  }
  if (kind === 'Separation') {
    const ink = value.lookup(1);
    return ink instanceof PDFName ? { kind: 'SPOT', name: ink.decodeText() } : { kind: 'OTHER' };
  }
  return DEVICE[kind] ?? { kind: 'OTHER' };
}

function fontName(doc: PDFDocument, resources: PDFDict | undefined, name: string): string | null {
  const ref = resources?.lookupMaybe(PDFName.of('Font'), PDFDict)?.get(PDFName.of(name));
  const font = ref ? doc.context.lookup(ref) : undefined;
  if (!(font instanceof PDFDict)) return null;
  const base = font.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText();
  // A subset carries a six-letter tag before its name: "ABCDEF+Vazirmatn-Bold".
  return base ? base.replace(/^[A-Z]{6}\+/, '') : font.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? null;
}

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITER = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

/** Walk one content stream's operators, keeping only the operands that matter here. */
function scanContent(doc: PDFDocument, bytes: Uint8Array, resources: PDFDict | undefined, out: PdfColours, depth: number, seen: Set<PDFObject>) {
  const operands: (number | string)[] = [];
  let fill: Space = { kind: 'GRAY' }, stroke: Space = { kind: 'GRAY' };
  const use = (space: Space, nums: number[]) => {
    if (space.kind === 'SPOT') bump(out.spots, space.name);
    else if (space.kind === 'RGB' && nums.length >= 3) bump(out.rgb, rgbToHex(nums[0]! * 255, nums[1]! * 255, nums[2]! * 255));
    else if (space.kind === 'CMYK' && nums.length >= 4) bump(out.cmyk, nums.slice(0, 4).map(pct).join(','));
    // Greys are neutral and never judged, but they are part of what the page is made of.
    else if (space.kind === 'GRAY' && nums.length >= 1) bump(out.rgb, rgbToHex(nums[0]! * 255, nums[0]! * 255, nums[0]! * 255));
  };
  const nums = () => operands.filter((o): o is number => typeof o === 'number');
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const c = bytes[i]!;
    if (WHITESPACE.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++; continue; }            // % comment
    if (c === 0x2f) {                                                                                  // /Name
      let j = i + 1;
      while (j < n && !WHITESPACE.has(bytes[j]!) && !DELIMITER.has(bytes[j]!)) j++;
      operands.push('/' + Buffer.from(bytes.subarray(i + 1, j)).toString('latin1').replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
      i = j; continue;
    }
    if (c === 0x28) {                                                                                  // (string)
      let level = 1; i++;
      while (i < n && level > 0) { const b = bytes[i]!; if (b === 0x5c) i++; else if (b === 0x28) level++; else if (b === 0x29) level--; i++; }
      operands.push(''); continue;
    }
    if (c === 0x3c) {                                                                                  // <hex> or <<
      if (bytes[i + 1] === 0x3c) { i += 2; continue; }
      while (i < n && bytes[i] !== 0x3e) i++;
      i++; operands.push(''); continue;
    }
    if (c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { i++; continue; }        // >> [ ] { }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {                          // number
      let j = i + 1;
      while (j < n && ((bytes[j]! >= 0x30 && bytes[j]! <= 0x39) || bytes[j] === 0x2e)) j++;
      operands.push(Number(Buffer.from(bytes.subarray(i, j)).toString('latin1')) || 0);
      i = j; continue;
    }
    let j = i;
    while (j < n && !WHITESPACE.has(bytes[j]!) && !DELIMITER.has(bytes[j]!)) j++;
    if (j === i) { i++; continue; }
    const op = Buffer.from(bytes.subarray(i, j)).toString('latin1');
    i = j;
    switch (op) {
      case 'rg': use({ kind: 'RGB' }, nums()); fill = { kind: 'RGB' }; break;
      case 'RG': use({ kind: 'RGB' }, nums()); stroke = { kind: 'RGB' }; break;
      case 'k': use({ kind: 'CMYK' }, nums()); fill = { kind: 'CMYK' }; break;
      case 'K': use({ kind: 'CMYK' }, nums()); stroke = { kind: 'CMYK' }; break;
      case 'g': use({ kind: 'GRAY' }, nums()); fill = { kind: 'GRAY' }; break;
      case 'G': use({ kind: 'GRAY' }, nums()); stroke = { kind: 'GRAY' }; break;
      case 'cs': case 'CS': {
        const name = operands.find((o): o is string => typeof o === 'string' && o.startsWith('/'));
        const space = name ? colourSpace(doc, resources, name.slice(1)) : { kind: 'OTHER' as const };
        if (op === 'cs') fill = space; else stroke = space;
        break;
      }
      case 'sc': case 'scn': use(fill, nums()); break;
      case 'SC': case 'SCN': use(stroke, nums()); break;
      case 'Tf': {
        const name = operands.find((o): o is string => typeof o === 'string' && o.startsWith('/'));
        const font = name ? fontName(doc, resources, name.slice(1)) : null;
        if (font) bump(out.fonts, font);
        break;
      }
      case 'Do': {
        const name = operands.find((o): o is string => typeof o === 'string' && o.startsWith('/'));
        const ref = name ? resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.get(PDFName.of(name.slice(1))) : undefined;
        const xobject = ref ? doc.context.lookup(ref) : undefined;
        if (xobject instanceof PDFStream && !seen.has(xobject) && depth < MAX_DEPTH
          && xobject.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Form') {
          seen.add(xobject);
          const inner = streamBytes(xobject);
          const own = xobject.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
          if (inner) scanContent(doc, inner, own ?? resources, out, depth + 1, seen);
        }
        break;
      }
      case 'BI': {
        // An inline image: its binary data runs from ID to EI and is not content to read.
        const id = Buffer.from(bytes.buffer, bytes.byteOffset + i, n - i).indexOf('ID');
        if (id < 0) { i = n; break; }
        let k = i + id + 3;
        while (k + 2 < n && !(WHITESPACE.has(bytes[k - 1]!) && bytes[k] === 0x45 && bytes[k + 1] === 0x49 && (k + 2 >= n || WHITESPACE.has(bytes[k + 2]!)))) k++;
        i = k + 2;
        break;
      }
    }
    operands.length = 0;
  }
}

export function scanPdf(doc: PDFDocument): PdfColours {
  const out: PdfColours = { rgb: new Map(), cmyk: new Map(), spots: new Map(), fonts: new Map(), pages: 0 };
  const seen = new Set<PDFObject>();
  let budget = MAX_CONTENT_BYTES;
  for (const page of doc.getPages()) {
    out.pages++;
    const contents = page.node.Contents();
    const parts = contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, k) => contents.lookup(k))
      : [contents];
    // A page's content may be split across streams, even mid-operator: read them as one.
    const chunks = parts.map((p) => streamBytes(p instanceof PDFRef ? doc.context.lookup(p) : p)).filter((b): b is Uint8Array => !!b);
    const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)).flatMap((c) => [c, Buffer.from('\n')]));
    budget -= bytes.length;
    if (budget < 0) break;
    scanContent(doc, bytes, page.node.Resources(), out, 0, seen);
  }
  return out;
}
