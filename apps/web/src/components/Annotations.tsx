import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Modal, Textarea, useToast } from './ui';
import { formatDateTime, localDigits } from '../lib/format';
import { NewVersionButton, VersionsButton, metadataFa, openPdf, useFileUrl, type FileMeta } from './Assets';
import { BrandCheckPanel } from './BrandCheck';
import { tr } from '../i18n';

/*
 * Roadmap #38 — feedback placed on the file itself: a pin on an image, a moment in a video, a region
 * of a PDF page. Positions are fractions of the shown size, so they hold at any zoom. A failing QC
 * review carries these into the revision's required correction.
 */

export interface AnnotationRow {
  id: string; documentId: string; kind: 'PIN' | 'TIMECODE' | 'HIGHLIGHT'; number: number; page: number | null;
  x: number | null; y: number | null; w: number | null; h: number | null; timeSec: number | null; note: string;
  status: 'OPEN' | 'RESOLVED'; createdAt: string; author: { id: string; fullName: string };
  qcReviewId: string | null; revision: { code: string } | null;
}
interface FileRow {
  id: string; fileName: string; mimeType: string; kind: 'image' | 'video' | 'pdf' | null; annotations: number;
  version: number; current: boolean; lineageId: string | null; metadata: FileMeta | null;
}
interface Data { deliverable: { id: string; code: string; name: string }; files: FileRow[]; annotations: AnnotationRow[] }
type Pending = { x?: number; y?: number; w?: number; h?: number; page?: number; timeSec?: number };

export const timecodeFa = (sec: number) => {
  const s = Math.floor(sec), m = Math.floor(s / 60), r = s % 60;
  return localDigits(`${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`);
};
const fractionOf = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { x: clamp((e.clientX - r.left) / (r.width || 1)), y: clamp((e.clientY - r.top) / (r.height || 1)) };
};

export const useAnnotations = (deliverableId: string) =>
  useQuery<Data>({ queryKey: [`/deliverables/${deliverableId}/annotations`], queryFn: () => apiGet(`/deliverables/${deliverableId}/annotations`) });

export function AnnotationsModal({ deliverableId, title, onClose }: { deliverableId: string; title?: string; onClose: () => void }) {
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useAnnotations(deliverableId);
  const [fileId, setFileId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [brand, setBrand] = useState(false);
  if (!data) return null;
  const files = data.files.filter((f) => f.kind);
  // One tab per file, at its current version; older versions are reached from the file (roadmap #42).
  const tabs = files.filter((f) => f.current);
  const file = files.find((f) => f.id === fileId) ?? tabs[0] ?? null;
  const lineageOf = (f: FileRow) => f.lineageId ?? f.id;
  const versions = file ? files.filter((f) => lineageOf(f) === lineageOf(file)).sort((a, b) => a.version - b.version) : [];
  const marks = data.annotations.filter((a) => a.documentId === file?.id);
  const refresh = () => qc.invalidateQueries({ queryKey: [`/deliverables/${deliverableId}/annotations`] });
  const kind = file?.kind === 'image' ? 'PIN' : file?.kind === 'video' ? 'TIMECODE' : 'HIGHLIGHT';
  const save = async () => {
    if (!file || !pending) return;
    try {
      await apiPost(`/deliverables/${deliverableId}/annotations`, { kind, documentId: file.id, ...pending, note: note.trim() });
      setPending(null); setNote(''); await refresh();
    } catch (e: any) { toast(e?.message ?? tr('ثبت یادداشت ناموفق بود.'), 'danger'); }
  };
  const setStatus = async (a: AnnotationRow, status: 'OPEN' | 'RESOLVED') => {
    try { await apiPatch(`/annotations/${a.id}`, { status }); await refresh(); } catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  const remove = async (a: AnnotationRow) => {
    try { await apiDelete(`/annotations/${a.id}`); await refresh(); } catch (e: any) { toast(e?.message ?? tr('انجام نشد.'), 'danger'); }
  };
  const mayMark = can('qc.read') && !!file?.current;
  return (
    <Modal open wide title={title ?? tr('یادداشت روی فایل‌ها — {0}', data.deliverable.name)} onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>{tr('بستن')}</Button>}>
      {!files.length ? <p className="text-sm text-ink-500">{tr('این خروجی فایل تصویر، ویدیو یا PDF ندارد.')}</p> : (
        <div className="space-y-3" data-testid="annotator">
          <div className="flex flex-wrap gap-1.5">
            {tabs.map((f) => (
              <button key={f.id} onClick={() => { setFileId(f.id); setPending(null); }}
                className={`rounded-md px-2 py-1 text-xs ${file && lineageOf(f) === lineageOf(file) ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-700'}`}>
                {f.fileName} {f.annotations > 0 && <span>({localDigits(f.annotations)})</span>}
              </button>
            ))}
          </div>
          {file && (
            <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-500" data-testid="file-versions">
              {versions.length > 1 && versions.map((v) => (
                <button key={v.id} onClick={() => { setFileId(v.id); setPending(null); }}
                  className={`rounded-full px-2 py-0.5 ${v.id === file.id ? 'bg-ink-800 text-white' : 'bg-ink-100 text-ink-700'}`}>{tr('نسخهٔ {0}{1}{2}', localDigits(v.version), v.current ? tr(' (فعلی)') : '', v.annotations > 0 ? tr(' · {0} یادداشت', localDigits(v.annotations)) : '')}</button>
              ))}
              {metadataFa(file.metadata) && <span>{metadataFa(file.metadata)}</span>}
              <VersionsButton documentId={file.id} version={versions.length} onChanged={refresh} />
              {/* The file against the client's brand library (roadmap #43). */}
              {file.kind !== 'video' && <Button size="sm" variant={brand ? 'secondary' : 'ghost'} onClick={() => setBrand(!brand)}>{tr('بررسی برند')}</Button>}
              {file.current && <NewVersionButton documentId={file.id} onDone={async () => { setFileId(null); await refresh(); }} />}
            </div>
          )}
          {file && !file.current && (
            <p className="rounded-lg bg-ink-100 px-3 py-2 text-xs text-ink-700" data-testid="old-version">{tr('این نسخهٔ قدیمی است — یادداشت‌هایش برای سنجیدن نسخهٔ تازه نشان داده می‌شوند و یادداشت تازه فقط روی نسخهٔ فعلی گذاشته می‌شود.')}</p>
          )}
          {mayMark && <p className="text-[12.5px] text-ink-500">
            {file?.kind === 'image' ? tr('روی تصویر کلیک کنید تا نشانه بگذارید.') : file?.kind === 'video' ? tr('ویدیو را در لحظهٔ مورد نظر نگه دارید و «یادداشت در این لحظه» را بزنید.') : tr('روی صفحه بکشید تا ناحیه‌ای را مشخص کنید.')}
          </p>}
          <div className="grid gap-3 lg:grid-cols-[1fr_16rem]">
            <div>
              {file?.kind === 'image' && <ImageStage documentId={file.id} marks={marks} focus={focus} pending={pending} onPick={mayMark ? setPending : undefined} />}
              {file?.kind === 'video' && <VideoStage documentId={file.id} marks={marks} onPick={mayMark ? setPending : undefined} seekTo={marks.find((m) => m.id === focus)?.timeSec ?? null} />}
              {file?.kind === 'pdf' && <PdfStage documentId={file.id} marks={marks} focus={focus} pending={pending} onPick={mayMark ? setPending : undefined} />}
              {brand && file && file.kind !== 'video' && <div className="mt-2"><BrandCheckPanel documentId={file.id} /></div>}
              {pending && (
                <div className="mt-2 space-y-2 rounded-lg bg-amber-50 p-2" data-testid="annotation-draft">
                  <p className="text-xs text-amber-900">
                    {kind === 'TIMECODE' ? tr('یادداشت در {0}', timecodeFa(pending.timeSec ?? 0)) : kind === 'HIGHLIGHT' ? tr('ناحیه در صفحهٔ {0}', localDigits(pending.page ?? 1)) : tr('نشانهٔ تازه')}
                  </p>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} aria-label={tr('متن یادداشت')} placeholder={tr('چه چیزی باید عوض شود؟')} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" disabled={!note.trim()} onClick={() => void save()}>{tr('ثبت یادداشت')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setPending(null); setNote(''); }}>{tr('انصراف')}</Button>
                  </div>
                </div>
              )}
            </div>
            <ol className="max-h-[28rem] space-y-1.5 overflow-y-auto text-xs" data-testid="annotation-list">
              {!marks.length && <li className="text-ink-400">{tr('روی این فایل یادداشتی نیست.')}</li>}
              {marks.map((a) => (
                <li key={a.id} onMouseEnter={() => setFocus(a.id)} onClick={() => setFocus(a.id)}
                  className={`cursor-pointer rounded-lg border px-2 py-1.5 ${focus === a.id ? 'border-brand-400' : 'border-ink-200'} ${a.status === 'RESOLVED' ? 'opacity-60' : ''}`}>
                  <div className="flex items-center gap-1.5">
                    <span className="grid size-5 place-items-center rounded-full bg-rose-600 text-[12px] font-semibold text-white">{localDigits(a.number)}</span>
                    <span className="text-ink-500">{a.kind === 'TIMECODE' ? timecodeFa(a.timeSec ?? 0) : a.kind === 'HIGHLIGHT' ? tr('صفحهٔ {0}', localDigits(a.page ?? 1)) : ''}</span>
                    {a.status === 'RESOLVED' ? <Badge tone="success">{tr('رفع شد')}</Badge> : a.revision ? <Badge tone="warning">{a.revision.code}</Badge> : null}
                  </div>
                  <p className="mt-1 whitespace-pre-line text-ink-800">{a.note}</p>
                  <p className="mt-0.5 text-[12px] text-ink-400">{a.author.fullName} · {formatDateTime(a.createdAt)}</p>
                  <div className="mt-1 flex gap-1">
                    {can('deliverable.write') && <Button size="sm" variant="ghost" onClick={() => void setStatus(a, a.status === 'OPEN' ? 'RESOLVED' : 'OPEN')}>{a.status === 'OPEN' ? tr('رفع شد') : tr('باز کردن دوباره')}</Button>}
                    {a.author.id === user?.id && !a.qcReviewId && <Button size="sm" variant="ghost" onClick={() => void remove(a)}>{tr('حذف')}</Button>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Pin({ a, focus }: { a: AnnotationRow; focus: boolean }) {
  return (
    <span style={{ left: `${(a.x ?? 0) * 100}%`, top: `${(a.y ?? 0) * 100}%` }} data-testid="pin"
      className={`absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[12.5px] font-semibold text-white shadow ring-2 ring-white ${a.status === 'RESOLVED' ? 'bg-emerald-600' : 'bg-rose-600'} ${focus ? 'scale-125' : ''}`}>
      {localDigits(a.number)}
    </span>
  );
}

function ImageStage({ documentId, marks, focus, pending, onPick }: { documentId: string; marks: AnnotationRow[]; focus: string | null; pending: Pending | null; onPick?: (p: Pending) => void }) {
  const url = useFileUrl(documentId);
  const box = useRef<HTMLDivElement>(null);
  const click = (e: ReactMouseEvent) => { if (onPick && box.current) onPick(fractionOf(e, box.current)); };
  return (
    <div ref={box} onClick={click} className={`relative inline-block max-w-full select-none ${onPick ? 'cursor-crosshair' : ''}`} data-testid="image-stage">
      {url ? <img src={url} alt="" className="block max-h-[28rem] max-w-full" draggable={false} /> : <div className="h-64 w-96 animate-pulse bg-ink-100" />}
      {marks.map((a) => <Pin key={a.id} a={a} focus={focus === a.id} />)}
      {pending?.x != null && <span style={{ left: `${pending.x * 100}%`, top: `${pending.y! * 100}%` }} className="absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400 ring-2 ring-white" />}
    </div>
  );
}

function VideoStage({ documentId, marks, onPick, seekTo }: { documentId: string; marks: AnnotationRow[]; onPick?: (p: Pending) => void; seekTo: number | null }) {
  const url = useFileUrl(documentId);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (seekTo != null && video.current) video.current.currentTime = seekTo; }, [seekTo]);
  return (
    <div className="space-y-2">
      {url ? <video ref={video} src={url} controls className="max-h-[26rem] w-full rounded bg-black" /> : <div className="h-64 animate-pulse bg-ink-100" />}
      <div className="flex flex-wrap items-center gap-1.5">
        {onPick && <Button size="sm" variant="secondary" onClick={() => { video.current?.pause(); onPick({ timeSec: Math.round((video.current?.currentTime ?? 0) * 10) / 10 }); }}>{tr('یادداشت در این لحظه')}</Button>}
        {marks.map((a) => (
          <button key={a.id} onClick={() => { if (video.current) video.current.currentTime = a.timeSec ?? 0; }} className="rounded bg-ink-100 px-1.5 py-0.5 text-[12.5px]">
            {localDigits(a.number)} · {timecodeFa(a.timeSec ?? 0)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A PDF page drawn by pdf.js — loaded only when a PDF is opened. */
function PdfStage({ documentId, marks, focus, pending, onPick }: { documentId: string; marks: AnnotationRow[]; focus: string | null; pending: Pending | null; onPick?: (p: Pending) => void }) {
  const url = useFileUrl(documentId);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<{ numPages: number; getPage: (n: number) => Promise<any> } | null>(null);
  const [page, setPage] = useState(1);
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void (async () => {
      try {
        const d = await openPdf(url);
        if (alive) { setDoc(d); setPage(1); }
      } catch { if (alive) setFailed(true); }
    })();
    return () => { alive = false; };
  }, [url]);
  useEffect(() => {
    if (!doc || !canvas.current) return;
    let task: { cancel: () => void } | null = null;
    void doc.getPage(page).then((p) => {
      const viewport = p.getViewport({ scale: 1.4 });
      const c = canvas.current!;
      c.width = viewport.width; c.height = viewport.height;
      task = p.render({ canvas: c, canvasContext: c.getContext('2d'), viewport });
    });
    return () => task?.cancel();
  }, [doc, page]);
  useEffect(() => { const m = marks.find((x) => x.id === focus); if (m?.page && m.page !== page) setPage(m.page); }, [focus, marks, page]);
  const down = (e: ReactMouseEvent) => { if (!onPick || !layer.current) return; const p = fractionOf(e, layer.current); setDrag({ x: p.x, y: p.y, x2: p.x, y2: p.y }); };
  const move = (e: ReactMouseEvent) => { if (!drag || !layer.current) return; const p = fractionOf(e, layer.current); setDrag({ ...drag, x2: p.x, y2: p.y }); };
  const up = () => {
    if (!drag || !onPick) return;
    const x = Math.min(drag.x, drag.x2), y = Math.min(drag.y, drag.y2), w = Math.abs(drag.x2 - drag.x), h = Math.abs(drag.y2 - drag.y);
    setDrag(null);
    if (w > 0.01 && h > 0.005) onPick({ page, x, y, w, h });
  };
  if (failed) return <p className="text-sm text-rose-700">{tr('نمایش این PDF ممکن نشد.')}</p>;
  const rect = (r: { x: number; y: number; w: number; h: number }) => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
  return (
    <div className="space-y-2" data-testid="pdf-stage">
      <div className="flex items-center gap-2 text-xs">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>{tr('صفحهٔ قبل')}</Button>
        <span>{tr('صفحهٔ {0} از {1}', localDigits(page), localDigits(doc?.numPages ?? 1))}</span>
        <Button size="sm" variant="ghost" disabled={!doc || page >= doc.numPages} onClick={() => setPage(page + 1)}>{tr('صفحهٔ بعد')}</Button>
      </div>
      <div className="relative inline-block max-w-full select-none">
        <canvas ref={canvas} className="block max-h-[34rem] max-w-full bg-white shadow" />
        <div ref={layer} onMouseDown={down} onMouseMove={move} onMouseUp={up} onMouseLeave={() => setDrag(null)} className={`absolute inset-0 ${onPick ? 'cursor-crosshair' : ''}`}>
          {marks.filter((a) => a.page === page).map((a) => (
            <div key={a.id} style={rect(a as { x: number; y: number; w: number; h: number })} className={`absolute border-2 ${a.status === 'RESOLVED' ? 'border-emerald-500 bg-emerald-400/10' : 'border-rose-500 bg-rose-400/15'} ${focus === a.id ? 'ring-2 ring-brand-400' : ''}`}>
              <span className="absolute -top-2.5 -start-2.5 grid size-5 place-items-center rounded-full bg-rose-600 text-[12px] text-white">{localDigits(a.number)}</span>
            </div>
          ))}
          {drag && <div style={rect({ x: Math.min(drag.x, drag.x2), y: Math.min(drag.y, drag.y2), w: Math.abs(drag.x2 - drag.x), h: Math.abs(drag.y2 - drag.y) })} className="absolute border-2 border-dashed border-amber-500 bg-amber-300/20" />}
          {pending?.w != null && pending.page === page && <div style={rect(pending as { x: number; y: number; w: number; h: number })} className="absolute border-2 border-amber-500 bg-amber-300/20" />}
        </div>
      </div>
    </div>
  );
}

/** A table row's entry point. */
export function AnnotateButton({ deliverable }: { deliverable: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{tr('یادداشت روی فایل')}</Button>
      {open && <AnnotationsModal deliverableId={deliverable.id} title={tr('یادداشت روی فایل‌ها — {0}', deliverable.name)} onClose={() => setOpen(false)} />}
    </>
  );
}
