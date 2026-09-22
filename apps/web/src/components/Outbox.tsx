import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clearSent, listOutbox, pendingCount, removeItem, OUTBOX_EVENT } from '../lib/outbox';
import { requeue, syncOutbox, watchConnectivity } from '../lib/sync';
import { Badge, Button, Card, EmptyState, Table, Td, Th, Tr, useToast } from './ui';
import { Code } from './common';
import { formatDateTime, toPersianDigits } from '../lib/format';

const STATE_FA: Record<string, { fa: string; tone: 'neutral' | 'info' | 'warning' | 'danger' | 'success' }> = {
  QUEUED: { fa: 'در صف ارسال', tone: 'warning' },
  SENDING: { fa: 'در حال ارسال', tone: 'info' },
  REJECTED: { fa: 'رد شد', tone: 'danger' },
  SENT: { fa: 'ارسال شد', tone: 'success' },
};

/**
 * What the device is still holding (roadmap #19). A form filled with no signal is not lost and
 * is not pretended to be accepted: it waits here, and when it finally reaches the server and a
 * rule refuses it, the refusal is shown in the server's own words beside the person's data.
 */
export function Outbox() {
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const toast = useToast();
  const qc = useQueryClient();

  // The query is the only copy: mirroring it into state is how a queued form ends up invisible
  // until the next reload, which is the one moment the person needs to see it.
  // networkMode 'always': this queue lives on the device, and the one moment it must be
  // readable is the moment the browser says there is no network.
  const { data } = useQuery({ queryKey: ['outbox'], queryFn: listOutbox, refetchInterval: 15_000, networkMode: 'always' });
  const items = data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['outbox'] });
  useEffect(() => {
    const mark = () => setOnline(navigator.onLine);
    const changed = () => { void qc.invalidateQueries({ queryKey: ['outbox'] }); };
    window.addEventListener('online', mark);
    window.addEventListener('offline', mark);
    window.addEventListener(OUTBOX_EVENT, changed);
    const stop = watchConnectivity(changed);
    return () => {
      window.removeEventListener('online', mark);
      window.removeEventListener('offline', mark);
      window.removeEventListener(OUTBOX_EVENT, changed);
      stop();
    };
  }, [qc]);

  const send = async () => {
    setBusy(true);
    try {
      const result = await syncOutbox();
      await refresh();

      await qc.invalidateQueries({ queryKey: ['/forms/submissions'] });
      toast(
        result.sent || result.rejected
          ? `${toPersianDigits(result.sent)} فرم ارسال شد${result.rejected ? ` و ${toPersianDigits(result.rejected)} فرم رد شد` : ''}.`
          : 'چیزی برای ارسال نبود یا هنوز ارتباط برقرار نیست.',
        result.rejected ? 'warning' : 'success',
      );
    } finally { setBusy(false); }
  };

  const waiting = pendingCount(items);
  if (!items.length) return null;

  return (
    <Card
      title="صف ارسال فرم‌ها"
      subtitle="فرم‌هایی که بدون اینترنت پر شده‌اند — با بازگشت شبکه خودشان ارسال می‌شوند"
      action={
        <div className="flex items-center gap-2">
          <Badge tone={online ? 'success' : 'warning'}>{online ? 'آنلاین' : 'آفلاین'}</Badge>
          <Button size="sm" variant="secondary" loading={busy} disabled={!waiting} onClick={() => void send()}>ارسال همین حالا</Button>
          {items.some((i) => i.state === 'SENT') && (
            <Button size="sm" variant="ghost" onClick={() => void clearSent().then(() => refresh())}>پاک‌کردن ارسال‌شده‌ها</Button>
          )}
        </div>
      }
    >
      {!items.length ? <EmptyState title="صف خالی است" /> : (
        <Table>
          <thead className="bg-ink-50/60">
            <tr><Th>فرم</Th><Th>زمان پر شدن</Th><Th>وضعیت</Th><Th>تلاش</Th><Th>پیام سامانه</Th><Th> </Th></tr>
          </thead>
          <tbody data-testid="outbox-items">
            {items.map((i) => (
              <Tr key={i.id}>
                <Td className="text-sm">
                  {i.formNameFa}
                  <span className="block text-[11px] text-ink-400"><Code>{i.formCode}</Code>{i.asDraft ? ' — پیش‌نویس' : ''}</span>
                </Td>
                <Td className="text-xs">{formatDateTime(new Date(i.createdAt).toISOString())}</Td>
                <Td><Badge tone={STATE_FA[i.state]!.tone}>{STATE_FA[i.state]!.fa}</Badge></Td>
                <Td className="nums text-xs">{toPersianDigits(i.attempts)}</Td>
                <Td className="max-w-xs text-[11px] text-ink-600">
                  {i.state === 'SENT' && i.submissionCode ? <span className="text-emerald-700">ثبت شد: {i.submissionCode}</span> : i.errorFa ?? '—'}
                </Td>
                <Td>
                  <div className="flex gap-1">
                    {i.state === 'REJECTED' && (
                      <Button size="sm" variant="ghost" onClick={() => void requeue(i).then(() => refresh())}>تلاش دوباره</Button>
                    )}
                    {i.state !== 'SENDING' && (
                      <Button size="sm" variant="ghost"
                        onClick={() => { if (confirm(`فرم «${i.formNameFa}» از صف حذف شود؟ داده‌های آن از دست می‌رود.`)) void removeItem(i.id).then(() => refresh()); }}>
                        حذف
                      </Button>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** A one-line marker for the shell: how many forms this device is still carrying. */
export function OutboxBadge() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['outbox'], queryFn: listOutbox, refetchInterval: 20_000, networkMode: 'always' });
  useEffect(() => {
    const changed = () => { void qc.invalidateQueries({ queryKey: ['outbox'] }); };
    window.addEventListener(OUTBOX_EVENT, changed);
    return () => window.removeEventListener(OUTBOX_EVENT, changed);
  }, [qc]);
  const waiting = pendingCount(data ?? []);
  if (!waiting) return null;
  return <Badge tone="warning">{toPersianDigits(waiting)} فرم در صف ارسال</Badge>;
}
