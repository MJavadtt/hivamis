import { useContext, useRef, useState } from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isViewableImage, type FileRecordType } from '@hiva/contracts';
import { apiBlob, apiDelete, apiGet, apiPost, apiUpload, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatRelative, localDigits } from '../lib/format';
import { Button, Modal, Textarea, useToast } from './ui';
import { tr } from '../i18n';

/**
 * Files on any record (the owner, 2026-11-06, ADR-121). One shelf — what is attached, opened through
 * the audited preview, more added beside it — shown from the header of every record's page, and from a
 * paperclip on the records that live as rows of another page.
 */

/** What a file is filed on: a column of its own (`projectId`…), or `recordType` and `recordId`. */
export type FileTarget = Record<string, string>;
export const onRecord = (recordType: FileRecordType, recordId: string): FileTarget => ({ recordType, recordId });

interface DocumentRow { id: string; fileName: string; mimeType: string }

/** A picture or a PDF a browser shows by itself; a Word file or a sheet it can only hand over. */
const opensInBrowser = (mime: string) => isViewableImage(mime) || mime === 'application/pdf';
const download = (f: DocumentRow) => downloadFile(`/documents/${f.id}/download`, f.fileName);

/**
 * Opens a file the way the app shows it — through the audited preview, never a bare link — or hands it
 * over under its own name if a browser cannot show it. The preview arrives opaque, so it gets its type
 * back here; and the tab opens first, because one opened after a wait is blocked as a popup.
 */
export async function openFile(f: DocumentRow) {
  const tab = opensInBrowser(f.mimeType) ? window.open('', '_blank') : null;
  if (!tab) return download(f);
  tab.opener = null;
  try {
    const url = URL.createObjectURL(new Blob([await apiBlob(`/documents/${f.id}/preview`)], { type: f.mimeType }));
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) { tab.close(); throw e; }
}

export function useFiles(target: FileTarget | null) {
  const { can } = useAuth();
  return useQuery<DocumentRow[]>({
    queryKey: ['/documents', target], queryFn: () => apiGet('/documents', target!), enabled: !!target && can('document.read'),
  });
}

/** Sends files to a record — or to none yet, for a form not saved (ADR-134); what arrived, and which did not and why. */
export async function sendFiles(target: FileTarget, files: File[]): Promise<{ sent: DocumentRow[]; failed: string[] }> {
  const failed: string[] = [];
  const sent: DocumentRow[] = [];
  for (const f of files) {
    const fd = new FormData();
    // The fields before the file: the server reads fields that arrive ahead of the stream.
    for (const [k, v] of Object.entries(target)) fd.append(k, v);
    fd.append('file', f, f.name);
    try { sent.push(await apiUpload<DocumentRow>('/documents', fd)); } catch (e: any) { failed.push(`«${f.name}»: ${e?.message ?? tr('بارگذاری ناموفق بود.')}`); }
  }
  return { sent, failed };
}

/** Sends files to a record; says which did not arrive, and why. Used by the shelf and by forms that attach as they save. */
export async function uploadFiles(target: FileTarget, files: File[]): Promise<string[]> {
  return (await sendFiles(target, files)).failed;
}

interface Note { id: string; body: string; createdAt: string; author: { id: string; fullName: string }; documents: DocumentRow[]; mayDelete: boolean }

/** A record's notes (ADR-134): every colleague who sees the record reads and writes them. */
export function useNotes(target: FileTarget | null) {
  return useQuery<Note[]>({ queryKey: ['/notes', target], queryFn: () => apiGet('/notes', target!), enabled: !!target, retry: false });
}

const Paperclip = () => (
  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="m21 11-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6L15.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const DownloadArrow = () => (
  <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Notes and files on a record, together (the owner, 2026-11-17; ADR-134): «در هر قسمت که الصاق فایل داریم،
 * امکان ثبت یادداشت هم می‌خواهم، می‌تواند به جای فایل پیوست یا همراه با آن قرار بگیرد». A few words,
 * files, or both, in one box; the record's notes newest first, each with what came with it; then the
 * files that came on their own.
 */
export function FileShelf({ target, label = tr('الصاق فایل'), notes = true }: { target: FileTarget; label?: string; notes?: boolean }) {
  return (
    <div className="space-y-4">
      {notes && <NoteBox target={target} />}
      <FilesOnly target={target} label={label} hideIds={notes} />
    </div>
  );
}

function NoteBox({ target }: { target: FileTarget }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useNotes(target);
  const picker = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState('');
  const [picked, setPicked] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const { sent, failed } = picked.length ? await sendFiles(target, picked) : { sent: [], failed: [] };
      if (failed.length) toast(failed.join(' '), 'danger');
      if (!body.trim() && !sent.length) return;
      await apiPost('/notes', { ...target, body: body.trim(), documentIds: sent.map((d) => d.id) });
      setBody(''); setPicked([]);
      if (picker.current) picker.current.value = '';
      await Promise.all([qc.invalidateQueries({ queryKey: ['/notes'] }), qc.invalidateQueries({ queryKey: ['/documents'] })]);
      toast(tr('یادداشت ثبت شد.'), 'success');
    } catch (e: any) { toast(e?.message ?? tr('ثبت یادداشت ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  const remove = async (n: Note) => {
    if (!window.confirm(tr('این یادداشت برداشته شود؟ فایل‌هایش روی رکورد می‌مانند.'))) return;
    try { await apiDelete(`/notes/${n.id}`); await qc.invalidateQueries({ queryKey: ['/notes'] }); }
    catch (e: any) { toast(e?.message ?? tr('حذف ناموفق بود.'), 'danger'); }
  };
  const reach = (f: DocumentRow) => void openFile(f).catch((e) => toast(e?.message ?? tr('دریافت ناموفق بود.'), 'danger'));
  const notes = Array.isArray(list.data) ? list.data : [];
  return (
    <section aria-label={tr('یادداشت‌ها')} data-testid="notes">
      <div className="rounded-lg bg-ink-50/60 p-2.5 ring-1 ring-ink-200">
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder={tr('یادداشتی بنویسید — یا فقط فایلی همراه کنید…')} aria-label={tr('یادداشت')} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {can('document.write') && (
            <>
              <input ref={picker} type="file" multiple className="hidden" onChange={(e) => setPicked(Array.from(e.target.files ?? []))} aria-label={tr('فایل همراه یادداشت')} />
              <Button size="sm" variant="ghost" onClick={() => picker.current?.click()}><Paperclip />{picked.length ? tr('{0} فایل', localDigits(picked.length)) : tr('همراه کردن فایل')}</Button>
            </>
          )}
          <Button size="sm" variant="primary" className="ms-auto" loading={busy} disabled={!body.trim() && !picked.length} onClick={() => void save()} data-testid="note-save">{tr('ثبت یادداشت')}</Button>
        </div>
        {picked.length > 0 && <p className="mt-1 text-xs text-ink-500">{picked.map((f) => f.name).join('، ')}</p>}
      </div>
      {notes.length > 0 && (
        <ul className="mt-3 space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg bg-surface px-3 py-2 text-[13.5px] ring-1 ring-ink-200" data-testid="note">
              <p className="mb-0.5 flex items-center gap-2 text-xs text-ink-500">
                <span className="font-semibold text-ink-700">{n.author.fullName}</span>
                <span>{formatRelative(n.createdAt)}</span>
                {n.mayDelete && <button type="button" onClick={() => void remove(n)} className="ms-auto text-ink-400 hover:text-rose-700" aria-label={tr('برداشتن یادداشت')}>×</button>}
              </p>
              {n.body && <p className="whitespace-pre-wrap text-ink-800">{n.body}</p>}
              {n.documents.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {n.documents.map((f) => <button key={f.id} type="button" onClick={() => reach(f)} className="inline-flex items-center gap-1 rounded-full bg-ink-50 px-2.5 py-0.5 text-xs text-brand-700 ring-1 ring-ink-200 hover:underline"><Paperclip />{f.fileName}</button>)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FilesOnly({ target, label, hideIds }: { target: FileTarget; label: string; hideIds: boolean }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const files = useFiles(target);
  const notes = useNotes(hideIds ? target : null);
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    const failed = await uploadFiles(target, Array.from(list));
    setUploading(false);
    if (picker.current) picker.current.value = '';
    await qc.invalidateQueries({ queryKey: ['/documents'] });
    toast(failed.length ? failed.join(' ') : tr('فایل‌ها الصاق شد.'), failed.length ? 'danger' : 'success');
  };
  const reach = (how: (f: DocumentRow) => Promise<void>, f: DocumentRow) => void how(f).catch((e) => toast(e?.message ?? tr('دریافت ناموفق بود.'), 'danger'));
  const remove = async (f: DocumentRow) => {
    if (!window.confirm(tr('«{0}» برداشته شود؟', f.fileName))) return;
    try { await apiDelete(`/documents/${f.id}`); await qc.invalidateQueries({ queryKey: ['/documents'] }); }
    catch (e: any) { toast(e?.message ?? tr('حذف ناموفق بود.'), 'danger'); }
  };

  // A file that came with a note is shown with it.
  const withNotes = new Set((Array.isArray(notes.data) ? notes.data : []).flatMap((n) => n.documents.map((d) => d.id)));
  const rows = (Array.isArray(files.data) ? files.data : []).filter((f) => !withNotes.has(f.id));
  return (
    <div data-testid="file-shelf">
      {hideIds && <p className="mb-1 text-xs font-bold text-ink-600">{tr('فایل‌ها')}</p>}
      {!rows.length ? <p className="text-sm text-ink-500">{tr('هنوز فایلی الصاق نشده است.')}</p> : (
        <ul className="flex flex-wrap gap-2">
          {rows.map((f) => (
            <li key={f.id} className="inline-flex items-center gap-1 rounded-full bg-ink-50 px-3 py-1 text-xs ring-1 ring-ink-200">
              <button type="button" onClick={() => reach(openFile, f)} className="text-brand-700 hover:underline">{f.fileName}</button>
              {opensInBrowser(f.mimeType) && <button type="button" onClick={() => reach(download, f)} className="text-ink-400 hover:text-brand-700" aria-label={tr('دریافت {0}', f.fileName)} title={tr('دریافت')}><DownloadArrow /></button>}
              {can('document.delete') && <button type="button" onClick={() => void remove(f)} className="text-ink-400 hover:text-rose-700" aria-label={tr('برداشتن {0}', f.fileName)}>×</button>}
            </li>
          ))}
        </ul>
      )}
      {can('document.write') && (
        <>
          <input ref={picker} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} aria-label={label} />
          <Button size="sm" variant="secondary" className="mt-2" loading={uploading} onClick={() => picker.current?.click()}>{label}</Button>
          <p className="mt-1 text-xs text-ink-500">{tr('PDF، عکس، Word، Excel، PowerPoint، فایل طراحی، ویدیو، صدا و فایل فشرده.')}</p>
        </>
      )}
    </div>
  );
}


/** The shelf of a record that is a row of another page. A row may be a link: nothing here reaches it. */
export function AttachButton({ target, title }: { target: FileTarget; title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen(true)} className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
        aria-label={tr('یادداشت و پیوست {0}', title ?? '')} title={tr('یادداشت و پیوست')}><Paperclip /></button>
      {open && <Modal open onClose={() => setOpen(false)} title={title ? tr('یادداشت و پیوست — {0}', title) : tr('یادداشت و پیوست')}><FileShelf target={target} /></Modal>}
    </span>
  );
}

const record = (type: FileRecordType) => (id: string) => onRecord(type, id);
const column = (name: string) => (id: string): FileTarget => ({ [name]: id });

/** Every page that is one record, and what its files are filed on. */
const RECORD_PAGES: [RegExp, (id: string) => FileTarget][] = [
  [/^\/opportunities\/([^/]+)$/, record('opportunity')],
  [/^\/companies\/([^/]+)$/, column('companyId')],
  [/^\/sales\/journey\/([^/]+)$/, column('companyId')],
  [/^\/briefs\/([^/]+)$/, record('brief')],
  [/^\/account\/journey\/([^/]+)$/, record('brief')],
  [/^\/proposals\/([^/]+)$/, column('proposalId')],
  [/^\/projects\/([^/]+)(?:\/ooh)?$/, column('projectId')],
  [/^\/work-orders\/([^/]+)$/, record('workOrder')],
  [/^\/tasks\/([^/]+)$/, record('task')],
  [/^\/changes\/([^/]+)$/, record('changeRequest')],
  [/^\/suppliers\/([^/]+)$/, record('supplier')],
  [/^\/contracts\/([^/]+)$/, column('contractId')],
  [/^\/bookings\/(?!admin$)([^/]+)$/, record('booking')],
  // A venue and a deployment project (ADR-134): their notes, beside the files their own pages keep.
  [/^\/sites\/venues\/([^/]+)$/, column('venueId')],
  [/^\/sites\/projects\/([^/]+)$/, column('siteProjectId')],
];

export function targetOfPage(pathname: string | undefined): FileTarget | null {
  for (const [path, target] of pathname ? RECORD_PAGES : []) {
    const hit = path.exec(pathname!);
    if (hit) return target(hit[1]!);
  }
  return null;
}

/** The page's own record, if it is one; a page outside a router has none. */
export function usePageTarget(): FileTarget | null {
  return targetOfPage(useContext(UNSAFE_LocationContext)?.location?.pathname);
}

/** «پیوست‌ها» in a record page's header, with how many there are. */
export function PageAttachments({ target }: { target: FileTarget }) {
  const [open, setOpen] = useState(false);
  const files = useFiles(target);
  const notes = useNotes(target);
  const count = (Array.isArray(files.data) ? files.data.length : 0) + (Array.isArray(notes.data) ? notes.data.length : 0);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} data-testid="page-attachments"><Paperclip />{tr('یادداشت و پیوست')}{count ? ` (${localDigits(count)})` : ''}</Button>
      {open && <Modal open onClose={() => setOpen(false)} title={tr('یادداشت‌ها و پیوست‌ها')}><FileShelf target={target} /></Modal>}
    </>
  );
}
