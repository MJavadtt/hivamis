import ExcelJS from 'exceljs';
import { esc } from '../pdf/fmt.js';

/**
 * The PDF of an invoice is drawn from the workbook it was written on (ADR-125), so both say the same
 * thing in the same place: its columns and rows at their widths and heights, its merged cells, its
 * borders, sizes, weights and alignment. Two things differ, and are said so. The page is set in the
 * bundled Vazirmatn — a server has none of the owner's fonts — a little smaller, as it runs wider;
 * and a text too long for its cell wraps where Excel would cut it, so nothing on an invoice is lost.
 *
 * In a right-to-left sheet Excel keeps its borders by column order — `left` is the side toward
 * column A, the right-hand side on the page — but its alignment as on the page.
 */

const PAGE_WIDTH_PT = ((297 - 2 * 6) / 25.4) * 72; // A4 landscape, 6 mm margins
const PAGE_HEIGHT_PT = ((210 - 2 * 6) / 25.4) * 72 * 0.96; // and a little room for a row that grows
/** Past this, a long invoice runs onto a second page rather than shrink out of reading. */
const MIN_FIT = 0.62;
/** Vazirmatn at the size of a Nazanin letter. */
const FONT_SCALE = 0.82;
const BORDER_PT: Record<string, string> = {
  hair: '0.3pt solid', thin: '0.6pt solid', dotted: '0.6pt dotted', dashed: '0.6pt dashed', dashDot: '0.6pt dashed', dashDotDot: '0.6pt dashed',
  medium: '1.3pt solid', mediumDashed: '1.3pt dashed', mediumDashDot: '1.3pt dashed', mediumDashDotDot: '1.3pt dashed', slantDashDot: '1.3pt dashed',
  thick: '2pt solid', double: '2pt double',
};
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
/**
 * Persian digits, as the owner's Nazanin draws them, each number kept left to right as Excel keeps it:
 * Persian digits alone would turn 021-22022070 round. An IBAN stays as a bank reads it.
 */
const numbers = (escaped: string) => escaped.replace(/[A-Za-z0-9]+(?:[-/.,:][A-Za-z0-9]+)*%?/g, (t) =>
  (/\d/.test(t) ? `<span class="n">${/^IR\d{24}$/.test(t) ? t : t.replace(/\d/g, (d) => PERSIAN[Number(d)]!)}</span>` : t));

/** Excel's own conversion from a column's width in characters to pixels. */
const columnPx = (w: number) => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7);

function shown(cell: ExcelJS.Cell): string {
  let v: unknown = cell.value;
  if (v && typeof v === 'object') {
    if ('result' in v) v = (v as { result: unknown }).result;
    else if ('richText' in v) v = (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('');
    else if ('text' in v) v = (v as { text: string }).text;
  }
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    const fmt = cell.numFmt ?? '';
    if (fmt.includes('#,##0')) {
      // The accounting format of the owner's form shows nothing owed as a dash.
      if (Math.round(v) === 0 && fmt.split(';').length > 2 && fmt.split(';')[2]!.includes('-')) return '-';
      return Math.round(v).toLocaleString('en-US');
    }
    return String(Number(v.toFixed(6)));
  }
  return String(v);
}

interface Edge { style?: string }
const edge = (e?: Edge) => (e?.style ? BORDER_PT[e.style] ?? BORDER_PT.thin : '');

export async function sheetHtml(xlsx: Buffer, lastRow: number): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  const ws = wb.worksheets[0]!;
  const firstCol = 2;
  const lastCol = ws.columnCount;

  const widths: number[] = [];
  for (let c = firstCol; c <= lastCol; c++) widths.push(columnPx(ws.getColumn(c).width ?? ws.properties.defaultColWidth ?? 9.14));
  const totalPx = widths.reduce((a, b) => a + b, 0);
  // How much the sheet is scaled to fill the page's width — its rows and type with it — and then, if
  // that leaves it a little too tall, onto the page's height.
  let k = PAGE_WIDTH_PT / (totalPx * 0.75);
  let tall = 0;
  for (let r = 1; r <= lastRow; r++) if (!ws.getRow(r).hidden) tall += (ws.getRow(r).height ?? ws.properties.defaultRowHeight ?? 15) * k;
  const fit = tall > PAGE_HEIGHT_PT && PAGE_HEIGHT_PT / tall >= MIN_FIT ? PAGE_HEIGHT_PT / tall : 1;
  k *= fit;

  const spans = new Map<string, { rows: number; cols: number; r2: number; c2: number }>();
  const covered = new Set<string>();
  for (const range of (ws.model as { merges?: string[] }).merges ?? []) {
    const [a, b] = range.split(':');
    const from = ws.getCell(a!), to = ws.getCell(b!);
    const r1 = Number(from.row), c1 = Number(from.col), r2 = Number(to.row), c2 = Number(to.col);
    let rows = 0;
    for (let r = r1; r <= r2; r++) if (!ws.getRow(r).hidden) rows++;
    spans.set(`${r1}:${c1}`, { rows, cols: c2 - c1 + 1, r2, c2 });
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(`${r}:${c}`);
  }

  const out: string[] = [];
  for (let r = 1; r <= lastRow; r++) {
    const row = ws.getRow(r);
    if (row.hidden) continue;
    const height = (row.height ?? ws.properties.defaultRowHeight ?? 15) * k;
    const cells: string[] = [];
    for (let c = firstCol; c <= lastCol; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const cell = ws.getCell(r, c);
      const span = spans.get(`${r}:${c}`);
      const r2 = span?.r2 ?? r, c2 = span?.c2 ?? c;
      // A merged cell's edges are its outer cells' own.
      const side = (pick: (x: ExcelJS.Cell) => Edge | undefined, cellsOnEdge: ExcelJS.Cell[]) => {
        for (const x of cellsOnEdge) { const e = edge(pick(x)); if (e) return e; }
        return '';
      };
      const along = (rr: number) => Array.from({ length: c2 - c + 1 }, (_, i) => ws.getCell(rr, c + i));
      const down = (cc: number) => Array.from({ length: r2 - r + 1 }, (_, i) => ws.getCell(r + i, cc));
      const top = side((x) => x.border?.top, along(r));
      const bottom = side((x) => x.border?.bottom, along(r2));
      const towardA = side((x) => x.border?.left, down(c));
      const away = side((x) => x.border?.right, down(c2));

      const font = cell.font ?? {};
      const al = cell.alignment ?? {};
      const text = shown(cell);
      const numeric = typeof cell.value === 'number' || (!!cell.value && typeof cell.value === 'object' && 'result' in cell.value);
      const align = al.horizontal === 'left' ? 'left' : al.horizontal === 'right' ? 'right'
        : al.horizontal === 'center' || al.horizontal === 'centerContinuous' ? 'center' : al.horizontal === 'justify' ? 'justify'
          : numeric ? 'left' : 'right';
      const valign = al.vertical === 'top' ? 'top' : al.vertical === 'middle' ? 'middle' : 'bottom';
      // What Excel wraps wraps; the rest stays on its line, as the form's labels do.
      const wraps = !!al.wrapText || !!al.shrinkToFit;
      const style = [
        top && `border-top:${top}`, bottom && `border-bottom:${bottom}`,
        towardA && `border-right:${towardA}`, away && `border-left:${away}`,
        `text-align:${align}`, `vertical-align:${valign}`, wraps ? '' : 'white-space:pre',
        `font-size:${((font.size ?? 10) * k * FONT_SCALE).toFixed(2)}pt`, font.bold ? 'font-weight:700' : '',
      ].filter(Boolean).join(';');
      const body = al.textRotation === 90 ? `<span class="up">${numbers(esc(text))}</span>` : numbers(esc(text));
      const attrs = `${span && span.cols > 1 ? ` colspan="${span.cols}"` : ''}${span && span.rows > 1 ? ` rowspan="${span.rows}"` : ''}`;
      cells.push(`<td${attrs} style="${style}">${body}</td>`);
    }
    out.push(`<tr style="height:${height.toFixed(2)}pt">${cells.join('')}</tr>`);
  }

  const cols = widths.map((w) => `<col style="width:${((w / totalPx) * 100).toFixed(3)}%">`).join('');
  return `<style>
.xf{width:${(fit * 100).toFixed(2)}%;border-collapse:collapse;table-layout:fixed;margin:0 auto;line-height:1.3;color:#000;}
.xf .n{direction:ltr;unicode-bidi:isolate;}
.xf td{border:none;padding:0 0.7mm;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;}
.xf tr{page-break-inside:avoid;}
.xf .up{display:inline-block;writing-mode:vertical-rl;transform:rotate(180deg);}
</style><table class="xf" dir="rtl"><colgroup>${cols}</colgroup>${out.join('')}</table>`;
}
