import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, StandardFonts, cmyk, grayscale, rgb } from 'pdf-lib';
import { brandKitSchema } from '@hiva/contracts';
import { closeApp, get, login, post, put, upload, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { nextCode } from '../src/lib/codes.js';
import { jpegSample, pngSample } from '../src/brand/pixels.js';
import { deltaE2000, dominantColours, hexToRgb, rgbToLab } from '../src/brand/palette.js';
import { imageBrandScan, pdfBrandScan, type BrandScan } from '../src/brand/scan.js';
import { brandFindingsFa, checkScan, fontKey, ltr } from '../src/brand/check.js';
import { backfillMetadata } from '../src/documents/backfill.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/brand/${name}`, import.meta.url));
const NAVY = '#1A2B3C', GOLD = '#D4AF37', TEAL = '#0F766E';
const dE = (a: string, b: string) => deltaE2000(rgbToLab(...hexToRgb(a)), rgbToLab(...hexToRgb(b)));

/* ── a PNG encoder, so every colour type, depth and interlacing can be written ────────────── */

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
type Px = [number, number, number, number];
/** The fixture design: navy left, gold right, a teal band at the bottom-left. */
const design = (w: number, h: number) => (x: number, y: number): Px =>
  x >= w / 2 ? [212, 175, 55, 255] : y >= h - h / 4 ? [15, 118, 110, 255] : [26, 43, 60, 255];
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

function png(w: number, h: number, pixel: (x: number, y: number) => Px, opts: { type?: 0 | 2 | 3 | 6; depth?: 4 | 8 | 16; interlace?: boolean; palette?: Px[] } = {}) {
  const type = opts.type ?? 2, depth = opts.depth ?? 8, channels = { 0: 1, 2: 3, 3: 1, 6: 4 }[type];
  const sample = (x: number, y: number): number[] => {
    const p = pixel(x, y);
    if (type === 3) return [opts.palette!.findIndex((c) => c.slice(0, 3).every((v, i) => v === p[i]))];
    if (type === 0) return [Math.round((p[0] * ((1 << depth) - 1)) / 255)];
    return (type === 6 ? p : p.slice(0, 3)).map((v) => (depth === 16 ? v * 257 : v));
  };
  const row = (xs: number[], y: number) => {
    const bits: number[] = [];
    for (const x of xs) for (const v of sample(x, y)) bits.push(v);
    const out = Buffer.alloc(1 + Math.ceil((xs.length * channels * depth) / 8));
    bits.forEach((v, i) => {
      if (depth === 16) out.writeUInt16BE(v, 1 + i * 2);
      else if (depth === 8) out[1 + i] = v;
      else out[1 + ((i * depth) >> 3)]! |= v << (8 - depth - ((i * depth) & 7));
    });
    return out;
  };
  const rows: Buffer[] = [];
  const passes = opts.interlace ? ADAM7 : [[0, 0, 1, 1] as const];
  for (const [x0, y0, dx, dy] of passes) {
    const xs = []; for (let x = x0; x < w; x += dx) xs.push(x);
    if (!xs.length) continue;
    for (let y = y0; y < h; y += dy) rows.push(row(xs, y));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = type; ihdr[12] = opts.interlace ? 1 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...(opts.palette ? [chunk('PLTE', Buffer.from(opts.palette.flatMap((c) => c.slice(0, 3)))), chunk('tRNS', Buffer.from(opts.palette.map((c) => c[3])))] : []),
    chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── a DC-only JPEG encoder, for the one layout no encoder here writes: Adobe YCCK ────────── */

function ycckJpeg(blocks: { ink: [number, number, number, number] }[], bw: number) {
  // Standard DC luminance code lengths; AC has one code, end-of-block.
  const dcCounts = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], dcValues = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const codes: { len: number; code: number }[] = []; let code = 0, k = 0;
  dcCounts.forEach((n, l) => { for (let i = 0; i < n; i++) codes[dcValues[k++]!] = { len: l + 1, code: code++ }; code <<= 1; });
  const bytes: number[] = []; let acc = 0, nbits = 0;
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) { acc = (acc << 1) | ((v >> i) & 1); if (++nbits === 8) { bytes.push(acc); if (acc === 0xff) bytes.push(0); acc = 0; nbits = 0; } } };
  const pred = [0, 0, 0, 0];
  for (const b of blocks) {
    // libjpeg's YCCK: the inverted-CMY part is carried as "RGB" through YCbCr; K as stored (Adobe: inverted).
    const [c, m, y, kk] = b.ink.map((v) => Math.round((v / 100) * 255));
    const Y = 0.299 * c! + 0.587 * m! + 0.114 * y!, Cb = 128 - 0.168736 * c! - 0.331264 * m! + 0.5 * y!, Cr = 128 + 0.5 * c! - 0.418688 * m! - 0.081312 * y!;
    [Y, Cb, Cr, 255 - kk!].forEach((level, n) => {
      const dc = Math.round((level - 128) * 8), diff = dc - pred[n]!; pred[n] = dc;
      const size = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
      put(codes[size]!.code, codes[size]!.len);
      if (size) put(diff > 0 ? diff : diff + (1 << size) - 1, size);
      put(0, 1);                                                   // EOB
    });
  }
  if (nbits) put(0xff, 8 - nbits);
  const seg = (m: number, body: number[]) => [0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  const bh = blocks.length / bw;
  return Buffer.from([
    0xff, 0xd8,
    ...seg(0xee, [...Buffer.from('Adobe'), 0, 100, 0, 0, 0, 0, 2]),
    ...seg(0xdb, [0, ...new Array(64).fill(1)]),
    ...seg(0xc0, [8, 0, bh * 8, 0, bw * 8, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0]),
    ...seg(0xc4, [0x00, ...dcCounts, ...dcValues]),
    ...seg(0xc4, [0x10, 1, ...new Array(15).fill(0), 0]),
    ...seg(0xda, [4, 1, 0x00, 2, 0x00, 3, 0x00, 4, 0x00, 0, 63, 0]),
    ...bytes, 0xff, 0xd9,
  ]);
}

describe('Reading an image’s colours without a decoding library', () => {
  const expectDesign = (swatches: { hex?: string; share: number }[]) => {
    const [gold, navy, teal] = swatches;
    expect(dE(gold!.hex!, GOLD)).toBeLessThan(2);
    expect(dE(navy!.hex!, NAVY)).toBeLessThan(2);
    expect(dE(teal!.hex!, TEAL)).toBeLessThan(2);
    expect([gold!.share, navy!.share, teal!.share]).toEqual([0.5, 0.375, 0.125]);
  };

  it('reads JPEGs as their encoders wrote them — baseline, progressive, with restart markers, grey', () => {
    for (const name of ['baseline.jpg', 'progressive.jpg', 'restart.jpg']) expectDesign(dominantColours(jpegSample(fixture(name))!));
    const grey = dominantColours(jpegSample(fixture('gray.jpg'))!);
    // 0.299R + 0.587G + 0.114B of gold, navy, teal.
    ['#ACACAC', '#282828', '#565656'].forEach((hex, i) => expect(dE(grey[i]!.hex!, hex)).toBeLessThan(1));
  });

  it('keeps a CMYK JPEG in ink — Pillow’s, Apple’s, and Adobe YCCK — rather than guessing its RGB', () => {
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 1);
    // Pillow converts naively: ink = 255 − RGB.
    const pil = dominantColours(jpegSample(fixture('cmyk.jpg'))!);
    expect(pil.map((s) => s.share)).toEqual([0.5, 0.375, 0.125]);
    [[17, 31, 78, 0], [90, 83, 76, 0], [94, 54, 57, 0]].forEach((ink, i) => expect(near(pil[i]!.cmyk!, ink)).toBe(true));
    const apple = dominantColours(jpegSample(fixture('sips-cmyk.jpg'))!);
    expect(near(apple[0]!.cmyk!, [5, 20, 91, 10])).toBe(true);
    expect(near(apple[1]!.cmyk!, [89, 67, 37, 51])).toBe(true);
    expect(near(apple[2]!.cmyk!, [85, 22, 49, 18])).toBe(true);
    const ycck = jpegSample(ycckJpeg([{ ink: [89, 67, 37, 51] }, { ink: [5, 20, 91, 10] }], 2))!;
    expect(ycck.space).toBe('CMYK');
    const inks = dominantColours(ycck).map((s) => s.cmyk!).sort((a, b) => a[0] - b[0]);
    expect(near(inks[0]!, [5, 20, 91, 10]) && near(inks[1]!, [89, 67, 37, 51])).toBe(true);
  });

  it('reads every PNG layout — RGB, 16-bit, grey, palette, interlaced — and leaves transparency out', () => {
    const w = 64, h = 32, px = design(w, h);
    for (const opts of [{}, { depth: 16 as const }, { interlace: true }, { type: 6 as const }]) expectDesign(dominantColours(pngSample(png(w, h, px, opts))!));
    const palette: Px[] = [[26, 43, 60, 255], [212, 175, 55, 255], [15, 118, 110, 255]];
    expectDesign(dominantColours(pngSample(png(w, h, px, { type: 3, depth: 4, palette }))!));
    // The gold half made transparent: what is left is navy and teal.
    const holes = dominantColours(pngSample(png(w, h, px, { type: 3, depth: 4, palette: [[26, 43, 60, 255], [212, 175, 55, 0], [15, 118, 110, 255]] }))!);
    expect(holes.map((s) => [s.hex, s.share])).toEqual([[NAVY, 0.75], [TEAL, 0.25]]);
    const grey = dominantColours(pngSample(png(w, h, (x) => (x < w / 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]), { type: 0, depth: 4 }))!);
    expect(grey.map((s) => s.hex)).toEqual(['#000000', '#FFFFFF']);
  });

  it('says what it cannot read instead of guessing', () => {
    expect(jpegSample(Buffer.from([0xff, 0xd8, 0xff, 0xc9, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0]))).toBeNull();   // arithmetic-coded
    expect(pngSample(Buffer.from('not a png at all, just some words here'))).toBeNull();
    const huge = png(1, 1, () => [0, 0, 0, 255]);
    huge.writeUInt32BE(20_000, 16); huge.writeUInt32BE(20_000, 20);
    expect(imageBrandScan(huge, 'image/png')).toMatchObject({ skipped: 'TOO_LARGE', colours: [] });
    expect(imageBrandScan(fixture('baseline.jpg').subarray(0, 300), 'image/jpeg').skipped).toBe('UNREADABLE');
  });

  it('measures colour difference as CIEDE2000 does', () => {
    // Sharma, Wu & Dalal's reference pairs.
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE2000([50, 3.1571, -77.2803], [50, 0, -82.7485])).toBeCloseTo(2.8615, 3);
    expect(deltaE2000([50, 0, 0], [50, -1, 2])).toBeCloseTo(2.3669, 3);
    expect(deltaE2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(1.2644, 3);
  });
});

async function samplePdf() {
  const inner = await PDFDocument.create();
  inner.addPage([200, 200]).drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: rgb(0.9, 0.22, 0.21) });
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold), serif = await doc.embedFont(StandardFonts.TimesRoman);
  page.drawRectangle({ x: 0, y: 700, width: 595, height: 142, color: rgb(26 / 255, 43 / 255, 60 / 255) });
  page.drawRectangle({ x: 0, y: 0, width: 595, height: 100, color: cmyk(0.89, 0.67, 0.37, 0.51) });
  page.drawText('Hiva', { x: 40, y: 760, size: 30, font: bold, color: rgb(212 / 255, 176 / 255, 56 / 255) });
  page.drawText('Terms', { x: 40, y: 400, size: 12, font: serif, color: grayscale(0.2) });
  const [embedded] = await doc.embedPdf(await inner.save());
  page.drawPage(embedded!, { x: 300, y: 300 });                // a form XObject: its colours count too
  // A spot ink, and an inline image whose bytes spell an operator that must not be read.
  const spot = doc.context.obj([PDFName.of('Separation'), PDFName.of('PANTONE 286 C'), PDFName.of('DeviceCMYK'), doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 0.66, 0, 0.02], N: 1 })]);
  page.node.Resources()!.set(PDFName.of('ColorSpace'), doc.context.obj({ CS9: spot }));
  const extra = doc.context.register(doc.context.stream('q /CS9 cs 1 scn 10 10 50 50 re f BI /W 4 /H 1 /CS /G /BPC 8 ID 1 0 0 rg EI Q'));
  const contents = page.node.Contents();
  page.node.set(PDFName.of('Contents'), doc.context.obj([...(contents && 'asArray' in contents ? (contents as any).asArray() : [page.node.get(PDFName.of('Contents'))]), extra]));
  return PDFDocument.load(await doc.save());
}

describe('Reading a PDF’s colours and typefaces', () => {
  it('counts the colours its content sets — RGB, grey, CMYK, spot, inside forms — and the fonts its text selects', async () => {
    const scan = pdfBrandScan(await samplePdf());
    expect(scan.colours.map((c) => c.hex).sort()).toEqual([NAVY, '#333333', '#D4B038', '#E63836'].sort());
    expect(scan.inks.map((c) => c.cmyk)).toEqual([[89, 67, 37, 51]]);
    expect(scan.spots).toEqual([{ name: 'PANTONE 286 C', share: expect.any(Number) }]);
    expect(scan.fonts!.map((f) => f.name).sort()).toEqual(['Helvetica-Bold', 'Times-Roman']);
    expect(scan.colours.find((c) => c.hex === '#FF0000')).toBeUndefined();   // the inline image's "1 0 0 rg" is data
  });
});

describe('A file against the brand', () => {
  const kit = {
    colors: [
      { name: 'سرمه‌ای', hex: NAVY, role: 'PRIMARY', cmyk: [89, 67, 37, 51] },
      { name: 'طلایی', hex: GOLD, role: 'ACCENT' },
      { name: 'PANTONE 286 C', hex: '#0033A0', role: 'SECONDARY' },
    ],
    fonts: [{ family: 'Helvetica' }],
  };
  const image = (colours: [string, number][]): BrandScan => ({ v: 1, kind: 'image', colours: colours.map(([hex, share]) => ({ hex, share })), inks: [] });

  it('names each colour — the brand’s, near it, neutral, or outside the palette — and warns past a tenth of the area', () => {
    const ok = checkScan(image([[GOLD, 0.5], ['#1B2D3E', 0.3], ['#FFFFFF', 0.15], ['#E53935', 0.05]]), kit);
    expect(ok.colours.map((c) => [c.hex, c.status, c.brand?.name])).toEqual([
      [GOLD, 'BRAND', 'طلایی'], ['#1B2D3E', 'BRAND', 'سرمه‌ای'], ['#FFFFFF', 'NEUTRAL', undefined], ['#E53935', 'OFF', 'طلایی'],
    ]);
    expect([ok.offShare, ok.verdict]).toEqual([0.05, 'OK']);
    const off = checkScan(image([[GOLD, 0.6], ['#E53935', 0.25], ['#2E7D32', 0.13], ['#00FF00', 0.02]]), kit);
    expect([off.offShare, off.verdict]).toEqual([0.38, 'WARN']);
    expect(off.colours.some((c) => c.hex === '#00FF00')).toBe(false);          // under 3%: detail, not design
    expect(brandFindingsFa('poster.png', off)).toEqual([{ severity: 'WARN', messageFa: `۳۸٪ از سطح «poster.png» با رنگ‌هایی بیرون از پالت برند است: ${ltr('#E53935')} (۲۵٪)، ${ltr('#2E7D32')} (۱۳٪)` }]);
  });

  it('holds a PDF to exact colours and to the brand’s typefaces, and says “nearly” when it is nearly', async () => {
    const c = checkScan(pdfBrandScan(await samplePdf()), kit);
    expect(c.colours.find((x) => x.hex === '#D4B038')).toMatchObject({ status: 'BRAND' });   // ΔE 0.4
    expect(c.colours.find((x) => x.cmyk)).toMatchObject({ status: 'BRAND', brand: { name: 'سرمه‌ای' } });
    expect(c.spots).toEqual([{ name: 'PANTONE 286 C', share: expect.any(Number), status: 'BRAND', brand: 'PANTONE 286 C' }]);
    expect(c.fonts.map((f) => [f.name, f.status])).toEqual([['Helvetica-Bold', 'BRAND'], ['Times-Roman', 'OFF']]);
    expect(c.verdict).toBe('WARN');
    const nearly = checkScan({ v: 1, kind: 'pdf', colours: [{ hex: '#1F3044', share: 1 }], inks: [], fonts: [] }, kit);
    expect(nearly.colours[0]).toMatchObject({ status: 'NEAR', brand: { name: 'سرمه‌ای' } });
    expect(brandFindingsFa('deck.pdf', nearly)).toEqual([{ severity: 'INFO', messageFa: expect.stringContaining(`به «سرمه‌ای» (${ltr('#1A2B3C')}) نزدیک است اما همان نیست`) }]);
  });

  it('matches typefaces by family, and leaves CMYK unjudged when the brand gives no CMYK', () => {
    expect(['ABCDEF+Vazirmatn-Bold', 'Arial,Bold', 'ArialMT', 'IRANSansX-Medium'].map(fontKey)).toEqual(['vazirmatn', 'arial', 'arial', 'iransansx']);
    const helveticaNeue = checkScan({ v: 1, kind: 'pdf', colours: [], inks: [], fonts: [{ name: 'Helvetica', share: 1 }] }, { colors: [], fonts: [{ family: 'Helvetica Neue' }] });
    expect(helveticaNeue.fonts[0]!.status).toBe('OFF');                         // a family, not a prefix of one
    const print = checkScan({ v: 1, kind: 'image', colours: [], inks: [{ cmyk: [0, 90, 80, 0], share: 0.6 }, { cmyk: [0, 0, 0, 100], share: 0.4 }] }, { colors: [{ name: 'طلایی', hex: GOLD, role: 'ACCENT' }], fonts: [] });
    expect(print.colours.map((x) => x.status)).toEqual(['UNCHECKED', 'NEUTRAL']);
    expect(print.verdict).toBe('NOT_CHECKED');
    expect(print.notesFa.join(' ')).toContain('رنگ‌های برند مقدار CMYK ندارند');
    expect(checkScan({ v: 1, kind: 'image', colours: [], inks: [], skipped: 'TOO_LARGE' }, kit)).toMatchObject({ verdict: 'NOT_CHECKED', notesFa: [expect.stringContaining('بزرگ‌تر')] });
  });

  it('keeps a colour’s CMYK in the brand kit, in whole ink percentages', () => {
    expect(brandKitSchema.parse({ colors: [{ name: 'سرمه‌ای', hex: '#1a2b3c', role: 'PRIMARY', cmyk: [89.4, 67, 37, 51] }], fonts: [] }).colors[0]).toEqual({ name: 'سرمه‌ای', hex: '#1A2B3C', role: 'PRIMARY', cmyk: [89, 67, 37, 51] });
    expect(brandKitSchema.safeParse({ colors: [{ name: 'x', hex: '#000000', role: 'PRIMARY', cmyk: [1, 2, 3] }], fonts: [] }).success).toBe(false);
    expect(brandKitSchema.safeParse({ colors: [{ name: 'x', hex: '#000000', role: 'PRIMARY', cmyk: [1, 2, 3, 120] }], fonts: [] }).success).toBe(false);
  });
});

describe('The brand check where the work is handed over', () => {
  let T: Record<string, string>;
  let deliverableId: string, companyId: string;
  const f: Record<string, string> = {};

  beforeAll(async () => {
    T = { creative: await login('creative@hiva.local'), designer: await login('designer@hiva.local') };
    const org = (await prisma.organization.findFirstOrThrow()).id;
    const project = await prisma.project.findFirstOrThrow({ where: { deletedAt: null } });
    companyId = project.companyId;
    deliverableId = (await prisma.deliverable.create({ data: { organizationId: org, code: await nextCode(prisma, 'deliverable'), projectId: project.id, name: 'کمپین برند', departmentCode: 'CR', state: 'IN_PROGRESS' } })).id;
    const up = async (key: string, name: string, type: string, content: Buffer) => {
      f[key] = expectOk(await upload(T.designer, { name, type, content }, { deliverableId }), key).id;
    };
    await up('onBrand', 'poster.png', 'image/png', png(64, 32, design(64, 32)));
    await up('offBrand', 'story.png', 'image/png', png(64, 32, (x) => (x < 40 ? [229, 57, 53, 255] : [212, 175, 55, 255])));
    await up('print', 'print.jpg', 'image/jpeg', fixture('sips-cmyk.jpg'));
    await up('deck', 'deck.pdf', 'application/pdf', Buffer.from(await (await samplePdf()).save()));
  });
  afterAll(async () => { await closeApp(); });

  it('reads each file at upload and keeps what it is made of with its metadata', async () => {
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: f.onBrand } });
    expect((doc.metadata as any).brand).toMatchObject({ v: 1, kind: 'image', colours: [{ hex: GOLD, share: 0.5 }, { hex: NAVY, share: 0.375 }, { hex: TEAL, share: 0.125 }] });
    const deck = await prisma.document.findUniqueOrThrow({ where: { id: f.deck } });
    expect((deck.metadata as any)).toMatchObject({ pageCount: 1, brand: { kind: 'pdf', fonts: expect.any(Array) } });
  });

  it('says nothing about the brand until the client has one', async () => {
    const r = expectOk(await post(`/deliverables/${deliverableId}/stage-zero`, T.creative), 'stage zero');
    expect(r.findings.filter((x: any) => x.check === 'brand')).toEqual([]);
    expect(r.notCheckedFa).toContain('هویت بصری — کتابخانهٔ برند این مشتری رنگ و فونتی ندارد');
  });

  it('warns in stage zero — never fails — naming the colours and typefaces outside the brand', async () => {
    expectOk(await put(`/companies/${companyId}/brand`, T.creative, {
      colors: [{ name: 'سرمه‌ای', hex: NAVY, role: 'PRIMARY', cmyk: [89, 67, 37, 51] }, { name: 'طلایی', hex: GOLD, role: 'ACCENT', cmyk: [5, 20, 91, 10] }, { name: 'سبزآبی', hex: TEAL, role: 'SECONDARY' }],
      fonts: [{ family: 'Helvetica', usage: 'تیتر' }],
    }), 'kit');
    const r = expectOk(await post(`/deliverables/${deliverableId}/stage-zero`, T.creative), 'stage zero');
    const brand = r.findings.filter((x: any) => x.check === 'brand');
    expect(brand.every((x: any) => x.severity !== 'FAIL')).toBe(true);
    expect(brand.map((x: any) => x.messageFa).sort()).toEqual([
      '«deck.pdf» فونت «Times-Roman» را به کار برده که در فهرست فونت‌های برند نیست',
      `۱۷٪ از رنگ‌گذاری‌های «deck.pdf» با رنگ‌هایی بیرون از پالت برند است: ${ltr('#E63836')} (۱۷٪)`,
      `۶۳٪ از سطح «story.png» با رنگ‌هایی بیرون از پالت برند است: ${ltr('#E53935')} (۶۳٪)`,
    ].sort());
    expect(brand.every((x: any) => x.severity === 'WARN')).toBe(true);
    expect(r.checkedFa).toContain('رنگ‌ها و فونت‌ها در برابر کتابخانهٔ برند مشتری');
    expect(r.notCheckedFa).toEqual(expect.arrayContaining(['هویت بصری: فونت متن‌های درون تصویر خوانده نمی‌شود']));
    expect(r.verdict).toBe('WARN');
    // The print file is matched in ink where the brand gave ink; its teal, which the brand gave
    // only as RGB, is left unjudged rather than called off-brand.
    const print = expectOk(await get(`/documents/${f.print}/brand-check`, T.designer), 'print');
    expect(print.check.colours.map((c: any) => [c.status, c.brand?.name ?? null])).toEqual([['BRAND', 'طلایی'], ['BRAND', 'سرمه‌ای'], ['UNCHECKED', null]]);
    expect(print.check.notesFa).toContain('بخشی از رنگ‌های CMYK سنجیده نشد: همهٔ رنگ‌های برند مقدار CMYK ندارند — آن را در کتابخانهٔ برند ثبت کنید');
  });

  it('shows one file against the brand for whoever reads files, and says why when it cannot', async () => {
    const r = expectOk(await get(`/documents/${f.offBrand}/brand-check`, T.designer), 'check');
    expect(r).toMatchObject({ supported: true, company: { id: companyId }, check: { verdict: 'WARN', offShare: 0.625 } });
    expect(r.kit.colors).toHaveLength(3);
    const text = expectOk(await upload(T.designer, { name: 'notes.txt', type: 'text/plain', content: 'متن' }, { deliverableId }), 'txt');
    expect(expectOk(await get(`/documents/${text.id}/brand-check`, T.designer), 'txt')).toMatchObject({ supported: false, check: null });
    expect((await get(`/documents/00000000-0000-4000-8000-000000000000/brand-check`, T.designer)).status).toBe(404);
  });

  it('reads the brand of files uploaded before the check, and marks what it cannot read', async () => {
    await prisma.document.update({ where: { id: f.onBrand }, data: { metadata: { width: 64, height: 32 } } });
    await prisma.document.update({ where: { id: f.deck }, data: { metadata: { pageCount: 1 }, storedName: 'gone.pdf' } });
    // Stage zero reads a file without a kept scan on the spot, and keeps nothing.
    expectOk(await post(`/deliverables/${deliverableId}/stage-zero`, T.creative), 'stage zero');
    expect((await prisma.document.findUniqueOrThrow({ where: { id: f.onBrand } })).metadata).toEqual({ width: 64, height: 32 });
    await backfillMetadata();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: f.onBrand } })).metadata).toMatchObject({ width: 64, height: 32, brand: { v: 1, colours: [{ hex: GOLD }, { hex: NAVY }, { hex: TEAL }] } });
    expect(((await prisma.document.findUniqueOrThrow({ where: { id: f.deck } })).metadata as any).brand).toMatchObject({ skipped: 'UNREADABLE' });
    expect((await backfillMetadata()).read).toBe(0);
  });
});
