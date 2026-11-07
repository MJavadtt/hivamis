import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { latinDigits, type InvoiceBuyer, type InvoiceForm } from '@hiva/contracts';
import { money, sumOf, type Money } from '../lib/money.js';
import { LAYOUTS, LINE_COLUMNS, TOTAL_SPANS, termsText, type Boxes, type FormLayout, type Labelled, type Party, type SellerDetails } from './forms.js';

/**
 * An invoice written on its company's own workbook (ADR-125). The file is the owner's, edited where
 * the invoice goes and nowhere else, so what opens in Excel is their form: its borders, fonts,
 * drawings and print setup. The amounts are live formulas, as in the owner's file, with their values
 * stored beside them for a viewer that does not calculate.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const templates = new Map<InvoiceForm, Promise<Buffer>>();
const template = (form: InvoiceForm) => {
  let t = templates.get(form);
  if (!t) { t = readFile(path.join(here, 'forms', `${form}.xlsx`)); templates.set(form, t); }
  return t;
};

export interface PrintedLine { code?: string | null; description: string; quantity: number; unit?: string | null; unitPrice: Money; discount: Money }
export interface PrintableInvoice {
  form: InvoiceForm; kind: string; state: string; number: string; issueDate: Date;
  seller: SellerDetails; buyer: InvoiceBuyer; lines: PrintedLine[]; taxPercent: number;
  saleTerms: string | null; notes: string | null;
}

/** Each row as the form computes it: (6 × 4), less the discount (7 − 8), the tax on that, and their sum (9 + 10). */
export function figures(inv: Pick<PrintableInvoice, 'lines' | 'taxPercent'>) {
  const rows = inv.lines.map((l) => {
    const gross = money(l.quantity).mul(l.unitPrice);
    const net = gross.sub(l.discount);
    const tax = net.mul(inv.taxPercent).div(100);
    return { gross, discount: money(l.discount), net, tax, total: net.add(tax) };
  });
  const sum = (k: keyof (typeof rows)[number]) => sumOf(rows.map((r) => r[k]));
  return { rows, totals: { gross: sum('gross'), discount: sum('discount'), net: sum('net'), tax: sum('tax'), total: sum('total') } };
}

const TITLES: Record<string, string> = { INVOICE: 'فاکتور فروش كالا و خدمات', PROFORMA: 'پیش فاکتور فروش كالا و خدمات' };
const NOT_FINAL: Record<string, string> = { DRAFT: ' (پیش‌نویس)', CANCELLED: ' (باطل‌شده)' };
export const titleOf = (kind: string, state: string) => `${TITLES[kind] ?? TITLES.INVOICE}${NOT_FINAL[state] ?? ''}`;

/** The Jalali date as the owner writes it: 1405/07/15. */
export function jalali(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Tehran' }).formatToParts(d);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${part('year')}/${part('month')}/${part('day')}`;
}

export const bankLine = (s: SellerDetails): string | null => {
  const account = s.accountNumber ? `شماره حساب شرکت : ${s.accountNumber}${s.bankName ? ` نزد بانک ${s.bankName}` : ''}` : s.bankName ? `بانک ${s.bankName}` : '';
  const iban = s.iban ? `شماره شبا :${s.iban}` : '';
  return [account, iban].filter(Boolean).join('/') || null;
};

/* ── the sheet's XML ───────────────────────────────────────────────────── */

const colNumber = (c: string) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n: number) => { let s = ''; while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; };
const split = (ref: string) => { const m = /^([A-Z]+)(\d+)$/.exec(ref)!; return { col: colNumber(m[1]!), row: Number(m[2]) }; };
// What XML 1.0 cannot carry is dropped; the rest escaped.
const xmlText = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Styles { fontPt: number[]; wraps: boolean[] }
function readStyles(xml: string): Styles {
  const fonts = [...xml.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/)![1]!.matchAll(/<font>([\s\S]*?)<\/font>|<font\/>/g)]
    .map((m) => Number(/<sz val="([\d.]+)"/.exec(m[1] ?? '')?.[1] ?? 10));
  const xfs = [...xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)![1]!.matchAll(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)];
  return {
    fontPt: xfs.map((m) => fonts[Number(/fontId="(\d+)"/.exec(m[0])?.[1] ?? 0)] ?? 10),
    wraps: xfs.map((m) => /wrapText="1"/.test(m[0])),
  };
}

class Sheet {
  constructor(public xml: string, private styles: Styles) {}

  private cellRe = (ref: string) => new RegExp(`<c r="${ref}"( s="\\d+")?(?: t="\\w+")?(?:\\/>|>[\\s\\S]*?<\\/c>)`);

  private put(ref: string, inner: string | null, type = '') {
    const re = this.cellRe(ref);
    const m = re.exec(this.xml);
    if (!m) throw new Error(`invoice form: cell ${ref} is not on the form`);
    const s = m[1] ?? '';
    this.xml = this.xml.replace(re, inner === null ? `<c r="${ref}"${s}/>` : `<c r="${ref}"${s}${type}>${inner}</c>`);
  }

  clear(ref: string) { this.put(ref, null); }
  number(ref: string, n: Money | number) { this.put(ref, `<v>${money(n).toString()}</v>`); }
  formula(ref: string, f: string, value: Money) { this.put(ref, `<f>${f}</f><v>${value.toString()}</v>`); }
  text(ref: string, s: string | null | undefined) {
    if (s == null || s === '') return this.clear(ref);
    this.put(ref, `<is><t xml:space="preserve">${xmlText(s)}</t></is>`, ' t="inlineStr"');
    this.fit(ref, s);
  }

  /* Rows, merges and columns: what a longer text needs the row to grow to. */
  private merges() { return [...this.xml.matchAll(/<mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"\/>/g)].map((m) => ({ from: split(m[1]!), to: split(m[2]!) })); }
  private colWidth(c: number) {
    for (const m of this.xml.matchAll(/<col min="(\d+)" max="(\d+)"[^>]*?width="([\d.]+)"/g)) if (c >= Number(m[1]) && c <= Number(m[2])) return Number(m[3]);
    return 9.14;
  }
  rowHeight(r: number) { return Number(new RegExp(`<row r="${r}"[^>]*?ht="([\\d.]+)"`).exec(this.xml)?.[1] ?? 15); }
  setRowHeight(r: number, ht: number) {
    this.xml = this.xml.replace(new RegExp(`<row r="${r}"([^>]*?)>`), (_m, attrs: string) =>
      `<row r="${r}"${attrs.replace(/ ht="[\d.]+"/, '').replace(/ customHeight="\d"/, '')} ht="${Math.min(409, Math.ceil(ht * 4) / 4)}" customHeight="1">`);
  }
  /**
   * Grows the row so a wrapped text shows whole, since Excel cannot fit a merged cell itself. The
   * estimate is on the safe side: 1.6 letters a column unit at 10pt, where the owner's longest line
   * (Hiva's address) uses 1.1.
   */
  private fit(ref: string, s: string) {
    const at = split(ref);
    const style = Number(new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(this.xml)?.[1] ?? 0);
    if (!this.styles.wraps[style]) return;
    const merge = this.merges().find((m) => m.from.row === at.row && m.from.col === at.col);
    if (merge && merge.to.row !== merge.from.row) return;
    const last = merge?.to.col ?? at.col;
    let width = 0;
    for (let c = at.col; c <= last; c++) width += this.colWidth(c);
    const pt = this.styles.fontPt[style] ?? 10;
    const perLine = Math.max(4, Math.floor(width * 1.6 * (10 / pt)));
    // The forms space their words with runs of blanks, which print narrow: counted as one.
    const lines = s.split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(p.trim().replace(/\s+/g, ' ').length / perLine)), 0);
    const need = lines * pt * 1.45 + 4;
    if (lines > 1 && need > this.rowHeight(at.row)) this.setRowHeight(at.row, need);
  }

  addMerge(ref: string) {
    this.xml = this.xml.replace(/<mergeCells count="(\d+)">/, (_m, n: string) => `<mergeCells count="${Number(n) + 1}"><mergeCell ref="${ref}"/>`);
  }

  /** `count` copies of row `source`, below row `after`; everything lower moves down with its merges. */
  insertRows(after: number, source: number, count: number) {
    if (!count) return;
    const moveRow = (row: string, to: number) => row
      .replace(/^<row r="\d+"/, `<row r="${to}"`)
      .replace(/<c r="([A-Z]+)\d+"/g, `<c r="$1${to}"`);
    const data = /<sheetData>([\s\S]*?)<\/sheetData>/.exec(this.xml)!;
    const rows = data[1]!.match(/<row [^>]*?(?:\/>|>[\s\S]*?<\/row>)/g) ?? [];
    const numberOf = (row: string) => Number(/^<row r="(\d+)"/.exec(row)![1]);
    const copy = rows.find((r) => numberOf(r) === source);
    if (!copy) throw new Error(`invoice form: row ${source} is not on the form`);
    const out: string[] = [];
    for (const row of rows) {
      const r = numberOf(row);
      out.push(r > after ? moveRow(row, r + count) : row);
      if (r === after) for (let i = 1; i <= count; i++) out.push(moveRow(copy, after + i));
    }
    this.xml = this.xml.replace(data[0], `<sheetData>${out.join('')}</sheetData>`);

    const merges = this.merges();
    const ref = (c: number, r: number) => `${colName(c)}${r}`;
    const moved = merges.map((m) => (m.from.row > after
      ? { from: { ...m.from, row: m.from.row + count }, to: { ...m.to, row: m.to.row + count } } : m));
    for (const m of merges.filter((x) => x.from.row === source && x.to.row === source)) {
      for (let i = 1; i <= count; i++) moved.push({ from: { ...m.from, row: after + i }, to: { ...m.to, row: after + i } });
    }
    this.xml = this.xml.replace(/<mergeCells count="\d+">[\s\S]*?<\/mergeCells>/,
      `<mergeCells count="${moved.length}">${moved.map((m) => `<mergeCell ref="${ref(m.from.col, m.from.row)}:${ref(m.to.col, m.to.row)}"/>`).join('')}</mergeCells>`);
    this.xml = this.xml.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\/>/, (_m, a: string, c: string, r: string) =>
      `<dimension ref="${a}:${c}${Number(r) > after ? Number(r) + count : r}"/>`);
  }
}

/** Drawings anchored below the inserted rows move down with them. */
const shiftDrawing = (xml: string, after: number, count: number) =>
  xml.replace(/<xdr:row>(\d+)<\/xdr:row>/g, (m, r: string) => (Number(r) >= after ? `<xdr:row>${Number(r) + count}</xdr:row>` : m));
/** So does the print area. */
const shiftPrintArea = (xml: string, after: number, count: number) =>
  xml.replace(/(<definedName [^>]*>[^<]*?)<\/definedName>/g, (_m, body: string) =>
    `${body.replace(/\$(\d+)\b/g, (x, r: string) => (Number(r) > after ? `$${Number(r) + count}` : x))}</definedName>`);

function writeBoxes(sheet: Sheet, b: Boxes, value: string | null | undefined) {
  const cols: string[] = [];
  for (let c = colNumber(b.from); c <= colNumber(b.to); c++) cols.push(colName(c));
  cols.forEach((c) => sheet.clear(`${c}${b.row}`));
  const digits = latinDigits(value ?? '').replace(/\D/g, '');
  if (!digits) return;
  if (digits.length > cols.length) {
    // Longer than the boxes: written whole across them, rather than cut.
    sheet.addMerge(`${b.from}${b.row}:${b.to}${b.row}`);
    sheet.text(`${b.from}${b.row}`, digits);
    return;
  }
  const start = cols.length - digits.length;
  [...digits].forEach((d, i) => sheet.number(`${cols[start + i]}${b.row}`, Number(d)));
}

function writeParty(sheet: Sheet, p: Party, v: Partial<Record<keyof Party, string | null | undefined>> & { legalName?: string | null }) {
  const labelled = ([cell, label]: Labelled, value: string | null | undefined) => sheet.text(cell, `${label}${value ?? ''}`);
  labelled(p.name, v.legalName);
  writeBoxes(sheet, p.economicCode, v.economicCode);
  writeBoxes(sheet, p.nationalId, v.nationalId);
  labelled(p.province, v.province);
  labelled(p.county, v.county);
  writeBoxes(sheet, p.postalCode, v.postalCode);
  labelled(p.city, v.city);
  labelled(p.address, v.address);
  labelled(p.phone, v.phone);
}

/** The filled workbook, and the layout with the rows it gained — what the PDF is drawn from. */
export async function invoiceWorkbook(inv: PrintableInvoice): Promise<{ xlsx: Buffer; lastRow: number; layout: FormLayout }> {
  const layout = LAYOUTS[inv.form];
  const zip = await JSZip.loadAsync(await template(inv.form));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const sheet = new Sheet(await zip.file(sheetPath)!.async('string'), readStyles(await zip.file('xl/styles.xml')!.async('string')));

  const extra = Math.max(0, inv.lines.length - layout.lines.rows);
  if (extra) {
    sheet.insertRows(layout.lines.repeat, layout.lines.repeat, extra);
    for (const name of Object.keys(zip.files).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))) {
      zip.file(name, shiftDrawing(await zip.file(name)!.async('string'), layout.lines.repeat, extra));
    }
    zip.file('xl/workbook.xml', shiftPrintArea(await zip.file('xl/workbook.xml')!.async('string'), layout.lines.repeat, extra));
  }
  const totalsRow = layout.totals + extra;

  sheet.text(layout.title.cell, `${layout.title.lead}${titleOf(inv.kind, inv.state)}${layout.title.trail}`);
  sheet.text(layout.number, `شماره : ${inv.number}`);
  sheet.text(layout.date[0], `${layout.date[1]}${jalali(inv.issueDate)}`);
  writeParty(sheet, layout.seller, inv.seller);
  writeParty(sheet, layout.buyer, inv.buyer);

  const pct = Number(inv.taxPercent);
  if (layout.rate) sheet.text(layout.rate, `${pct}%`);
  const { rows, totals } = figures(inv);
  const C = LINE_COLUMNS;
  inv.lines.forEach((l, i) => {
    const r = layout.lines.first + i;
    const f = rows[i]!;
    sheet.number(`${C.row}${r}`, i + 1);
    sheet.text(`${C.code}${r}`, l.code);
    sheet.text(`${C.description}${r}`, l.description);
    sheet.number(`${C.quantity}${r}`, l.quantity);
    sheet.text(`${C.unit}${r}`, l.unit);
    sheet.number(`${C.unitPrice}${r}`, l.unitPrice);
    sheet.formula(`${C.gross}${r}`, `${C.quantity}${r}*${C.unitPrice}${r}`, f.gross);
    sheet.number(`${C.discount}${r}`, l.discount);
    sheet.formula(`${C.net}${r}`, `${C.gross}${r}-${C.discount}${r}`, f.net);
    sheet.formula(`${C.tax}${r}`, `${C.net}${r}*${pct}%`, f.tax);
    sheet.formula(`${C.total}${r}`, `${C.net}${r}+${C.tax}${r}`, f.total);
  });
  const a = layout.lines.first, b = layout.lines.first + layout.lines.rows + extra - 1;
  for (const [k, [from, to]] of Object.entries(TOTAL_SPANS) as [keyof typeof TOTAL_SPANS, readonly [string, string]][]) {
    sheet.formula(`${from}${totalsRow}`, `SUM(${from}${a}:${to}${b})`, totals[k]);
  }

  const shift = (ref: string) => { const s = split(ref); return `${colName(s.col)}${s.row + extra}`; };
  sheet.text(shift(layout.terms), termsText(inv.saleTerms));
  sheet.text(shift(layout.notes), inv.notes);
  sheet.text(shift(layout.bank), bankLine(inv.seller));

  zip.file(sheetPath, sheet.xml);
  const xlsx = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return { xlsx, lastRow: layout.lastRow + extra, layout };
}
