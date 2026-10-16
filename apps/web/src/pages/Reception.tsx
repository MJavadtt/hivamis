import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import { formatDateTime, localDigits, sep } from '../lib/format';
import { PageBody, PageHeader } from '../components/Shell';
import { Badge, Button, Card, EmptyState, Input, LoadingBlock, Tabs, useToast } from '../components/ui';
import { tr } from '../i18n';

/**
 * The reception desk (audit F-9, step 4): the day's confirmed meetings with outside guests, who is
 * expected, who is in and who has left. Checking a guest in tells the organiser at once. The desk sees
 * names, companies, rooms and times — not what the meeting is about beyond its title.
 */

interface Guest { id: string; fullName: string; company: string | null; isVip: boolean; checkedInAt: string | null; checkedOutAt: string | null }
interface Meeting {
  id: string; code: string; title: string; startsAt: string; endsAt: string; placeNote: string | null; parkingSpaces: number;
  room: { name: string; floor: string | null } | null; organizer: { id: string; fullName: string }; guests: Guest[];
}

/** The local day, from midnight to midnight, `offset` days from today. */
function day(offset: number) {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() + offset);
  return { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() };
}
const time = (iso: string) => formatDateTime(iso).split(' ').at(-1);

export default function Reception() {
  const qc = useQueryClient();
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const span = day(offset);
  const { data, isLoading } = useQuery<Meeting[]>({ queryKey: ['/reception', offset], queryFn: () => apiGet('/reception', span), refetchInterval: 60_000 });
  const mark = async (g: Guest, what: 'check-in' | 'check-out') => {
    try {
      await apiPost(`/reception/guests/${g.id}/${what}`);
      toast(what === 'check-in' ? tr('ورود {0} ثبت شد؛ برگزارکننده باخبر شد.', g.fullName) : tr('خروج {0} ثبت شد.', g.fullName));
      await qc.invalidateQueries({ queryKey: ['/reception'] });
    } catch (e) { toast((e as Error).message, 'danger'); }
  };
  const needle = q.trim();
  const meetings = (data ?? [])
    .map((m) => ({ ...m, guests: needle ? m.guests.filter((g) => `${g.fullName} ${g.company ?? ''}`.includes(needle)) : m.guests }))
    .filter((m) => m.guests.length);
  const expected = (data ?? []).reduce((n, m) => n + m.guests.length, 0);
  const inside = (data ?? []).reduce((n, m) => n + m.guests.filter((g) => g.checkedInAt && !g.checkedOutAt).length, 0);

  return (
    <>
      <PageHeader title={tr('پذیرش')} subtitle={tr('مهمانان جلسه‌های امروز: چه کسی می‌آید، چه کسی رسیده، چه کسی رفته')} />
      <PageBody>
        <div className="space-y-4" data-testid="reception">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs tabs={[{ key: '0', label: tr('امروز') }, { key: '1', label: tr('فردا') }]} active={String(offset)} onChange={(k) => setOffset(Number(k))} />
            <div className="w-64"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('نام مهمان یا شرکت')} aria-label={tr('جستجوی مهمان')} /></div>
            <span className="text-xs text-ink-500">{tr('{0} مهمان، {1} نفر اکنون در ساختمان', localDigits(expected), localDigits(inside))}</span>
          </div>
          {isLoading ? <LoadingBlock /> : !meetings.length ? <EmptyState title={tr('مهمانی در این روز انتظار نمی‌رود')} /> : meetings.map((m) => (
            <Card key={m.id} title={<span>{time(m.startsAt)}–{time(m.endsAt)}{sep()}{m.title}</span>}
              subtitle={<>{m.room ? `${m.room.name}${m.room.floor ? `${sep()}${tr('طبقهٔ {0}', m.room.floor)}` : ''}` : m.placeNote ?? '—'}{sep()}{tr('برگزارکننده: {0}', m.organizer.fullName)}{m.parkingSpaces > 0 ? `${sep()}${tr('{0} جای پارک', localDigits(m.parkingSpaces))}` : ''}</>}>
              <ul className="divide-y divide-ink-100" data-testid="reception-guests">
                {m.guests.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-ink-800">{g.fullName}</span>
                      {g.company && <span className="text-xs text-ink-500"> — {g.company}</span>}
                    </span>
                    {g.isVip && <Badge tone="warning">VIP</Badge>}
                    {g.checkedOutAt ? <Badge tone="neutral">{tr('رفت {0}', time(g.checkedOutAt) ?? '')}</Badge>
                      : g.checkedInAt ? <>
                        <Badge tone="success">{tr('رسید {0}', time(g.checkedInAt) ?? '')}</Badge>
                        <Button size="sm" variant="ghost" onClick={() => void mark(g, 'check-out')}>{tr('ثبت خروج')}</Button>
                      </> : <Button size="sm" variant="primary" onClick={() => void mark(g, 'check-in')}>{tr('ثبت ورود')}</Button>}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </PageBody>
    </>
  );
}
