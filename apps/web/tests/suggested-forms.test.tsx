import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { setAccessToken, setRefreshToken } from '../src/lib/api';
import { SuggestedForms } from '../src/components/SuggestedForms';
import { QuickForms } from '../src/components/QuickForms';

/**
 * Hivamis task 4b: a record's page offers the forms its stage calls for, and one click opens a form
 * with the record already in it; the quick menu puts the forms a person sends most one click away.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', email: 'p@hiva.local', fullName: 'پریسا', jobTitle: null, department: { code: 'OP', nameFa: 'عملیات' }, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['PMO_MANAGER'], permissions: ['form.read', 'project.read', 'form.submit'], locale: 'fa', mustChangePassword: false };
const REPORT = { code: 'K01_STATUS', nameFa: 'گزارش وضعیت پروژه', nameEn: 'Project status report', category: 'K', prefill: { projectId: 'p1' }, fitsStage: true, unitUses: 4, lastForRecord: '2026-10-01T08:00:00Z' };
const RISK = { code: 'J09_RISK', nameFa: 'ثبت ریسک', nameEn: 'Risk', category: 'J', prefill: { projectId: 'p1' }, fitsStage: false, unitUses: 0, lastForRecord: null };
const DEFINITION = {
  id: 'd1', no: 90, code: 'K01_STATUS', nameFa: 'گزارش وضعیت پروژه', nameEn: 'Project status report', category: 'K', module: 'REPORTING_CUSTOMER_SUCCESS',
  senderDepts: ['OP'], receiverDepts: ['A'], approverRoles: ['PMO_MANAGER'], slaCode: null, binding: null, nextProcessFa: null, canSubmit: true, sla: null,
  schema: [{ key: 'projectId', labelFa: 'پروژه', labelEn: 'Project', type: 'entityRef', entity: 'project', required: true }, { key: 'summary', labelFa: 'خلاصه', labelEn: 'Summary', type: 'textarea' }],
};

function mount(ui: React.ReactNode) {
  setAccessToken('t'); setRefreshToken('r');
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    sent.push({ method: init?.method ?? 'GET', path: p + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(ME);
    if (p === '/forms/suggest') return json(url.searchParams.get('entity')
      ? { state: 'ACTIVE', total: url.searchParams.get('limit') === '30' ? 2 : 3, forms: url.searchParams.get('limit') === '30' ? [REPORT, RISK] : [REPORT, RISK] }
      : { state: null, total: null, forms: [REPORT, RISK] });
    if (p === '/forms/definitions/K01_STATUS') return json(DEFINITION);
    if (p === '/projects') return json({ items: [{ id: 'p1', code: 'PRJ-1', name: 'کمپین پاییز' }] });
    if (p === '/forms/submissions') return json({ id: 's1' }, 201);
    return json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter>{ui}</MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

describe('Related forms on a record’s page', () => {
  it('opens a form with the record already in it, and sends it as it is', async () => {
    const sent = mount(<SuggestedForms entity="project" id="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: /گزارش وضعیت پروژه/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'ثبت و ارسال' }));
    await waitFor(() => expect(sent.find((x) => x.method === 'POST' && x.path === '/forms/submissions')?.body)
      .toMatchObject({ formCode: 'K01_STATUS', data: { projectId: 'p1' }, asDraft: false }));
  });

  it('marks what the stage calls for and what was already sent for this record, and offers the rest', async () => {
    const sent = mount(<SuggestedForms entity="project" id="p1" />);
    const report = await screen.findByRole('button', { name: /گزارش وضعیت پروژه/ });
    expect(report.className).toContain('bg-brand-50/60');
    expect(report.title).toContain('آخرین بار برای همین رکورد');
    expect(screen.getByRole('button', { name: /ثبت ریسک/ }).className).not.toContain('bg-brand-50/60');
    fireEvent.click(screen.getByRole('button', { name: /همهٔ فرم‌های مرتبط/ }));
    await waitFor(() => expect(sent.some((x) => x.path.startsWith('/forms/suggest') && x.path.includes('limit=30'))).toBe(true));
  });
});

describe('The quick menu', () => {
  it('lists the forms a person sends most and opens one with a click', async () => {
    mount(<QuickForms />);
    fireEvent.click(await screen.findByRole('button', { name: 'فرم تازه' }));
    const menu = await screen.findByTestId('quick-forms');
    expect(menu.textContent).toContain('ثبت ریسک');
    fireEvent.click(screen.getByRole('menuitem', { name: 'گزارش وضعیت پروژه' }));
    expect(await screen.findByRole('button', { name: 'ثبت و ارسال' })).toBeDefined();
    expect(screen.queryByTestId('quick-forms')).toBeNull();
  });
});
