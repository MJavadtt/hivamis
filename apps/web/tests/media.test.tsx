import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: () => true, user: { department: { code: 'ME' } } }), useSystemAdmin: () => false }));
import { ProjectMedia } from '../src/components/Media';

const order = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id, code: `MO-00000${id}`, state, channel: 'TV', placement: 'تیزر ۳۰ ثانیه', flightStart: '2026-09-20T00:00:00Z', flightEnd: '2026-09-24T00:00:00Z',
  pricingModel: 'COMMISSION', commissionPercent: '15', currency: 'IRR',
  clientAmount: '1000000000', netAmount: '850000000', agencyRevenue: '150000000', originalClientAmount: null, originalNetAmount: null,
  vendorInvoiceAmount: null, vendorInvoiceNumber: null, discrepancyNote: null, proofNote: null,
  supplier: { id: 's1', name: 'شبکهٔ نمونه' }, clientInvoice: null, availableTransitions: [], ...extra,
});

describe('Media orders on a project', () => {
  it('keeps pass-through apart from the agency’s share, and bills the chosen orders with the split shown', async () => {
    const posted: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posted.push({ url: String(input), body: JSON.parse(String(init.body)) }); return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }); }
      return new Response(JSON.stringify({ items: [order('1', 'AIRED'), order('2', 'DRAFT'), order('3', 'CANCELLED')] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><ProjectMedia projectId="p1" /></MemoryRouter></QueryClientProvider>);

    await screen.findByTestId('media-orders');
    // Cancelled orders count for nothing; the draft still counts as planned media.
    expect(screen.getByText('عبوری به رسانه‌ها').closest('div')!.parentElement!.textContent).toContain('۱٫۷ میلیارد ریال');
    expect(screen.getByText('سهم آژانس').closest('div')!.parentElement!.textContent).toContain('۳۰۰٫۰ میلیون ریال');

    // Only an order that is booked or ran can be billed.
    expect(screen.queryByLabelText('انتخاب MO-000002')).toBeNull();
    fireEvent.click(screen.getByLabelText('انتخاب MO-000001'));
    fireEvent.click(screen.getByText('صورت‌حساب ۱ سفارش'));
    expect((await screen.findByTestId('media-bill-split')).textContent).toContain('هزینهٔ عبوری رسانه ۸۵۰٫۰ میلیون ریال + کمیسیون آژانس ۱۵۰٫۰ میلیون ریال');
    fireEvent.change(screen.getByLabelText('شمارهٔ صورت‌حساب'), { target: { value: 'M-17' } });
    fireEvent.click(screen.getByText('صدور'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].url).toContain('/projects/p1/media-billing');
    expect(posted[0].body).toMatchObject({ orderIds: ['1'], number: 'M-17' });
  });
});
