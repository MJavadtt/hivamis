import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectLessons } from '../src/components/ProjectLessons';
import { AuthProvider } from '../src/lib/auth';

const payload = {
  project: { id: 'p2', code: 'PRJ-000042', name: 'کمپین ویدئویی تازه', state: 'ACTIVE' },
  reviewed: 1, usedService: false, noteFa: null,
  lessons: [{
    lessonId: 'l1', titleFa: 'تدوین ویدئو دیرتر از برآورد تمام می‌شود', category: 'DELIVERY',
    recommendation: 'برای تدوین ویدئو دو هفته حاشیه بگذارید.', snippetFa: 'تدوین دو هفته بیشتر طول کشید.',
    score: 0.71, whyFa: ['همین مشتری — آینده‌سازان', 'همان واحد اجرایی: CR', 'شباهت موضوعی با شرح این پروژه'],
    fromProject: { id: 'p1', code: 'PRJ-000009', name: 'کمپین سال گذشته' },
    companyName: 'آینده‌سازان', review: null,
  }],
};

function mount() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/auth/refresh')) return new Response(JSON.stringify({ accessToken: 'a', refreshToken: 'r' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/auth/me')) return new Response(JSON.stringify({ id: 'u1', fullName: 'فرشاد بهرامی', permissions: ['project.read', 'project.plan'], roles: ['PMO_MANAGER'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  localStorage.setItem('hiva.refresh', 'r');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AuthProvider><ProjectLessons projectId="p2" /></AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ProjectLessons', () => {
  it('shows the past lesson with the reasons it was surfaced', async () => {
    mount();
    const list = await screen.findByTestId('project-lessons');
    expect(list.textContent).toContain('تدوین ویدئو دیرتر از برآورد تمام می‌شود');
    expect(list.textContent).toContain('دو هفته حاشیه');
    expect(list.textContent).toContain('همین مشتری — آینده‌سازان');
    expect(list.textContent).toContain('کمپین سال گذشته');
    expect(screen.getByText('۱ درس بررسی‌شده')).toBeTruthy();
    // The local embedder's limits are stated rather than implied.
    expect(screen.getByText(/بیشتر بر پایهٔ واژه‌های مشترک/)).toBeTruthy();
  });

  it('will not record “not relevant” until a reason is written', async () => {
    mount();
    const list = await screen.findByTestId('project-lessons');
    fireEvent.click([...list.querySelectorAll('button')].find((b) => b.textContent === 'مرتبط نیست')!);

    const panel = await screen.findByTestId('lesson-decision');
    const submit = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'ثبت') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(panel.querySelector('textarea')!, { target: { value: 'این پروژه اصلاً ویدئو ندارد.' } });
    expect(([...panel.querySelectorAll('button')].find((b) => b.textContent === 'ثبت') as HTMLButtonElement).disabled).toBe(false);
  });
});
