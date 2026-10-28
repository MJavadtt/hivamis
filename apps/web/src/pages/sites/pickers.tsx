import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiUpload, type Page } from '../../lib/api';
import { Button, Input, Modal, Field, Select, useToast } from '../../components/ui';
import { tr } from '../../i18n';

/**
 * Choosers the venues module's forms share (ADR-103): a colleague, a venue, a client project, a client —
 * each read from the organisation's own lists — and the upload that files a document as a venue's or a
 * deployment project's evidence.
 */

interface Person { id: string; fullName: string; jobTitle: string | null }

export function PeopleSelect({ value, onChange, label, empty = tr('— هیچ‌کس —') }: { value: string | null | undefined; onChange: (id: string | null) => void; label: string; empty?: string }) {
  const { data } = useQuery<Person[]>({ queryKey: ['/people', ''], queryFn: () => apiGet('/people') });
  return (
    <Select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{empty}</option>
      {data?.map((p) => <option key={p.id} value={p.id}>{p.fullName}{p.jobTitle ? ` — ${p.jobTitle}` : ''}</option>)}
    </Select>
  );
}

/** A venue by name, code or city — searched, not scrolled through. */
export function VenueSelect({ value, onChange, initialLabel }: { value: string | null; onChange: (id: string | null, label?: string) => void; initialLabel?: string }) {
  const [q, setQ] = useState('');
  const { data } = useQuery<Page<{ id: string; code: string; name: string; city: string }>>({
    queryKey: ['/venues', 'pick', q], queryFn: () => apiGet('/venues', { q: q || undefined, pageSize: '50', sort: 'name', order: 'asc' }),
  });
  const items = data?.items ?? [];
  return (
    <div className="space-y-1">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('جستجوی مکان…')} aria-label={tr('جستجوی مکان')} />
      <Select aria-label={tr('مکان')} value={value ?? ''} onChange={(e) => { const v = items.find((x) => x.id === e.target.value); onChange(e.target.value || null, v ? `${v.name} — ${v.city}` : undefined); }}>
        <option value="">{initialLabel ?? tr('— مکان را برگزینید —')}</option>
        {value && !items.some((x) => x.id === value) && initialLabel && <option value={value}>{initialLabel}</option>}
        {items.map((v) => <option key={v.id} value={v.id}>{v.name} — {v.city} ({v.code})</option>)}
      </Select>
    </div>
  );
}

export function RecordSelect({ path, value, onChange, label, render }: { path: '/projects' | '/companies'; value: string | null | undefined; onChange: (id: string | null) => void; label: string; render: (r: any) => string }) {
  const { data } = useQuery<Page<any>>({ queryKey: [path, 'pick'], queryFn: () => apiGet(path, { pageSize: '200' }) });
  return (
    <Select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{tr('— هیچ —')}</option>
      {data?.items.map((r) => <option key={r.id} value={r.id}>{render(r)}</option>)}
    </Select>
  );
}

/** Files a document as the project's (or a venue's) evidence of one of its records. */
export function SiteUpload({ fields, label, accept, onDone, size = 'sm' }: { fields: Record<string, string>; label: string; accept?: string; onDone?: () => void; size?: 'sm' | 'md' }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      for (const file of files) {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        if (caption) form.append('caption', caption);
        form.append('file', file);
        await apiUpload('/documents', form);
      }
      toast(tr('بارگذاری شد.'));
      setOpen(false); setFiles([]); setCaption('');
      onDone?.();
    } catch (e: any) { toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'); } finally { setBusy(false); }
  };
  return (
    <>
      <Button size={size} onClick={() => setOpen(true)}>{label}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={label}
        footer={<><Button onClick={() => setOpen(false)}>{tr('انصراف')}</Button><Button variant="primary" loading={busy} disabled={!files.length} onClick={() => void send()}>{tr('بارگذاری')}</Button></>}>
        <div className="space-y-3">
          <Field label={tr('فایل')} required><Input type="file" accept={accept} multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} /></Field>
          <Field label={tr('توضیح')}><Input value={caption} onChange={(e) => setCaption(e.target.value)} /></Field>
        </div>
      </Modal>
    </>
  );
}
