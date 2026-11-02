import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { CommercialDesk, contractNext, invoiceNext } from '../src/pages/CommercialDesk';
import { StartAuthorization } from '../src/components/StartAuthorization';

/**
 * The owner's brief (2026-11-02): finance and legal kept as they are, but simpler to work in — each
 * contract, invoice, go-ahead and purchase with what it waits for — and work may start without a
 * contract: on the client's official order or an execution order with an invoice.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 25, pageCount: 1 });
const move = (action: string, labelFa: string, requiresReason = false) => ({ action, labelFa, labelEn: action, requiresReason, to: 'X' });
const user = (permissions: string[]) => ({ id: 'u1', email: 'x@hiva.local', fullName: 'x', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions, locale: 'fa', mustChangePassword: false });

function mount(node: React.ReactNode, permissions: string[], api: (p: string, url: URL, method: string) => unknown) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(user(permissions));
    if (p.endsWith('/preflight')) return json({ state: 'x', transitions: [] });
    const answer = api(p, url, method);
    if (answer !== undefined) return json(answer, method === 'POST' ? 201 : 200);
    return json(method === 'GET' ? page([]) : {}, method === 'POST' ? 201 : 200);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter>{node}</MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

describe('Starting work, with or without a contract', () => {
  it('records the client’s official order as the go-ahead, without asking for a contract', async () => {
    const sent = mount(<StartAuthorization projectId="pr-1" companyId="co-1" transitions={[move('authorize', 'صدور مجوز شروع پروژه')]} onDone={() => undefined} />,
      ['project.read', 'project.authorize', 'contract.read', 'finance.read'], () => undefined);
    const panel = await screen.findByTestId('start-authorization');
    const save = () => within(panel).getByRole('button', { name: 'ثبت مبنای شروع' }) as HTMLButtonElement;
    fireEvent.click(await within(panel).findByRole('radio', { name: /سفارش رسمی مشتری/ }));
    expect(within(panel).queryByLabelText('قرارداد')).toBeNull();
    expect(save().disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText('شمارهٔ سند'), { target: { value: 'نامهٔ ۱۴۰۵/۲۳' } });
    fireEvent.click(save());
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && s.path === '/projects/pr-1/authorize')).toBe(true));
    expect(sent.find((s) => s.path === '/projects/pr-1/authorize')!.body).toEqual({ basis: 'OFFICIAL_ORDER', referenceDocument: 'نامهٔ ۱۴۰۵/۲۳' });
    expect(within(panel).getByRole('button', { name: 'صدور مجوز شروع پروژه' })).toBeTruthy();
  });

  it('offers only the client’s signed contracts, and ties an execution order to its invoice', async () => {
    const sent = mount(<StartAuthorization projectId="pr-1" companyId="co-1" transitions={[]} onDone={() => undefined} />,
      ['project.read', 'project.authorize', 'contract.read', 'finance.read'], (p) => {
        if (p === '/contracts') return page([{ id: 'k-1', code: 'CTR-1', title: 'قرارداد کمپین', state: 'SIGNED', contractNumber: 'Q-12' }, { id: 'k-2', code: 'CTR-2', title: 'پیش‌نویس', state: 'DRAFTING', contractNumber: null }]);
        if (p === '/invoices') return page([{ id: 'i-1', kind: 'PROFORMA', number: 'PF-7', total: '100000000', state: 'ISSUED', issueDate: '2026-10-01T00:00:00.000Z' }]);
        return undefined;
      });
    const panel = await screen.findByTestId('start-authorization');
    fireEvent.click(await within(panel).findByRole('radio', { name: /قرارداد امضاشده/ }));
    await within(panel).findByRole('option', { name: 'قرارداد کمپین — Q-12' });
    expect(within(within(panel).getByLabelText('قرارداد')).getAllByRole('option')).toHaveLength(2);
    fireEvent.click(within(panel).getByRole('radio', { name: /دستور اجرا با فاکتور/ }));
    const option = await within(panel).findByRole('option', { name: /پیش‌فاکتور — PF-7/ });
    fireEvent.change(within(panel).getByLabelText('فاکتور'), { target: { value: (option as HTMLOptionElement).value } });
    fireEvent.change(within(panel).getByLabelText('شمارهٔ سند'), { target: { value: 'PF-7' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'ثبت مبنای شروع' }));
    await waitFor(() => expect(sent.some((s) => s.path === '/projects/pr-1/authorize')).toBe(true));
    expect(sent.find((s) => s.path === '/projects/pr-1/authorize')!.body).toEqual({ basis: 'INVOICED_EXECUTION_ORDER', invoiceId: 'i-1', referenceDocument: 'PF-7' });
  });

  it('once a basis is recorded, shows it and leaves only the project’s next move', async () => {
    mount(<StartAuthorization projectId="pr-1" companyId="co-1" transitions={[move('request_authorization', 'درخواست مجوز شروع')]} recorded={{ basis: 'OFFICIAL_ORDER', referenceDocument: 'نامهٔ ۲۳' }} onDone={() => undefined} />,
      ['project.read', 'project.authorize', 'project.write'], () => undefined);
    expect((await screen.findByTestId('basis-recorded')).textContent).toBe('مبنا ثبت شده است: سفارش رسمی مشتری — نامهٔ ۲۳');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByRole('button', { name: 'درخواست مجوز شروع' })).toBeTruthy();
  });

  it('tells whoever may not record it who does', async () => {
    mount(<StartAuthorization projectId="pr-1" companyId="co-1" transitions={[]} onDone={() => undefined} />, ['project.read'], () => undefined);
    expect((await screen.findByTestId('start-authorization')).textContent).toContain('ثبت مجوز شروع با مدیر اکانت یا مدیریت است.');
  });
});

describe('The contracts and finance desk', () => {
  it('says what each contract and invoice waits for', () => {
    expect(contractNext('LEGAL_REVIEW')).toBe('در بررسی حقوقی و مالی است؛ تأیید کنید یا با توضیح برای اصلاح برگردانید.');
    expect(invoiceNext({ state: 'SENT', dueDate: '2026-01-01T00:00:00.000Z' }, Date.parse('2026-11-01'))).toBe('سررسید گذشته و پرداخت نشده است؛ پیگیری کنید.');
    expect(invoiceNext({ state: 'DRAFT', dueDate: null })).toBe('پیش‌نویس است؛ بازبینی و صادر کنید.');
  });

  it('lists contracts, invoices, go-aheads and purchases, with the review’s two ways side by side', async () => {
    mount(<CommercialDesk />, ['contract.read', 'contract.legal_review', 'finance.read', 'project.read', 'supplier.read'], (p, url) => {
      const state = url.searchParams.get('state');
      if (p === '/contracts' && state === 'LEGAL_REVIEW') return page([{ id: 'k-1', code: 'CTR-1', title: 'قرارداد کمپین', state, contractNumber: null, company: { legalName: 'بانک' }, availableTransitions: [move('request_revision', 'درخواست اصلاح قرارداد', true), move('approve', 'تأیید داخلی قرارداد')] }]);
      if (p === '/invoices' && state === 'SENT') return page([{ id: 'i-1', kind: 'INVOICE', number: 'F-9', total: '50000000', paidAmount: '0', state, dueDate: '2026-01-01T00:00:00.000Z', company: { legalName: 'بانک' }, project: null }]);
      if (p === '/projects' && state === 'PENDING_AUTHORIZATION') return page([{ id: 'pr-1', code: 'PRJ-1', name: 'کمپین بانک', state, company: { legalName: 'بانک' } }]);
      if (p === '/outsource-requests' && state === 'UNIT_MANAGER_REVIEW') return page([{ id: 'o-1', code: 'OUT-1', kind: 'FREELANCER', scopeOfWork: 'عکاسی محصول', estimatedCost: '20000000', neededBy: '2026-11-30T00:00:00.000Z', state, proposedSupplierName: 'استودیو نور', supplier: null, project: { name: 'کمپین بانک' }, availableTransitions: [move('approve', 'تأیید تأمین'), move('reject', 'رد درخواست', true)] }]);
      return undefined;
    });
    expect((await screen.findByTestId('commercial-summary')).textContent).toBe('۱ قرارداد در جریان، ۱ پیش‌فاکتور یا فاکتور باز (۱ سررسیدگذشته)، ۱ پروژه منتظر مجوز شروع، ۱ درخواست خرید.');
    const contracts = screen.getByRole('region', { name: 'قراردادهای فروش' });
    expect(within(contracts).getByRole('button', { name: 'تأیید داخلی قرارداد' })).toBeTruthy();
    expect(within(contracts).getByRole('button', { name: 'درخواست اصلاح قرارداد' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'پیش‌فاکتورها و فاکتورها' })).getByText('سررسید گذشته و پرداخت نشده است؛ پیگیری کنید.').className).toContain('rose');
    expect(within(screen.getByRole('region', { name: 'پروژه‌های منتظر مجوز شروع' })).getByRole('link', { name: 'کمپین بانک' }).getAttribute('href')).toBe('/projects/pr-1');
    expect(within(screen.getByRole('region', { name: 'درخواست‌های خرید و تأمین بیرونی' })).getByRole('button', { name: 'تأیید تأمین' })).toBeTruthy();
  });
});
