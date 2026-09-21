import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui';
import { setAccessToken, setRefreshToken } from '../src/lib/api';
import Delegations from '../src/pages/Delegations';

/** You can lend only what you hold in your own right; the lists say who, what, until when. */
const ME = {
  id: 'u-am', email: 'am@hiva.local', fullName: 'رضا شریفی', jobTitle: 'مدیر اکانت', departmentCode: 'A', locale: 'fa',
  roles: ['ACCOUNT_MANAGER', 'CEO'], permissions: ['brief.approve', 'workorder.issue', 'pricing.approve'],
  delegated: { 'pricing.approve': 'u-deputy' }, delegatedRoles: { CEO: 'u-ceo' },
};
const rows = [
  { id: 'd1', fromUserId: 'u-am', toUserId: 'u-designer', fromName: 'رضا شریفی', toName: 'بهراد مهرنیا', permissions: ['workorder.issue'], roles: [], startsAt: '2026-09-20T00:00:00Z', endsAt: '2026-09-27T00:00:00Z', reason: 'مرخصی', status: 'ACTIVE' },
  { id: 'd2', fromUserId: 'u-deputy', toUserId: 'u-am', fromName: 'کامران راد', toName: 'رضا شریفی', permissions: ['pricing.approve'], roles: [], startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-09-30T00:00:00Z', reason: 'سفر', status: 'ACTIVE' },
];
function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
function mount() {
  const calls: { url: string; method: string; body?: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/auth/refresh')) return json({ accessToken: 't', refreshToken: 'r' });
    if (url.includes('/auth/me')) return json(ME);
    if (url.includes('/delegations') && method === 'POST') return json({ id: 'new' });
    if (url.includes('/delegations')) return json(rows);
    if (url.includes('/users')) return json({ items: [{ id: 'u-designer', fullName: 'بهراد مهرنیا', jobTitle: 'طراح' }, { id: 'u-am', fullName: 'رضا شریفی', jobTitle: null }] });
    return json({});
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><AuthProvider><MemoryRouter><Delegations /></MemoryRouter></AuthProvider></ToastProvider></QueryClientProvider>);
  return calls;
}
beforeEach(() => { setAccessToken('t'); setRefreshToken('r'); });

describe('Delegations page', () => {
  it('offers only what the user holds in their own right — not what was lent to them', async () => {
    mount();
    const picker = await screen.findByTestId('permission-picker');
    expect(picker.textContent).toContain('تأیید بریف');
    expect(picker.textContent).toContain('صدور سفارش کار به واحد');
    expect(picker.textContent).not.toContain('تأیید نهایی قیمت‌گذاری');   // pricing.approve is borrowed
    expect(screen.queryByLabelText('CEO')).toBeNull();                  // CEO role is borrowed too
    expect(screen.getByLabelText('ACCOUNT_MANAGER')).toBeTruthy();
  });

  it('separates what I gave from what I was given, with status and dates', async () => {
    mount();
    const lists = await screen.findAllByTestId('delegation-list');
    expect(lists[0]!.textContent).toContain('بهراد مهرنیا');
    expect(lists[0]!.textContent).toContain('فعال');
    expect(lists[0]!.textContent).toContain('لغو');
    expect(lists[1]!.textContent).toContain('از طرف کامران راد');
    expect(lists[1]!.textContent).toContain('تأیید نهایی قیمت‌گذاری');
  });

  it('submits a delegation with the chosen scope, window and reason', async () => {
    const calls = mount();
    await screen.findByTestId('permission-picker');
    fireEvent.change(screen.getByLabelText('گیرنده'), { target: { value: 'u-designer' } });
    fireEvent.click(screen.getByLabelText('workorder.issue'));
    const to = document.getElementById('delegation-to') as HTMLInputElement;
    fireEvent.change(to, { target: { value: '۱۴۰۵/۰۷/۰۵ ۱۸:۰۰' } }); fireEvent.blur(to);
    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'مرخصی' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت تفویض' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes('/delegations'))).toBe(true));
    const body = calls.find((c) => c.method === 'POST' && c.url.includes('/delegations'))!.body;
    expect(body).toMatchObject({ toUserId: 'u-designer', permissions: ['workorder.issue'], roles: [], reason: 'مرخصی' });
    expect(body.endsAt).toMatch(/^2026-09-2/);
  });
});
