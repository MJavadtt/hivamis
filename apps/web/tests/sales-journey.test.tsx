import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { CustomerJourney, NewCustomer } from '../src/pages/SalesJourney';

/**
 * The owner's brief (2026-11-02): a salesperson registers a customer with all its people and where it
 * came from — no estimated value — then records each meeting, makes it a sale, writes the brief and
 * sends it, on one page that says at each step what it is for. Everything is written through the
 * CRM's own routes.
 */
const OPTIONS = {
  kinds: [{ value: 'DIRECT', fa: 'تماس مستقیم', detailFa: 'کانال' }],
  channels: [{ value: 'EXHIBITION', fa: 'نمایشگاه' }],
  salesTeam: [], staff: [], marketers: [], partners: [], canManageMarketers: false, canAddPartners: false,
};
const USER = {
  id: 'u1', email: 's@hiva.local', fullName: 'الهام کریمی', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [],
  permissions: ['crm.lead.read', 'crm.lead.write', 'crm.lead.convert', 'crm.company.read', 'crm.company.write', 'crm.contact.write', 'crm.activity.write', 'brief.read', 'brief.write', 'brief.submit'],
  locale: 'fa', mustChangePassword: false,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 25, pageCount: 1 });

const C360 = (over: Record<string, unknown> = {}) => ({
  company: {
    id: 'co-1', legalName: 'بانک آینده‌سازان', brandName: null, industry: 'بانک', notes: 'کمپین پاییز',
    contacts: [{ id: 'ct-1', fullName: 'علی رضایی', jobTitle: 'مدیر بازاریابی', phone: '09121234567', email: null, isPrimary: true }],
  },
  opportunities: [], activities: [], ...over,
});

function mount(node: React.ReactNode, at: string, api: (path: string, method: string, url: URL) => unknown = () => undefined) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(USER);
    if (p === '/leads/source-options') return json(OPTIONS);
    if (p === '/leads/duplicates') return json({ phone: url.searchParams.get('phone'), leads: [], contacts: [] });
    if (p.endsWith('/preflight')) return json({ state: 'x', transitions: [] });
    const answer = api(p, method, url);
    if (answer !== undefined) return json(answer, method === 'POST' ? 201 : 200);
    if (method === 'GET') return json(page([]));
    return json({ id: 'new' }, 201);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider>
        <MemoryRouter initialEntries={[at]}>
          <Routes>
            <Route path="/sales/new" element={node} />
            <Route path="/sales/journey/:companyId" element={node} />
          </Routes>
          <Routes><Route path="/sales/journey/:companyId" element={<span data-testid="landed" />} /><Route path="*" element={null} /></Routes>
        </MemoryRouter>
      </AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}
const posts = (sent: { method: string; path: string; body: any }[], path: string) => sent.filter((s) => s.method === 'POST' && s.path === path);

describe('A new customer', () => {
  it('makes the lead, the client and every contact together — with its source and no estimated value — then opens its journey', async () => {
    const sent = mount(<NewCustomer />, '/sales/new', (p, m) => (p === '/companies' && m === 'POST' ? { id: 'co-new' } : undefined));
    const save = () => screen.getByRole('button', { name: 'ثبت مشتری' }) as HTMLButtonElement;
    fireEvent.change(await screen.findByLabelText('نام مشتری یا برند'), { target: { value: 'هلدینگ ماد' } });
    fireEvent.change(screen.getByLabelText('نوع کسب‌وکار'), { target: { value: 'خودرو' } });
    fireEvent.change(screen.getByLabelText('نام مخاطب ۱'), { target: { value: 'سارا محمدی' } });
    fireEvent.change(screen.getByLabelText('تلفن مخاطب ۱'), { target: { value: '0935 777 0011' } });
    fireEvent.click(screen.getByRole('button', { name: '+ مخاطب دیگر' }));
    fireEvent.change(screen.getByLabelText('نام مخاطب ۲'), { target: { value: 'رضا احمدی' } });
    fireEvent.change(screen.getByLabelText('سمت مخاطب ۲'), { target: { value: 'مدیر مالی' } });
    expect(save().disabled).toBe(true);

    const source = screen.getByTestId('lead-source');
    fireEvent.click(await within(source).findByRole('button', { name: 'تماس مستقیم' }));
    fireEvent.click(within(source).getByRole('button', { name: 'نمایشگاه' }));
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(save());

    await screen.findByTestId('landed');
    const lead = posts(sent, '/leads')[0]!.body;
    expect(lead).toMatchObject({ name: 'هلدینگ ماد', companyName: 'هلدینگ ماد', contactName: 'سارا محمدی', phone: '09357770011', source: 'DIRECT', sourceChannel: 'EXHIBITION' });
    expect(lead).not.toHaveProperty('estimatedValue');
    expect(posts(sent, '/companies')[0]!.body).toMatchObject({ legalName: 'هلدینگ ماد', industry: 'خودرو' });
    expect(posts(sent, '/contacts').map((c) => c.body)).toEqual([
      expect.objectContaining({ companyId: 'co-new', fullName: 'سارا محمدی', phone: '09357770011', isPrimary: true }),
      expect.objectContaining({ companyId: 'co-new', fullName: 'رضا احمدی', jobTitle: 'مدیر مالی', isPrimary: false }),
    ]);
  });

  it('points to a customer already on file instead of making it twice', async () => {
    mount(<NewCustomer />, '/sales/new', (p, m) => (p === '/companies' && m === 'GET' ? page([{ id: 'co-1', legalName: 'بانک آینده‌سازان', brandName: null }]) : undefined));
    fireEvent.change(await screen.findByLabelText('نام مشتری یا برند'), { target: { value: 'بانک آینده‌سازان' } });
    const notice = await screen.findByTestId('existing-customer');
    expect(within(notice).getByRole('link', { name: 'مسیر فروش آن را باز کنید' }).getAttribute('href')).toBe('/sales/journey/co-1');
  });
});

describe('A customer’s journey', () => {
  it('shows where it stands, records a meeting with whom and where, and makes the qualified lead a sale for this same client', async () => {
    const sent = mount(<CustomerJourney />, '/sales/journey/co-1', (p, m) => {
      if (p === '/companies/co-1/360') return C360();
      if (p === '/leads' && m === 'GET') return page([{ id: 'l-1', code: 'LEAD-000020', companyName: 'بانک آینده‌سازان', companyId: null, state: 'QUALIFIED', createdAt: '2026-11-01T00:00:00.000Z', availableTransitions: [] }]);
      return undefined;
    });
    const steps = await screen.findByTestId('journey-steps');
    expect(within(steps).getByText('پیگیری و جلسه').closest('li')!.getAttribute('aria-current')).toBe('step');

    const form = screen.getByTestId('follow-up');
    fireEvent.change(within(form).getByLabelText('مخاطب پیگیری'), { target: { value: 'ct-1' } });
    fireEvent.change(within(form).getByLabelText('محل جلسه'), { target: { value: 'دفتر مشتری' } });
    fireEvent.change(within(form).getByLabelText('خلاصهٔ گفت‌وگو'), { target: { value: 'نیاز به کمپین دیجیتال' } });
    fireEvent.change(within(form).getByLabelText('پیگیری بعدی'), { target: { value: 'فرستادن نمونه‌کار' } });
    fireEvent.click(within(form).getByRole('button', { name: 'ثبت پیگیری' }));
    await waitFor(() => expect(posts(sent, '/activities')).toHaveLength(1));
    expect(posts(sent, '/activities')[0]!.body).toMatchObject({
      companyId: 'co-1', kind: 'MEETING', summary: 'با: علی رضایی — محل: دفتر مشتری\nنیاز به کمپین دیجیتال', nextStep: 'فرستادن نمونه‌کار',
    });

    fireEvent.click(await screen.findByRole('button', { name: 'تبدیل به فرصت فروش' }));
    await waitFor(() => expect(posts(sent, '/leads/l-1/convert')).toHaveLength(1));
    expect(posts(sent, '/leads/l-1/convert')[0]!.body).toEqual({ companyId: 'co-1', title: 'فرصت — بانک آینده‌سازان' });
  });

  it('writes the brief in plain questions for the sale', async () => {
    const sent = mount(<CustomerJourney />, '/sales/journey/co-1', (p) => {
      if (p === '/companies/co-1/360') return C360({ opportunities: [{ id: 'o-1', code: 'OPP-000003', title: 'فرصت — بانک', state: 'QUALIFIED', createdAt: '2026-11-01T00:00:00.000Z' }] });
      return undefined;
    });
    const brief = await screen.findByTestId('new-brief');
    fireEvent.change(within(brief).getByLabelText('هدف کسب‌وکار'), { target: { value: 'معرفی کارت تازه' } });
    fireEvent.click(within(brief).getByRole('checkbox', { name: 'خلاقیت / گرافیک / تولید' }));
    fireEvent.click(within(brief).getByRole('button', { name: 'ذخیرهٔ بریف' }));
    await waitFor(() => expect(posts(sent, '/briefs')).toHaveLength(1));
    expect(posts(sent, '/briefs')[0]!.body).toMatchObject({ opportunityId: 'o-1', title: 'بریف — بانک آینده‌سازان', businessObjective: 'معرفی کارت تازه', unitsNeeded: ['CR'] });
  });

  it('says plainly a brief came back, who sent it back and why, and offers to send it again', async () => {
    mount(<CustomerJourney />, '/sales/journey/co-1', (p) => {
      if (p === '/companies/co-1/360') return C360({
        opportunities: [{ id: 'o-1', code: 'OPP-000003', title: 'فرصت — بانک', state: 'BRIEF_REQUESTED', createdAt: '2026-11-01T00:00:00.000Z' }],
        activities: [{ id: 'a-1', kind: 'CALL', occurredAt: '2026-11-01T00:00:00.000Z', summary: 'تماس نخست', nextStep: null, nextStepDue: null }],
      });
      if (p === '/briefs') return page([{ id: 'b-1', code: 'BRF-000004', title: 'بریف — بانک', state: 'RETURNED_INCOMPLETE', availableTransitions: [{ action: 'resubmit', labelFa: 'ارسال دوباره', labelEn: 'Resubmit', requiresReason: false, to: 'SUBMITTED' }] }]);
      if (p === '/workflow/brief/b-1/history') return [{ id: 'h1', toState: 'RETURNED_INCOMPLETE', reason: 'بودجه مشخص نیست', createdAt: new Date().toISOString(), actor: { fullName: 'سپیده آذر' } }];
      return undefined;
    });
    const send = await screen.findByRole('region', { name: 'ارسال برای بررسی' });
    const note = await within(send).findByTestId('return-note');
    expect(note.textContent).toContain('سپیده آذر');
    expect(note.textContent).toContain('«بودجه مشخص نیست»');
    expect(within(send).getByText('بریف برای تکمیل برگشته است. آن را باز کنید، کامل کنید، و دوباره بفرستید.')).toBeTruthy();
    expect(within(send).getByRole('button', { name: 'ارسال دوباره' })).toBeTruthy();
    expect(screen.getByTestId('timeline').textContent).toContain('تماس تلفنی');
    const steps = screen.getByTestId('journey-steps');
    expect(within(steps).getByText('ارسال برای بررسی').closest('li')!.getAttribute('aria-current')).toBe('step');
  });
});
