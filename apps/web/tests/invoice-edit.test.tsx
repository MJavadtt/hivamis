import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { NewInvoiceModal } from '../src/components/Fx';

/**
 * The owner (2026-10-30): "make invoices editable too." The invoice form opens on the invoice as it
 * stands — its lines, its client past the first page of clients — and sends the whole of it back; the
 * server recomputes the totals and says when the tax system needs a correction.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', email: 'a@hiva.local', fullName: 'مدیر', jobTitle: null, locale: 'fa', mustChangePassword: false, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['SUPER_ADMIN'], permissions: ['finance.invoice', 'finance.read'] };
const INVOICE = {
  id: 'i1', kind: 'INVOICE', number: 'INV-1405-007', companyId: 'c9', projectId: 'p1', issueDate: '2026-10-01T00:00:00.000Z', dueDate: '2026-11-01T00:00:00.000Z',
  currency: 'IRR', taxPercent: '10', notes: null, state: 'ISSUED', accountingExportId: null,
  lines: [{ description: 'طراحی', quantity: 1, unitPrice: 1000000 }],
};

beforeEach(() => localStorage.clear());

describe('Editing an invoice (ADR-110)', () => {
  it('opens on the invoice as it stands and sends it back whole, a cleared field as null', async () => {
    setAccessToken('t'); markSignedIn(true);
    const sent: { method: string; path: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
      const method = init?.method ?? 'GET';
      sent.push({ method, path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (p === '/auth/refresh') return json({ accessToken: 't' });
      if (p === '/auth/me') return json(ME);
      if (p === '/invoices/i1' && method === 'GET') return json(INVOICE);
      if (p === '/invoices/i1' && method === 'PATCH') return json({ ...INVOICE, taxCorrectionDue: true });
      // Two hundred clients and more: the invoice's own is not on the first page.
      if (p === '/companies') return json({ items: [{ id: 'c1', legalName: 'شرکت نخست' }], total: 210, page: 1, pageSize: 200 });
      if (p === '/companies/c9') return json({ id: 'c9', legalName: 'مشتری دورتر' });
      if (p === '/projects') return json({ items: [{ id: 'p1', name: 'پروژهٔ یکم', code: 'PRJ-000001' }], total: 1, page: 1, pageSize: 200 });
      return json({});
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter><NewInvoiceModal invoiceId="i1" onClose={() => undefined} /></MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
      </QueryClientProvider>,
    );
    const dialog = within(await screen.findByRole('dialog'));
    await waitFor(() => expect((dialog.getByLabelText('شماره') as HTMLInputElement).value).toBe('INV-1405-007'));
    await waitFor(() => expect(dialog.getByRole('option', { name: 'مشتری دورتر' })).toBeTruthy());
    expect((dialog.getByLabelText('قیمت واحد') as HTMLInputElement).value).toBe('1000000');
    fireEvent.change(dialog.getByLabelText('قیمت واحد'), { target: { value: '1500000' } });
    fireEvent.change(dialog.getByLabelText('یادداشت'), { target: { value: 'تصحیح مبلغ' } });
    fireEvent.click(dialog.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => expect(sent.some((x) => x.path === '/invoices/i1' && x.method === 'PATCH')).toBe(true));
    expect(sent.find((x) => x.path === '/invoices/i1' && x.method === 'PATCH')!.body).toMatchObject({
      number: 'INV-1405-007', companyId: 'c9', projectId: 'p1', issueDate: '2026-10-01', dueDate: '2026-11-01', taxPercent: 10, notes: 'تصحیح مبلغ',
      lines: [{ description: 'طراحی', quantity: 1, unitPrice: 1500000 }],
    });
    expect(await screen.findByText(/«اصلاحی» آن را بفرستید/)).toBeTruthy();
  });
});
