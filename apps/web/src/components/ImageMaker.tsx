import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { tr } from '../i18n';
import { Button, Field, Modal, Select, Textarea, useToast } from './ui';

/**
 * A picture from a description, drawn inside the installation and filed with the project's files
 * (audit F-2). Shown only to someone with `ai.image` and `document.write`, and only where an image
 * server is set up — off by default, since it needs the hardware.
 */
export function ImageMaker({ projectId, companyId, onDone }: { projectId?: string; companyId?: string; onDone: () => void | Promise<unknown> }) {
  const { can } = useAuth();
  const allowed = can('ai.image', 'document.write');
  const { data: status } = useQuery<{ mode: string; ready: boolean }>({
    queryKey: ['/ai/image/status'], queryFn: () => apiGet('/ai/image/status'), enabled: allowed, staleTime: 60_000, retry: false,
  });
  const [open, setOpen] = useState(false);
  if (!allowed || !status || status.mode === 'off') return null;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} disabled={!status.ready}
        title={status.ready ? undefined : tr('سرور تصویر آماده نیست؛ به مدیر سیستم خبر دهید.')} data-testid="image-maker">
        {tr('ساخت تصویر')}
      </Button>
      {open && <ImagePanel projectId={projectId} companyId={companyId} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

function ImagePanel({ projectId, companyId, onClose, onDone }: { projectId?: string; companyId?: string; onClose: () => void; onDone: () => void | Promise<unknown> }) {
  const toast = useToast();
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('512x512');
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      await apiPost('/ai/image', { prompt, size, projectId: projectId ?? null, companyId: companyId ?? null });
      toast(tr('تصویر ساخته شد و در فایل‌ها قرار گرفت.'), 'success');
      await onDone();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={tr('ساخت تصویر')} onClose={busy ? () => undefined : onClose}>
      <div className="space-y-3">
        <Field label={tr('تصویر چه باشد؟')} required hint={tr('توصیف به انگلیسی معمولاً نتیجهٔ بهتری می‌دهد. متن توصیف همراه تصویر نگه داشته می‌شود.')}>
          <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={1000} autoFocus />
        </Field>
        <Field label={tr('اندازه')}>
          <Select value={size} onChange={(e) => setSize(e.target.value)}>
            <option value="512x512">512 × 512</option>
            <option value="768x768">768 × 768</option>
            <option value="1024x1024">1024 × 1024</option>
          </Select>
        </Field>
        {busy && <p className="text-xs text-ink-500">{tr('در حال ساخت — روی سرور بدون GPU ممکن است چند دقیقه طول بکشد.')}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{tr('انصراف')}</Button>
          <Button variant="primary" onClick={() => void make()} disabled={!prompt.trim()} loading={busy}>{tr('بساز')}</Button>
        </div>
      </div>
    </Modal>
  );
}
