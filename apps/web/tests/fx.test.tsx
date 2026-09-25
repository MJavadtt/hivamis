import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Amount, FxPreview, NewPaymentModal } from '../src/components/Fx';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
};

describe('Foreign amounts', () => {
  it('previews the rial value at the day’s rate — or says plainly why it cannot be recorded', async () => {
    const answers: Record<string, unknown> = {
      USD: { rate: 1_200_000, effectiveDate: '2026-09-25T00:00:00.000Z', ageDays: 0, usable: true },
      EUR: { rate: 1_250_000, effectiveDate: '2026-08-16T00:00:00.000Z', ageDays: 40, usable: false, maxAgeDays: 7 },
      GBP: { rate: null, effectiveDate: null, ageDays: null, usable: false },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => json(answers[new URL(String(input)).searchParams.get('currency')!])));
    const { unmount } = wrap(<FxPreview currency="USD" amount={300} on="2026-09-25" />);
    expect((await screen.findByTestId('fx-preview')).textContent).toContain('۳۶۰,۰۰۰,۰۰۰ ریال');
    unmount();
    const stale = wrap(<FxPreview currency="EUR" amount={1} on={null} />);
    expect((await screen.findByTestId('fx-preview')).textContent).toContain('کهنه‌تر از ۷ روز');
    stale.unmount();
    wrap(<FxPreview currency="GBP" amount={1} on={null} />);
    expect((await screen.findByTestId('fx-preview')).textContent).toContain('نرخی ثبت نشده');
  });

  it('shows a foreign figure as written, with its rial booking beneath', () => {
    render(<Amount base={11_000_000_000} original={11_000} currency="USD" />);
    expect(screen.getByText('۱۱,۰۰۰ دلار آمریکا')).toBeTruthy();
    expect(screen.getByText('۱۱.۰ میلیارد ریال')).toBeTruthy();
  });

  it('takes a foreign invoice’s currency for a receipt, keeps it changeable, and always sends it', async () => {
    const posted: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/invoices')) return json({ items: [{ id: 'i1', number: 'EX-1', state: 'ISSUED', currency: 'USD', total: 10_000_000_000, originalTotal: 10_000, originalPaidAmount: 4_000, company: { legalName: 'Gulf Co' } }] });
      if (url.includes('/fx/rate')) return json({ rate: 1_100_000, effectiveDate: '2026-09-15T00:00:00.000Z', ageDays: 0, usable: true });
      posted.push(JSON.parse(String(init?.body)));
      return json({ id: 'p1' }, 201);
    }));
    wrap(<NewPaymentModal onClose={() => {}} />);
    const invoiceSelect = await screen.findByLabelText('فاکتور');
    await waitFor(() => expect((invoiceSelect as HTMLSelectElement).options.length).toBe(2));
    fireEvent.change(invoiceSelect, { target: { value: 'i1' } });
    expect((screen.getByLabelText('ارز مبلغ') as HTMLSelectElement).value).toBe('USD');
    expect(screen.getByText(/۴,۰۰۰ دلار آمریکا از ۱۰,۰۰۰ دلار آمریکا تسویه شده/)).toBeTruthy();
    // Paid in rials instead — which the person must choose, and the request must say.
    fireEvent.change(screen.getByLabelText('ارز مبلغ'), { target: { value: 'IRR' } });
    fireEvent.change(screen.getByLabelText('مبلغ'), { target: { value: '6600000000' } });
    fireEvent.click(screen.getByText('ثبت'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ direction: 'IN', invoiceId: 'i1', amount: 6_600_000_000, currency: 'IRR' });
  });
});
