import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { downloadFile, markSignedIn, setAccessToken } from '../src/lib/api';
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

function mount(node: React.ReactNode, at = '/', permissions = ['document.read', 'document.write', 'document.delete'], shelf: unknown[] = [FILE], refuse?: string) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; url: string; body?: BodyInit | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, url: url.search, body: init?.body });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(USER(permissions));
    if (p === '/documents' && method === 'GET') return json(shelf);
    if (p === '/documents' && method === 'POST' && refuse) return json({ error: { code: 'UNSUPPORTED_TYPE', message: refuse } }, 400);
    if (p.endsWith('/preview') || p.endsWith('/download')) return new Response('bytes', { headers: { 'content-disposition': `attachment; filename="${encodeURIComponent('پیشنهاد قیمت.xlsx')}"` } });
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

describe('A file too large for the window', () => {
  it('says what to do when the browser cannot keep it', async () => {
    setAccessToken('t'); markSignedIn(true);
    const res = new Response('x');
    vi.spyOn(res, 'blob').mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', vi.fn(async () => res));
    await expect(downloadFile('/documents/d/download', 'film.mov')).rejects.toThrow('پنجرهٔ ناشناس');
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
    expect(await uploadFiles(onRecord('invoice', 'i-1'), [new File(['x'], 'a.pdf', { type: 'application/pdf' })])).toEqual([]);
    const form = sent.find((s) => s.method === 'POST' && s.path === '/documents')!.body as FormData;
    expect([...form.keys()]).toEqual(['recordType', 'recordId', 'file']);
    expect(form.get('recordType')).toBe('invoice');
  });

  it('hands over what a browser cannot show, under its own name, without asking for a preview', async () => {
    const sheet = { id: 'doc-2', fileName: 'پیشنهاد قیمت.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    const sent = mount(<FileShelf target={onRecord('task', 't-1')} />, '/', undefined, [sheet]);
    URL.createObjectURL = vi.fn(() => 'blob:file');
    URL.revokeObjectURL = vi.fn();
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    const open = vi.spyOn(window, 'open');
    fireEvent.click(await screen.findByRole('button', { name: sheet.fileName }));
    await waitFor(() => expect(saved).toEqual([sheet.fileName]));
    expect(open).not.toHaveBeenCalled();
    expect(sent.some((s) => s.path === '/documents/doc-2/download')).toBe(true);
    expect(sent.some((s) => s.path.endsWith('/preview'))).toBe(false);
    expect(screen.queryByRole('button', { name: `دریافت ${sheet.fileName}` })).toBeNull();
    click.mockRestore(); open.mockRestore();
  });

  it('shows a PDF in a tab opened at the click, as what it is, and offers it to keep', async () => {
    const sent = mount(<FileShelf target={onRecord('task', 't-1')} />);
    const made: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => { made.push(b); return 'blob:file'; });
    URL.revokeObjectURL = vi.fn();
    const tab = { opener: window as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    fireEvent.click(await screen.findByRole('button', { name: FILE.fileName }));
    // Opened by the click itself; a tab opened once the file has arrived is a blocked popup.
    expect(open).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(tab.location.href).toBe('blob:file'));
    expect(tab.opener).toBeNull();
    expect(made[0]!.type).toBe('application/pdf');
    expect(sent.some((s) => s.path === '/documents/doc-1/preview')).toBe(true);
    expect(screen.getByRole('button', { name: `دریافت ${FILE.fileName}` })).toBeTruthy();
    open.mockRestore();
  });

  it('says which file was refused, and why', async () => {
    mount(<FileShelf target={onRecord('task', 't-1')} />, '/', undefined, [], 'این نوع فایل پذیرفته نمی‌شود.');
    fireEvent.change(await screen.findByLabelText('الصاق فایل'), { target: { files: [new File(['x'], 'run.exe')] } });
    expect(await screen.findByText('«run.exe»: این نوع فایل پذیرفته نمی‌شود.')).toBeTruthy();
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
