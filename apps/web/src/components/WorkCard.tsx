import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { daysFromNow, formatDate, formatRelative, localDigits } from '../lib/format';
import { STAGE, forwardMove, groupOf, hrefOf, isDecision, stageOf, whatToDo, type WorkItem } from '../lib/plain';
import { WorkflowActions } from './common';
import { Badge, Button, cx } from './ui';
import { tr } from '../i18n';

/**
 * One piece of work, read at a glance (the owner's brief, 2026-11-02): what it is, whose project,
 * where it stands in plain words, what to do now, by when — and one button that does it. The rest
 * of what can be done with it is on its own page, one click away.
 */

/** Where a record stands, in plain words; its own state is in the tooltip for whoever needs it. */
export function StagePill({ state, entity }: { state: string; entity?: string }) {
  const s = STAGE[stageOf(state, entity)];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** By when, as a person says it — and in red once it has passed. */
export function DueText({ at }: { at: string | null }) {
  if (!at) return null;
  const days = daysFromNow(at) ?? 0;
  return (
    <span className={cx(days < 0 ? 'font-medium text-rose-700' : days <= 1 ? 'font-medium text-amber-700' : 'text-ink-500')} title={formatDate(at)}>
      {days < 0 ? tr('{0} روز از مهلت گذشته', localDigits(-days)) : tr('مهلت: {0}', formatRelative(at))}
    </span>
  );
}

interface HistoryRow { id: string; toState: string; reason: string | null; createdAt: string; actor: { fullName: string } | null }

/** Who sent it back (or asked about it), when, and why — read from the record's own history. */
export function ReturnNote({ entity, id, state }: { entity: string; id: string; state: string }) {
  const { data } = useQuery<HistoryRow[]>({
    queryKey: [`/workflow/${entity}/${id}/history`],
    queryFn: () => apiGet(`/workflow/${entity}/${id}/history`),
    retry: false, staleTime: 60_000,
  });
  const back = data?.find((t) => t.toState === state);
  if (!back) return null;
  return (
    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] leading-6 text-amber-900" data-testid="return-note">
      {(state === 'CLARIFICATION_REQUESTED' ? tr('{0} {1} پرسید', back.actor?.fullName ?? tr('کسی'), formatRelative(back.createdAt)) : tr('{0} {1} برگرداند', back.actor?.fullName ?? tr('کسی'), formatRelative(back.createdAt)))}
      {back.reason ? <>{tr(': ')}<span className="font-medium">«{back.reason}»</span></> : '.'}
    </p>
  );
}

export function WorkCard({ item, onDone }: { item: WorkItem; onDone?: () => void }) {
  const href = hrefOf(item);
  const group = groupOf(item);
  const move = isDecision(item) ? null : forwardMove(item.availableTransitions);
  const late = item.sla?.state === 'BREACHED' || (!!item.dueAt && (daysFromNow(item.dueAt) ?? 0) < 0);
  return (
    <article
      className={cx('rounded-xl bg-surface p-4 ring-1 ring-edge', group === 'returned' && 'ring-amber-300', late && group !== 'returned' && 'ring-rose-200')}
      data-testid="work-card" data-group={group}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link to={href} className="text-[15px] font-semibold text-ink-900 hover:underline">{item.title}</Link>
          {item.projectName && <p className="mt-0.5 text-xs text-ink-500">{tr('پروژهٔ {0}', item.projectName)}</p>}
        </div>
        <StagePill state={item.state} entity={item.entityType} />
      </div>
      <p className="mt-2 text-sm leading-7 text-ink-700">{whatToDo(item)}</p>
      {/* Only a state that means "sent back": a correction being worked on got there by being started. */}
      {stageOf(item.state, item.entityType) === 'returned' && <ReturnNote entity={item.entityType} id={item.entityId} state={item.state} />}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs">
          <DueText at={item.sla?.dueAt ?? item.dueAt} />
          {item.sla?.risk && item.sla.risk.risk !== 'WATCH' && !late && <span className="ms-2 text-amber-700">{tr('ممکن است دیر شود')}</span>}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {isDecision(item)
            ? <Link to={href}><Button size="sm" variant="primary">{tr('بررسی و تصمیم')}</Button></Link>
            : move
              ? <WorkflowActions minimal entity={item.entityType} id={item.entityId} transitions={[move]} onDone={onDone} />
              : null}
          <Link to={href}><Button size="sm" variant="ghost">{move || isDecision(item) ? tr('جزئیات') : tr('باز کردن')}</Button></Link>
        </div>
      </div>
    </article>
  );
}
