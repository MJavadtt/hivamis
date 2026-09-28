/**
 * A file's colours and typefaces against the client's brand library (roadmap #43).
 *
 * The check advises; it never decides. A photograph has colours no palette lists, a chart needs
 * more than four, and only a person knows whether that is right — so what it finds is a warning
 * with the colours named and measured, and the reviewer judges. What it could not judge is said.
 *
 * Tolerances are CIEDE2000 for RGB (about 1 is the smallest difference an eye sees) and ink
 * percentage points for CMYK. An image is measured through compression and 8×8 averaging, so it
 * gets room; a PDF's colours are exact numbers, so "almost the brand's navy" is itself worth
 * saying — it is usually a colour picked by eye from a screenshot. (A PDF keeps a colour to three
 * decimals, so the brand's own colour always comes back within ΔE 0.5 of its hex.)
 */
import { chroma, deltaE2000, hexToRgb, inkDistance, rgbToLab } from './palette.js';
import type { BrandScan } from './scan.js';

export interface KitColour { name: string; hex: string; role: string; cmyk?: number[] | null }
export interface Kit { colors: KitColour[]; fonts: { family: string; usage?: string }[] }

export type Status = 'BRAND' | 'NEAR' | 'NEUTRAL' | 'OFF' | 'UNCHECKED';
export interface ColourVerdict {
  hex?: string; cmyk?: number[]; share: number; status: Status;
  brand?: { name: string; hex: string }; distance?: number;
}
export interface FontVerdict { name: string; share: number; status: 'BRAND' | 'OFF' | 'UNCHECKED'; brand?: string }
export interface SpotVerdict { name: string; share: number; status: 'BRAND' | 'UNCHECKED'; brand?: string }
export interface BrandCheck {
  kind: 'image' | 'pdf';
  verdict: 'OK' | 'WARN' | 'NOT_CHECKED';
  colours: ColourVerdict[];
  fonts: FontVerdict[];
  spots: SpotVerdict[];
  /** Share of the area (image) or of colour settings (PDF) in colours outside the palette. */
  offShare: number;
  notesFa: string[];
}

export const TOLERANCE = {
  image: { match: 8, near: 15, ink: { match: 6, near: 12 }, minShare: 0.03, warnAt: 0.1 },
  pdf: { match: 1, near: 10, ink: { match: 2, near: 8 }, minShare: 0, warnAt: 0.05 },
} as const;
/** Below this chroma a colour is white, grey or black: allowed with any brand. */
export const NEUTRAL_CHROMA = 8;

const fa = (n: number, digits = 0) => new Intl.NumberFormat('fa-IR', { maximumFractionDigits: digits }).format(n);
export const percentFa = (share: number) => `${fa(Math.round(share * 100))}٪`;

/** "ABCDEF+Vazirmatn-Bold", "Arial,Bold", "ArialMT" → a family key: "vazirmatn", "arial", "arial". */
export function fontKey(name: string): string {
  const family = name.replace(/^[A-Z]{6}\+/, '').split(/[,-]/)[0] ?? '';
  const key = family.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return key.length > 5 ? key.replace(/(mt|ps)$/, '') : key;
}
const spotKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function checkScan(scan: BrandScan, kit: Kit | null): BrandCheck {
  const t = TOLERANCE[scan.kind];
  const notesFa: string[] = [];
  const out: BrandCheck = { kind: scan.kind, verdict: 'NOT_CHECKED', colours: [], fonts: [], spots: [], offShare: 0, notesFa };
  if (scan.skipped) {
    notesFa.push(scan.skipped === 'TOO_LARGE' ? 'تصویر بزرگ‌تر از آن است که رنگ‌هایش خوانده شود' : 'محتوای فایل خوانده نشد');
    return out;
  }
  const colours = kit?.colors ?? [];
  const labs = colours.map((c) => ({ c, lab: rgbToLab(...hexToRgb(c.hex)) }));
  const inked = colours.filter((c) => c.cmyk?.length === 4);

  for (const s of scan.colours) {
    if (s.share < t.minShare) continue;
    const lab = rgbToLab(...hexToRgb(s.hex));
    if (chroma(lab) < NEUTRAL_CHROMA) { out.colours.push({ hex: s.hex, share: s.share, status: 'NEUTRAL' }); continue; }
    if (!labs.length) { out.colours.push({ hex: s.hex, share: s.share, status: 'UNCHECKED' }); continue; }
    const best = labs.map((b) => ({ b, d: deltaE2000(lab, b.lab) })).sort((x, y) => x.d - y.d)[0]!;
    const status: Status = best.d <= t.match ? 'BRAND' : best.d <= t.near ? 'NEAR' : 'OFF';
    out.colours.push({ hex: s.hex, share: s.share, status, brand: { name: best.b.c.name, hex: best.b.c.hex }, distance: Math.round(best.d * 10) / 10 });
  }
  for (const s of scan.inks) {
    if (s.share < t.minShare) continue;
    const [c, m, y, k] = s.cmyk;
    // Paper, black ink alone, and a rich black are neutral whatever the brand.
    if ((c <= 5 && m <= 5 && y <= 5) || k >= 90) { out.colours.push({ cmyk: s.cmyk, share: s.share, status: 'NEUTRAL' }); continue; }
    if (!inked.length) { out.colours.push({ cmyk: s.cmyk, share: s.share, status: 'UNCHECKED' }); continue; }
    const best = inked.map((b) => ({ b, d: inkDistance(s.cmyk, b.cmyk!) })).sort((x, z) => x.d - z.d)[0]!;
    // Far from every inked brand colour, it may still be one the brand gave no ink for: not judged.
    const status: Status = best.d <= t.ink.match ? 'BRAND' : best.d <= t.ink.near ? 'NEAR' : inked.length < colours.length ? 'UNCHECKED' : 'OFF';
    out.colours.push(status === 'UNCHECKED' ? { cmyk: s.cmyk, share: s.share, status } : { cmyk: s.cmyk, share: s.share, status, brand: { name: best.b.name, hex: best.b.hex }, distance: best.d });
  }
  out.colours.sort((a, b) => b.share - a.share);
  for (const s of scan.spots ?? []) {
    const brand = colours.find((c) => spotKey(c.name) === spotKey(s.name));
    out.spots.push({ name: s.name, share: s.share, status: brand ? 'BRAND' : 'UNCHECKED', ...(brand ? { brand: brand.name } : {}) });
  }
  const brandFonts = (kit?.fonts ?? []).map((f) => ({ family: f.family, key: fontKey(f.family) })).filter((f) => f.key);
  for (const f of scan.fonts ?? []) {
    const key = fontKey(f.name);
    const brand = brandFonts.find((b) => key.startsWith(b.key));
    out.fonts.push({ name: f.name, share: f.share, status: !brandFonts.length ? 'UNCHECKED' : brand ? 'BRAND' : 'OFF', ...(brand ? { brand: brand.family } : {}) });
  }

  out.offShare = Math.round(out.colours.filter((c) => c.status === 'OFF').reduce((s, c) => s + c.share, 0) * 1000) / 1000;
  if (!colours.length) notesFa.push('کتابخانهٔ برند این مشتری رنگی ندارد — رنگ‌ها سنجیده نشد');
  if (out.colours.some((c) => c.cmyk && c.status === 'UNCHECKED')) {
    notesFa.push(inked.length
      ? 'بخشی از رنگ‌های CMYK سنجیده نشد: همهٔ رنگ‌های برند مقدار CMYK ندارند — آن را در کتابخانهٔ برند ثبت کنید'
      : 'رنگ‌های CMYK سنجیده نشد: رنگ‌های برند مقدار CMYK ندارند — آن را در کتابخانهٔ برند ثبت کنید');
  }
  if (out.spots.some((s) => s.status === 'UNCHECKED')) notesFa.push('رنگ اختصاصی (Spot) فقط با نامش سنجیده می‌شود — نامی که در رنگ‌های برند نیست سنجیده نشد');
  if (scan.kind === 'image') notesFa.push('فونت متن‌های درون تصویر خوانده نمی‌شود');
  else {
    if (!brandFonts.length && out.fonts.length) notesFa.push('کتابخانهٔ برند این مشتری فونتی ندارد — فونت‌ها سنجیده نشد');
    notesFa.push('تصاویر درون PDF خوانده نمی‌شوند — رنگ‌ها از متن و اشکال برداری است');
  }

  const warn = out.offShare >= t.warnAt || out.fonts.some((f) => f.status === 'OFF');
  // Not a pass when most of the file could not be judged: "nothing wrong" would claim too much.
  const unchecked = out.colours.filter((c) => c.status === 'UNCHECKED').reduce((sum, c) => sum + c.share, 0);
  const judged = out.colours.some((c) => c.status !== 'UNCHECKED') || out.fonts.some((f) => f.status !== 'UNCHECKED');
  out.verdict = warn ? 'WARN' : judged && unchecked <= 0.5 ? 'OK' : 'NOT_CHECKED';
  return out;
}

/** A code kept left-to-right inside Persian text — otherwise the '#' of a hex code drifts to its far end. */
export const ltr = (s: string) => `\u2066${s}\u2069`;
const colourFa = (c: ColourVerdict) => ltr(c.hex ?? `CMYK ${c.cmyk!.join('/')}`);

/** What a reviewer reads in QC stage zero: warnings for what is off, a note for what is nearly right. */
export function brandFindingsFa(fileName: string, c: BrandCheck): { severity: 'WARN' | 'INFO'; messageFa: string }[] {
  const out: { severity: 'WARN' | 'INFO'; messageFa: string }[] = [];
  const off = c.colours.filter((x) => x.status === 'OFF');
  if (off.length && c.offShare >= TOLERANCE[c.kind].warnAt) {
    const list = off.slice(0, 4).map((x) => `${colourFa(x)} (${percentFa(x.share)})`).join('، ');
    const where = c.kind === 'image' ? 'سطح' : 'رنگ‌گذاری‌های';
    out.push({ severity: 'WARN', messageFa: `${percentFa(c.offShare)} از ${where} «${fileName}» با رنگ‌هایی بیرون از پالت برند است: ${list}` });
  }
  const offFonts = c.fonts.filter((f) => f.status === 'OFF');
  if (offFonts.length) {
    out.push({ severity: 'WARN', messageFa: `«${fileName}» فونت ${offFonts.slice(0, 4).map((f) => `«${f.name}»`).join('، ')} را به کار برده که در فهرست فونت‌های برند نیست` });
  }
  if (c.kind === 'pdf') {
    for (const x of c.colours.filter((v) => v.status === 'NEAR').slice(0, 3)) {
      out.push({ severity: 'INFO', messageFa: `در «${fileName}» رنگ ${colourFa(x)} به «${x.brand!.name}» (${ltr(x.brand!.hex)}) نزدیک است اما همان نیست — شاید با چشم برداشته شده` });
    }
  }
  return out;
}
