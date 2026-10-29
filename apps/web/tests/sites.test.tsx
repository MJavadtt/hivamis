import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import VenuesPage from '../src/pages/sites/Venues';
import ProjectsPage from '../src/pages/sites/Projects';
import RentalsPage from '../src/pages/sites/Rentals';
import { AmountInput } from '../src/pages/sites/shared';

/**
 * ADR-103 on the page: the venue list filtered by the address bar, a duplicate shown before it is
 * saved, a project's buttons the workflow's own (the contract decided on its version, not by a bare
 * move), a payment sent with its own key, and the rentals register reading the server's sums.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (permissions: string[]) => ({ id: 'u1', email: 'f@hiva.local', fullName: 'لیلا', jobTitle: null, locale: 'fa', mustChangePassword: false, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions });
const OPTIONS = [
  { id: 'o1', list: 'VENUE_TYPE', code: 'MALL', labelFa: 'مجتمع تجاری', labelEn: 'Shopping mall', sortOrder: 10, isActive: true, meta: {} },
  { id: 'o2', list: 'VENUE_GRADE', code: 'A', labelFa: 'A', labelEn: 'A', sortOrder: 10, isActive: true, meta: {} },
  { id: 'o3', list: 'CONTACT_ROLE', code: 'CEO', labelFa: 'مدیرعامل', labelEn: 'CEO', sortOrder: 10, isActive: true, meta: {} },
  { id: 'o4', list: 'COOPERATION', code: 'FORMAL', labelFa: 'قراردادی رسمی', labelEn: 'Formal', sortOrder: 10, isActive: true, meta: { requiresContract: true } },
  { id: 'o5', list: 'PAYMENT_METHOD', code: 'CHEQUE', labelFa: 'چک', labelEn: 'Cheque', sortOrder: 10, isActive: true, meta: { isCheque: true } },
  { id: 'o6', list: 'PAYMENT_METHOD', code: 'CASH', labelFa: 'نقد', labelEn: 'Cash', sortOrder: 20, isActive: true, meta: {} },
];
const VENUE = {
  id: 'v1', code: 'VEN-000001', name: 'مجتمع کوروش', province: 'تهران', city: 'تهران', address: 'ستاری', typeCode: 'MALL', gradeCode: 'A', audienceCodes: [], phone: '021', isActive: true,
  archivedAt: null, updatedAt: '2026-10-20T00:00:00Z', primaryContact: { fullName: 'علی مدیرزاده', phone: '0912' }, contacts: 1, photos: 0, projects: 2, activeProjects: 1,
  completeness: { score: 67, missing: ['audienceCodes', 'photos'] }, version: 1,
};

type Handler = (path: string, method: string, body: any, query: URLSearchParams) => Response | undefined;
function mount(path: string, routes: { path: string; element: JSX.Element }[], permissions: string[], handler: Handler) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any; query: URLSearchParams }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ method, path: p, body, query: url.searchParams });
    if (p === '/auth/refresh') return json({ accessToken: 't' });
    if (p === '/auth/me') return json(me(permissions));
    if (p === '/site-options') return json(OPTIONS);
    if (p === '/site-saved-views') return json([]);
    if (p === '/people') return json([{ id: 'u2', fullName: 'مینا رستمی', jobTitle: null }]);
    return handler(p, method, body, url.searchParams) ?? json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider>
        <MemoryRouter initialEntries={[path]}><Routes>{routes.map((r) => <Route key={r.path} path={r.path} element={r.element} />)}</Routes></MemoryRouter>
      </AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

beforeEach(() => localStorage.clear());

describe('The venue database', () => {
  it('lists venues with the filters the address carries, and their completeness', async () => {
    const sent = mount('/sites/venues?province=تهران&incomplete=true', [{ path: '/sites/venues', element: <VenuesPage /> }], ['venue.read', 'venue.write'], (p) => {
      if (p === '/venues') return json({ items: [VENUE], total: 1, page: 1, pageSize: 25, pageCount: 1 });
      if (p === '/venues/facets') return json({ places: [{ province: 'تهران', city: 'تهران', n: 1 }] });
    });
    expect(await screen.findByText('مجتمع کوروش')).toBeTruthy();
    expect(screen.getByText('علی مدیرزاده')).toBeTruthy();
    const list = sent.find((s) => s.path === '/venues');
    expect(list?.query.get('province')).toBe('تهران');
    expect(list?.query.get('incomplete')).toBe('true');
    expect(screen.getByText('۶۷٪')).toBeTruthy();
  });

  it('shows a likely duplicate before saving, and saves only once the person says it is another venue', async () => {
    const sent = mount('/sites/venues', [{ path: '/sites/venues', element: <VenuesPage /> }, { path: '/sites/venues/:id', element: <p>profile</p> }], ['venue.read', 'venue.write'], (p, method) => {
      if (p === '/venues' && method === 'GET') return json({ items: [], total: 0, page: 1, pageSize: 25, pageCount: 1 });
      if (p === '/venues/facets') return json({ places: [] });
      if (p === '/venues/duplicates') return json({ candidates: [{ id: 'v1', code: 'VEN-000001', name: 'مجتمع کوروش', city: 'تهران', province: 'تهران', reasons: ['NAME_CITY'], archived: false }] });
      if (p === '/venues' && method === 'POST') return json({ id: 'v9' }, 201);
    });
    fireEvent.click(await screen.findByRole('button', { name: /مکان تازه/ }));
    const form = within(await screen.findByRole('dialog'));
    fireEvent.change(form.getByLabelText(/نام مکان/), { target: { value: 'مجتمع کوروش' } });
    fireEvent.change(form.getByLabelText(/^استان/), { target: { value: 'تهران' } });
    fireEvent.change(form.getByLabelText(/^شهر/), { target: { value: 'تهران' } });
    fireEvent.change(form.getByLabelText(/نوع مکان/), { target: { value: 'MALL' } });
    expect(await screen.findByText('این مکان شبیه این مکان‌های ثبت‌شده است:', {}, { timeout: 3000 })).toBeTruthy();
    const save = form.getByRole('button', { name: 'ثبت' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(form.getByLabelText('دیدم؛ این مکان دیگری است و تکراری نیست'));
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(sent.some((s) => s.path === '/venues' && s.method === 'POST')).toBe(true));
    const body = sent.find((s) => s.path === '/venues' && s.method === 'POST')!.body;
    expect(body.confirmNotDuplicate).toBe(true);
    expect(body.contacts).toEqual([]);
  });
});

const PROJECT = {
  id: 'p1', code: 'SIT-000001', name: 'کانتر پاییز', state: 'CONTRACT_PENDING', placement: 'همکف', currency: 'IRR', version: 3, termsLocked: true, venueId: 'v1',
  venue: { id: 'v1', code: 'VEN-000001', name: 'مجتمع کوروش', city: 'تهران', province: 'تهران', address: null, phone: null, contacts: [] },
  responsible: { id: 'u2', fullName: 'مینا رستمی' }, responsibleId: 'u2', createdBy: { fullName: 'مینا رستمی' }, createdAt: '2026-10-01T00:00:00Z',
  project: null, projectId: null, company: null, companyId: null, cooperationCode: 'FORMAL', contractStart: '2026-10-23', contractEnd: '2027-04-21',
  depositAmount: '60000000.00', rentAmount: '30000000.00', rentPeriod: 'MONTHLY', rentDueDay: 5, rentMethodCode: 'CHEQUE', chargeAmount: null, chargeDueDay: null, chargeMethodCode: null,
  installPlannedAt: null, installedAt: null, installDays: null, installStatus: 'NOT_STARTED', installCost: null, transportCost: null, installNotes: null, notes: null,
  scheduleGeneratedAt: null, closedAt: null, cancelReason: null, fabricationCost: '0.00',
  negotiations: [], approvals: [], counters: [], assignments: [], documents: [],
  contracts: [{ id: 'c1', version: 1, reference: 'ق-۲۲', status: 'PENDING_APPROVAL', terms: { rentAmount: '30000000', contractStart: '2026-10-23', contractEnd: '2027-04-21', cooperationCode: 'FORMAL' }, notes: null, submittedAt: '2026-10-25T00:00:00Z', decidedAt: null, decisionComment: null, createdBy: { id: 'u2', fullName: 'مینا رستمی' }, decidedBy: null, createdAt: '2026-10-24T00:00:00Z' }],
  availableTransitions: [
    { action: 'reopen_negotiation', labelFa: 'بازگشت به مذاکره', labelEn: 'Back to negotiation', requiresReason: true, to: 'NEGOTIATION' },
    { action: 'approve_contract', labelFa: 'تأیید قرارداد', labelEn: 'Approve the contract', requiresReason: false, to: 'CONTRACT_APPROVED' },
  ],
  balances: null,
};

describe('A deployment project', () => {
  it('decides the contract on its version — not by a bare move — and says the terms are the contract’s', async () => {
    const sent = mount('/sites/projects/p1?tab=contract', [{ path: '/sites/projects/:id', element: <ProjectsPage /> }], ['site.read', 'site.write', 'site.contract.approve'], (p, method) => {
      if (p === '/site-projects/p1') return json(PROJECT);
      if (p === '/workflow/siteProject/p1/preflight') return json({ transitions: [] });
      if (p === '/workflow/siteProject/p1/history') return json([]);
      if (p === '/site-contracts/c1/decision' && method === 'POST') return json({ ...PROJECT.contracts[0], status: 'APPROVED' });
    });
    expect(await screen.findByText('نسخهٔ ۱')).toBeTruthy();
    // The workflow bar offers going back, but approving is the version's decision.
    expect(screen.getByRole('button', { name: 'بازگشت به مذاکره' })).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: 'تأیید قرارداد' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'تأیید قرارداد' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ثبت تصمیم' }));
    await waitFor(() => expect(sent.some((s) => s.path === '/site-contracts/c1/decision')).toBe(true));
    expect(sent.find((s) => s.path === '/site-contracts/c1/decision')!.body.decision).toBe('APPROVE');
    expect(sent.some((s) => s.path === '/workflow/siteProject/p1/transitions')).toBe(false);
  });

  it('records a payment with its own key, asking for the cheque number a cheque needs', async () => {
    const ledger = {
      obligations: [{ id: 'ob1', kind: 'RENT', categoryCode: null, description: null, periodStart: '2026-10-23', periodEnd: '2026-11-22', dueDate: '2026-10-28', amount: '30000000.00', settledAmount: '0.00', outstanding: '30000000.00', overdue: true, status: 'OPEN', source: 'SCHEDULE', closeReason: null }],
      payments: [], deposits: [],
      balances: { currency: 'IRR', due: '30000000.00', settled: '0.00', outstanding: '30000000.00', overdue: '30000000.00', upcoming30: '0.00', paidOut: '0.00', paidIn: '0.00', credit: '0.00', byKind: {}, deposit: { original: null, held: '0.00', deductionsApproved: '0.00', deductionsPending: '0.00', refunded: '0.00', remaining: '0.00', status: 'NONE' }, costs: { installation: '0.00', transport: '0.00', fabrication: '0.00', total: '0.00' } },
    };
    const sent = mount('/sites/projects/p1?tab=finance', [{ path: '/sites/projects/:id', element: <ProjectsPage /> }], ['site.read', 'rental.read', 'rental.manage'], (p, method) => {
      if (p === '/site-projects/p1') return json({ ...PROJECT, state: 'ACTIVE', availableTransitions: [], balances: ledger.balances, scheduleGeneratedAt: '2026-10-24T00:00:00Z' });
      if (p === '/site-projects/p1/ledger') return json(ledger);
      if (p === '/workflow/siteProject/p1/history') return json([]);
      if (p === '/site-projects/p1/payments' && method === 'POST') return json({ id: 'pay1' }, 201);
    });
    expect(await screen.findByText('سررسید گذشته')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'پرداخت' }));
    const dialog = within(await screen.findByRole('dialog'));
    const submit = dialog.getByRole('button', { name: 'ثبت پرداخت' });
    // The rent's own method — a cheque — is chosen, and its number is asked for before it is sent.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/شمارهٔ چک/), { target: { value: '778899' } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(sent.some((s) => s.path === '/site-projects/p1/payments')).toBe(true));
    const body = sent.find((s) => s.path === '/site-projects/p1/payments')!.body;
    expect(body).toMatchObject({ purpose: 'OBLIGATIONS', amount: '30000000', methodCode: 'CHEQUE', chequeNumber: '778899', allocations: [{ obligationId: 'ob1', amount: '30000000' }] });
    expect(body.clientKey.length).toBeGreaterThanOrEqual(8);
  });
});

describe('The rentals register', () => {
  it('reads the totals the server added up, per currency', async () => {
    mount('/sites/rentals?tab=register', [{ path: '/sites/rentals', element: <RentalsPage /> }], ['rental.read'], (p) => {
      if (p === '/site-obligations') return json({
        items: [{ id: 'o1', kind: 'CHARGE', dueDate: '2026-10-28', amount: '3000000.00', settledAmount: '0.00', outstanding: '3000000.00', overdue: false, status: 'OPEN', currency: 'IRR', description: null, periodStart: null, periodEnd: null, siteProject: { id: 'p1', code: 'SIT-000001', name: 'کانتر پاییز', responsible: null, venue: { name: 'مجتمع کوروش', city: 'تهران' } } }],
        total: 1, page: 1, pageSize: 50, pageCount: 1, totals: [{ currency: 'IRR', amount: '3000000.00', settled: '0.00', outstanding: '3000000.00' }],
      });
    });
    expect(await screen.findByText('کانتر پاییز')).toBeTruthy();
    expect(screen.getByText(/جمع:/)).toBeTruthy();
  });

  it('keeps a sum as the decimal string typed, Persian digits and separators and all', () => {
    const onChange = vi.fn();
    render(<AmountInput value="" onChange={onChange} aria-label="مبلغ" />);
    fireEvent.change(screen.getByLabelText('مبلغ'), { target: { value: '۱۲٬۵۰۰٬۰۰۰.۵' } });
    expect(onChange).toHaveBeenCalledWith('12500000.5');
  });
});

describe('Excel in beside Excel out', () => {
  it('offers the import beside the export, locked to the list’s kind, for whoever may import it', async () => {
    const sent = mount('/sites/venues', [{ path: '/sites/venues', element: <VenuesPage /> }], ['venue.read', 'venue.write', 'venue.manage'], (p) => {
      if (p === '/venues') return json({ items: [], total: 0, page: 1, pageSize: 25, pageCount: 1 });
      if (p === '/venues/facets') return json({ places: [] });
      if (p === '/site-data/columns/VENUES') return json([{ key: 'name', fa: 'نام مکان', required: true }]);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'ورود از اکسل' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect((dialog.getByLabelText('نوع') as HTMLSelectElement).disabled).toBe(true);
    expect(dialog.getByRole('button', { name: 'دریافت الگوی خالی' })).toBeTruthy();
    await waitFor(() => expect(sent.some((s) => s.path === '/site-data/columns/VENUES')).toBe(true));
  });

  it('shows no import to someone who may only read the list', async () => {
    mount('/sites/venues', [{ path: '/sites/venues', element: <VenuesPage /> }], ['venue.read'], (p) => {
      if (p === '/venues') return json({ items: [], total: 0, page: 1, pageSize: 25, pageCount: 1 });
      if (p === '/venues/facets') return json({ places: [] });
    });
    expect(await screen.findByRole('button', { name: 'خروجی اکسل' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ورود از اکسل' })).toBeNull();
  });
});
