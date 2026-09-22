import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssigneePicker } from '../src/components/AssigneePicker';

const candidate = (over: Partial<any>) => ({
  load: { userId: 'u1', fullName: 'آزاد یکم', jobTitle: 'طراح', departmentCode: 'CR', capacityHours: 80, committedHours: 0, remainingHours: 80, leaveHours: 0, utilisation: 0, status: 'UNDER_UTILISED', openTasks: 0, overdueTasks: 0 },
  fits: true, utilisationAfter: 20, statusAfter: 'UNDER_UTILISED',
  earliestFinish: '2026-10-01T05:30:00Z', missesDueDate: false,
  history: { doneTasks: 9, onTimePercent: 90, estimateErrorPercent: 12 },
  score: 88, reasonsFa: ['۸۰ ساعت ظرفیت آزاد در این بازه — کار ۱۶ ساعت است'], warningsFa: [],
  ...over,
});

const body = {
  hours: 16, by: '2026-10-05T13:30:00Z', window: { from: '2026-09-22T05:30:00Z', to: '2026-10-05T13:30:00Z' },
  candidates: [
    candidate({}),
    candidate({
      load: { userId: 'u2', fullName: 'پرکار یکم', jobTitle: 'طراح', departmentCode: 'CR', capacityHours: 80, committedHours: 76, remainingHours: 4, leaveHours: 8, utilisation: 95, status: 'AT_CAPACITY', openTasks: 3, overdueTasks: 1 },
      fits: false, utilisationAfter: 115, statusAfter: 'OVER_ALLOCATED', missesDueDate: true, score: 41,
      reasonsFa: ['ظرفیت آزادش ۴ ساعت است و کار ۱۶ ساعت'],
      warningsFa: ['این تخصیص او را به ۱۱۵٪ ظرفیت می‌رساند', 'با کاری که روی دستش است، پیش از موعد این وظیفه تمام نمی‌کند'],
    }),
  ],
};

describe('AssigneePicker', () => {
  it('ranks by free capacity and says what the assignment would cost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onChange = vi.fn();
    render(<QueryClientProvider client={qc}><AssigneePicker taskId="t1" value="" onChange={onChange} /></QueryClientProvider>);

    const picker = await screen.findByTestId('assignee-picker');
    const rows = picker.querySelectorAll('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('آزاد یکم');
    expect(rows[0]!.textContent).toContain('۸۰ ساعت آزاد');
    // The loaded one is offered too — with the cost of choosing them spelled out.
    expect(rows[1]!.textContent).toContain('۱۱۵٪');
    expect(rows[1]!.textContent).toContain('این تخصیص او را به ۱۱۵٪ ظرفیت می‌رساند');
    expect(rows[1]!.textContent).toContain('پیش از موعد این وظیفه تمام نمی‌کند');

    rows[1]!.click();
    expect(onChange).toHaveBeenCalledWith('u2');
  });
});
