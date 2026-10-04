import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { setAccessToken, setRefreshToken } from '../src/lib/api';
import Admin from '../src/pages/Admin';
import Reports from '../src/pages/Reports';

/**
 * «هر قسمتی به نقشی داده نشد، حتی نباید آن را ببیند» (Hivamis task 6): a tab is there only for who
 * may read what it shows — not shown, then refused.
 */
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function mount(node: React.ReactNode, permissions: string[]) {
  setAccessToken('t'); setRefreshToken('r');
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    asked.push(p);
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json({ id: 'u', email: 'x@hiva.local', fullName: 'x', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions, locale: 'fa', mustChangePassword: false });
    if (p === '/reports/data-quality') return json({ score: 90, checks: [], total: 0 });
    if (p.startsWith('/reports/')) return json(null);
    return json([]);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter>{node}</MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return asked;
}

const tabs = async () => (await screen.findAllByRole('tab')).map((t) => t.textContent);

describe('Reports', () => {
  it('shows process discovery and estimate accuracy only to who may read them', async () => {
    mount(<Reports />, ['report.read', 'finance.read']);
    // Once the person is known: a tab only finance.read shows is there.
    await screen.findByRole('tab', { name: 'درآمد و کار در جریان' });
    const shown = await tabs();
    expect(shown).not.toContain('کشف فرآیند');
    expect(shown).not.toContain('دقت برآورد');
    expect(shown).toContain('کیفیت داده');
  });

  it('shows them, and the executive tower, to who may', async () => {
    mount(<Reports />, ['report.read', 'report.executive', 'pricing.read']);
    await screen.findByRole('tab', { name: 'کشف فرآیند' });
    expect(await tabs()).toEqual(expect.arrayContaining(['برج کنترل مدیریتی', 'کشف فرآیند', 'دقت برآورد']));
  });
});

describe('Administration', () => {
  it('opens on the part its holder may use, and shows no other', async () => {
    const asked = mount(<Admin />, ['admin.settings']);
    await screen.findByRole('tab', { name: 'منابع سرنخ' });
    expect(await tabs()).toEqual(['سیاست‌های SLA', 'تقویم کاری', 'رنگ واحدها', 'طراح فرم', 'مسیریابی فرم‌ها', 'منابع سرنخ']);
    await screen.findByRole('tab', { name: 'سیاست‌های SLA', selected: true });
    expect(asked).not.toContain('/users');
    expect(asked).not.toContain('/audit-events');
  });

  it('gives the auditor the trail, the rules and the roles to read — and no settings', async () => {
    mount(<Admin />, ['admin.audit']);
    await screen.findByRole('tab', { name: 'رهگیری حسابرسی' });
    const shown = await tabs();
    expect(shown).toEqual(expect.arrayContaining(['رهگیری حسابرسی', 'نسخه‌های قوانین', 'نقش‌ها و دسترسی‌ها', 'هشدارهای امنیتی']));
    expect(shown).not.toContain('کاربران');
    expect(shown).not.toContain('سیاست‌های SLA');
  });
});
