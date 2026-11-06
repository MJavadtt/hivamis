import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { BackButton, parentOf } from '../src/components/BackButton';
import { AttachButton, FileShelf, onRecord, targetOfPage, uploadFiles } from '../src/components/RecordFiles';
import { PageHeader } from '../src/components/Shell';

/**
 * The owner, 2026-11-06: a way back on every page, and files on every record — from the header of a
 * record's page, and from a paperclip on a record that lives as a row of another page.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const USER = (permissions: string[]) => ({ id: 'u1', email: 'x@hiva.local', fullName: 'x', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions, locale: 'fa', mustChangePassword: false });
const FILE = { id: 'doc-1', fileName: 'quote.pdf', mimeType: 'application/pdf' };

function mount(node: React.ReactNode, at = '/', permissions = ['document.read', 'document.write', 'document.delete']) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; url: string; body?: BodyInit | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, url: url.search, body: init?.body });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(USER(permissions));
    if (p === '/documents' && method === 'GET') return json([FILE]);
    return json({ id: 'new' }, 201);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter initialEntries={[at]}>{node}</MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}
function Where() { return <span data-testid="where">{useLocation().pathname}</span>; }

describe('The way back', () => {
  it('knows the page above each page, and that the workspace has none', () => {
    expect(parentOf('/')).toBeNull();
    expect(parentOf('/leads')).toBe('/');
    expect(parentOf('/tasks/t-1')).toBe('/tasks');
    expect(parentOf('/projects/p-1/ooh')).toBe('/projects/p-1');
    expect(parentOf('/sites/venues/v-1')).toBe('/sites/venues');
    expect(parentOf('/sales/journey/co-1')).toBe('/companies/co-1');
    expect(parentOf('/sales/new')).toBe('/leads');
    expect(parentOf('/account/journey/b-1')).toBe('/account');
  });

  it('goes up from a page opened straight from a link, and is not on the workspace', async () => {
    mount(<Routes><Route path="*" element={<><BackButton /><Where /></>} /></Routes>, '/tasks/t-1');
    fireEvent.click(screen.getByRole('button', { name: /بازگشت/ }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/tasks'));
    fireEvent.click(screen.getByRole('button', { name: /بازگشت/ }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'));
    expect(screen.queryByRole('button', { name: /بازگشت/ })).toBeNull();
  });
});

describe('Files on every record', () => {
  it('knows the record of every record page, and that a list has none', () => {
    expect(targetOfPage('/tasks/t-1')).toEqual({ recordType: 'task', recordId: 't-1' });
    expect(targetOfPage('/work-orders/w-1')).toEqual({ recordType: 'workOrder', recordId: 'w-1' });
    expect(targetOfPage('/projects/p-1')).toEqual({ projectId: 'p-1' });
    expect(targetOfPage('/projects/p-1/ooh')).toEqual({ projectId: 'p-1' });
    expect(targetOfPage('/sales/journey/co-1')).toEqual({ companyId: 'co-1' });
    expect(targetOfPage('/account/journey/b-1')).toEqual({ recordType: 'brief', recordId: 'b-1' });
    expect(targetOfPage('/bookings/k-1')).toEqual({ recordType: 'booking', recordId: 'k-1' });
    expect(targetOfPage('/bookings/admin')).toBeNull();
    expect(targetOfPage('/tasks')).toBeNull();
  });

  it('puts «پیوست‌ها» with its count in a record page’s header, and only there', async () => {
    mount(<PageHeader title="وظیفه" />, '/tasks/t-1');
    const button = await screen.findByTestId('page-attachments');
    await waitFor(() => expect(button.textContent).toContain('(۱)'));
    fireEvent.click(button);
    expect(await within(await screen.findByRole('dialog', { name: 'پیوست‌ها' })).findByRole('button', { name: 'quote.pdf' })).toBeTruthy();
  });

  it('leaves a list’s header alone', async () => {
    const sent = mount(<PageHeader title="وظایف" />, '/tasks');
    await screen.findByText('وظایف');
    expect(screen.queryByTestId('page-attachments')).toBeNull();
    expect(sent.some((s) => s.path === '/documents')).toBe(false);
  });

  it('sends the record’s name ahead of the file', async () => {
    const sent = mount(<span />);
    expect(await uploadFiles(onRecord('invoice', 'i-1'), [new File(['x'], 'a.pdf', { type: 'application/pdf' })])).toBe(0);
    const form = sent.find((s) => s.method === 'POST' && s.path === '/documents')!.body as FormData;
    expect([...form.keys()]).toEqual(['recordType', 'recordId', 'file']);
    expect(form.get('recordType')).toBe('invoice');
  });

  it('asks before taking a file off, and hides that from who may not', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const sent = mount(<FileShelf target={onRecord('lead', 'l-1')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'برداشتن quote.pdf' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'DELETE' && s.path === '/documents/doc-1')).toBe(true));
    expect(confirm).toHaveBeenCalled();
  });

  it('opens from a row without following the row’s link', async () => {
    const follow = vi.fn();
    mount(<div onClick={follow}><AttachButton target={onRecord('lead', 'l-1')} title="سرنخ نمونه" /></div>);
    fireEvent.click(await screen.findByRole('button', { name: 'پیوست‌های سرنخ نمونه' }));
    expect(await screen.findByRole('dialog', { name: 'پیوست‌های سرنخ نمونه' })).toBeTruthy();
    expect(follow).not.toHaveBeenCalled();
  });
});
