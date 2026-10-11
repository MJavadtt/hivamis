import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { LeadsList } from '../src/pages/Crm';
import { LeadReferrers } from '../src/components/LeadSource';

/**
 * A lead's mobile number checked while it is typed, and its source in two clicks (Hivamis task 2).
 */
const OPTIONS = (over: Record<string, unknown> = {}) => ({
  kinds: [
    { value: 'SALES_TEAM', fa: 'تیم فروش', detailFa: 'عضو تیم فروش' }, { value: 'MARKETER', fa: 'بازاریابان', detailFa: 'بازاریاب' },
    { value: 'STAFF', fa: 'پرسنل شرکت', detailFa: 'همکار (خارج از تیم فروش)' }, { value: 'DIRECT', fa: 'تماس مستقیم', detailFa: 'کانال' },
    { value: 'PARTNER', fa: 'شرکت‌های همکار', detailFa: 'شرکت همکار' },
  ],
  channels: [{ value: 'PHONE', fa: 'تلفن' }, { value: 'EXHIBITION', fa: 'نمایشگاه' }, { value: 'EVENT', fa: 'رویداد' }, { value: 'CAMPAIGN', fa: 'کمپین' }],
  salesTeam: [{ id: 'u-nima', fullName: 'نیما فروزان', jobTitle: 'مدیر فروش', department: 'فروش' }],
  staff: [{ id: 'u-design', fullName: 'بهراد مهرنیا', jobTitle: 'طراح', department: 'خلاقیت' }],
  marketers: [{ id: 'r-mahsa', name: 'مهسا یزدانی' }],
  partners: [{ id: 'r-print', name: 'چاپخانهٔ نقش‌آفرین' }],
  canManageMarketers: false, canAddPartners: true, ...over,
});
const LEADS = { items: [{
  id: 'l-1', code: 'LEAD-000010', name: 'سرنخ نمونه', companyName: 'هلدینگ ماد', phone: '09352201000', source: 'SALES_TEAM',
  sourceUser: { id: 'u-nima', fullName: 'نیما فروزان' }, sourceReferrer: null, sourceChannel: null, estimatedValue: '1000', owner: null, state: 'NEW', availableTransitions: [],
}], total: 1, page: 1, pageSize: 25, pageCount: 1 };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const USER = { id: 'u1', email: 's@hiva.local', fullName: 'الهام کریمی', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: ['crm.lead.read', 'crm.lead.write'], locale: 'fa', mustChangePassword: false };

function mount(node: React.ReactNode, opts: { options?: unknown; duplicates?: (phone: string) => unknown } = {}) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(USER);
    if (p === '/leads/source-options') return json(opts.options ?? OPTIONS());
    if (p === '/leads/duplicates') return json(opts.duplicates?.(url.searchParams.get('phone')!) ?? { phone: url.searchParams.get('phone'), leads: [], contacts: [] });
    if (p === '/leads' && method === 'POST') return json({ id: 'l-new' }, 201);
    if (p === '/leads') return json(LEADS);
    if (p === '/lead-referrers' && method === 'GET') return json({ items: [{ id: 'r-mahsa', kind: 'MARKETER', name: 'مهسا یزدانی', phone: '09121110001', note: null, isActive: true, leads: 3, createdAt: '2026-10-01T00:00:00.000Z' }], total: 1 });
    return json({}, 201);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter>{node}</MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

async function openForm() {
  fireEvent.click(await screen.findByRole('button', { name: /سرنخ جدید/ }));
  const dialog = await screen.findByRole('dialog', { name: 'ثبت سرنخ جدید' });
  const fill = (label: string, value: string) => fireEvent.change(within(dialog).getByLabelText(new RegExp(label)), { target: { value } });
  return { dialog, fill, save: () => within(dialog).getByRole('button', { name: 'ثبت' }) as HTMLButtonElement };
}

describe('The leads list', () => {
  it('shows each lead’s mobile and its source as one phrase', async () => {
    mount(<LeadsList />);
    const row = (await screen.findByText('سرنخ نمونه')).closest('tr')!;
    expect(within(row).getByText('تیم فروش — نیما فروزان')).toBeTruthy();
    expect(within(row).getByText('09352201000')).toBeTruthy();
  });
});

describe('Registering a lead', () => {
  it('reads the mobile however it is typed, and will not save until the source’s second step is taken', async () => {
    const sent = mount(<LeadsList />);
    const { dialog, fill, save } = await openForm();
    fill('نام سرنخ', 'کمپین پاییز'); fill('نام شرکت', 'شرکت نمونه');
    fill('تلفن همراه', '۰۲۱۸۸');
    expect(within(dialog).getByText('شمارهٔ همراه معتبر نیست — مانند ۰۹۱۲۱۲۳۴۵۶۷')).toBeTruthy();
    fill('تلفن همراه', '+98 935 777 0011');
    expect(within(dialog).getByText('ثبت می‌شود: 09357770011')).toBeTruthy();
    expect(save().disabled).toBe(true);

    const source = within(dialog).getByTestId('lead-source');
    fireEvent.click(await within(source).findByRole('button', { name: 'تماس مستقیم' }));
    expect(save().disabled).toBe(true);
    fireEvent.click(within(source).getByRole('button', { name: 'نمایشگاه' }));
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(save());
    await waitFor(() => expect(sent.find((s) => s.method === 'POST' && s.path === '/leads')).toBeTruthy());
    expect(sent.find((s) => s.method === 'POST' && s.path === '/leads')!.body).toMatchObject({ name: 'کمپین پاییز', phone: '09357770011', source: 'DIRECT', sourceChannel: 'EXHIBITION' });
  });

  it('shows who already has the number, and asks to be told it is meant before saving', async () => {
    const sent = mount(<LeadsList />, {
      duplicates: (phone) => ({ phone, leads: [{ id: 'l-1', code: 'LEAD-000010', name: 'سرنخ نمونه', companyName: 'هلدینگ ماد', state: 'NEW', owner: 'الهام کریمی' }], contacts: [{ id: 'c-1', fullName: 'علی رضایی', company: 'بانک آینده‌سازان', companyId: 'co-1' }] }),
    });
    const { dialog, fill, save } = await openForm();
    fill('نام سرنخ', 'تکراری'); fill('نام شرکت', 'شرکت');
    fill('تلفن همراه', '09352201000');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'تیم فروش' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'نیما فروزان' }));
    const warning = await within(dialog).findByTestId('lead-duplicate');
    expect(warning.textContent).toContain('LEAD-000010');
    expect(warning.textContent).toContain('علی رضایی');
    expect(save().disabled).toBe(true);
    fireEvent.click(within(warning).getByRole('checkbox'));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(sent.find((s) => s.method === 'POST' && s.path === '/leads')?.body).toMatchObject({ source: 'SALES_TEAM', sourceUserId: 'u-nima', confirmDuplicate: true }));
  });

  it('names a partner from the list, or a new one by typing it', async () => {
    const sent = mount(<LeadsList />);
    const { dialog, fill, save } = await openForm();
    fill('نام سرنخ', 'از همکار'); fill('نام شرکت', 'شرکت'); fill('تلفن همراه', '09121234567');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'شرکت‌های همکار' }));
    fireEvent.change(within(dialog).getByLabelText('نام شرکت همکار'), { target: { value: 'آژانس رویداد کیش' } });
    expect(within(dialog).getByText(/«آژانس رویداد کیش» در فهرست نیست و با ثبت سرنخ به شرکت‌های همکار افزوده می‌شود/)).toBeTruthy();
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(save());
    await waitFor(() => expect(sent.find((s) => s.method === 'POST' && s.path === '/leads')?.body).toMatchObject({ source: 'PARTNER', sourcePartnerName: 'آژانس رویداد کیش' }));
  });

  it('says where marketers come from when the list is empty, and lets the admin go and add one', async () => {
    mount(<LeadsList />, { options: OPTIONS({ marketers: [], canManageMarketers: true }) });
    const { dialog } = await openForm();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'بازاریابان' }));
    expect(within(dialog).getByText(/فهرست بازاریابان خالی است/)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'افزودن بازاریاب' }).getAttribute('href')).toBe('/admin?tab=referrers');
  });
});

describe('The admin’s list of lead sources', () => {
  it('adds a marketer, and retires one without losing the leads that name them', async () => {
    const sent = mount(<LeadReferrers />);
    const row = (await screen.findByText('مهسا یزدانی')).closest('tr')!;
    expect(within(row).getByText('۳')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'کنار گذاشتن' }));
    await waitFor(() => expect(sent.find((s) => s.method === 'PATCH')).toMatchObject({ path: '/lead-referrers/r-mahsa', body: { isActive: false } }));

    fireEvent.change(screen.getByLabelText('نام'), { target: { value: 'سینا فرهمند' } });
    fireEvent.click(screen.getByRole('button', { name: 'افزودن' }));
    await waitFor(() => expect(sent.find((s) => s.method === 'POST' && s.path === '/lead-referrers')?.body).toEqual({ kind: 'MARKETER', name: 'سینا فرهمند' }));
  });
});
