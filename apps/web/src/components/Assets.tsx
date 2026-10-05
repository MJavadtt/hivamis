import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { COLOR_SPACE_LABELS } from '@hiva/contracts';
import { apiBlob, apiGet, apiUpload, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Modal, Select, useToast } from './ui';
import { formatDateTime, localDigits } from '../lib/format';
import { tr, trx } from '../i18n';

/*
 * Roadmap #42 — a file's versions and what each one says about itself. A new version takes the
 * old one's place and the old one is kept; previews are drawn here from the file itself.
 */

export interface FileMeta {
  width?: number; height?: number; colorSpace?: string; bitDepth?: number;
  durationSec?: number; pageCount?: number; pageSizeMm?: { w: number; h: number }; fontFamily?: string;
}
export interface VersionRow {
  id: string; fileName: string; mimeType: string; sizeBytes: number; checksum: string | null; version: number;
  metadata: FileMeta | null; createdAt: string; current: boolean; clientVisible: boolean;
  uploadedBy: { fullName: string } | null; annotations: number;
}

const PAPERS: [string, number, number][] = [['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['Letter', 216, 279]];
export function paperName(mm: { w: number; h: number }) {
  const [short, long] = mm.w <= mm.h ? [mm.w, mm.h] : [mm.h, mm.w];
  const paper = PAPERS.find(([, w, h]) => Math.abs(w - short) <= 2 && Math.abs(h - long) <= 2)?.[0];
  const size = paper ?? tr('{0}×{1} میلی‌متر', localDigits(mm.w), localDigits(mm.h));
  return mm.w > mm.h ? tr('{0} افقی', size) : size;
}
export const durationFa = (sec: number) => {
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return localDigits(h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`);
};
export const sizeFa = (bytes: number) =>
  bytes < 1024 * 1024 ? `${localDigits(Math.max(1, Math.ceil(bytes / 1024)))} KB` : `${localDigits((bytes / 1024 / 1024).toFixed(1))} MB`;

/** One line for a file's facts, as a designer would say them. */
export function metadataFa(m: FileMeta | null | undefined): string {
  if (!m) return '';
  const parts: string[] = [];
  if (m.width && m.height) parts.push(tr('{0}×{1} پیکسل', localDigits(m.width), localDigits(m.height)));
  if (m.colorSpace) parts.push(trx(COLOR_SPACE_LABELS[m.colorSpace] ?? m.colorSpace));
  if (m.durationSec != null) parts.push(tr('مدت {0}', durationFa(m.durationSec)));
  if (m.pageCount) parts.push(tr('{0} صفحه', localDigits(m.pageCount)));
  if (m.pageSizeMm) parts.push(paperName(m.pageSizeMm));
  if (m.fontFamily) parts.push(tr('خانوادهٔ {0}', m.fontFamily));
  return parts.join(' · ');
}

/** The facts two versions are compared on, in order. */
export function factRows(v: Pick<VersionRow, 'mimeType' | 'sizeBytes' | 'metadata'>): [string, string][] {
  const m = v.metadata ?? {};
  return [
    [tr('ابعاد'), m.width && m.height ? `${localDigits(m.width)}×${localDigits(m.height)}` : '—'],
    [tr('فضای رنگ'), m.colorSpace ? COLOR_SPACE_LABELS[m.colorSpace] ?? m.colorSpace : '—'],
    [tr('مدت'), m.durationSec != null ? durationFa(m.durationSec) : '—'],
    [tr('صفحه‌ها'), m.pageCount ? localDigits(m.pageCount) : '—'],
    [tr('اندازهٔ صفحه'), m.pageSizeMm ? paperName(m.pageSizeMm) : '—'],
    [tr('خانوادهٔ فونت'), m.fontFamily ?? '—'],
    [tr('نوع فایل'), v.mimeType],
    [tr('حجم'), sizeFa(v.sizeBytes)],
  ];
}

export const VersionBadge = ({ version, current = true }: { version: number; current?: boolean }) =>
  version > 1 || !current ? <Badge tone={current ? 'info' : 'neutral'}>{current ? tr('نسخهٔ {0}', localDigits(version)) : tr('نسخهٔ قدیمی {0}', localDigits(version))}</Badge> : null;

/**
 * A file's bytes behind the session, as an object URL that is released when no longer shown.
 * Read through `/preview`, which records a view rather than a download.
 */
export function useFileUrl(documentId: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!documentId) return;
    let alive = true, made: string | null = null;
    void apiBlob(`/documents/${documentId}/preview`).then((b) => { if (alive) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => setUrl(null));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); setUrl(null); };
  }, [documentId]);
  return url;
}

/** pdf.js, loaded only when a PDF is shown. */
export async function openPdf(url: string) {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  return pdfjs.getDocument({ data: new Uint8Array(await (await fetch(url)).arrayBuffer()) }).promise;
}

const FONT_TYPES = ['font/ttf', 'font/otf', 'font/woff', 'font/woff2'];
export const SAMPLE_TEXT = tr('نمونهٔ متن برند — ابجد هوز ۱۲۳۴ Hiva');

/** A typeface from its own file, registered under a private name for this page only. */
function useFontFace(url: string | null, id: string) {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    if (!url || typeof FontFace === 'undefined') return;
    let alive = true, face: FontFace | null = null;
    void (async () => {
      try {
        const name = `hiva-asset-${id}`;
        face = new FontFace(name, await (await fetch(url)).arrayBuffer());
        await face.load();
        document.fonts.add(face);
        if (alive) setFamily(name);
      } catch { if (alive) setFamily(null); }
    })();
    return () => { alive = false; if (face) document.fonts.delete(face); };
  }, [url, id]);
  return family;
}

/** A look at the file itself: the image, the video, a PDF's first page, a font set in itself. */
export function FilePreview({ documentId, mimeType, size = 'sm' }: { documentId: string; mimeType: string; size?: 'sm' | 'lg' }) {
  const previewable = mimeType.startsWith('image/') || mimeType === 'video/mp4' || mimeType === 'application/pdf' || FONT_TYPES.includes(mimeType);
  const url = useFileUrl(previewable ? documentId : null);
  const box = size === 'lg' ? 'max-h-[22rem]' : 'max-h-28';
  if (!previewable) return <div className="grid h-16 w-20 place-items-center rounded bg-ink-100 text-[12px] text-ink-500" data-testid="preview-none">{mimeType.split('/')[1]?.slice(0, 8).toUpperCase()}</div>;
  if (!url) return <div className={`animate-pulse rounded bg-ink-100 ${size === 'lg' ? 'h-64 w-full' : 'h-16 w-20'}`} />;
  if (mimeType.startsWith('image/')) return <img src={url} alt="" className={`block ${box} max-w-full rounded bg-[repeating-conic-gradient(#e5e7eb_0_25%,#fff_0_50%)] bg-[length:12px_12px] object-contain`} data-testid="preview-image" />;
  if (mimeType === 'video/mp4') return <video src={url} controls={size === 'lg'} muted className={`block ${box} max-w-full rounded bg-black`} data-testid="preview-video" />;
  if (mimeType === 'application/pdf') return <PdfFirstPage url={url} width={size === 'lg' ? 360 : 80} />;
  return <FontSample url={url} id={documentId} large={size === 'lg'} />;
}

function PdfFirstPage({ url, width }: { url: string; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true, task: { cancel: () => void } | null = null;
    void (async () => {
      try {
        const page = await (await openPdf(url)).getPage(1);
        if (!alive || !canvas.current) return;
        const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
        canvas.current.width = viewport.width; canvas.current.height = viewport.height;
        task = page.render({ canvas: canvas.current, canvasContext: canvas.current.getContext('2d')!, viewport });
      } catch { if (alive) setFailed(true); }
    })();
    return () => { alive = false; task?.cancel(); };
  }, [url, width]);
  if (failed) return <div className="grid h-16 w-20 place-items-center rounded bg-ink-100 text-[12px] text-ink-500">PDF</div>;
  return <canvas ref={canvas} className="block max-w-full rounded bg-white shadow-sm ring-1 ring-ink-200" data-testid="preview-pdf" />;
}

function FontSample({ url, id, large }: { url: string; id: string; large: boolean }) {
  const family = useFontFace(url, id);
  return (
    <p style={family ? { fontFamily: `'${family}'` } : undefined} data-testid="preview-font"
      className={`rounded bg-ink-50 px-2 py-1 leading-relaxed text-ink-900 ${large ? 'text-2xl' : 'max-w-[11rem] truncate text-sm'} ${family ? '' : 'text-ink-400'}`}>
      {SAMPLE_TEXT}
    </p>
  );
}

/** Upload a new version of a file: it takes the file's place, and the old one is kept. */
export function NewVersionButton({ documentId, onDone, label = tr('نسخهٔ جدید') }: { documentId: string; onDone?: () => void | Promise<unknown>; label?: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!can('document.write')) return null;
  const send = async (file: File) => {
    const form = new FormData();
    form.append('replacesId', documentId);
    form.append('file', file);
    setBusy(true);
    try {
      const d = await apiUpload<{ version: number }>('/documents', form);
      toast(tr('نسخهٔ {0} جای نسخهٔ پیشین را گرفت؛ نسخهٔ پیشین نگه داشته شد.', localDigits(d.version)));
      await onDone?.();
    } catch (e: any) { toast(e?.message ?? tr('بارگذاری ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <>
      <input ref={input} type="file" className="hidden" data-testid={`new-version-input-${documentId}`} onChange={(e) => { const f = e.target.files?.[0]; if (f) void send(f); e.target.value = ''; }} />
      <Button size="sm" variant="ghost" loading={busy} onClick={() => input.current?.click()}>{label}</Button>
    </>
  );
}

/** Every version of a file, and any two of them side by side. */
export function VersionsModal({ documentId, onClose, onChanged }: { documentId: string; onClose: () => void; onChanged?: () => void | Promise<unknown> }) {
  const qc = useQueryClient();
  const key = [`/documents/${documentId}/versions`];
  const { data } = useQuery<VersionRow[]>({ queryKey: key, queryFn: () => apiGet(key[0]!) });
  const [picked, setPicked] = useState<{ from?: string; to?: string }>({});
  const [overlay, setOverlay] = useState(false);
  const [opacity, setOpacity] = useState(50);
  if (!data) return null;
  const current = data.find((v) => v.current);
  const from = data.find((v) => v.id === picked.from) ?? data[data.length - 2];
  const to = data.find((v) => v.id === picked.to) ?? data[data.length - 1];
  const both = from && to && from.id !== to.id ? [from, to] as const : null;
  const refresh = async () => { await qc.invalidateQueries({ queryKey: key }); await onChanged?.(); };
  const label = (v: VersionRow) => tr('نسخهٔ {0}{1}', localDigits(v.version), v.current ? tr(' (فعلی)') : '');
  const images = both && both.every((v) => v.mimeType.startsWith('image/'));
  return (
    <Modal open wide title={tr('نسخه‌های «{0}»', current?.fileName ?? data[data.length - 1]?.fileName ?? '')} onClose={onClose}
      footer={<>{current && <NewVersionButton documentId={current.id} onDone={refresh} label={tr('بارگذاری نسخهٔ جدید')} />}<Button variant="ghost" onClick={onClose}>{tr('بستن')}</Button></>}>
      <div className="space-y-4" data-testid="versions">
        <ol className="divide-y divide-ink-100 rounded-lg border border-ink-200 text-sm">
          {[...data].reverse().map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="version-row">
              <FilePreview documentId={v.id} mimeType={v.mimeType} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{label(v)}</span>
                  <span className="truncate text-ink-600">{v.fileName}</span>
                  {v.clientVisible && <Badge tone="info">{tr('در پورتال')}</Badge>}
                  {v.annotations > 0 && <Badge tone="warning">{tr('{0} یادداشت', localDigits(v.annotations))}</Badge>}
                </p>
                <p className="text-[12.5px] text-ink-500">{[metadataFa(v.metadata), sizeFa(v.sizeBytes)].filter(Boolean).join(' · ')}</p>
                <p className="text-[12.5px] text-ink-400">{v.uploadedBy?.fullName ?? '—'} · {formatDateTime(v.createdAt)}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void downloadFile(`/documents/${v.id}/download`, v.fileName)}>{tr('دریافت')}</Button>
            </li>
          ))}
        </ol>

        {data.length < 2 ? <p className="text-xs text-ink-500">{tr('این فایل هنوز یک نسخه دارد؛ با «بارگذاری نسخهٔ جدید» نسخهٔ بعدی جای آن را می‌گیرد و این نسخه نگه داشته می‌شود.')}</p> : (
          <section className="space-y-3" data-testid="compare">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{tr('مقایسهٔ')}</span>
              <Select aria-label={tr('نسخهٔ نخست')} value={from?.id} onChange={(e) => setPicked({ ...picked, from: e.target.value })} className="w-auto">
                {data.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
              </Select>
              <span>{tr('با')}</span>
              <Select aria-label={tr('نسخهٔ دوم')} value={to?.id} onChange={(e) => setPicked({ ...picked, to: e.target.value })} className="w-auto">
                {data.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
              </Select>
              {images && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />{' '}{tr('روی هم')}</label>}
            </div>
            {!both ? <p className="text-xs text-ink-500">{tr('دو نسخهٔ متفاوت را برگزینید.')}</p> : (
              <>
                {both[0].checksum && both[0].checksum === both[1].checksum && <p className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800">{tr('این دو نسخه بایت‌به‌بایت یکسان‌اند.')}</p>}
                {overlay && images ? (
                  <div className="space-y-2">
                    <div className="relative inline-block" data-testid="overlay">
                      <FilePreview documentId={both[0].id} mimeType={both[0].mimeType} size="lg" />
                      <div className="absolute inset-0" style={{ opacity: opacity / 100 }}><FilePreview documentId={both[1].id} mimeType={both[1].mimeType} size="lg" /></div>
                    </div>
                    <label className="flex items-center gap-2 text-xs">{label(both[0])}<input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label={tr('میزان نمایش نسخهٔ دوم')} />{label(both[1])}</label>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {both.map((v) => (
                      <figure key={v.id} className="space-y-1">
                        <figcaption className="text-xs font-medium text-ink-700">{label(v)} — {formatDateTime(v.createdAt)}</figcaption>
                        <FilePreview documentId={v.id} mimeType={v.mimeType} size="lg" />
                      </figure>
                    ))}
                  </div>
                )}
                <table className="w-full text-xs" data-testid="fact-diff">
                  <thead><tr className="text-ink-500"><th className="py-1 text-start font-normal" /><th className="py-1 text-start font-normal">{label(both[0])}</th><th className="py-1 text-start font-normal">{label(both[1])}</th></tr></thead>
                  <tbody>
                    {factRows(both[0]).map(([name, a], i) => {
                      const b = factRows(both[1])[i]![1];
                      if (a === '—' && b === '—') return null;
                      return (
                        <tr key={name} className={a !== b ? 'bg-amber-50 text-amber-900' : ''} data-changed={a !== b || undefined}>
                          <td className="px-1 py-1 text-ink-500">{name}</td><td className="px-1 py-1">{a}</td><td className="px-1 py-1">{b}{a !== b && <span className="ms-1 text-[12px]">{tr('(تغییر کرد)')}</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}

/** Entry point beside a file: its history, when it has one. */
export function VersionsButton({ documentId, version, onChanged }: { documentId: string; version: number; onChanged?: () => void | Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{version > 1 ? tr('نسخه‌ها ({0})', localDigits(version)) : tr('نسخه‌ها')}</Button>
      {open && <VersionsModal documentId={documentId} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </>
  );
}
