/**
 * The first sheet of the file an organisation actually has (roadmap #48): an Excel workbook, or a
 * CSV Excel saved — no library.
 *
 *   .xlsx  a ZIP of XML: entries inflated with zlib, shared strings and inline strings read, a cell
 *          styled as a date turned from Excel's day count into YYYY-MM-DD.
 *   .csv   UTF-8 if it is valid UTF-8, otherwise Windows-1256 — what Persian Excel writes when told
 *          plain "CSV"; comma- or semicolon-separated, whichever the header uses.
 *
 * Limits are set against a hostile file: entries, total inflated size, rows.
 */
import { inflateRawSync } from 'node:zlib';
import { parseCsv } from '../forms/bulk.js';

export const MAX_ROWS = 5000;
const MAX_ENTRIES = 2000;
const MAX_INFLATED = 60 * 1024 * 1024;

export class SheetError extends Error {}

/* ── ZIP ─────────────────────────────────────────────────────────────────────────────────── */

function unzip(b: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new SheetError('فایل اکسل خوانا نیست');
  const entries = b.readUInt16LE(eocd + 10), cdOffset = b.readUInt32LE(eocd + 16);
  if (entries > MAX_ENTRIES) throw new SheetError('فایل اکسل بیش از اندازه جزء دارد');
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0, at = cdOffset; n < entries; n++) {
    if (b.readUInt32LE(at) !== 0x02014b50) throw new SheetError('فایل اکسل آسیب دیده است');
    const method = b.readUInt16LE(at + 10), csize = b.readUInt32LE(at + 20), usize = b.readUInt32LE(at + 24);
    const nameLen = b.readUInt16LE(at + 28), extraLen = b.readUInt16LE(at + 30), commentLen = b.readUInt16LE(at + 32);
    const local = b.readUInt32LE(at + 42);
    const name = b.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    // Only the parts a sheet is read from.
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    total += usize;
    if (total > MAX_INFLATED) throw new SheetError('فایل اکسل بیش از اندازه بزرگ است');
    const dataAt = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(dataAt, dataAt + csize);
    out.set(name, method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) + 1024 }) : Buffer.alloc(0));
  }
  return out;
}

/* ── XML, just enough ────────────────────────────────────────────────────────────────────── */

const unescape = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1]!)).join('');

/** Built-in number formats that are dates, and any custom one that spells a year or a day. */
function dateStyles(styles: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\s[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') ?? '');
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  [...xfs.matchAll(/<xf\s[^>]*?\/?>/g)].forEach((m, i) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]/g, '') ?? '';
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[yd]/i.test(code)) out.add(i);
  });
  return out;
}

const colIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
/** Excel counts days from 1899-12-30. */
const excelDate = (serial: number) => new Date(Math.round((serial - 25569) * 86_400_000)).toISOString().slice(0, 10);

function readXlsx(b: Buffer): string[][] {
  const parts = unzip(b);
  const workbook = parts.get('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw new SheetError('فایل اکسل کاربرگی ندارد');
  const firstSheet = /<sheet\s[^>]*>/.exec(workbook)?.[0] ?? '';
  const rid = attr(firstSheet, 'r:id');
  const rels = parts.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const target = [...rels.matchAll(/<Relationship\s[^>]*>/g)].map((m) => m[0]).find((r) => attr(r, 'Id') === rid);
  const path = target ? `xl/${attr(target, 'Target')!.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = parts.get(path)?.toString('utf8') ?? [...parts.entries()].find(([k]) => k.startsWith('xl/worksheets/'))?.[1].toString('utf8');
  if (!sheet) throw new SheetError('فایل اکسل کاربرگی ندارد');
  const shared = [...(parts.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
  const dates = dateStyles(parts.get('xl/styles.xml')?.toString('utf8'));

  const rows: string[][] = [];
  for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length > MAX_ROWS) throw new SheetError(`بیش از ${MAX_ROWS} ردیف در یک فایل پذیرفته نمی‌شود`);
    const row: string[] = [];
    for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = c[1]!, body = c[2] ?? '';
      const at = colIndex(attr(head, 'r') ?? 'A');
      const t = attr(head, 't'), v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (t === 's') value = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') value = texts(body);
      else if (t === 'b') value = v === '1' ? 'true' : 'false';
      else if (t === 'str' || t === 'e') value = unescape(v ?? '');
      else if (v != null) value = dates.has(Number(attr(head, 's') ?? -1)) ? excelDate(Number(v)) : v;
      row[at] = value.trim();
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/* ── CSV ─────────────────────────────────────────────────────────────────────────────────── */

export function decodeText(b: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return new TextDecoder('windows-1256').decode(b); }
}

function readCsv(b: Buffer): string[][] {
  const text = decodeText(b);
  const header = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (header.match(/;/g)?.length ?? 0) > (header.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = parseCsv(text, delimiter);
  if (rows.length > MAX_ROWS + 1) throw new SheetError(`بیش از ${MAX_ROWS} ردیف در یک فایل پذیرفته نمی‌شود`);
  return rows.map((r) => r.map((c) => c.trim()));
}

/**
 * Arabic yeh and kaf as Persian. Windows-1256 has no Persian «ی» and «ک», so a CSV saved by
 * Persian Excel spells every name with the Arabic letters — and «علي» would never match «علی».
 */
export const persianLetters = (s: string) => s.replace(/\u064A/g, '\u06CC').replace(/\u0643/g, '\u06A9').replace(/\u0649/g, '\u06CC');

/** The first sheet as rows of text, whichever of the two the file is. */
export function readTable(b: Buffer): string[][] {
  const rows = b.length >= 4 && b.readUInt32LE(0) === 0x04034b50 ? readXlsx(b) : readCsv(b);
  return rows.map((r) => r.map(persianLetters));
}
