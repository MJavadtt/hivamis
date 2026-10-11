import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { SlaClocksCard } from '../src/components/SlaClocks';

/**
 * The card's job is to put the number that matters next to the one people expect, and to let
 * the right people — and only them — stop a deadline, with a reason.
 */
const OWNER = { id: 'u-designer', email: 'designer@hiva.local', fullName: 'طراح', jobTitle: '', departmentCode: 'CR', roles: ['DESIGNER'], permissions: ['project.read'], locale: 'fa' };
const TRAFFIC = { ...OWNER, id: 'u-account', permissions: ['project.read', 'traffic.manage'] };
const BYSTANDER = { ...OWNER, id: 'u-sales', permissions: ['project.read'] };

const running = {
  id: 'c1', state: 'RUNNING', startedAt: '2026-09-05T05:30:00.000Z', dueAt: '2026-09-06T13:30:00.000Z',
  stoppedAt: null, ownerId: 'u-designer', policy: { code: 'SLA_ACCOUNT_QC', labelFa: 'QC اکانت' },
  elapsedHours: 11, pausedHours: 8, controlledHours: 3, budgetHours: 8, pauses: [
    { id: 'p1', kind: 'WAITING_ON_CLIENT', reason: 'منتظر فایل مشتری', pausedAt: '2026-09-05T07:30:00.000Z', resumedAt: '2026-09-06T07:30:00.000Z', businessHours: '8' },
  ],
};
const paused = { ...running, id: 'c2', state: 'PAUSED', pauses: [{ ...running.pauses[0], id: 'p2', resumedAt: null }] };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** fetch keyed by path so each test declares only what it needs. */
function serve(user: unknown, clocks: unknown[]) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/auth/refresh')) return json({ accessToken: 't2', refreshToken: 'r2' });
    if (url.includes('/auth/me')) return json(user);
    if (url.includes('/sla-clocks/') && method === 'POST') return json({ ...paused, state: 'PAUSED' });
    if (url.includes('/sla-clocks')) return json(clocks);
    return json({ error: { message: 'unexpected' } }, 500);
  }));
  return calls;
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider>
          <SlaClocksCard entityType="project" entityId="prj-1" />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => { setAccessToken('t'); markSignedIn(true); });

describe('SLA clocks card', () => {
  it('shows elapsed, waiting and controlled hours side by side, in Persian digits', async () => {
    serve(OWNER, [running]);
    mount();
    const line = await screen.findByTestId('sla-hours');
    expect(line.textContent).toContain('سپری‌شده ۱۱ ساعت');
    expect(line.textContent).toContain('در انتظار دیگران ۸ ساعت');
    expect(line.textContent).toContain('تحت کنترل ما ۳ ساعت');
    expect(line.textContent).toContain('از ۸ ساعت');
  });

  it('lets the owner pause, and sends the kind and reason', async () => {
    const calls = serve(OWNER, [running]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'توقف' }));
    fireEvent.change(screen.getByLabelText('نوع توقف'), { target: { value: 'WAITING_ON_SUPPLIER' } });
    fireEvent.change(screen.getByLabelText('دلیل توقف'), { target: { value: 'منتظر نمونه چاپ' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت توقف' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/sla-clocks/c1/pause'))).toBe(true));
    const post = calls.find((c) => c.url.includes('/sla-clocks/c1/pause'))!;
    expect(post.method).toBe('POST');
    expect(post.body).toEqual({ kind: 'WAITING_ON_SUPPLIER', reason: 'منتظر نمونه چاپ' });
  });

  it('will not submit a pause without a reason', async () => {
    serve(OWNER, [running]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'توقف' }));
    expect((screen.getByRole('button', { name: 'ثبت توقف' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('never offers the machine-only TRANSITION kind', async () => {
    serve(OWNER, [running]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'توقف' }));
    const options = [...screen.getByLabelText('نوع توقف').querySelectorAll('option')].map((o) => o.value);
    expect(options).toContain('WAITING_ON_CLIENT');
    expect(options).not.toContain('TRANSITION');
  });

  it('shows the current pause reason and a resume button to traffic management', async () => {
    const calls = serve(TRAFFIC, [paused]);
    mount();
    expect(await screen.findByText('منتظر فایل مشتری')).toBeTruthy();
    expect(screen.getByText('در انتظار مشتری')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'از سرگیری' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/sla-clocks/c2/resume'))).toBe(true));
  });

  it('offers no controls to someone who is neither the owner nor traffic management', async () => {
    serve(BYSTANDER, [running, paused]);
    mount();
    await screen.findAllByTestId('sla-hours');
    expect(screen.queryByRole('button', { name: 'توقف' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'از سرگیری' })).toBeNull();
  });
});
