import type { ReactNode } from 'react';
import { localDigits } from '../lib/format';
import { cx } from './ui';
import { tr } from '../i18n';

/**
 * A guided journey (the owner's brief, 2026-11-02: "break complex processes into understandable
 * steps"): the steps of a piece of work as a person does them, each done, being done, or ahead — and
 * each step's own section on the page, numbered the same way. Nothing here decides anything: a step is
 * done when the records the page reads say so.
 */

export interface JourneyStep { key: string; label: string; done: boolean }

/** The step to work on now: the first not yet done. */
export const currentStep = (steps: JourneyStep[]) => steps.findIndex((s) => !s.done);

export function JourneySteps({ steps }: { steps: JourneyStep[] }) {
  const now = currentStep(steps);
  return (
    <ol className="flex gap-1 overflow-x-auto rounded-xl bg-surface px-3 py-3 ring-1 ring-edge" aria-label={tr('گام‌ها')} data-testid="journey-steps" data-tour="journey">
      {steps.map((s, i) => (
        <li key={s.key} aria-current={i === now ? 'step' : undefined}
          className={cx('flex min-w-[7rem] flex-1 flex-col items-center gap-1 text-center text-[12.5px] leading-5',
            i === now ? 'font-semibold text-ink-900' : s.done ? 'text-emerald-700' : 'text-ink-400')}>
          <span className={cx('grid size-7 place-items-center rounded-full text-[12px] ring-1',
            i === now ? 'bg-brand-100 text-brand-800 ring-brand-500' : s.done ? 'bg-emerald-50 ring-emerald-300' : 'bg-ink-50 ring-ink-200')}>
            {s.done ? '✓' : localDigits(i + 1)}
          </span>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

/** One step's section: its number, what it is for, and its work. */
export function StepSection({ n, title, hint, done, children, tour }: {
  n: number; title: string; hint?: string; done?: boolean; children: ReactNode;
  /** Where the owl's tour of the page points at this step. */
  tour?: string;
}) {
  return (
    <section aria-label={title} data-tour={tour} className="rounded-xl bg-surface p-4 ring-1 ring-edge">
      <h2 className="flex items-center gap-2 text-[15px] font-bold text-ink-900">
        <span className={cx('grid size-7 place-items-center rounded-full text-[12.5px] ring-1', done ? 'bg-emerald-50 text-emerald-700 ring-emerald-300' : 'bg-brand-50 text-brand-800 ring-brand-300')}>
          {done ? '✓' : localDigits(n)}
        </span>
        {title}
      </h2>
      {hint && <p className="mt-1 text-sm leading-7 text-ink-500">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
