import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { Badge, LoadingBlock, ProgressBar, cx } from './ui';
import { formatDate, localDigits } from '../lib/format';
import { tr, trx } from '../i18n';

interface Candidate {
  load: {
    userId: string; fullName: string; jobTitle: string | null; departmentCode: string | null;
    capacityHours: number; committedHours: number; remainingHours: number; leaveHours: number;
    utilisation: number; status: string; openTasks: number; overdueTasks: number;
  };
  fits: boolean; utilisationAfter: number; statusAfter: string;
  earliestFinish: string; missesDueDate: boolean;
  history: { doneTasks: number; onTimePercent: number | null; estimateErrorPercent: number | null };
  score: number; reasonsFa: string[]; warningsFa: string[];
}

/**
 * Who has room for this work, at the moment the work is handed over (roadmap #12).
 * Ranked by free capacity on each person's own calendar, then by how their finished tasks
 * actually went. Nobody is hidden and nothing is refused: an over-capacity choice is allowed,
 * it is just made with the number in view.
 */
export function AssigneePicker({ taskId, value, onChange }: { taskId: string; value: string; onChange: (userId: string) => void }) {
  const { data, isLoading } = useQuery<{ hours: number; by: string | null; window: { from: string; to: string }; candidates: Candidate[] }>({
    queryKey: ['/tasks/suggest-assignee', taskId],
    queryFn: () => apiGet('/tasks/suggest-assignee', { taskId, limit: '8' }),
  });
  if (isLoading) return <LoadingBlock label={tr('در حال سنجش ظرفیت…')} />;
  if (!data?.candidates.length) return <p className="text-xs text-ink-500">{tr('فردی در این واحد برای پیشنهاد یافت نشد — مسئول را از فهرست کاربران انتخاب کنید.')}</p>;

  return (
    <div className="space-y-2" data-testid="assignee-picker">
      <p className="text-[11px] text-ink-500">{tr('{0} ساعت کار{1} — ظرفیت آزاد هر فرد تا {2}، روی تقویم خودش', localDigits(data.hours), data.by ? tr(' با موعد {0}', formatDate(data.by)) : '', formatDate(data.window.to))}</p>
      {data.candidates.map((c) => {
        const picked = value === c.load.userId;
        return (
          <button
            type="button"
            key={c.load.userId}
            onClick={() => onChange(c.load.userId)}
            aria-pressed={picked}
            className={cx(
              'w-full rounded-lg px-3 py-2 text-start ring-1 transition',
              picked ? 'bg-brand-50 ring-brand-400' : 'bg-surface ring-ink-200/70 hover:bg-ink-50/60',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-ink-800">{c.load.fullName}</span>
              {c.load.jobTitle && <span className="text-[11px] text-ink-400">{trx(c.load.jobTitle)}</span>}
              <span className="ms-auto nums text-[11px] text-ink-500">{tr('{0} ساعت آزاد', localDigits(c.load.remainingHours))}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="w-28">
                <ProgressBar value={c.utilisationAfter}
                  tone={c.utilisationAfter > 100 ? 'danger' : c.utilisationAfter >= 85 ? 'warning' : 'success'} />
              </div>
              <span className="nums text-[11px] text-ink-500">{tr('{0}٪ → {1}٪ با این وظیفه', localDigits(c.load.utilisation), localDigits(c.utilisationAfter))}</span>
              {c.missesDueDate
                ? <Badge tone="danger">{tr('تا {0} تمام می‌کند', formatDate(c.earliestFinish))}</Badge>
                : <Badge tone="success">{tr('تا {0}', formatDate(c.earliestFinish))}</Badge>}
            </div>
            <ul className="mt-1 space-y-0.5 text-[11px] text-ink-500">
              {c.reasonsFa.map((r, i) => <li key={i}>· {r}</li>)}
              {c.warningsFa.map((w, i) => <li key={`w${i}`} className="text-amber-700">⚠ {w}</li>)}
            </ul>
          </button>
        );
      })}
    </div>
  );
}
