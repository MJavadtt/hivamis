import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../lib/api';
import { formatRelative } from '../lib/format';
import { pageOf } from '../lib/plain';
import { Badge, cx } from './ui';
import { tr, trx } from '../i18n';

export interface NotificationRow {
  id: string; kind: string; title: string; body: string | null;
  entityType: string | null; entityId: string | null;
  severity: string; readAt: string | null; createdAt: string;
}

/**
 * A notification is a way in (the owner's brief, 2026-11-02): it opens the record it is about, and
 * opening it marks it read. One with nothing to open is marked read with the rest («خوانده‌شدن همه»).
 */
export function NoticeRow({ n, onOpen }: { n: NotificationRow; onOpen?: () => void }) {
  const qc = useQueryClient();
  const to = pageOf(n.entityType, n.entityId);
  const read = () => {
    onOpen?.();
    if (n.readAt) return;
    void apiPost(`/notifications/${n.id}/read`).then(() => qc.invalidateQueries({ queryKey: ['/notifications'] })).catch(() => undefined);
  };
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-ink-800">{trx(n.title)}</p>
        {n.severity === 'CRITICAL' && <Badge tone="danger">{tr('بحرانی')}</Badge>}
        {n.severity === 'WARNING' && <Badge tone="warning">{tr('هشدار')}</Badge>}
      </div>
      {n.body && <p className="mt-0.5 text-xs leading-6 text-ink-500">{trx(n.body)}</p>}
      <p className="mt-1 flex items-center justify-between text-[12.5px] text-ink-400">
        <span>{formatRelative(n.createdAt)}</span>
        {to && <span className="text-brand-700">{tr('باز کردن')}</span>}
      </p>
    </>
  );
  const cls = cx('block border-b border-ink-200/60 px-3 py-2.5 last:border-0', !n.readAt && 'bg-brand-50/60');
  return to
    ? <Link to={to} onClick={read} className={cx(cls, 'hover:bg-ink-50')} data-testid="notice">{body}</Link>
    : <div className={cls} data-testid="notice">{body}</div>;
}
