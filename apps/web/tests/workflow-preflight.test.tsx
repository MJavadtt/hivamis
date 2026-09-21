import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { setAccessToken, setRefreshToken } from '../src/lib/api';
import { WorkflowActions } from '../src/components/common';

/**
 * The action bar asks the engine what stands between the user and each move, and shows it
 * beside the button — every verdict, not the first failure.
 */
const transitions = [
  { action: 'activate', labelFa: 'شروع اجرای پروژه', labelEn: 'Activate', requiresReason: false, to: 'ACTIVE' },
  { action: 'hold', labelFa: 'توقف موقت', labelEn: 'Hold', requiresReason: true, to: 'ON_HOLD' },
];
const preflight = {
  state: 'PLANNING',
  transitions: [
    {
      action: 'activate', permitted: true, ready: false,
      checks: [
        { guard: 'project.isAuthorized', labelFa: 'مجوز شروع پروژه صادر شده باشد', ok: false, messageFa: 'مجوز شروع ثبت نشده است.', rule: 'Doc_H §13' },
        { guard: 'project.hasSchedule', labelFa: 'زمان‌بندی پروژه ثبت شده باشد', ok: true },
        { guard: 'project.hasRaci', labelFa: 'ماتریس RACI تعریف شده باشد', ok: false, messageFa: 'ماتریس RACI ناقص است.', rule: 'Doc_H §H.68' },
      ],
    },
    { action: 'hold', permitted: true, ready: true, checks: [] },
  ],
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const VIEWER = { id: 'u1', email: 'x@hiva.local', fullName: 'x', jobTitle: '', departmentCode: 'A', roles: [], permissions: ['project.read'], locale: 'fa' };
const DEPUTY = { ...VIEWER, permissions: ['project.read', 'governance.waive'] };

function mount(user: unknown = VIEWER) {
  const urls: string[] = [];
  const posts: any[] = [];
  setAccessToken('t'); setRefreshToken('r');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/auth/refresh')) return json({ accessToken: 't', refreshToken: 'r' });
    if (url.includes('/auth/me')) return json(user);
    if (url.includes('/waivers')) { posts.push(JSON.parse(String(init?.body))); return json({ id: 'w1' }); }
    return json(preflight);
  }));
  (mount as any).posts = posts;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter>
            <WorkflowActions entity="project" id="prj-1" transitions={transitions} />
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return urls;
}

describe('Workflow actions — preflight checklist', () => {
  it('offers a governed exception on a failing check only to those who may grant one', async () => {
    mount();
    await screen.findByTestId('preflight');
    expect(screen.queryByRole('button', { name: 'صدور استثنا' })).toBeNull();
  });

  it('lets the executive waive one guard with a reason, and asks the engine again', async () => {
    mount(DEPUTY);
    await screen.findByTestId('preflight');
    const offers = await screen.findAllByRole('button', { name: 'صدور استثنا' });
    expect(offers).toHaveLength(2);                                   // one per failing check
    fireEvent.click(offers[0]!);
    const reason = screen.getByLabelText('دلیل استثنا');
    fireEvent.change(reason, { target: { value: 'قرارداد در راه است؛ با مسئولیت من' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت استثنا با مسئولیت من' }));
    await waitFor(() => expect((mount as any).posts).toHaveLength(1));
    expect((mount as any).posts[0]).toMatchObject({ entityType: 'project', entityId: 'prj-1', guard: 'project.isAuthorized', action: 'activate' });
  });

  it('asks the engine for the preflight of this record', async () => {
    const urls = mount();
    await screen.findByTestId('preflight');
    expect(urls.some((u) => u.includes('/workflow/project/prj-1/preflight'))).toBe(true);
  });

  it('lists every check for a blocked action, failures first, with the explanation', async () => {
    mount();
    const box = await screen.findByTestId('preflight');
    const lines = [...box.querySelectorAll('li')].map((li) => li.textContent);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('✗');
    expect(lines[0]).toContain('مجوز شروع پروژه صادر شده باشد');
    expect(lines[0]).toContain('مجوز شروع ثبت نشده است.');
    expect(lines[1]).toContain('✗');
    expect(lines[1]).toContain('ماتریس RACI');
    expect(lines[2]).toContain('✓');
    expect(lines[2]).toContain('زمان‌بندی');
    expect(box.textContent).toContain('پیش‌نیازهای «شروع اجرای پروژه»');
  });

  it('marks the blocked button with the number of unmet prerequisites, and leaves it clickable', async () => {
    mount();
    await screen.findByTestId('preflight');
    const button = screen.getByRole('button', { name: /شروع اجرای پروژه/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('۲');
    expect(button.title).toContain('مجوز شروع ثبت نشده است.');
  });

  it('shows nothing extra for an action with no unmet prerequisite', async () => {
    mount();
    const box = await screen.findByTestId('preflight');
    expect(box.textContent).not.toContain('توقف موقت');
    const hold = screen.getByRole('button', { name: 'توقف موقت' }) as HTMLButtonElement;
    expect(hold.title).toBe('');
  });
});
