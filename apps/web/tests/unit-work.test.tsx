import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { TaskGlance } from '../src/components/TaskGlance';
import Quality from '../src/pages/Quality';
import { hrefOf } from '../src/lib/plain';

/**
 * The owner's brief (2026-11-02): a unit's person sees in one place what is asked, who asked, for
 * which project, what to hand in and its files, by when — and does the next step from there; a unit's
 * manager has two decisions, approve and forward or send back for correction with a clear reason.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = (permissions: string[]) => ({ id: 'u1', email: 'x@hiva.local', fullName: 'x', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions, locale: 'fa', mustChangePassword: false });

function mount(node: React.ReactNode, permissions: string[], api: (p: string, method: string) => unknown, at = '/') {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(user(permissions));
    if (p.endsWith('/preflight')) return json({ state: 'x', transitions: [] });
    const answer = api(p, method);
    if (answer !== undefined) return json(answer, method === 'POST' ? 201 : 200);
    return json(method === 'GET' ? [] : {}, method === 'POST' ? 201 : 200);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter initialEntries={[at]}><Routes><Route path="*" element={node} /></Routes></MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

const TASK = (over: Record<string, unknown> = {}) => ({
  id: 't-1', code: 'TSK-000031', title: 'طراحی بنر', description: null, state: 'IN_PROGRESS', dueDate: '2026-11-20T00:00:00.000Z',
  createdById: 'u-am', deliverableId: 'd-1', project: { id: 'pr-1', name: 'کمپین بانک' }, assignee: { fullName: 'بهراد مهرنیا' },
  workOrder: { id: 'w-1', code: 'WO-000011', title: 'خلاقیت — بانک' },
  availableTransitions: [{ action: 'submit', labelFa: 'تحویل خروجی', labelEn: 'Submit', requiresReason: false, to: 'SUBMITTED' }, { action: 'block', labelFa: 'اعلام مانع/تأخیر', labelEn: 'Block', requiresReason: true, to: 'BLOCKED' }],
  ...over,
});
const unitApi = (p: string) => {
  if (p === '/work-orders/w-1') return { id: 'w-1', scopeOfWork: 'بنر کمپین پاییز در سه اندازه', brief: 'معرفی کارت تازه به جوانان', expectedOutput: 'سه بنر', outputFormat: 'PSD و PDF', owner: { fullName: 'سپیده آذر' }, project: { company: { legalName: 'بانک آینده‌سازان' } } };
  if (p === '/people') return [{ id: 'u-am', fullName: 'سپیده آذر', jobTitle: 'مدیر اکانت' }];
  if (p === '/documents') return [{ id: 'doc-1', fileName: 'banner-v1.pdf', mimeType: 'application/pdf' }];
  if (p === '/workflow/task/t-1/history') return [{ id: 'h', toState: 'REVISION_REQUIRED', reason: 'رنگ‌ها با هویت بصری نمی‌خواند', createdAt: new Date().toISOString(), actor: { fullName: 'سپیده آذر' } }];
  return undefined;
};

describe('A unit’s task, at a glance', () => {
  it('says what is asked, by whom, for what, what to hand in and by when — with its files and the one next step', async () => {
    mount(<TaskGlance task={TASK() as never} />, ['task.read', 'workorder.read', 'document.read', 'document.write', 'task.execute'], unitApi);
    const card = await screen.findByTestId('task-glance');
    await waitFor(() => expect(card.textContent).toContain('بنر کمپین پاییز در سه اندازه'));
    expect(card.textContent).toContain('سپیده آذر');
    expect(card.textContent).toContain('بانک آینده‌سازان');
    expect(card.textContent).toContain('سه بنر — قالب: PSD و PDF');
    expect(card.textContent).toContain('بهراد مهرنیا');
    expect(await within(card).findByRole('button', { name: 'banner-v1.pdf' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'گذاشتن فایل خروجی' })).toBeTruthy();
    expect(card.textContent).toContain('وقتی کار آماده شد، خروجی را تحویل دهید.');
    expect(within(card).getByRole('button', { name: 'تحویل خروجی' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'اعلام مانع/تأخیر' })).toBeNull();
  });

  it('says who sent it back and why', async () => {
    mount(<TaskGlance task={TASK({ state: 'REVISION_REQUIRED', availableTransitions: [{ action: 'start', labelFa: 'شروع کار', labelEn: 'Start', requiresReason: false, to: 'IN_PROGRESS' }] }) as never} />,
      ['task.read', 'workorder.read', 'document.read'], unitApi);
    const note = await screen.findByTestId('return-note');
    expect(note.textContent).toContain('«رنگ‌ها با هویت بصری نمی‌خواند»');
    expect(screen.getByRole('button', { name: 'شروع کار' })).toBeTruthy();
  });
});

describe('A unit manager’s decision', () => {
  it('opens from the work card on the item itself', () => {
    const item = { kind: 'qcUnit', entityType: 'deliverable', entityId: 'd-1', code: 'DLV-1', title: 'بنر', state: 'SUBMITTED', projectCode: null, projectName: null, dueAt: null, sla: null, href: '/qc', availableTransitions: [] };
    expect(hrefOf(item)).toBe('/qc?tab=unit&review=d-1');
    expect(hrefOf({ ...item, kind: 'qcFinal' })).toBe('/qc?tab=final&review=d-1');
  });

  it('is two plain choices, and sending back needs a clear reason', async () => {
    const sent = mount(<Quality />, ['qc.read', 'qc.unit', 'deliverable.read'], (p, m) => {
      if (p === '/qc/queue') return {
        unit: [{ id: 'd-1', code: 'DLV-000031', name: 'بنر پاییز', departmentCode: 'CR', state: 'SUBMITTED', project: { id: 'pr-1', name: 'کمپین بانک' }, qcReviews: [], availableTransitions: [] }],
        account: [], final: [], revisions: [], counts: { unit: 1, account: 0, final: 0, revisions: 0, overdueRevisions: 0 },
      };
      if (p === '/deliverables/d-1/annotations') return { annotations: [] };
      if (p === '/qc-reviews' && m === 'POST') return { review: { id: 'r-1' }, revision: { code: 'REV-000004' } };
      return undefined;
    }, '/qc?tab=unit&review=d-1');
    const decision = await screen.findByTestId('qc-decision');
    const dialog = decision.closest('[role="dialog"]') as HTMLElement;
    const submit = () => within(dialog).getAllByRole('button').at(-1) as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    fireEvent.click(within(decision).getByRole('button', { name: /برگرداندن برای اصلاح/ }));
    expect(submit().textContent).toBe('برگرداندن برای اصلاح');
    expect(submit().disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'با بریف نمی‌خواند' }));
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && s.path === '/qc-reviews')).toBe(true));
    expect(sent.find((s) => s.method === 'POST' && s.path === '/qc-reviews')!.body).toMatchObject({ level: 'UNIT', deliverableId: 'd-1', verdict: 'FAILED', findings: 'با بریف نمی‌خواند' });
  });
});
