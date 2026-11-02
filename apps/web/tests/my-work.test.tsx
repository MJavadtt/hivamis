import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import MyWork from '../src/pages/MyWork';
import { forwardMove, groupOf, stageOf, whatToDo } from '../src/lib/plain';

/**
 * The owner's brief (2026-11-02): a person sees what to do, not how the system works. Each piece of
 * work is a card that says in plain words where it stands and what to do, with one button that does
 * it; work that came back says who sent it back and why; the queue is sorted the way a person
 * thinks about it — what came back, what is late, what waits on their decision, the rest.
 */
const queue = {
  kinds: { task: 'وظیفه', workOrder: 'سفارش کار', formApproval: 'تأیید فرم' },
  counts: { task: 3, workOrder: 1, formApproval: 1 },
  breached: 1, atRisk: 0,
  items: [
    {
      kind: 'task', entityType: 'task', entityId: 't-late', code: 'TSK-000009', title: 'وظیفهٔ دیرشده', state: 'ASSIGNED',
      projectCode: 'PRJ-000002', projectName: 'کمپین', dueAt: '2026-10-01T00:00:00.000Z', href: '/tasks/t-late',
      sla: { policyCode: 'SLA_REVISION', labelFa: 'اصلاحیه', state: 'BREACHED', dueAt: '2026-09-01T00:00:00.000Z', budgetHours: 8, controlledHours: 11 },
      availableTransitions: [{ action: 'accept', labelFa: 'پذیرش', labelEn: 'Accept', requiresReason: false, to: 'ACCEPTED' }],
    },
    {
      kind: 'task', entityType: 'task', entityId: 't-back', code: 'TSK-000011', title: 'لوگوی کمپین', state: 'REVISION_REQUIRED',
      projectCode: 'PRJ-000002', projectName: 'کمپین', dueAt: null, href: '/tasks/t-back', sla: null,
      availableTransitions: [{ action: 'start', labelFa: 'شروع کار', labelEn: 'Start work', requiresReason: false, to: 'IN_PROGRESS' }],
    },
    {
      kind: 'workOrder', entityType: 'workOrder', entityId: 'w-1', code: 'WO-000003', title: 'طراحی UI', state: 'ISSUED',
      projectCode: 'PRJ-000002', projectName: 'کمپین', dueAt: null, href: '/work-orders/w-1', sla: null,
      availableTransitions: [
        { action: 'request_clarification', labelFa: 'اعلام ابهام', labelEn: 'Ask', requiresReason: true, to: 'CLARIFICATION_REQUESTED' },
        { action: 'accept', labelFa: 'پذیرش سفارش', labelEn: 'Accept order', requiresReason: false, to: 'ACCEPTED' },
      ],
    },
    {
      kind: 'formApproval', entityType: 'formSubmission', entityId: 'f-1', code: 'FRM-000004', title: 'فرم تکمیل بریف', state: 'PENDING_APPROVAL',
      projectCode: null, projectName: null, dueAt: null, href: '/forms', sla: null, availableTransitions: [],
    },
    {
      kind: 'task', entityType: 'task', entityId: 't-done', code: 'TSK-000012', title: 'بنر تحویل‌شده', state: 'SUBMITTED',
      projectCode: null, projectName: null, dueAt: null, href: '/tasks/t-done', sla: null, availableTransitions: [],
    },
  ],
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const USER = { id: 'u1', email: 'x@hiva.local', fullName: 'x', jobTitle: '', departmentCode: 'CR', roles: [], permissions: ['task.read'], locale: 'fa' };
function mount() {
  setAccessToken('t'); markSignedIn(true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/refresh')) return json({ accessToken: 't', refreshToken: 'r' });
    if (url.includes('/auth/me')) return json(USER);
    if (url.includes('/preflight')) return json({ state: 'x', transitions: [] });
    if (url.includes('/workflow/task/t-back/history')) {
      return json([{ id: 'h1', toState: 'REVISION_REQUIRED', reason: 'رنگ لوگو با هویت بصری نمی‌خواند', createdAt: new Date().toISOString(), actor: { fullName: 'سپیده آذر' } }]);
    }
    return json(queue);
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider><MemoryRouter><MyWork /></MemoryRouter></AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const card = (title: string) => screen.getAllByTestId('work-card').find((c) => c.textContent?.includes(title))!;

describe('My work, in plain words', () => {
  it('reads every state as one of a few things a person needs to know', () => {
    expect(['ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'REVISION_REQUIRED', 'BLOCKED', 'APPROVED', 'CLOSED', 'CANCELLED'].map((s) => stageOf(s, 'task')))
      .toEqual(['new', 'progress', 'waiting', 'returned', 'stopped', 'approved', 'done', 'cancelled']);
    expect(stageOf('SENT', 'invoice')).toBe('progress');
    expect(queue.items.map((i) => groupOf(i as never))).toEqual(['urgent', 'returned', 'todo', 'decide', 'waiting']);
    // Handed in, but the next step is this person's too: it is still theirs to do.
    const own = { ...queue.items[4]!, availableTransitions: [{ action: 'send_to_qc', labelFa: 'ارسال به کنترل کیفیت', labelEn: 'Send to QC', requiresReason: false, to: 'IN_QC' }] };
    expect(groupOf(own as never)).toBe('todo');
    expect(whatToDo(own as never)).toBe('تحویل داده شده و گام بعد با شماست: «ارسال به کنترل کیفیت».');
    // Sending handed-in work back is a choice beside the way forward, never the way forward itself.
    const t = (action: string) => ({ action, labelFa: action, labelEn: action, requiresReason: false, to: 'X' });
    expect(forwardMove([t('reopen'), t('complete')])?.action).toBe('complete');
    expect(forwardMove([t('client_request_revision'), t('client_approve')])?.action).toBe('client_approve');
    expect(forwardMove([t('escalate'), t('expire')])).toBeNull();
  });

  it('says in one sentence how the day looks, and sorts the work as a person would', async () => {
    mount();
    expect((await screen.findByTestId('work-summary')).textContent)
      .toBe('۴ کار با شماست، ۱ کار برای اصلاح برگشته، ۱ کار فوری است، ۱ مورد منتظر تصمیم شماست.');
    const sections = [...screen.getByTestId('my-work').querySelectorAll('section')].map((s) => s.getAttribute('aria-label'));
    expect(sections).toEqual(['برگشت برای اصلاح', 'فوری', 'منتظر تصمیم شما', 'کارهای من', 'تحویل داده‌ام']);
  });

  it('gives each card its status and what to do in plain words, and one button that does it', async () => {
    mount();
    await screen.findByTestId('my-work');
    const late = card('وظیفهٔ دیرشده');
    expect(late.textContent).toContain('تازه');
    expect(late.textContent).toContain('این کار به شما سپرده شده است. اول آن را بپذیرید.');
    expect(late.textContent).toMatch(/روز از مهلت گذشته/);
    expect(within(late).getByRole('button', { name: 'پذیرش' })).toBeTruthy();
    // The way forward is the main button; asking a question stays on the order's own page.
    const order = card('طراحی UI');
    expect(within(order).getByRole('button', { name: 'پذیرش سفارش' })).toBeTruthy();
    expect(within(order).queryByRole('button', { name: 'اعلام ابهام' })).toBeNull();
    // A form opens on itself, to be decided.
    const form = card('فرم تکمیل بریف');
    expect(within(form).getByRole('link', { name: 'بررسی و تصمیم' }).getAttribute('href')).toBe('/forms?tab=inbox&submission=f-1');
    // Handed in: nothing to do but wait.
    expect(card('بنر تحویل‌شده').textContent).toContain('کاری با شما نیست');
  });

  it('says who sent work back, and why', async () => {
    mount();
    await screen.findByTestId('my-work');
    const note = await within(card('لوگوی کمپین')).findByTestId('return-note');
    expect(note.textContent).toContain('سپیده آذر');
    expect(note.textContent).toContain('«رنگ لوگو با هویت بصری نمی‌خواند»');
  });

  it('shows one group at a time when asked', async () => {
    mount();
    await screen.findByTestId('my-work');
    fireEvent.click(screen.getByRole('button', { name: /^منتظر تصمیم شما/ }));
    expect(screen.getAllByTestId('work-card').map((c) => c.textContent)).toEqual([expect.stringContaining('فرم تکمیل بریف')]);
    fireEvent.click(screen.getByRole('button', { name: 'همه' }));
    expect(screen.getAllByTestId('work-card')).toHaveLength(5);
  });
});
