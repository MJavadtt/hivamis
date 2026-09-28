import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { stateLabelFa } from '@hiva/contracts';
import { apiGet } from '../lib/api';
import { Badge, Button, EmptyState, Modal, cx } from './ui';
import { Code } from './common';
import { JalaliDateInput } from './JalaliDateInput';
import { formatDateTime, toPersianDigits } from '../lib/format';

interface Change { field: string; before?: unknown; after?: unknown; withheld?: string }
interface Event {
  id: string; at: string; action: string; reason: string | null; actorName: string | null; changes: Change[];
  onBehalfOfName?: string | null;
  /** Metadata of an event about the record (an export, a pause) — not a change to it. */
  details: Record<string, unknown> | null;
}
interface History { events: Event[]; withheld: string[] }
interface Snapshot {
  known: boolean; snapshot: Record<string, unknown> | null; withheld?: string[];
  asOf: { at: string; action: string } | null; earliest?: string;
}

const ACTION_FA: Record<string, string> = {
  CREATE: 'ایجاد', UPDATE: 'ویرایش', DELETE: 'حذف', STATE_TRANSITION: 'تغییر وضعیت', APPROVE: 'تأیید',
  EXPORT: 'خروجی PDF', FILE_UPLOAD: 'بارگذاری فایل', FILE_DOWNLOAD: 'دانلود فایل', FILE_VIEW: 'مشاهدهٔ فایل',
  SLA_PAUSE: 'توقف مهلت', SLA_RESUME: 'از سرگیری مهلت',
  LESSON_REVIEWED: 'بررسی درس آموخته',
};
const WITHHELD_FA: Record<string, string> = {
  cost: 'قیمت تمام‌شده — خارج از سطح دسترسی', price: 'قیمت فروش — خارج از سطح دسترسی', sensitive: 'محرمانه',
};

/** A value as a person would read it: states by their label, dates as Jalali, the rest as-is. */
function show(field: string, v: unknown): string {
  if (v == null || v === '') return '—';
  if (field === 'state' && typeof v === 'string') return stateLabelFa(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return formatDateTime(v);
  if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))) return toPersianDigits(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * The record's history as evidence: every change with who and when, field by field, and the
 * record as it stood on any date. Everything here is read from the audit trail — nothing the
 * page shows can be edited into being.
 */
export function RecordHistory({ entityType, entityId }: { entityType: string; entityId: string }) {
  const [open, setOpen] = useState(false);
  const [asOf, setAsOf] = useState<string>('');
  const { data, isLoading } = useQuery<History>({
    queryKey: ['/history', entityType, entityId],
    queryFn: () => apiGet(`/history/${entityType}/${entityId}`),
    enabled: open,
  });
  const { data: snap } = useQuery<Snapshot>({
    queryKey: ['/history/at', entityType, entityId, asOf],
    queryFn: () => apiGet(`/history/${entityType}/${entityId}/at`, { ts: asOf }),
    enabled: open && !!asOf,
  });

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>تاریخچه</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="تاریخچهٔ تغییرات" wide>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-600">
            <span className="mb-1 block">وضعیت رکورد در تاریخ</span>
            <JalaliDateInput value={asOf} onChange={setAsOf} mode="datetime" id="history-as-of" />
          </label>
          {asOf && snap && (
            <div className="min-w-0 flex-1 rounded-lg bg-ink-50/60 p-3 text-xs" data-testid="history-snapshot">
              {!snap.known ? (
                <p>در آن تاریخ هنوز اثری از این رکورد ثبت نشده بود{snap.earliest ? ` — نخستین ثبت: ${formatDateTime(snap.earliest)}` : ''}.</p>
              ) : (
                <>
                  <p className="mb-2 text-ink-500">
                    بر اساس آخرین رویداد تا آن لحظه: {ACTION_FA[snap.asOf!.action] ?? snap.asOf!.action} در {formatDateTime(snap.asOf!.at)}
                  </p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    {Object.entries(snap.snapshot!).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt><Code>{k}</Code></dt>
                        <dd className="truncate">{show(k, v)}</dd>
                      </div>
                    ))}
                    {snap.withheld?.map((k) => (
                      <div key={k} className="contents text-ink-400">
                        <dt><Code>{k}</Code></dt>
                        <dd>محرمانه — خارج از سطح دسترسی</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </div>
          )}
        </div>

        {isLoading ? null : !data?.events.length ? <EmptyState title="تغییری ثبت نشده" /> : (
          <ol className="space-y-3" data-testid="history-timeline">
            {[...data.events].reverse().map((ev) => (
              <li key={ev.id} className="rounded-lg ring-1 ring-ink-200/70 p-3 text-xs">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <Badge tone={ev.action === 'DELETE' ? 'danger' : ev.action === 'STATE_TRANSITION' ? 'info' : 'neutral'}>
                    {ACTION_FA[ev.action] ?? ev.action}
                  </Badge>
                  <span className="text-ink-700">{ev.actorName ?? 'نامشخص'}{ev.onBehalfOfName && <span className="text-ink-500"> به نمایندگی از {ev.onBehalfOfName}</span>}</span>
                  <span className="text-ink-400">{formatDateTime(ev.at)}</span>
                  {ev.reason && <span className="text-ink-500">— {ev.reason}</span>}
                </div>
                {ev.details && (
                  <p className="text-ink-500" data-testid="history-details">
                    {Object.entries(ev.details)
                      .filter(([, v]) => typeof v !== 'object' || v === null)
                      .map(([k, v]) => `${k}: ${show(k, v)}`).join(' · ')}
                  </p>
                )}
                {ev.changes.length > 0 && (
                  <ul className="space-y-0.5">
                    {ev.changes.map((c) => (
                      <li key={c.field} className={cx('flex flex-wrap items-baseline gap-1.5', c.withheld && 'text-ink-400')}>
                        <Code>{c.field}</Code>
                        {c.withheld ? <span>{WITHHELD_FA[c.withheld] ?? 'محرمانه'}</span> : (
                          <>
                            <span className="text-ink-500 line-through decoration-rose-400">{show(c.field, c.before)}</span>
                            <span aria-hidden>←</span>
                            <span className="font-medium text-ink-800">{show(c.field, c.after)}</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </>
  );
}
