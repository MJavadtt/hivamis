import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import MyWork from '../src/pages/MyWork';

/**
 * The queue renders in the server's order, says how much of each clock is left, and puts the
 * item's own actions on the row — the work is done from the list, not from five pages.
 */
const queue = {
  kinds: { task: 'وظیفه', workOrder: 'سفارش کار', formApproval: 'تأیید فرم' },
  counts: { task: 2, workOrder: 1, formApproval: 1 },
  breached: 1, atRisk: 0,
  items: [
    {
      kind: 'task', entityType: 'task', entityId: 't-late', code: 'TSK-000009', title: 'وظیفهٔ دیرشده', state: 'ASSIGNED',
      projectCode: 'PRJ-000002', projectName: 'کمپین', dueAt: '2026-10-01T00:00:00.000Z', href: '/tasks/t-late',
      sla: { policyCode: 'SLA_REVISION', labelFa: 'اصلاحیه', state: 'BREACHED', dueAt: '2026-09-01T00:00:00.000Z', budgetHours: 8, controlledHours: 11 },
      availableTransitions: [{ action: 'accept', labelFa: 'پذیرش', labelEn: 'Accept', requiresReason: false, to: 'ACCEPTED' }],
    },
    {
      kind: 'workOrder', entityType: 'workOrder', entityId: 'w-1', code: 'WO-000003', title: 'طراحی UI', state: 'ISSUED',
      projectCode: 'PRJ-000002', projectName: 'کمپین', dueAt: null, href: '/work-orders/w-1',
      sla: { policyCode: 'SLA_TASK_ACCEPTANCE', labelFa: 'پذیرش سفارش', state: 'RUNNING', dueAt: '2026-09-30T00:00:00.000Z', budgetHours: 4, controlledHours: 1.5 },
      availableTransitions: [{ action: 'accept', labelFa: 'پذیرش سفارش', labelEn: 'Accept order', requiresReason: false, to: 'ACCEPTED' }],
    },
    {
      kind: 'formApproval', entityType: 'formSubmission', entityId: 'f-1', code: 'FRM-000004', title: 'فرم تکمیل بریف', state: 'PENDING_APPROVAL',
      projectCode: null, projectName: null, dueAt: null, href: '/forms', sla: null, availableTransitions: [],
    },
    {
      kind: 'task', entityType: 'task', entityId: 't-calm', code: 'TSK-000010', title: 'وظیفهٔ آرام', state: 'ASSIGNED',
      projectCode: null, projectName: null, dueAt: '2026-12-01T00:00:00.000Z', href: '/tasks/t-calm', sla: null,
      availableTransitions: [{ action: 'accept', labelFa: 'پذیرش', labelEn: 'Accept', requiresReason: false, to: 'ACCEPTED' }],
    },
  ],
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function mount() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/preflight')) return json({ state: 'x', transitions: [] });
    return json(queue);
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter><MyWork /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('My work', () => {
  it('keeps the server’s order — the breached item first', async () => {
    mount();
    const list = await screen.findByTestId('my-work');
    const titles = [...list.querySelectorAll(':scope > li')].map((li) => li.textContent ?? '');
    expect(titles[0]).toContain('وظیفهٔ دیرشده');
    expect(titles[0]).toContain('نقض شده');
    expect(titles[3]).toContain('وظیفهٔ آرام');
  });

  it('says how much of a running clock is left, in working hours', async () => {
    mount();
    const list = await screen.findByTestId('my-work');
    expect(list.textContent).toContain('پذیرش سفارش: ۲.۵ ساعت کاری مانده');
  });

  it('puts the item’s own actions on the row, and a link where there are none', async () => {
    mount();
    await screen.findByTestId('my-work');
    expect(screen.getAllByRole('button', { name: /پذیرش/ }).length).toBeGreaterThanOrEqual(3);
    const open = screen.getByRole('link', { name: 'باز کردن' });
    expect(open.getAttribute('href')).toBe('/forms');
  });

  it('filters by kind', async () => {
    mount();
    await screen.findByTestId('my-work');
    fireEvent.click(screen.getByRole('button', { name: /^سفارش کار/ }));
    const list = screen.getByTestId('my-work');
    expect(list.querySelectorAll(':scope > li')).toHaveLength(1);
    expect(list.textContent).toContain('طراحی UI');
    fireEvent.click(screen.getByRole('button', { name: 'همه' }));
    expect(screen.getByTestId('my-work').querySelectorAll(':scope > li')).toHaveLength(4);
  });
});
