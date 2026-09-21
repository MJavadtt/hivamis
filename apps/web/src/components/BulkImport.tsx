import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost, downloadFile } from '../lib/api';
import { Badge, Button, Table, Td, Th, Tr, useToast } from './ui';
import { toPersianDigits } from '../lib/format';

interface PreviewRow { index: number; ok: boolean; issues: { path: string; message: string }[]; data: Record<string, unknown> }
interface Preview { total: number; valid: number; invalid: number; rows: PreviewRow[] }
interface Result { total: number; created: number; failed: number; rows: { index: number; ok: boolean; code?: string; issues: { message: string }[] }[] }

/**
 * Spreadsheet in, submissions out — for any form, from its schema. The file is checked row by
 * row before anything is written; the person sees every problem at once and decides whether the
 * valid rows go in as drafts (the default for a migration) or through approval.
 */
export function BulkImport({ code, canSubmit }: { code: string; canSubmit: boolean }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const qc = useQueryClient();

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name); setResult(null); setPreview(null); setBusy(true);
    try {
      const text = await f.text();
      setCsv(text);
      setPreview(await apiPost<Preview>(`/forms/definitions/${code}/import`, { csv: text, mode: 'preview' }));
    } catch (e: any) {
      toast(e?.message ?? 'خواندن فایل ناموفق بود.', 'danger');
    } finally { setBusy(false); }
  };

  const run = async (mode: 'draft' | 'submit') => {
    if (!csv) return;
    setBusy(true);
    try {
      const r = await apiPost<Result>(`/forms/definitions/${code}/import`, { csv, mode });
      setResult(r); setPreview(null);
      toast(`${toPersianDigits(r.created)} ردیف ثبت شد${r.failed ? `، ${toPersianDigits(r.failed)} ردیف ناموفق` : ''}.`, r.failed ? 'warning' : 'success');
      await qc.invalidateQueries();
    } catch (e: any) {
      toast(e?.message ?? 'ورود داده ناموفق بود.', 'danger');
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg bg-ink-50/60 p-3 text-xs" data-testid="bulk-import">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink-700">ورود و خروج انبوه</span>
        <Button size="sm" onClick={() => void downloadFile(`/forms/definitions/${code}/template.csv`, `${code}-template.csv`)}>قالب CSV</Button>
        <Button size="sm" onClick={() => void downloadFile(`/forms/definitions/${code}/export.csv`, `${code}.csv`)}>خروجی CSV</Button>
        {canSubmit && (
          <>
            <input ref={file} type="file" accept=".csv,text/csv" className="hidden" aria-label="فایل CSV" onChange={(e) => void choose(e.target.files?.[0])} />
            <Button size="sm" variant="primary" loading={busy} onClick={() => file.current?.click()}>ورود از CSV…</Button>
            {fileName && <span className="text-ink-500">{fileName}</span>}
          </>
        )}
      </div>

      {preview && (
        <div data-testid="bulk-preview">
          <p className="mb-2">
            {toPersianDigits(preview.total)} ردیف خوانده شد —{' '}
            <span className="text-emerald-700">{toPersianDigits(preview.valid)} معتبر</span>
            {preview.invalid > 0 && <>، <span className="text-rose-700">{toPersianDigits(preview.invalid)} با خطا</span></>}.
            {preview.invalid > 0 && ' ردیف‌های خطادار ثبت نمی‌شوند.'}
          </p>
          {preview.invalid > 0 && (
            <Table>
              <thead className="bg-ink-50/60"><tr><Th>ردیف</Th><Th>خطا</Th></tr></thead>
              <tbody>
                {preview.rows.filter((r) => !r.ok).map((r) => (
                  <Tr key={r.index}>
                    <Td className="nums">{toPersianDigits(r.index)}</Td>
                    <Td className="text-rose-700">{r.issues.map((i) => i.message).join('؛ ')}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" loading={busy} disabled={preview.valid === 0} onClick={() => void run('draft')}>
              ثبت {toPersianDigits(preview.valid)} ردیف به‌عنوان پیش‌نویس
            </Button>
            <Button size="sm" loading={busy} disabled={preview.valid === 0} onClick={() => void run('submit')}>ثبت و ارسال برای تأیید</Button>
          </div>
        </div>
      )}

      {result && (
        <p data-testid="bulk-result">
          <Badge tone={result.failed ? 'warning' : 'success'}>{toPersianDigits(result.created)} ثبت شد</Badge>{' '}
          {result.failed > 0 && <Badge tone="danger">{toPersianDigits(result.failed)} ناموفق</Badge>}{' '}
          <span className="text-ink-500">{result.rows.filter((r) => r.ok).map((r) => r.code).join('، ')}</span>
        </p>
      )}
    </div>
  );
}
