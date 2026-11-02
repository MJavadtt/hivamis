import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { forwardMove, stageOf, whatToDo, type Transition } from '../lib/plain';
import { WorkflowActions } from './common';
import { DueText, ReturnNote, StagePill } from './WorkCard';
import { DeliverableFiles } from './DeliverableFiles';
import { tr } from '../i18n';

/**
 * A task as the person doing it needs it (the owner's brief, 2026-11-02): what is asked, who asked,
 * for which project, what is to be handed in and its files, by when, who is responsible — then what to
 * do now and the one button that does it. Read from the task, its work order and its deliverable.
 */

interface Task {
  id: string; code: string; title: string; description: string | null; state: string; dueDate: string | null;
  createdById: string; deliverableId: string | null; availableTransitions: Transition[];
  project: { id: string; name: string } | null; assignee: { fullName: string } | null; workOrder: { id: string; code: string; title: string } | null;
}
interface Order { id: string; scopeOfWork: string; brief: string; expectedOutput: string; outputFormat: string; owner: { fullName: string } | null; project: { company: { legalName: string } | null } | null }
interface Person { id: string; fullName: string; jobTitle: string | null }

export function TaskGlance({ task: t, onDone }: { task: Task; onDone?: () => void }) {
  const { can } = useAuth();
  const order = useQuery<Order>({ queryKey: [`/work-orders/${t.workOrder?.id}`], queryFn: () => apiGet(`/work-orders/${t.workOrder!.id}`), enabled: !!t.workOrder && can('workorder.read') });
  const people = useQuery<Person[]>({ queryKey: ['/people', ''], queryFn: () => apiGet('/people') });
  const asker = people.data?.find((p) => p.id === t.createdById);
  const o = order.data;
  const move = forwardMove(t.availableTransitions);
  const returned = stageOf(t.state, 'task') === 'returned';


  const rows: [string, React.ReactNode][] = [
    [tr('چه خواسته شده'), o?.scopeOfWork || t.description || t.title],
    [tr('چه کسی خواسته'), [asker?.fullName, o?.owner && o.owner.fullName !== asker?.fullName ? tr('مسئول سفارش: {0}', o.owner.fullName) : null].filter(Boolean).join(' — ') || '—'],
    [tr('پروژه'), t.project ? <Link to={`/projects/${t.project.id}`} className="text-brand-700 hover:underline">{t.project.name}</Link> : '—'],
    [tr('مشتری'), o?.project?.company?.legalName ?? '—'],
    [tr('چه باید تحویل داد'), o ? tr('{0} — قالب: {1}', o.expectedOutput, o.outputFormat) : '—'],
    [tr('مهلت'), <DueText key="due" at={t.dueDate} />],
    [tr('مسئول'), t.assignee?.fullName ?? tr('— هنوز به کسی سپرده نشده —')],
  ];

  return (
    <section aria-label={tr('این کار در یک نگاه')} className="rounded-xl bg-surface p-4 ring-1 ring-edge" data-testid="task-glance" data-tour="task-glance">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold text-ink-900">{tr('این کار در یک نگاه')}</h2>
        <StagePill state={t.state} entity="task" />
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="text-sm">
            <dt className="text-xs text-ink-500">{k}</dt>
            <dd className="mt-0.5 whitespace-pre-line leading-6 text-ink-800">{v}</dd>
          </div>
        ))}
      </dl>
      {o?.brief && (
        <details className="mt-3 rounded-lg bg-ink-50/60 px-3 py-2 text-sm">
          <summary className="cursor-pointer text-ink-700">{tr('توضیح سفارش‌دهنده')}</summary>
          <p className="mt-1 whitespace-pre-line leading-7 text-ink-800">{o.brief}</p>
        </details>
      )}

      {t.deliverableId && (
        <div className="mt-3" data-testid="task-files">
          <p className="mb-1 text-xs text-ink-500">{tr('فایل‌های خروجی')}</p>
          <DeliverableFiles deliverableId={t.deliverableId} />
        </div>
      )}

      <div className="mt-4 space-y-2 border-t border-ink-100 pt-3">
        {returned && <ReturnNote entity="task" id={t.id} state={t.state} />}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-ink-800">{whatToDo({ kind: 'task', entityType: 'task', entityId: t.id, code: t.code, title: t.title, state: t.state, projectCode: null, projectName: null, dueAt: t.dueDate, sla: null, href: '', availableTransitions: t.availableTransitions })}</p>
          {move && <WorkflowActions minimal entity="task" id={t.id} transitions={[move]} onDone={onDone} />}
        </div>
        <p className="text-xs text-ink-500">{tr('سؤال یا توضیحی دارید؟ آن را در «یادداشت‌ها»ی همین کار، پایین‌تر، بنویسید؛ کنار کار می‌ماند و همه می‌بینند.')}</p>
      </div>
    </section>
  );
}
