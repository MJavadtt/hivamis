import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiDelete } from '../lib/api';
import { offlineQuery } from '../lib/offline';
import { sendOrQueue } from '../lib/sync';
import { useAuth } from '../lib/auth';
import { useAction } from '../hooks/queries';
import { JalaliDateInput } from './JalaliDateInput';
import { Button, Card, EmptyState, Input, ProgressBar } from './ui';
import { formatDate, localDigits } from '../lib/format';
import { tr } from '../i18n';

interface Entry { id: string; hours: string; workedOn: string; note: string | null; user: { id: string; fullName: string } }
interface Time { estimateHours: string | null; actualHours: string | null; entries: Entry[] }

const h = (v: string | number | null | undefined) => (v == null ? '—' : tr('{0} س', localDigits(Math.round(Number(v) * 10) / 10)));

/**
 * Hours on a task: a number, a day, a note. Against the estimate, so the person who declared
 * the cost sees the reality beside it — that is the Doc_H "cost accuracy" KPI, closed.
 */
export function TaskTime({ taskId, taskCode, assigneeId }: { taskId: string; taskCode?: string; assigneeId: string | null }) {
  const { user, can } = useAuth();
  const { data, refetch } = useQuery<Time>({ ...offlineQuery<Time>(`/tasks/${taskId}/time`), queryKey: ['/tasks', taskId, 'time'] });
  const [hours, setHours] = useState('');
  const [day, setDay] = useState('');
  const [note, setNote] = useState('');
  const mayLog = user?.id === assigneeId || can('task.write');
  // Out on a set with no signal, the hours wait on the phone and go when it is back (audit F-7).
  const add = useAction(
    () => sendOrQueue({
      kind: 'time', path: `/tasks/${taskId}/time`, link: `/tasks/${taskId}`,
      body: { hours: Number(hours), ...(day ? { workedOn: day } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
      label: tr('{0} ساعت روی {1}', localDigits(Number(hours)), taskCode ?? tr('وظیفه')),
    }),
    (r) => (r.queued ? tr('بدون اتصال: در صف ماند و با بازگشت شبکه ثبت می‌شود.') : tr('زمان ثبت شد.')),
    { offline: true },
  );
  const remove = useAction((id: string) => apiDelete(`/tasks/${taskId}/time/${id}`), tr('ثبت زمان حذف شد.'));
  if (!data) return null;
  const est = data.estimateHours == null ? null : Number(data.estimateHours);
  const act = data.actualHours == null ? 0 : Number(data.actualHours);
  const used = est ? Math.min(150, (act / est) * 100) : 0;

  return (
    <Card title={tr('ثبت زمان')} subtitle={est != null ? tr('برآورد {0} · واقعی {1}', h(est), h(act)) : tr('واقعی {0} · برآوردی ثبت نشده', h(act))}>
      {est != null && (
        <div className="px-4 pt-3"><ProgressBar value={used} tone={used > 100 ? 'danger' : used > 85 ? 'warning' : 'success'} /></div>
      )}
      {mayLog && (
        <form className="flex flex-wrap items-end gap-2 px-4 py-3" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined, { onSuccess: () => { setHours(''); setNote(''); void refetch(); } }); }}>
          <label className="text-xs text-ink-600"><span className="mb-1 block">{tr('ساعت')}</span><Input type="number" inputMode="decimal" min={0.25} max={24} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} className="w-20 text-xs" aria-label={tr('ساعت')} required /></label>
          <label className="text-xs text-ink-600"><span className="mb-1 block">{tr('روز')}</span><JalaliDateInput value={day} onChange={setDay} id={`time-day-${taskId}`} /></label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('یادداشت (اختیاری)')} className="min-w-[10rem] flex-1 text-xs" aria-label={tr('یادداشت')} />
          <Button type="submit" size="sm" variant="primary" loading={add.isPending} disabled={!hours || Number(hours) <= 0}>{tr('ثبت')}</Button>
        </form>
      )}
      {!data.entries.length ? <EmptyState title={tr('زمانی ثبت نشده')} /> : (
        <ul className="divide-y divide-ink-100" data-testid="time-entries">
          {data.entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
              <span><span className="nums font-medium text-ink-800">{h(e.hours)}</span> · {e.user.fullName} · {formatDate(e.workedOn)}{e.note && <span className="text-ink-500"> — {e.note}</span>}</span>
              {(e.user.id === user?.id || can('task.write')) && <Button size="sm" variant="ghost" onClick={() => remove.mutate(e.id, { onSuccess: () => void refetch() })}>{tr('حذف')}</Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
