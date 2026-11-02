import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageProgress, placeOn } from '../src/components/StageProgress';

/**
 * Where a record stands (the owner's brief, 2026-11-02): the steps of its process, the one it is on,
 * and what comes next — the reader's to take, or someone else's.
 */
describe('Where a record stands', () => {
  it('places a sent-back or stopped record on the step it went back to', () => {
    expect(placeOn('task', 'REVISION_REQUIRED')).toMatchObject({ at: 3, stage: 'returned' });
    expect(placeOn('brief', 'RETURNED_INCOMPLETE')).toMatchObject({ at: 0, stage: 'returned' });
    expect(placeOn('project', 'ON_HOLD')).toMatchObject({ at: 4, stage: 'stopped' });
    expect(placeOn('project', 'CANCELLED')).toMatchObject({ at: -1, stage: 'cancelled' });
  });

  it('marks the steps done and the step it is on, and says the next step is the reader’s when it is', () => {
    render(<StageProgress entity="brief" state="SUBMITTED" transitions={[
      { action: 'return_incomplete', labelFa: 'بازگشت برای تکمیل', labelEn: 'Return', requiresReason: true, to: 'RETURNED_INCOMPLETE' },
      { action: 'start_review', labelFa: 'شروع بررسی', labelEn: 'Start review', requiresReason: false, to: 'UNDER_REVIEW' },
    ]} />);
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]!.textContent).toContain('✓');
    expect(steps[1]!.getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('stage-progress').textContent).toContain('گام بعد با شماست: «شروع بررسی»');
  });

  it('says whose the next step is when it is not the reader’s, and when the road has ended', () => {
    const { unmount } = render(<StageProgress entity="workOrder" state="ISSUED" transitions={[]} owner="بهراد مهرنیا" />);
    expect(screen.getByTestId('stage-progress').textContent).toMatch(/گام بعد: «.+» — با کسی است/);
    expect(screen.getByTestId('stage-progress').textContent).toContain('مسئول: بهراد مهرنیا');
    unmount();
    render(<StageProgress entity="contract" state="REGISTERED" />);
    expect(screen.getByTestId('stage-progress').textContent).toContain('این مسیر به پایان رسیده است.');
  });
});
