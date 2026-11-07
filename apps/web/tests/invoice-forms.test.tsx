import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { downloadFile, markSignedIn, setAccessToken } from '../src/lib/api';
import { NewInvoiceModal } from '../src/components/Fx';
import { DraftProvider } from '../src/lib/drafts';

/**
 * The owner (2026-11-07; ADR-125): an invoice first asks which company issues it — هیوا or خط تیره —
 * then reads the buyer from the client's record, to be completed or typed over.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', email: 'f@hiva.local', fullName: 'مالی', jobTitle: null, locale: 'fa', mustChangePassword: false, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['FINANCE_MANAGER'], permissions: ['finance.invoice', 'finance.read'] };
const SELLERS = [
  { id: 's1', form: 'hiva', shortName: 'هیوا', legalName: 'تجارت رسان هیوا قشم' },
  { id: 's2', form: 'khat-tireh', shortName: 'خط تیره', legalName: 'شرکت طراحان خط تیره' },
];

beforeEach(() => localStorage.clear());

describe('Issuing an invoice on a company\'s form (ADR-125)', () => {
  it('asks for the company first, reads the buyer from the client, and sends both with the lines', async () => {
    setAccessToken('t'); markSignedIn(true);
    const sent: { method: string; path: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
      const method = init?.method ?? 'GET';
      sent.push({ method, path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (p === '/auth/refresh') return json({ accessToken: 't' });
      if (p === '/auth/me') return json(ME);
      if (p === '/invoice-sellers') return json(SELLERS);
      if (p === '/companies') return json({ items: [{ id: 'c1', legalName: 'شرکت خریدار' }], total: 1, page: 1, pageSize: 200 });
      if (p === '/invoices/buyer/c1') return json({ legalName: 'شرکت خریدار', nationalId: '10101010101', economicCode: null, postalCode: null, province: 'تهران', county: null, city: null, address: 'تهران', phone: null });
      if (p === '/projects') return json({ items: [], total: 0, page: 1, pageSize: 200 });
      if (p === '/invoices' && method === 'POST') return json({ id: 'i9' }, 201);
      return json({});
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter><NewInvoiceModal onClose={() => undefined} /></MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
      </QueryClientProvider>,
    );
    const dialog = within(await screen.findByRole('dialog'));
    // The company first, and nothing else until it is chosen.
    expect(await dialog.findByText('این سند به نام کدام شرکت صادر شود؟')).toBeTruthy();
    expect(dialog.queryByLabelText('شماره')).toBeNull();
    expect(dialog.queryByRole('button', { name: 'صدور' })).toBeNull();
    fireEvent.click(await dialog.findByRole('radio', { name: /خط تیره/ }));
    expect(dialog.getByTestId('seller-picked').textContent).toContain('شرکت طراحان خط تیره');

    fireEvent.change(dialog.getByLabelText('شماره'), { target: { value: 'KT-1' } });
    await waitFor(() => expect(dialog.getByRole('option', { name: 'شرکت خریدار' })).toBeTruthy());
    fireEvent.change(dialog.getAllByRole('combobox').find((s) => within(s).queryByRole('option', { name: 'شرکت خریدار' }))!, { target: { value: 'c1' } });
    // The client's record read in, and what is missing typed over it.
    const buyer = within(await dialog.findByRole('region', { name: 'مشخصات خریدار' }));
    await waitFor(() => expect((buyer.getByLabelText('شناسهٔ ملی') as HTMLInputElement).value).toBe('10101010101'));
    fireEvent.change(buyer.getByLabelText('کد پستی ده‌رقمی'), { target: { value: '1234567890' } });

    fireEvent.change(dialog.getByLabelText('شرح'), { target: { value: 'طراحی' } });
    fireEvent.change(dialog.getByLabelText('قیمت واحد'), { target: { value: '1000000' } });
    fireEvent.change(dialog.getByLabelText('تخفیف'), { target: { value: '2000000' } });
    expect(dialog.getByText('تخفیف یک ردیف از مبلغ کل آن بیشتر است.')).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'صدور' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText('تخفیف'), { target: { value: '100000' } });
    fireEvent.change(dialog.getByLabelText('شرایط و نحوهٔ فروش'), { target: { value: 'CASH' } });
    fireEvent.click(dialog.getByRole('button', { name: 'صدور' }));

    await waitFor(() => expect(sent.some((x) => x.path === '/invoices' && x.method === 'POST')).toBe(true));
    expect(sent.find((x) => x.path === '/invoices' && x.method === 'POST')!.body).toMatchObject({
      sellerId: 's2', companyId: 'c1', number: 'KT-1', saleTerms: 'CASH', fillCompany: true,
      buyer: { legalName: 'شرکت خریدار', nationalId: '10101010101', postalCode: '1234567890', province: 'تهران' },
      lines: [{ description: 'طراحی', quantity: 1, unitPrice: 1000000, discount: 100000 }],
    });
  });

  it('keeps the company chosen in the dialog\'s own draft: brought back with its notice, and forgotten with it', async () => {
    setAccessToken('t'); markSignedIn(true);
    const sent: { method: string; path: string; body: any }[] = [];
    const stored = [{ id: 'd1', key: '/finance#invoice:new', title: 'صدور سند مالی', path: '/finance', updatedAt: '2026-11-07T08:00:00.000Z',
      fields: { 'فروشنده': { label: 'فروشنده', value: 's2', base: '' } } }];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
      const method = init?.method ?? 'GET';
      sent.push({ method, path: p, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (p === '/auth/refresh') return json({ accessToken: 't' });
      if (p === '/auth/me') return json(ME);
      if (p === '/me/drafts' && method === 'GET') return json(stored);
      if (p === '/invoice-sellers') return json(SELLERS);
      if (p === '/companies' || p === '/projects') return json({ items: [], total: 0, page: 1, pageSize: 200 });
      return json({});
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter initialEntries={['/finance']}><DraftProvider><NewInvoiceModal onClose={() => undefined} /></DraftProvider></MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
      </QueryClientProvider>,
    );
    const dialog = within(await screen.findByRole('dialog'));
    expect((await dialog.findByTestId('seller-picked')).textContent).toContain('شرکت طراحان خط تیره');
    expect(dialog.getByTestId('draft-notice').textContent).toContain('برگردانده شد');
    fireEvent.click(dialog.getByRole('button', { name: 'حذف پیش‌نویس' }));
    expect(await dialog.findByText('این سند به نام کدام شرکت صادر شود؟')).toBeTruthy();
    // Chosen again, it is the dialog's draft that keeps it — never the page's.
    fireEvent.click(await dialog.findByRole('radio', { name: /هیوا/ }));
    await waitFor(() => expect(sent.some((x) => x.method === 'PUT' && x.path === '/me/drafts')).toBe(true), { timeout: 4000 });
    expect(sent.filter((x) => x.method === 'PUT' && x.path === '/me/drafts').every((x) => x.body.key === '/finance#invoice:new')).toBe(true);
  });
});

describe('A download\'s name', () => {
  it('is the full Persian name the server gives, not the plain one it sends old browsers', async () => {
    setAccessToken('t'); markSignedIn(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: {
      'content-disposition': `attachment; filename="invoice-KT-1.xlsx"; filename*=UTF-8''${encodeURIComponent('فاکتور KT-1.xlsx')}`,
    } })));
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    await downloadFile('/invoices/i1/workbook', 'fallback.xlsx');
    click.mockRestore();
    expect(names).toEqual(['فاکتور KT-1.xlsx']);
  });
});
