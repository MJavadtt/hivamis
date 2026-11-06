import { useContext, useRef, useState } from 'react';
import { UNSAFE_LocationContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileRecordType } from '@hiva/contracts';
import { apiBlob, apiDelete, apiGet, apiUpload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { localDigits } from '../lib/format';
import { Button, Modal, useToast } from './ui';
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

async function openPreview(id: string) {
  const url = URL.createObjectURL(await apiBlob(`/documents/${id}/preview`));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function useFiles(target: FileTarget | null) {
  const { can } = useAuth();
  return useQuery<DocumentRow[]>({
    queryKey: ['/documents', target], queryFn: () => apiGet('/documents', target!), enabled: !!target && can('document.read'),
  });
}

/** Sends files to a record; says how it went. Used by the shelf and by forms that attach as they save. */
export async function uploadFiles(target: FileTarget, files: File[]): Promise<number> {
  let failed = 0;
  for (const f of files) {
    const fd = new FormData();
    // The fields before the file: the server reads fields that arrive ahead of the stream.
    for (const [k, v] of Object.entries(target)) fd.append(k, v);
    fd.append('file', f, f.name);
    try { await apiUpload('/documents', fd); } catch { failed += 1; }
  }
  return failed;
}

export function FileShelf({ target, label = tr('الصاق فایل') }: { target: FileTarget; label?: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const files = useFiles(target);
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    const failed = await uploadFiles(target, Array.from(list));
    setUploading(false);
    if (picker.current) picker.current.value = '';
    await qc.invalidateQueries({ queryKey: ['/documents'] });
    toast(failed ? tr('{0} فایل نرسید؛ دوباره بفرستید.', localDigits(failed)) : tr('فایل‌ها الصاق شد.'), failed ? 'danger' : 'success');
  };
  const remove = async (f: DocumentRow) => {
    if (!window.confirm(tr('«{0}» برداشته شود؟', f.fileName))) return;
    try { await apiDelete(`/documents/${f.id}`); await qc.invalidateQueries({ queryKey: ['/documents'] }); }
    catch (e: any) { toast(e?.message ?? tr('حذف ناموفق بود.'), 'danger'); }
  };

  const rows = Array.isArray(files.data) ? files.data : [];
  return (
    <div data-testid="file-shelf">
      {!rows.length ? <p className="text-sm text-ink-500">{tr('هنوز فایلی الصاق نشده است.')}</p> : (
        <ul className="flex flex-wrap gap-2">
          {rows.map((f) => (
            <li key={f.id} className="inline-flex items-center gap-1 rounded-full bg-ink-50 px-3 py-1 text-xs ring-1 ring-ink-200">
              <button type="button" onClick={() => void openPreview(f.id)} className="text-brand-700 hover:underline">{f.fileName}</button>
              {can('document.delete') && <button type="button" onClick={() => void remove(f)} className="text-ink-400 hover:text-rose-700" aria-label={tr('برداشتن {0}', f.fileName)}>×</button>}
            </li>
          ))}
        </ul>
      )}
      {can('document.write') && (
        <>
          <input ref={picker} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} aria-label={label} />
          <Button size="sm" variant="secondary" className="mt-2" loading={uploading} onClick={() => picker.current?.click()}>{label}</Button>
        </>
      )}
    </div>
  );
}

const Paperclip = () => (
  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="m21 11-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6L15.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The shelf of a record that is a row of another page. A row may be a link: nothing here reaches it. */
export function AttachButton({ target, title }: { target: FileTarget; title?: string }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can('document.read')) return null;
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen(true)} className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
        aria-label={tr('پیوست‌های {0}', title ?? '')} title={tr('پیوست‌ها')}><Paperclip /></button>
      {open && <Modal open onClose={() => setOpen(false)} title={title ? tr('پیوست‌های {0}', title) : tr('پیوست‌ها')}><FileShelf target={target} /></Modal>}
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
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const files = useFiles(target);
  if (!can('document.read')) return null;
  const count = Array.isArray(files.data) ? files.data.length : 0;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} data-testid="page-attachments"><Paperclip />{tr('پیوست‌ها')}{count ? ` (${localDigits(count)})` : ''}</Button>
      {open && <Modal open onClose={() => setOpen(false)} title={tr('پیوست‌ها')}><FileShelf target={target} /></Modal>}
    </>
  );
}
