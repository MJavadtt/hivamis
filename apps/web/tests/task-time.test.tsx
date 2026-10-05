import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui';
import { setAccessToken, setRefreshToken } from '../src/lib/api';
import { TaskTime } from '../src/components/TaskTime';
import { WorkflowActions } from '../src/components/common';

const ME = { id: 'u-designer', email: 'd@hiva.local', fullName: 'طراح', jobTitle: '', departmentCode: 'CR', roles: [], permissions: ['task.read'], locale: 'fa' };
const time = { estimateHours: '10', actualHours: '7.5', entries: [{ id: 'e1', hours: '3.5', workedOn: '2026-09-20', note: 'وایرفریم', user: { id: 'u-designer', fullName: 'طراح' } }] };
function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
function serve() {
  const calls: { url: string; method: string; body?: any }[] = [];
  setAccessToken('t'); setRefreshToken('r');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/auth/refresh')) return json({ accessToken: 't', refreshToken: 'r' });
    if (url.includes('/auth/me')) return json(ME);
    if (url.includes('/transitions')) return json({ toState: 'SUBMITTED' });
    if (url.includes('/preflight')) return json({ state: 'x', transitions: [] });
    if (url.includes('/time') && method === 'POST') return json({ actualHours: 9.5 });
    return json(time);
  }));
  return calls;
}
const wrap = (el: JSX.Element) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><AuthProvider><MemoryRouter>{el}</MemoryRouter></AuthProvider></ToastProvider></QueryClientProvider>);
};
beforeEach(() => { vi.restoreAllMocks(); });

describe('Time on a task', () => {
  it('shows the estimate beside the actual and lets the assignee log hours', async () => {
    const calls = serve();
    wrap(<TaskTime taskId="t1" assigneeId="u-designer" />);
    const list = await screen.findByTestId('time-entries');
    expect(list.textContent).toContain('۳٫۵ س');
    expect(list.textContent).toContain('وایرفریم');
    expect(screen.getByText(/برآورد ۱۰ س · واقعی ۷٫۵ س/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ساعت'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/tasks/t1/time'))).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.url.includes('/time'))!.body).toMatchObject({ hours: 2 });
  });

  it('asks for hours when a task is submitted, and sends them as the payload', async () => {
    const calls = serve();
    wrap(<WorkflowActions entity="task" id="t1" transitions={[{ action: 'submit', labelFa: 'تحویل', labelEn: 'Submit', requiresReason: false, to: 'SUBMITTED' }]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'تحویل' }));
    const field = await screen.findByLabelText('ساعت‌های صرف‌شده');
    fireEvent.change(field, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت و ادامه' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/transitions'))).toBe(true));
    expect(calls.find((c) => c.url.includes('/transitions'))!.body).toEqual({ action: 'submit', payload: { hours: '8' } });
  });
});
