import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));
import { RevenueReport, WipLabel } from '../src/components/Revenue';

const month = (period: string, labelFa: string, closed: boolean, recognised: number, invoiced: number) => ({
  period, labelFa, closed, recognised, invoiced, labourCost: 100_000_000, externalCost: 0, unpricedHours: 0,
  margin: recognised - 100_000_000, billingMargin: invoiced - 100_000_000,
});
const report = {
  lastClosed: '1405-05', nextToClose: '1405-06',
  wip: { unbilled: 300_000_000, deferred: 200_000_000 },
  months: [month('1405-05', 'مرداد ۱۴۰۵', true, 250_000_000, 0), month('1405-06', 'شهریور ۱۴۰۵', false, 250_000_000, 700_000_000), month('1405-07', 'مهر ۱۴۰۵ (تا امروز)', false, 0, 0)],
  projects: [{ id: 'p1', code: 'PRJ-1', name: 'کمپین سنجش با ساعت', client: 'آینده‌سازان', methodFa: 'درصد پیشرفت بر پایهٔ ساعت کار', contractValue: 1e9, progress: 0.5, recognised: 5e8, invoiced: 7e8, wip: -2e8, reasonFa: null, expectedLoss: null }],
};

describe('Revenue recognition', () => {
  it('sets the earned margin beside the billing one, and offers only the next month to close', async () => {
    const posted: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posted.push({ url: String(input), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ totals: { recognised: 25e7, projects: 1 }, unmeasured: [] }), { status: 201, headers: { 'content-type': 'application/json' } }); }
      return new Response(JSON.stringify(report), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><RevenueReport /></MemoryRouter></QueryClientProvider>);

    const rows = await screen.findByTestId('revenue-months');
    const shahrivar = [...rows.querySelectorAll('tr')].find((r) => r.textContent!.includes('شهریور'))!;
    // Billed 700 million in the month, earned 250: the billing view calls it a 600-million month.
    expect(shahrivar.textContent).toContain('۱۵۰٫۰ میلیون ریال');
    expect(shahrivar.textContent).toContain('۶۰۰٫۰ میلیون ریال');
    expect(screen.getByText('کمپین سنجش با ساعت').closest('tr')!.textContent).toContain('پیش‌صورت‌حساب');

    // The current month is never offered; the next in order is.
    fireEvent.click(screen.getByText('بستن شهریور ۱۴۰۵'));
    fireEvent.click(await screen.findByText('بستن دوره'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body).toEqual({ period: '1405-06' });
  });

  it('says on what footing invoices are compared, and lets the administrator change it (audit CALC-1)', async () => {
    const patched: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') { patched.push({ url: String(input), body: JSON.parse(String(init.body)) }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }
      return new Response(JSON.stringify({ ...report, contractValueIncludesTax: false }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><RevenueReport /></MemoryRouter></QueryClientProvider>);
    const basis = await screen.findByTestId('tax-basis');
    expect(basis.textContent).toContain('بدون مالیات سنجیده می‌شوند');
    fireEvent.click(screen.getByText('قراردادها با مالیات‌اند'));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toMatchObject({ url: expect.stringContaining('/api/v1/organization'), body: { contractValueIncludesTax: true } });
  });

  it('names work in progress for what it is', () => {
    const { container, rerender } = render(<WipLabel wip={300_000_000} />);
    expect(container.textContent).toContain('کار انجام‌شدهٔ صورت‌حساب‌نشده');
    rerender(<WipLabel wip={-200_000_000} />);
    expect(container.textContent).toContain('درآمد انتقالی');
  });
});
