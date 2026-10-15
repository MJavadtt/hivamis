import type { RequestOptions } from '../lib/api';
import { useShownSince } from '../lib/offline';
import { formatDateTime } from '../lib/format';
import { tr } from '../i18n';

/** Said where a page shows the device's copy rather than the server's answer (audit F-7). */
export function Freshness({ path, query }: { path: string; query?: RequestOptions['query'] }) {
  const since = useShownSince(path, query);
  if (!since) return null;
  return (
    <p role="status" data-testid="freshness" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200">
      {tr('بدون اتصال — آخرین به‌روزرسانی: {0}', formatDateTime(new Date(since).toISOString()))}
    </p>
  );
}
