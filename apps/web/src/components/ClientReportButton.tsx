import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../hooks/queries';
import { Badge, Button, Input, Modal } from './ui';
import { tr } from '../i18n';

interface Preview { html: string; omitted: string[]; to: string | null; contact: string | null }

const OMITTED_FA: Record<string, string> = {
  financialStatus: tr('وضعیت مالی'), decisionsNeeded: tr('تصمیمات داخلی'),
  'redaction:cost': tr('قیمت تمام‌شده'), 'redaction:price': tr('قیمت فروش'), 'redaction:finance': tr('اسناد مالی'),
};

/**
 * Send a status report to the client, after seeing exactly what they will see. The preview is
 * the client's copy — built for a reader outside the organisation — and the strip above it says
 * what has been left out, so nobody has to wonder whether the margin went with it.
 */
export function ClientReportButton({ reportId }: { reportId: string }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const { data } = useQuery<Preview>({
    queryKey: ['/status-reports', reportId, 'client-preview'],
    queryFn: () => apiGet(`/status-reports/${reportId}/client-preview`),
    enabled: open,
  });
  const send = useAction(
    () => apiPost(`/status-reports/${reportId}/send-to-client`, to.trim() ? { to: to.trim() } : {}),
    tr('گزارش برای مشتری ارسال شد.'),
  );
  if (!can('project.execute')) return null;

  const recipient = to.trim() || data?.to || '';
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>{tr('ارسال برای مشتری')}</Button>
      <Modal
        open={open} onClose={() => setOpen(false)} title={tr('گزارش وضعیت — نسخهٔ مشتری')} wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{tr('انصراف')}</Button>
            <Button variant="primary" loading={send.isPending} disabled={!recipient}
              onClick={() => send.mutate(undefined, { onSuccess: () => setOpen(false) })}>{tr('ارسال به {0}', recipient || '—')}</Button>
          </>
        }
      >
        {data && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs" data-testid="client-report-omitted">
              <span className="text-ink-500">{tr('در نسخهٔ مشتری نیست:')}</span>
              {data.omitted.map((o) => <Badge key={o} tone="neutral">{OMITTED_FA[o] ?? o}</Badge>)}
            </div>
            <label className="mb-3 block text-xs text-ink-600">
              <span className="mb-1 block">{tr('گیرنده {0}', data.contact ? `— ${data.contact}` : '')}</span>
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder={data.to ?? tr('نشانی ایمیل مشتری ثبت نشده')} type="email" aria-label={tr('گیرنده')} />
            </label>
            {/* The server builds this HTML with the same escaping as the PDF; it is our own template. */}
            <div className="max-h-[50vh] overflow-auto rounded-lg ring-1 ring-ink-200 p-4 text-sm"
              data-testid="client-report-preview" dangerouslySetInnerHTML={{ __html: data.html }} />
          </>
        )}
      </Modal>
    </>
  );
}
