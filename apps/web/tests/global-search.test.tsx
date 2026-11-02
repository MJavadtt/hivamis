import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { ThemeProvider } from '../src/lib/theme';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { Shell } from '../src/components/Shell';

/**
 * The owner's brief (2026-11-02): one search for customers, projects, contract numbers, tasks,
 * colleagues and the other business identifiers — shown simply, each with its plain status — and a
 * question finds the guide's answer, not only records.
 */
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', email: 'p@hiva.local', fullName: 'پریسا نوری', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: ['project.read', 'task.read', 'workorder.read', 'contract.read'], locale: 'fa', mustChangePassword: false };

function Where() { return <span data-testid="where">{useLocation().pathname}</span>; }

function mount() {
  localStorage.setItem('hiva.owl.greeted', '1');
  setAccessToken('t'); markSignedIn(true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(ME);
    if (p === '/notifications') return json({ items: [], unread: 0 });
    if (p === '/search') return json({ query: url.searchParams.get('q'), total: 1, groups: [{ type: 'contract', labelFa: 'قراردادها', items: [{ id: 'k-1', code: 'CTR-000004', title: 'قرارداد کمپین آرمان', state: 'SIGNED' }] }] });
    if (p === '/work-orders') return json({ items: [{ id: 'w-1', code: 'WO-000011', title: 'طراحی کمپین آرمان', state: 'IN_PROGRESS', project: { name: 'کمپین آرمان' } }] });
    if (p === '/people') return json([{ id: 'u-9', fullName: 'آرمان نیک‌پور', jobTitle: 'طراح ارشد', email: 'arman@hiva.local' }, { id: 'u-8', fullName: 'سارا مدیری', jobTitle: 'مدیرعامل', email: 'ceo@hiva.local' }]);
    return json({ items: [] });
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider><ToastProvider><LocaleProvider><AuthProvider><MemoryRouter>
        <Routes><Route path="*" element={<Shell><Where /></Shell>} /></Routes>
      </MemoryRouter></AuthProvider></LocaleProvider></ToastProvider></ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Global search', () => {
  it('finds records, work orders and colleagues together, each with its plain status', async () => {
    mount();
    const box = (await screen.findAllByRole('searchbox'))[0]!;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'آرمان' } });
    const results = await screen.findByRole('listbox', { name: 'نتایج جستجو' });
    await within(results).findByRole('group', { name: 'همکاران' });
    expect(within(results).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['قراردادها', 'سفارش‌های کار', 'همکاران']));
    const contract = within(results).getByRole('option', { name: /قرارداد کمپین آرمان/ });
    expect(contract.textContent).toContain('انجام شد');
    expect(within(within(results).getByRole('group', { name: 'همکاران' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['آرمان نیک‌پورطراح ارشد']);
    fireEvent.click(within(results).getByRole('option', { name: /آرمان نیک‌پور/ }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/people/u-9'));
  });

  it('answers a question from the guide', async () => {
    mount();
    const box = (await screen.findAllByRole('searchbox'))[0]!;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'چطور ساعت کارم را ثبت کنم' } });
    const help = await screen.findByRole('group', { name: 'راهنما: چطور…' });
    expect(within(help).getAllByRole('option').length).toBeGreaterThan(0);
  });
});
