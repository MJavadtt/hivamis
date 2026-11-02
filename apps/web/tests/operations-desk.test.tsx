import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { OperationsDesk } from '../src/pages/OperationsDesk';

/**
 * The owner's brief (2026-11-02): one place for what the units hand in, ask and have not yet taken,
 * each unit's load, and the proposals being put together — with the decision the reader may take.
 */
const USER = {
  id: 'u-am', email: 'am@hiva.local', fullName: 'x', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [],
  permissions: ['workorder.read', 'workorder.issue', 'qc.account', 'proposal.read'], locale: 'fa', mustChangePassword: false,
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 25, pageCount: 1 });
const move = (action: string, labelFa: string, requiresReason = false) => ({ action, labelFa, labelEn: action, requiresReason, to: 'X' });
const order = (over: Record<string, unknown>) => ({
  id: 'w', code: 'WO-1', title: 'سفارش', state: 'IN_PROGRESS', targetDepartmentCode: 'CR', proposalId: 'p-1', deadline: null,
  createdAt: '2026-10-20T00:00:00.000Z', owner: { fullName: 'بهراد مهرنیا' }, project: { id: 'pr-1', code: 'PRJ-1', name: 'کمپین بانک' }, availableTransitions: [], ...over,
});
const ORDERS: Record<string, unknown[]> = {
  SUBMITTED: [order({ id: 'w-in', title: 'طراحی بنر', state: 'SUBMITTED', availableTransitions: [move('reopen', 'بازگشت برای اصلاح', true), move('complete', 'تأیید و بستن سفارش')] })],
  CLARIFICATION_REQUESTED: [order({ id: 'w-q', title: 'برنامهٔ رسانه', state: 'CLARIFICATION_REQUESTED', targetDepartmentCode: 'ME', availableTransitions: [move('clarify', 'رفع ابهام')] })],
  ISSUED: [order({ id: 'w-new', title: 'استراتژی محتوا', state: 'ISSUED', targetDepartmentCode: 'ST' })],
  IN_PROGRESS: [order({ id: 'w-run', title: 'تیزر', targetDepartmentCode: 'CR' })],
};

function mount() {
  setAccessToken('t'); markSignedIn(true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(USER);
    if (p.endsWith('/preflight')) return json({ state: 'x', transitions: [] });
    if (p === '/workflow/workOrder/w-q/history') return json([{ id: 'h', toState: 'CLARIFICATION_REQUESTED', reason: 'بودجهٔ رسانه چقدر است؟', createdAt: new Date().toISOString(), actor: { fullName: 'نگار رسانه' } }]);
    if (p === '/work-orders') return json(page(ORDERS[url.searchParams.get('state')!] ?? []));
    if (p === '/proposals') return json(page(url.searchParams.get('state') === 'INTEGRATION'
      ? [{ id: 'p-1', code: 'PRP-1', title: 'پروپوزال بانک', state: 'INTEGRATION', brief: { id: 'b-1', title: 'بریف', opportunity: { company: { legalName: 'بانک آینده‌سازان' } } } }] : []));
    return json(page([]));
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter><OperationsDesk /></MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
}
const section = (name: string) => screen.getByRole('region', { name });

describe('The operations desk', () => {
  it('says how things stand, and offers each decision where it is to be taken', async () => {
    mount();
    expect((await screen.findByTestId('ops-summary')).textContent).toBe('۱ خروجی منتظر بررسی، ۱ سؤال از واحدها، ۱ سفارش هنوز پذیرفته نشده، ۱ پروپوزال در حال آماده شدن.');
    const handedIn = section('خروجی‌های رسیده برای بررسی');
    expect(within(handedIn).getByRole('button', { name: 'تأیید و بستن سفارش' })).toBeTruthy();
    expect(within(handedIn).getByRole('button', { name: 'بازگشت برای اصلاح' })).toBeTruthy();
    // The question, who asked it, and the answer's button.
    const questions = section('سؤال‌های واحدها');
    const note = await within(questions).findByTestId('return-note');
    expect(note.textContent).toContain('نگار رسانه');
    expect(note.textContent).toContain('بودجهٔ رسانه چقدر است؟');
    expect(within(questions).getByRole('button', { name: 'رفع ابهام' })).toBeTruthy();
    expect(within(section('سفارش‌های هنوز پذیرفته‌نشده')).getByText('استراتژی محتوا')).toBeTruthy();
  });

  it('shows each unit’s load and each proposal’s next step', async () => {
    mount();
    const load = await screen.findByTestId('unit-load');
    const row = (unit: string) => [...load.querySelectorAll('tbody tr')].find((r) => r.textContent?.startsWith(unit))!;
    expect([...row('خلاقیت / گرافیک / تولید').querySelectorAll('td')].slice(1).map((c) => c.textContent)).toEqual(['۰', '۱', '۱']);
    const proposal = screen.getByTestId('ops-proposal');
    expect(within(proposal).getByRole('link').getAttribute('href')).toBe('/account/journey/b-1');
    expect(proposal.textContent).toContain('خروجی‌ها رسیده است؛ یکپارچه کنید و به قیمت‌گذاری بفرستید.');
  });
});
