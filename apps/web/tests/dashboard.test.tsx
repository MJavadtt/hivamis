import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { setAccessToken, setRefreshToken } from '../src/lib/api';
import Dashboard from '../src/pages/Dashboard';
import Forms from '../src/pages/Forms';

/**
 * The landing dashboard in the organisation's own words (Hivamis task 1), its tiles as ways into
 * the lists they count, and "my projects" in two halves: executing, and still being sold.
 */
const dashboard = (opportunities: unknown) => ({
  tasks: { items: [], total: 3, overdue: 2, dueThisWeek: 1, awaitingAcceptance: 0 },
  projects: [{ id: 'p-1', code: 'PRJ-000016', name: 'بازطراحی هویت', state: 'ACTIVE', healthStatus: 'GREEN', plannedEnd: null, company: { legalName: 'بانک آینده‌سازان' } }],
  opportunities,
  forms: { mySubmissionsPending: 0, awaitingMyApproval: 4 },
  revisions: { items: [], overdue: 0 },
  sla: { items: [], breached: 1, atRisk: 2 },
  unreadNotifications: 0,
});
const OPP = [{ id: 'o-1', code: 'OPP-000007', title: 'کمپین نوروزی', state: 'PROPOSAL', estimatedValue: '1500000000', expectedCloseDate: '2026-11-01T00:00:00.000Z', company: { legalName: 'شرکت نمونه' } }];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const USER = { id: 'u1', email: 's@hiva.local', fullName: 'الهام کریمی', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: [], locale: 'fa', mustChangePassword: false };

function mount(node: React.ReactNode, entry: string, routes: (path: string) => unknown) {
  setAccessToken('t'); setRefreshToken('r');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(USER);
    return json(routes(p + url.search));
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
}

describe('The dashboard', () => {
  it('says what the organisation calls things, and each tile opens what it counts', async () => {
    mount(<Dashboard />, '/', () => dashboard(OPP));
    const late = (await screen.findByText('وظایف تاخیردار')).closest('a')!;
    expect(late.getAttribute('href')).toBe('/my-work');
    expect(screen.getByText('در انتظار تأیید').closest('a')!.getAttribute('href')).toBe('/forms?tab=inbox');
    const breach = screen.getByText('نقض روند').closest('a')!;
    expect(breach.textContent).toContain('۱ نقض‌شده — ۲ در خطر');
    expect(screen.getByText('روندهای من')).toBeTruthy();
    expect(screen.getByText('اصلاحیه‌ها')).toBeTruthy();
    for (const old of ['سررسید گذشته', 'در انتظار تأیید من', 'SLA در خطر / نقض‌شده', 'SLAهای من', 'اصلاحیه‌های من']) {
      expect(screen.queryByText(old)).toBeNull();
    }
  });

  it('splits my projects into what is executing and what is still being sold', async () => {
    mount(<Dashboard />, '/', () => dashboard(OPP));
    const executing = await screen.findByRole('tab', { name: /در حال اجرا \(فعال\)/ });
    expect(executing.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('بازطراحی هویت')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /فروش \(فرصت فروش\)/ }));
    const row = screen.getByText('کمپین نوروزی').closest('tr')!;
    expect(within(row).getByText('شرکت نمونه')).toBeTruthy();
    expect(screen.getByText('کمپین نوروزی').closest('a')!.getAttribute('href')).toBe('/opportunities/o-1');
    expect(screen.getByText('همه فرصت‌ها').getAttribute('href')).toBe('/opportunities');
    expect(screen.queryByText('بازطراحی هویت')).toBeNull();
  });

  it('shows no sales half to someone who may not read the pipeline', async () => {
    mount(<Dashboard />, '/', () => dashboard(null));
    expect(await screen.findByText('بازطراحی هویت')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});

describe('Links into the forms', () => {
  const inbox = { items: [{
    id: 's-1', code: 'FRM-000011', state: 'PENDING_APPROVAL', createdAt: '2026-10-03T06:00:00.000Z',
    definition: { code: 'D29_RESOURCE_NEED', nameFa: 'فرم اعلام نیاز منابع', category: 'D', module: 'X' },
    submittedBy: { fullName: 'بهراد مهرنیا' }, project: null,
  }], total: 1 };
  const routes = (p: string) => (p.startsWith('/forms/submissions/s-1') ? { data: {}, definition: { schema: [] } } : p.startsWith('/forms/submissions') ? inbox : []);

  it('opens the inbox when a link asks for it', async () => {
    mount(<Forms />, '/forms?tab=inbox', routes);
    expect((await screen.findByRole('tab', { name: 'در انتظار تأیید من' })).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('فرم اعلام نیاز منابع')).toBeTruthy();
  });

  it('opens one submission for a decision when an email or the phone links to it', async () => {
    mount(<Forms />, '/forms?submission=s-1', routes);
    expect(await screen.findByRole('dialog', { name: 'بررسی: فرم اعلام نیاز منابع' })).toBeTruthy();
  });

  it('says so when the linked form no longer waits for this person', async () => {
    mount(<Forms />, '/forms?submission=s-gone', routes);
    expect(await screen.findByText('این فرم دیگر در انتظار تصمیم شما نیست.')).toBeTruthy();
  });
});
