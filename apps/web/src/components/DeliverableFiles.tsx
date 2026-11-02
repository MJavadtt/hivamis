import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiGet, apiUpload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { localDigits } from '../lib/format';
import { Button, useToast } from './ui';
import { tr } from '../i18n';

/** A deliverable's files, each opened through the audited preview, and new ones added beside them. */

interface DocumentRow { id: string; fileName: string; mimeType: string }

async function openPreview(id: string) {
  const url = URL.createObjectURL(await apiBlob(`/documents/${id}/preview`));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function useDeliverableFiles(deliverableId: string | null | undefined) {
  const { can } = useAuth();
  return useQuery<DocumentRow[]>({
    queryKey: ['/documents', { deliverableId }], queryFn: () => apiGet('/documents', { deliverableId: deliverableId! }), enabled: !!deliverableId && can('document.read'),
  });
}

export function DeliverableFiles({ deliverableId, label = tr('گذاشتن فایل خروجی') }: { deliverableId: string; label?: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const files = useDeliverableFiles(deliverableId);
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    let failed = 0;
    for (const f of Array.from(list)) {
      const fd = new FormData();
      // The field before the file: the server reads fields that arrive ahead of the stream.
      fd.append('deliverableId', deliverableId);
      fd.append('file', f, f.name);
      try { await apiUpload('/documents', fd); } catch { failed += 1; }
    }
    setUploading(false);
    if (picker.current) picker.current.value = '';
    await qc.invalidateQueries({ queryKey: ['/documents'] });
    toast(failed ? tr('{0} فایل نرسید؛ دوباره بفرستید.', localDigits(failed)) : tr('فایل‌ها کنار خروجی گذاشته شد.'), failed ? 'danger' : 'success');
  };

  return (
    <div data-testid="deliverable-files">
      {!files.data?.length ? <p className="text-sm text-ink-500">{tr('هنوز فایلی گذاشته نشده است.')}</p> : (
        <ul className="flex flex-wrap gap-2">
          {files.data.map((f) => (
            <li key={f.id}><button type="button" onClick={() => void openPreview(f.id)} className="rounded-full bg-ink-50 px-3 py-1 text-xs text-brand-700 ring-1 ring-ink-200 hover:underline">{f.fileName}</button></li>
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
