import { chromium, type Browser } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../lib/errors.js';
import { env } from '../env.js';
import { esc } from './fmt.js';
import { resolveExecutable } from './browser-path.js';
import { hivaSvg } from '@hiva/contracts';

export { resolveExecutable };

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Persian requires contextual glyph shaping and bidirectional layout. No pure-JS PDF writer
 * gets this right, so documents are laid out by a real browser engine and printed to PDF.
 */
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  browserPromise ??= chromium
    .launch({
      executablePath: resolveExecutable(),
      /**
       * --no-sandbox: the container runs as an unprivileged user without CAP_SYS_ADMIN, which
       * Chromium's setuid sandbox requires. The exposure is bounded by what this page can do
       * rather than by the sandbox: the render context is `offline: true`, JavaScript is
       * disabled, and a route filter aborts every request that is not a data: URI, so the page
       * cannot fetch, execute, or reach the network at all. Input is HTML this codebase builds
       * and escapes. Granting the capability back would be the stronger posture; it is a
       * deployment decision, noted in docs/pdf-export.md.
       */
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    })
    .catch((err) => {
      browserPromise = null; // allow a later request to retry
      throw new AppError(
        503,
        'PDF_ENGINE_UNAVAILABLE',
        'موتور تولید PDF در دسترس نیست. راهنمای راه‌اندازی: docs/pdf-export.md',
        { cause: err instanceof Error ? err.message : String(err) },
      );
    });
  return browserPromise;
}

let fontCache: { regular: string; bold: string } | null = null;

/** Base64 the bundled Vazirmatn faces so a PDF renders identically on a host with no Persian fonts. */
async function fonts(): Promise<{ regular: string; bold: string }> {
  if (fontCache) return fontCache;
  const dir = path.join(here, 'assets');
  const [regular, bold] = await Promise.all([
    readFile(path.join(dir, 'Vazirmatn-Regular.woff2')),
    readFile(path.join(dir, 'Vazirmatn-Bold.woff2')),
  ]);
  fontCache = { regular: regular.toString('base64'), bold: bold.toString('base64') };
  return fontCache;
}

export interface RenderOptions {
  /** Right-hand header line, typically the document code. */
  headerRight?: string;
  landscape?: boolean;
  footerNote?: string;
}

/**
 * Chromium renders are CPU-bound, so concurrency buys queueing rather than throughput: measured
 * at 400 projects, request rate is flat from five simultaneous renders upward while latency
 * climbs linearly and process RSS more than doubles. Unbounded, a burst of executive-report
 * exports — landscape, multi-page, the most expensive document in the system — will exhaust
 * container memory. This admits PDF_MAX_CONCURRENCY at a time and queues a bounded number
 * behind them; beyond that a caller is turned away immediately rather than joining a queue that
 * cannot drain before their client gives up.
 */
let activeRenders = 0;
const renderQueue: (() => void)[] = [];

async function acquireRenderSlot(): Promise<void> {
  if (activeRenders < env.PDF_MAX_CONCURRENCY) {
    activeRenders++;
    return;
  }
  if (renderQueue.length >= env.PDF_MAX_CONCURRENCY * env.PDF_QUEUE_FACTOR) {
    throw new AppError(
      503,
      'PDF_ENGINE_BUSY',
      'تولید PDF در حال حاضر پرترافیک است. لطفاً چند لحظه بعد دوباره تلاش کنید.',
    );
  }
  await new Promise<void>((resolve) => renderQueue.push(resolve));
  activeRenders++;
}

function releaseRenderSlot(): void {
  activeRenders--;
  renderQueue.shift()?.();
}

/**
 * Render a document body to a PDF buffer.
 *
 * The page is rendered with networking disabled: every asset is inlined, so a value that
 * contained markup could never trigger an outbound request from the render host.
 */
export async function renderPdf(bodyHtml: string, opts: RenderOptions = {}): Promise<Buffer> {
  await acquireRenderSlot();
  try {
    return await renderPdfUnthrottled(bodyHtml, opts);
  } finally {
    releaseRenderSlot();
  }
}

async function renderPdfUnthrottled(bodyHtml: string, opts: RenderOptions = {}): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'fa-IR',
    timezoneId: 'Asia/Tehran',
    offline: true,
    javaScriptEnabled: false,
  });

  try {
    const page = await context.newPage();
    await page.route('**/*', (route) =>
      route.request().url().startsWith('data:') ? route.continue() : route.abort(),
    );

    const { regular, bold } = await fonts();
    await page.setContent(shell(bodyHtml, regular, bold), { waitUntil: 'load', timeout: 15_000 });

    return await page.pdf({
      format: 'A4',
      landscape: opts.landscape ?? false,
      printBackground: true,
      margin: { top: '22mm', bottom: '20mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(opts.headerRight ?? ''),
      footerTemplate: footerTemplate(opts.footerNote ?? ''),
    });
  } finally {
    await context.close().catch(() => undefined);
  }
}

const headerTemplate = (right: string) => `
<div style="font-family:-apple-system,sans-serif;font-size:7pt;color:#94a3b8;width:100%;
            padding:0 14mm;display:flex;justify-content:space-between;direction:rtl;">
  <span>هیوامیس — سامانه عملیات سازمانی</span><span>${esc(right)}</span>
</div>`;

/** The mark, small, in the running footer: Chrome draws header and footer apart from the page. */
const FOOT_MARK = hivaSvg('mark', { color: '#94a3b8', height: 10 });

const footerTemplate = (note: string) => `
<div style="font-family:-apple-system,sans-serif;font-size:7pt;color:#94a3b8;width:100%;
            padding:0 14mm;display:flex;justify-content:space-between;align-items:center;direction:rtl;">
  <span style="display:flex;align-items:center;gap:4px;">${FOOT_MARK}${esc(note)}</span>
  <span>صفحه <span class="pageNumber"></span> از <span class="totalPages"></span></span>
</div>`;

/** Document chrome: embedded fonts, RTL root, and the print stylesheet shared by every template. */
function shell(body: string, regular: string, bold: string): string {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<style>
@font-face{font-family:Vazirmatn;font-weight:400;font-style:normal;font-display:block;
  src:url(data:font/woff2;base64,${regular}) format('woff2');}
@font-face{font-family:Vazirmatn;font-weight:700;font-style:normal;font-display:block;
  src:url(data:font/woff2;base64,${bold}) format('woff2');}
*{box-sizing:border-box;}
body{font-family:Vazirmatn,sans-serif;font-size:9.5pt;line-height:1.75;color:#0f172a;margin:0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;}
h1{font-size:15pt;margin:0 0 2mm;font-weight:700;}
h2{font-size:11pt;margin:7mm 0 2.5mm;padding-bottom:1.5mm;border-bottom:1.5px solid #e2e8f0;
  font-weight:700;color:#1e293b;page-break-after:avoid;}
h3{font-size:9.5pt;margin:4mm 0 1.5mm;font-weight:700;color:#334155;page-break-after:avoid;}
p{margin:0 0 2mm;}
.doc-head{border-bottom:2.5px solid #0f172a;padding-bottom:4mm;margin-bottom:5mm;
  display:flex;justify-content:space-between;align-items:flex-start;gap:8mm;}
.brand{font-size:8pt;color:#64748b;letter-spacing:.4px;display:flex;align-items:center;gap:3mm;margin-bottom:2mm;}
.brand .logo svg{height:12mm;width:auto;display:block;}
.code{font-family:ui-monospace,monospace;font-size:9pt;color:#475569;direction:ltr;text-align:left;}
.chip{display:inline-block;padding:.6mm 2.4mm;border-radius:2.5mm;font-size:7.5pt;
  background:#f1f5f9;color:#334155;border:.4px solid #cbd5e1;}
.chip-ok{background:#dcfce7;color:#166534;border-color:#86efac;}
.chip-warn{background:#fef3c7;color:#92400e;border-color:#fcd34d;}
.chip-bad{background:#fee2e2;color:#991b1b;border-color:#fca5a5;}
table{width:100%;border-collapse:collapse;margin:2mm 0 4mm;font-size:8.5pt;page-break-inside:auto;}
th,td{border:.4px solid #cbd5e1;padding:1.6mm 2.2mm;text-align:right;vertical-align:top;}
th{background:#f8fafc;font-weight:700;color:#334155;}
tr{page-break-inside:avoid;}
.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:2.5mm 5mm;margin:3mm 0 5mm;
  background:#f8fafc;border:.4px solid #e2e8f0;border-radius:2mm;padding:3.5mm 4mm;}
.meta div{font-size:8.5pt;}
.meta .k{color:#64748b;font-size:7.5pt;display:block;margin-bottom:.4mm;}
.meta .v{font-weight:700;color:#0f172a;}
.field{margin-bottom:3mm;page-break-inside:avoid;}
.field .k{color:#64748b;font-size:7.5pt;display:block;margin-bottom:.6mm;}
.field .v{white-space:pre-wrap;}
.redacted{color:#94a3b8;font-style:italic;font-size:8pt;}
.num{font-variant-numeric:tabular-nums;direction:ltr;display:inline-block;}
.muted{color:#64748b;}
.rule{background:#fffbeb;border:.4px solid #fcd34d;border-right:2.5px solid #f59e0b;
  padding:2.5mm 3mm;border-radius:1.5mm;margin:3mm 0;font-size:8pt;color:#78350f;}
.sig{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm;margin-top:10mm;page-break-inside:avoid;}
.sig div{border-top:.6px solid #94a3b8;padding-top:2mm;font-size:8pt;color:#475569;min-height:16mm;}
.empty{color:#94a3b8;font-style:italic;}
</style></head><body>${body}</body></html>`;
}

export async function shutdownPdfEngine(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  if (p) await p.then((b) => b.close()).catch(() => undefined);
}

/** True when a browser can actually be launched — surfaced on the health endpoint. */
/**
 * Cached for a minute, mirroring the SLA calendar cache: launching Chromium is expensive and a
 * readiness probe runs on a short interval, so an uncached check would start a browser every time.
 */
let healthCache: { at: number; ok: boolean } | null = null;
const HEALTH_TTL_MS = 60_000;

export async function pdfEngineHealthyCached(): Promise<boolean> {
  if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.ok;
  const ok = await pdfEngineHealthy().catch(() => false);
  healthCache = { at: Date.now(), ok };
  return ok;
}

export async function pdfEngineHealthy(): Promise<boolean> {
  try {
    await getBrowser();
    return true;
  } catch {
    return false;
  }
}
