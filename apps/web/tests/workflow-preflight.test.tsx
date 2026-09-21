import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
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

function mount() {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return json(preflight);
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <WorkflowActions entity="project" id="prj-1" transitions={transitions} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return urls;
}

describe('Workflow actions — preflight checklist', () => {
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
