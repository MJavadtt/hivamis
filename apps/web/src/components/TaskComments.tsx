import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TASK_COMMENT_MAX } from '@hiva/contracts';
import { offlineQuery } from '../lib/offline';
import { sendOrQueue } from '../lib/sync';
import { useAction } from '../hooks/queries';
import { formatDateTime } from '../lib/format';
import { Avatar } from './Avatar';
import { Button, Card, EmptyState, Textarea } from './ui';
import { tr } from '../i18n';

interface Note { id: string; body: string; createdAt: string; author: { id: string; fullName: string; avatarUrl: string | null } }

/**
 * Notes on a task (audit F-7): what someone working on it wants the others to know — written where
 * the work is, and if there is no signal there, sent when there is.
 */
export function TaskComments({ taskId, taskCode }: { taskId: string; taskCode: string }) {
  const { data, refetch } = useQuery<Note[]>({ ...offlineQuery<Note[]>(`/tasks/${taskId}/comments`), queryKey: ['/tasks', taskId, 'comments'] });
  const [text, setText] = useState('');
  const add = useAction(
    () => sendOrQueue({ kind: 'comment', path: `/tasks/${taskId}/comments`, body: { body: text.trim() }, label: tr('یادداشت روی {0}', taskCode), link: `/tasks/${taskId}` }),
    (r) => (r.queued ? tr('بدون اتصال: در صف ماند و با بازگشت شبکه فرستاده می‌شود.') : tr('یادداشت گذاشته شد.')),
    { offline: true },
  );
  const notes = Array.isArray(data) ? data : [];
  return (
    <Card title={tr('یادداشت‌ها')} subtitle={tr('برای همهٔ کسانی که این وظیفه را می‌بینند')}>
      {!notes.length ? <EmptyState title={tr('هنوز یادداشتی نیست')} /> : (
        <ul className="divide-y divide-ink-100" data-testid="task-comments">
          {notes.map((n) => (
            <li key={n.id} className="flex gap-2.5 px-4 py-2.5">
              <Avatar name={n.author.fullName} src={n.author.avatarUrl} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-ink-500"><span className="font-semibold text-ink-800">{n.author.fullName}</span> · {formatDateTime(n.createdAt)}</p>
                <p dir="auto" className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-6 text-ink-800">{n.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="flex items-end gap-2 border-t border-ink-100 px-4 py-3" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined, { onSuccess: () => { setText(''); void refetch(); } }); }}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={TASK_COMMENT_MAX} dir="auto" aria-label={tr('یادداشت تازه')} placeholder={tr('یادداشتی برای همکاران…')} className="flex-1" />
        <Button type="submit" size="sm" variant="primary" loading={add.isPending} disabled={!text.trim()}>{tr('گذاشتن')}</Button>
      </form>
    </Card>
  );
}
