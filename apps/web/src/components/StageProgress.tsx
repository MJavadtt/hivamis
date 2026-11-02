import { useEffect, useRef } from 'react';
import { stateLabelFa } from '@hiva/contracts';
import { STAGE, forwardMove, stageOf, type Transition } from '../lib/plain';
import { cx } from './ui';
import { localDigits } from '../lib/format';
import { loc, tr, trx } from '../i18n';

/**
 * Where a record stands on its road (the owner's brief, 2026-11-02: "show the current stage, the one
 * before and the next, without the workflow engine's details"): the main steps of its process in order,
 * the step it is on, and in one sentence what comes next and whether it is the reader's to take.
 * Drawn from the record's own state and the moves the server says the reader may make — nothing is
 * decided here.
 */

/** The main road of each process, in order. */
const ROADS: Record<string, string[]> = {
  lead: ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED'],
  opportunity: ['NEW', 'QUALIFIED', 'BRIEF_REQUESTED', 'BRIEF_COMPLETED', 'PROPOSAL', 'NEGOTIATION', 'WON'],
  brief: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED'],
  proposal: ['DRAFT', 'AWAITING_UNIT_OUTPUTS', 'INTEGRATION', 'PRICING', 'FINAL_QC', 'APPROVED', 'DELIVERED_TO_SALES', 'PRESENTED_TO_CLIENT', 'CLIENT_APPROVED'],
  project: ['DRAFT', 'PENDING_AUTHORIZATION', 'AUTHORIZED', 'PLANNING', 'ACTIVE', 'COMPLETED', 'PENDING_CLOSURE', 'CLOSED'],
  workOrder: ['DRAFT', 'ISSUED', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETED'],
  task: ['CREATED', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'SUBMITTED', 'IN_QC', 'APPROVED', 'CLOSED'],
  changeRequest: ['SUBMITTED', 'SCOPE_REVIEW', 'COMMERCIAL_REVIEW', 'PENDING_CUSTOMER_APPROVAL', 'APPROVED', 'IMPLEMENTING', 'CLOSED'],
  contract: ['REQUESTED', 'DRAFTING', 'LEGAL_REVIEW', 'INTERNAL_APPROVED', 'PENDING_SIGNATURE', 'SIGNED', 'REGISTERED'],
  booking: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'COMPLETED'],
};

/** Where a state off the road sits on it: sent back to a step, or stopped at one. */
const ON_ROAD: Record<string, Record<string, string>> = {
  task: { REVISION_REQUIRED: 'IN_PROGRESS', BLOCKED: 'IN_PROGRESS' },
  brief: { RETURNED_INCOMPLETE: 'DRAFT' },
  booking: { CHANGES_REQUESTED: 'DRAFT' },
  contract: { REVISION_REQUESTED: 'DRAFTING' },
  workOrder: { CLARIFICATION_REQUESTED: 'PENDING_ACCEPTANCE' },
  proposal: { CLIENT_REVISION_REQUESTED: 'DELIVERED_TO_SALES', CLIENT_REJECTED: 'PRESENTED_TO_CLIENT' },
  project: { ON_HOLD: 'ACTIVE' },
};

const label = (state: string) => trx(stateLabelFa(state));

/** The step a record is on, its index on the road, and what that says about it. */
export function placeOn(entity: string, state: string) {
  const road = ROADS[entity] ?? [];
  const at = road.indexOf(ON_ROAD[entity]?.[state] ?? state);
  return { road, at, stage: stageOf(state, entity) };
}

export function StageProgress({ entity, state, transitions, owner, inline }: {
  entity: string; state: string; transitions?: Transition[]; owner?: string | null;
  /** Inside a card or a page body, without the margins it takes under a page's header. */
  inline?: boolean;
}) {
  const { road, at, stage } = placeOn(entity, state);
  const steps = useRef<HTMLOListElement>(null);
  // On a narrow screen the road scrolls: the step it is on is the one brought into view.
  useEffect(() => {
    const here = steps.current?.querySelector<HTMLElement>('[aria-current="step"]');
    if (here && steps.current && steps.current.scrollWidth > steps.current.clientWidth) {
      steps.current.scrollLeft += here.getBoundingClientRect().left - steps.current.getBoundingClientRect().left - steps.current.clientWidth / 2 + here.clientWidth / 2;
    }
  }, [state]);
  if (!road.length) return null;
  const move = forwardMove(transitions ?? []);
  const off = at < 0;
  const ended = !off && at === road.length - 1;
  const sentence = stage === 'cancelled'
    ? tr('«{0}» است و دیگر جلو نمی‌رود.', label(state))
    : ended ? tr('این مسیر به پایان رسیده است.')
      : move ? tr('گام بعد با شماست: «{0}» — دکمه‌اش در همین صفحه است.', loc(move, 'label'))
        : !off && road[at + 1] ? tr('گام بعد: «{0}» — با کسی است که این گام به او سپرده شده.', label(road[at + 1]!)) : '';

  return (
    <section className={cx('rounded-xl bg-surface px-4 py-3 ring-1 ring-edge', !inline && 'mx-3 mt-3 sm:mx-5')} aria-label={tr('مسیر کار')} data-testid="stage-progress" data-tour="stage">
      <ol ref={steps} className="flex gap-1 overflow-x-auto pb-1" aria-label={tr('گام‌ها')}>
        {road.map((s, i) => {
          const here = i === at;
          const done = !off && i < at;
          return (
            <li key={s} aria-current={here ? 'step' : undefined}
              className={cx('flex min-w-[6.5rem] flex-1 flex-col items-center gap-1 text-center text-[12px] leading-5',
                here ? 'font-semibold text-ink-900' : done ? 'text-emerald-700' : 'text-ink-400')}>
              <span className={cx('grid size-6 place-items-center rounded-full text-[12px] ring-1',
                here ? (stage === 'returned' ? 'bg-amber-100 ring-amber-400 text-amber-800' : stage === 'stopped' ? 'bg-rose-100 ring-rose-400 text-rose-800' : 'bg-brand-100 ring-brand-500 text-brand-800')
                  : done ? 'bg-emerald-50 ring-emerald-300' : 'bg-ink-50 ring-ink-200')}>
                {done ? '✓' : localDigits(i + 1)}
              </span>
              {label(s)}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-sm leading-7 text-ink-700">
        <span className="font-medium">{tr('اکنون: «{0}»', label(state))}</span>
        {(stage === 'returned' || stage === 'stopped') && <span className={stage === 'returned' ? 'text-amber-700' : 'text-rose-700'}>{' — '}{STAGE[stage].label}</span>}
        {sentence && <>{tr('. ')}{sentence}</>}
        {owner && <span className="text-ink-500">{' '}{tr('مسئول: {0}', owner)}</span>}
      </p>
    </section>
  );
}
