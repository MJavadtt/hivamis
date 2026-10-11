import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { ClientReportButton } from '../src/components/ClientReportButton';

/** Sending a report to the client shows exactly what they get, and what they do not. */
const ACCOUNT = { id: 'u1', email: 'a@hiva.local', fullName: 'اکانت', jobTitle: '', departmentCode: 'A', roles: ['ACCOUNT_MANAGER'], permissions: ['project.execute', 'report.read'], locale: 'fa' };
const SALES = { ...ACCOUNT, permissions: ['report.read'] };
const preview = { html: '<p>پیشرفت ۶۰٪</p>', omitted: ['financialStatus', 'decisionsNeeded', 'redaction:cost'], to: 'client@example.com', contact: 'خانم رضایی' };

function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
function serve(user: unknown) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/auth/refresh')) return json({ accessToken: 't', refreshToken: 'r' });
    if (url.includes('/auth/me')) return json(user);
    if (url.includes('/send-to-client')) return json({ to: 'client@example.com', bytes: 12345 });
    if (url.includes('/client-preview')) return json(preview);
    return json({});
  }));
  return calls;
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><AuthProvider><ClientReportButton reportId="rpt-1" /></AuthProvider></ToastProvider></QueryClientProvider>);
}
beforeEach(() => { setAccessToken('t'); markSignedIn(true); });

describe('Client report button', () => {
  it('is offered only to those who may execute the project', async () => {
    serve(SALES); mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('button', { name: 'ارسال برای مشتری' })).toBeNull();
  });

  it('previews the client copy and names what has been left out', async () => {
    serve(ACCOUNT); mount();
    fireEvent.click(await screen.findByRole('button', { name: 'ارسال برای مشتری' }));
    const omitted = await screen.findByTestId('client-report-omitted');
    expect(omitted.textContent).toContain('وضعیت مالی');
    expect(omitted.textContent).toContain('تصمیمات داخلی');
    expect(omitted.textContent).toContain('قیمت تمام‌شده');
    expect(screen.getByTestId('client-report-preview').textContent).toContain('پیشرفت ۶۰٪');
    expect(screen.getByText(/خانم رضایی/)).toBeTruthy();
  });

  it('sends to the primary contact by default, or to an address typed in', async () => {
    const calls = serve(ACCOUNT); mount();
    fireEvent.click(await screen.findByRole('button', { name: 'ارسال برای مشتری' }));
    await screen.findByTestId('client-report-preview');
    fireEvent.change(screen.getByLabelText('گیرنده'), { target: { value: 'ceo@client.example' } });
    fireEvent.click(screen.getByRole('button', { name: /^ارسال به/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/send-to-client'))).toBe(true));
    expect(calls.find((c) => c.url.includes('/send-to-client'))!.body).toEqual({ to: 'ceo@client.example' });
  });
});
