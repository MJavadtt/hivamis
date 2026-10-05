import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));
import { InvoiceTax } from '../src/components/Moadian';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const payload = { header: { tbill: 55_000_000, tadis: 50_000_000, tvam: 5_000_000 }, body: [{}] };

describe('An invoice and سامانهٔ مؤدیان', () => {
  it('holds reporting back while something is missing, and lets the buyer’s identifiers be completed on the spot', async () => {
    const puts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') { puts.push({ url, body: JSON.parse(String(init.body)) }); return json({}); }
      if (url.endsWith('/tax')) return json({ subjects: ['ORIGINAL'], referenceTaxId: null, cancelled: false, inFlight: false, mode: 'off', modeFa: 'ارسال خاموش است', payload, submissions: [],
        problems: [{ field: 'bpc', messageFa: 'کد پستی ده‌رقمی خریدار (شرکت نمونه) ثبت نشده است' }] });
      return json({ id: 'i1', companyId: 'c1', company: { nationalId: '14000000001', postalCode: null } });
    }));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InvoiceTax invoiceId="i1" onClose={() => {}} /></QueryClientProvider>);
    expect((await screen.findByTestId('tax-problems')).textContent).toContain('کد پستی ده‌رقمی خریدار');
    expect((screen.getByText('گزارش به سامانه').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('invoice-tax').textContent).toContain('۵۵٬۰۰۰٬۰۰۰ ریال');
    fireEvent.change(await screen.findByLabelText('کد پستی خریدار'), { target: { value: '1234567890' } });
    fireEvent.click(screen.getByText('ذخیره'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: expect.stringContaining('/companies/c1/tax-identifiers'), body: { nationalId: '14000000001', postalCode: '1234567890' } });
  });

  it('reports a ready invoice as an original, and marks what went to the sandbox', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return json({ status: 'ACCEPTED', taxId: 'A1B2C304C160000000001X' }, 201); }
      return json({ subjects: ['ORIGINAL'], referenceTaxId: null, cancelled: false, inFlight: false, mode: 'sandbox', modeFa: 'حالت آزمایشی', payload, problems: [],
        submissions: [{ id: 's0', subject: 'ORIGINAL', taxId: 'A1B2C304C160000000000Y', status: 'REJECTED', channel: 'sandbox', errors: [{ code: 'E1' }], createdAt: '2026-09-26T08:00:00Z' }] });
    }));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InvoiceTax invoiceId="i1" onClose={() => {}} /></QueryClientProvider>);
    const history = await screen.findByTestId('tax-submissions');
    expect(history.textContent).toContain('آزمایشی');
    expect(history.textContent).toContain('رد شده');
    fireEvent.click(screen.getByText('گزارش به سامانه'));
    await waitFor(() => expect(posts).toEqual([{ subject: 'ORIGINAL' }]));
  });
});
