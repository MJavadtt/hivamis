import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiGet, downloadPdfBundle } from '../lib/api';
import { Badge, Button, Checkbox, ErrorBlock, LoadingBlock, Modal, useToast } from './ui';
import { toPersianDigits } from '../lib/format';

interface AttachmentItem {
  type: 'record' | 'file';
  kind?: string;
  id: string;
  title: string;
  code?: string | null;
  mimeType?: string;
  sizeBytes?: number;
  embeddable?: boolean;
  defaultSelected: boolean;
}
interface AttachmentGroup { key: string; titleFa: string; items: AttachmentItem[] }
interface AttachmentsResponse { groups: AttachmentGroup[]; maxItems: number; totalAvailable: number }

const keyOf = (i: AttachmentItem) => `${i.type}:${i.id}`;

const humanSize = (bytes?: number) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${toPersianDigits(bytes)} بایت`;
  if (bytes < 1024 * 1024) return `${toPersianDigits((bytes / 1024).toFixed(0))} کیلوبایت`;
  return `${toPersianDigits((bytes / 1024 / 1024).toFixed(1))} مگابایت`;
};

/**
 * Assemble a complete dossier: the record plus whatever is attached to it.
 *
 * The picker only lists what the signed-in user is entitled to export — the server omits the rest
 * rather than showing it locked, so an unreadable record's existence is not disclosed here either.
 */
export function PdfBundleButton({ kind, id, label = 'خروجی کامل با پیوست‌ها' }: {
  kind: string; id: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} title="دریافت سند به همراه پیوست‌ها">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
        </svg>
        {label}
      </Button>
      {open && <BundleModal kind={kind} id={id} onClose={() => setOpen(false)} />}
    </>
  );
}

function BundleModal({ kind, id, onClose }: { kind: string; id: string; onClose: () => void }) {
  const showToast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const { data, isLoading, error } = useQuery<AttachmentsResponse>({
    queryKey: [`/pdf/${kind}/${id}/attachments`],
    queryFn: () => apiGet(`/pdf/${kind}/${id}/attachments`),
  });

  // Apply the server's suggested defaults once the list arrives.
  useEffect(() => {
    if (!data) return;
    const next = new Set<string>();
    for (const g of data.groups) for (const i of g.items) if (i.defaultSelected) next.add(keyOf(i));
    setSelected(next);
  }, [data]);

  const all = useMemo(() => data?.groups.flatMap((g) => g.items) ?? [], [data]);
  const count = selected.size;
  const overLimit = data ? count > data.maxItems : false;

  const toggle = (item: AttachmentItem) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(item);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  const setGroup = (group: AttachmentGroup, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of group.items) on ? next.add(keyOf(i)) : next.delete(keyOf(i));
      return next;
    });

  const setAll = (on: boolean) =>
    setSelected(on ? new Set(all.map(keyOf)) : new Set());

  const download = async () => {
    setBusy(true);
    try {
      const chosen = all.filter((i) => selected.has(keyOf(i)));
      const sections = await downloadPdfBundle(kind, id, {
        items: chosen.filter((i) => i.type === 'record').map((i) => ({ kind: i.kind!, id: i.id })),
        fileIds: chosen.filter((i) => i.type === 'file').map((i) => i.id),
      });
      showToast(`بسته اسناد با ${toPersianDigits(sections)} بخش آماده شد.`, 'success');
      onClose();
    } catch (err) {
      showToast(
        err instanceof ApiError ? err.body.message : 'تولید بسته اسناد ناموفق بود.',
        'danger',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="انتخاب پیوست‌ها برای خروجی کامل"
      footer={
        <>
          <span className="me-auto text-xs text-ink-500">
            {overLimit
              ? `حداکثر ${toPersianDigits(data!.maxItems)} پیوست مجاز است`
              : `${toPersianDigits(count)} مورد انتخاب شده`}
          </span>
          <Button variant="ghost" onClick={onClose}>انصراف</Button>
          <Button variant="primary" loading={busy} disabled={overLimit} onClick={() => void download()}>
            دریافت PDF کامل
          </Button>
        </>
      }
    >
      {isLoading && <LoadingBlock label="در حال یافتن پیوست‌ها…" />}
      {error && <ErrorBlock error={error} />}

      {data && (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
            <span>
              سند اصلی همیشه در ابتدای بسته قرار می‌گیرد. تنها پیوست‌هایی نمایش داده می‌شوند که در
              سطح دسترسی شما هستند.
            </span>
            <span className="flex shrink-0 gap-2">
              <button type="button" className="text-brand-600 hover:underline" onClick={() => setAll(true)}>انتخاب همه</button>
              <button type="button" className="text-brand-600 hover:underline" onClick={() => setAll(false)}>هیچ‌کدام</button>
            </span>
          </div>

          {data.groups.length === 0 && (
            <p className="py-6 text-center text-sm text-ink-500">پیوستی برای این سند یافت نشد.</p>
          )}

          {data.groups.map((g) => {
            const on = g.items.filter((i) => selected.has(keyOf(i))).length;
            return (
              <section key={g.key} className="rounded-lg border border-ink-200">
                <header className="flex items-center justify-between border-b border-ink-200 bg-ink-50/60 px-3 py-2">
                  <h3 className="text-sm font-medium text-ink-800">
                    {g.titleFa}
                    <span className="ms-2 text-xs text-ink-500">
                      ({toPersianDigits(on)} از {toPersianDigits(g.items.length)})
                    </span>
                  </h3>
                  <button
                    type="button"
                    className="text-xs text-brand-600 hover:underline"
                    onClick={() => setGroup(g, on < g.items.length)}
                  >
                    {on < g.items.length ? 'انتخاب گروه' : 'حذف گروه'}
                  </button>
                </header>
                <ul className="divide-y divide-ink-100">
                  {g.items.map((i) => (
                    <li key={keyOf(i)} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        checked={selected.has(keyOf(i))}
                        onChange={() => toggle(i)}
                        label={
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="truncate text-sm text-ink-800">{i.title}</span>
                            {i.code && <code className="shrink-0 text-[11px] text-ink-400">{i.code}</code>}
                            {i.type === 'file' && (
                              <Badge tone={i.embeddable ? 'info' : 'warning'}>
                                {i.embeddable ? 'فایل' : 'درج‌نشدنی'}
                              </Badge>
                            )}
                            {i.sizeBytes ? (
                              <span className="shrink-0 text-[11px] text-ink-400">{humanSize(i.sizeBytes)}</span>
                            ) : null}
                          </span>
                        }
                      />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          {all.some((i) => i.type === 'file' && !i.embeddable) && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
              فایل‌های «درج‌نشدنی» (مانند Word، Excel یا ZIP) قابل ادغام در PDF نیستند؛ در صورت
              انتخاب، نام آن‌ها در فهرست ابتدای بسته ثبت می‌شود تا جداگانه دریافت شوند.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
