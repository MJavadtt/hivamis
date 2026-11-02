import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { AccountDesk, AccountJourney, deskGroupOf, nextFor } from '../src/pages/AccountJourney';

/**
 * The owner's brief (2026-11-02): Account's part of a sale as steps a person follows — review the
 * brief, open the project and proposal, order each unit, take what the units hand in, finish the
 * proposal, hand it to Sales — each saying what it waits for, each written through the routes and
 * moves the rest of the system uses.
 */
const USER = {
  id: 'u-am', email: 'am@hiva.local', fullName: 'سپیده آذر', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [],
  permissions: ['brief.read', 'brief.review', 'brief.approve', 'brief.return', 'proposal.read', 'proposal.write', 'project.read', 'project.write', 'workorder.read', 'workorder.issue', 'pricing.set_price', 'qc.account'],
  locale: 'fa', mustChangePassword: false,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 25, pageCount: 1 });
const move = (action: string, labelFa: string, requiresReason = false) => ({ action, labelFa, labelEn: action, requiresReason, to: 'X' });

const BRIEF = (over: Record<string, unknown> = {}) => ({
  id: 'b-1', code: 'BRF-000007', title: 'بریف — بانک آینده‌سازان', state: 'APPROVED', createdAt: '2026-11-01T00:00:00.000Z',
  businessObjective: 'معرفی کارت تازه', targetAudience: 'جوانان', scope: 'کمپین دیجیتال سه‌ماهه', expectedDeliverables: 'تیزر و بنر',
  budgetRange: '5000000000', desiredDeadline: '2026-12-20T00:00:00.000Z', unitsNeeded: ['CR', 'DM'], completenessScore: 100, missingItems: [],
  opportunity: { id: 'o-1', title: 'فرصت', companyId: 'co-1', company: { id: 'co-1', legalName: 'بانک آینده‌سازان' } },
  proposals: [], availableTransitions: [], ...over,
});
const PROPOSAL = (over: Record<string, unknown> = {}) => ({
  id: 'p-1', code: 'PRP-000003', title: 'پروپوزال — بانک', state: 'DRAFT', totalCost: null, salePrice: null, pricingApprovedAt: null,
  costDeclarations: [], qcReviews: [], availableTransitions: [move('dispatch_orders', 'ارسال سفارش به واحدها')], ...over,
});
const PROJECT = { id: 'pr-1', code: 'PRJ-000009', name: 'بانک آینده‌سازان', state: 'DRAFT', briefId: 'b-1', proposalId: null, plannedEnd: '2026-12-20T00:00:00.000Z' };

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
    if (p.endsWith('/preflight')) return json({ state: 'x', transitions: [] });
    if (p === '/people') return json([{ id: 'u-dm', fullName: 'نگار دیجیتال', jobTitle: 'مدیر واحد', department: { code: 'DM' } }, { id: 'u-cr', fullName: 'بهراد مهرنیا', jobTitle: 'طراح', department: { code: 'CR' } }]);
    const answer = api(p, method, url);
    if (answer !== undefined) return json(answer, method === 'POST' ? 201 : 200);
    if (method === 'GET') return json(page([]));
    return json({ id: 'new' }, 201);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider>
        <MemoryRouter initialEntries={[at]}>
          <Routes><Route path="/account" element={node} /><Route path="/account/journey/:briefId" element={node} /></Routes>
        </MemoryRouter>
      </AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}
const posts = (sent: { method: string; path: string; body: any }[], path: string) => sent.filter((s) => s.method === 'POST' && s.path === path);
const current = () => within(screen.getByTestId('journey-steps')).getAllByRole('listitem').find((li) => li.getAttribute('aria-current') === 'step')?.textContent;

describe('Where a brief stands, for Account', () => {
  it('says in one sentence what each brief waits for, and sorts them the way Account works', () => {
    expect(nextFor({ state: 'SUBMITTED' })).toBe('بریف تازه رسیده است؛ بررسی آن را شروع کنید.');
    expect(nextFor({ state: 'APPROVED' })).toBe('تأیید شده؛ پروژه و پروپوزال را باز کنید.');
    expect(nextFor({ state: 'APPROVED' }, { state: 'PRICING' })).toBe('قیمت فروش را تعیین کنید و به QC نهایی بفرستید.');
    expect(['SUBMITTED', 'UNDER_REVIEW', 'RETURNED_INCOMPLETE', 'DRAFT'].map((s) => deskGroupOf({ state: s }))).toEqual(['review', 'review', 'returned', null]);
    expect(deskGroupOf({ state: 'APPROVED' }, { state: 'AWAITING_UNIT_OUTPUTS' })).toBe('working');
    expect(deskGroupOf({ state: 'APPROVED' }, { state: 'PRESENTED_TO_CLIENT' })).toBe('sales');
    // The client asked for changes: it is Account's again.
    expect(deskGroupOf({ state: 'APPROVED' }, { state: 'CLIENT_REVISION_REQUESTED' })).toBe('working');
  });

  it('lists every brief under what it waits for', async () => {
    mount(<AccountDesk />, '/account', (p) => {
      if (p === '/briefs') return page([BRIEF({ id: 'b-new', title: 'بریف تازه', state: 'SUBMITTED' }), BRIEF({ id: 'b-1' }), BRIEF({ id: 'b-old', title: 'بریف قدیمی' })]);
      if (p === '/proposals') return page([{ id: 'p-1', briefId: 'b-1', state: 'INTEGRATION', version: 1 }, { id: 'p-9', briefId: 'b-old', state: 'DELIVERED_TO_SALES', version: 2 }]);
      return undefined;
    });
    const desk = await screen.findByTestId('account-desk');
    expect([...desk.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))).toEqual(['بریف‌های تازه برای بررسی', 'در دست اکانت', 'نزد فروش و مشتری']);
    const row = screen.getAllByTestId('desk-row').find((r) => r.textContent?.includes('بانک آینده‌سازان') && r.textContent.includes('یکپارچه'))!;
    expect(within(row).getByRole('link').getAttribute('href')).toBe('/account/journey/b-1');
  });
});

describe('A brief’s account journey', () => {
  it('shows what Sales said and what is missing, with approve and send back side by side', async () => {
    mount(<AccountJourney />, '/account/journey/b-1', (p) => p === '/briefs/b-1'
      ? BRIEF({ state: 'UNDER_REVIEW', budgetRange: null, missingItems: ['بودجه'], availableTransitions: [move('return_incomplete', 'بازگشت بریف ناقص', true), move('approve', 'تأیید بریف')] })
      : undefined);
    const review = await screen.findByRole('region', { name: 'بررسی بریف' });
    expect(within(review).getByText('کم است: بودجه')).toBeTruthy();
    expect(within(review).getByRole('button', { name: 'تأیید بریف' })).toBeTruthy();
    expect(within(review).getByRole('button', { name: 'بازگشت بریف ناقص' })).toBeTruthy();
    expect(current()).toContain('بررسی بریف');
  });

  it('opens the project and the proposal from the brief with one button', async () => {
    const sent = mount(<AccountJourney />, '/account/journey/b-1', (p) => (p === '/briefs/b-1' ? BRIEF() : undefined));
    const start = await screen.findByTestId('start-work');
    expect((within(start).getByLabelText('نام پروژه') as HTMLInputElement).value).toBe('بانک آینده‌سازان');
    fireEvent.click(within(start).getByRole('button', { name: 'باز کردن پروژه و پروپوزال' }));
    await waitFor(() => expect(posts(sent, '/proposals')).toHaveLength(1));
    expect(posts(sent, '/projects')[0]!.body).toMatchObject({
      name: 'بانک آینده‌سازان', companyId: 'co-1', briefId: 'b-1', accountOwnerId: 'u-am', objective: 'معرفی کارت تازه', plannedBudget: 5000000000, plannedEnd: '2026-12-20',
    });
    expect(posts(sent, '/proposals')[0]!.body).toEqual({ briefId: 'b-1', title: 'پروپوزال — بانک آینده‌سازان' });
  });

  it('orders each unit the brief needs — filled from the brief — and issues what is written', async () => {
    const sent = mount(<AccountJourney />, '/account/journey/b-1', (p) => {
      if (p === '/briefs/b-1') return BRIEF({ proposals: [{ id: 'p-1', code: 'PRP-000003', title: 'پروپوزال', state: 'DRAFT', version: 1 }] });
      if (p === '/proposals/p-1') return PROPOSAL();
      if (p === '/projects') return page([PROJECT]);
      if (p === '/work-orders') return page([{ id: 'w-1', code: 'WO-000011', title: 'خلاقیت — بانک', state: 'DRAFT', targetDepartmentCode: 'CR', proposalId: 'p-1', deadline: null, owner: { fullName: 'بهراد مهرنیا' }, availableTransitions: [move('issue', 'صدور سفارش'), move('cancel', 'لغو سفارش', true)] }]);
      return undefined;
    });
    const orders = await screen.findByRole('region', { name: 'سفارش به واحدها' });
    const [cr, dm] = await within(orders).findAllByTestId('unit-order');
    expect(await within(cr!).findByRole('button', { name: 'صدور سفارش' })).toBeTruthy();
    expect(within(cr!).queryByRole('button', { name: 'لغو سفارش' })).toBeNull();
    expect(current()).toContain('سفارش به واحدها');

    fireEvent.click(within(dm!).getByRole('button', { name: 'نوشتن سفارش دیجیتال مارکتینگ' }));
    const form = within(dm!).getByTestId('order-form');
    expect((within(form).getByLabelText('شرح کار') as HTMLTextAreaElement).value).toBe('کمپین دیجیتال سه‌ماهه');
    fireEvent.change(within(form).getByLabelText('قالب خروجی'), { target: { value: 'PDF' } });
    await within(form).findByRole('option', { name: 'نگار دیجیتال — مدیر واحد' });
    fireEvent.change(within(form).getByLabelText('مسئول سفارش'), { target: { value: 'u-dm' } });
    expect(within(within(form).getByLabelText('مسئول سفارش')).getAllByRole('option').map((o) => o.textContent)).toEqual(['— برگزینید —', 'نگار دیجیتال — مدیر واحد']);
    fireEvent.click(within(form).getByRole('button', { name: 'ذخیرهٔ سفارش' }));
    await waitFor(() => expect(posts(sent, '/work-orders')).toHaveLength(1));
    expect(posts(sent, '/work-orders')[0]!.body).toMatchObject({
      projectId: 'pr-1', proposalId: 'p-1', targetDepartmentCode: 'DM', scopeOfWork: 'کمپین دیجیتال سه‌ماهه', brief: 'معرفی کارت تازه\nمخاطب: جوانان',
      expectedOutput: 'تیزر و بنر', outputFormat: 'PDF', deadline: '2026-12-20', ownerId: 'u-dm', priority: 'NORMAL',
    });
    expect(within(orders).getByRole('button', { name: 'ارسال سفارش به واحدها' })).toBeTruthy();
  });

  it('shows what each unit handed in and what it cost, to accept or send back', async () => {
    mount(<AccountJourney />, '/account/journey/b-1', (p) => {
      if (p === '/briefs/b-1') return BRIEF({ proposals: [{ id: 'p-1', code: 'PRP-000003', title: 'پروپوزال', state: 'AWAITING_UNIT_OUTPUTS', version: 1 }] });
      if (p === '/proposals/p-1') return PROPOSAL({ state: 'AWAITING_UNIT_OUTPUTS', availableTransitions: [move('integrate', 'یکپارچه‌سازی خروجی‌ها')], costDeclarations: [{ id: 'c-1', workOrderId: 'w-1', departmentCode: 'CR', internalCost: '100000000', externalCost: '20000000' }] });
      if (p === '/projects') return page([PROJECT]);
      if (p === '/work-orders') return page([
        { id: 'w-1', code: 'WO-000011', title: 'خلاقیت — بانک', state: 'SUBMITTED', targetDepartmentCode: 'CR', proposalId: 'p-1', deadline: null, owner: null, availableTransitions: [move('reopen', 'بازگشت برای اصلاح', true), move('complete', 'تأیید و بستن سفارش')] },
        { id: 'w-2', code: 'WO-000012', title: 'دیجیتال — بانک', state: 'IN_PROGRESS', targetDepartmentCode: 'DM', proposalId: 'p-1', deadline: null, owner: null, availableTransitions: [] },
      ]);
      return undefined;
    });
    const outputs = await screen.findByRole('region', { name: 'خروجی و هزینهٔ واحدها' });
    const [cr, dm] = await within(outputs).findAllByTestId('unit-output');
    expect(within(cr!).getByRole('button', { name: 'تأیید و بستن سفارش' })).toBeTruthy();
    expect(within(cr!).getByRole('button', { name: 'بازگشت برای اصلاح' })).toBeTruthy();
    expect(cr!.textContent).toContain('هزینه:');
    expect(dm!.textContent).toContain('هزینه هنوز اعلام نشده');
    expect(within(outputs).getByRole('button', { name: 'یکپارچه‌سازی خروجی‌ها' })).toBeTruthy();
    expect(current()).toContain('خروجی و هزینهٔ واحدها');
  });
});
