import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { BulkImport } from '../src/components/BulkImport';

/** A file is checked before anything is written, and the person sees every problem at once. */
const preview = {
  total: 3, valid: 2, invalid: 1,
  rows: [
    { index: 1, ok: true, issues: [], data: {} },
    { index: 2, ok: false, issues: [{ path: 'briefId', message: '«بریف»: «BRF-999999» پیدا نشد' }, { path: 'x', message: '«اطلاعات» الزامی است' }], data: {} },
    { index: 3, ok: true, issues: [], data: {} },
  ],
};
const result = { total: 3, created: 2, failed: 1, rows: [{ index: 1, ok: true, code: 'FRM-000010', issues: [] }, { index: 2, ok: false, issues: [{ message: 'x' }] }, { index: 3, ok: true, code: 'FRM-000011', issues: [] }] };

function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
function mount() {
  const calls: { body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ body });
    return json(body.mode === 'preview' ? preview : result);
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><BulkImport code="B10_BRIEF_COMPLETION" canSubmit /></ToastProvider></QueryClientProvider>);
  return calls;
}
const csvFile = () => new File(['briefId,addedInformation\nBRF-000004,x\n'], 'rows.csv', { type: 'text/csv' });

describe('Bulk import', () => {
  it('previews the chosen file and lists each failing row with its problems', async () => {
    const calls = mount();
    fireEvent.change(screen.getByLabelText('فایل CSV'), { target: { files: [csvFile()] } });
    const box = await screen.findByTestId('bulk-preview');
    expect(calls[0]!.body).toMatchObject({ mode: 'preview' });
    expect(calls[0]!.body.csv).toContain('BRF-000004');
    expect(box.textContent).toContain('۳ ردیف خوانده شد');
    expect(box.textContent).toContain('۲ معتبر');
    expect(box.textContent).toContain('۱ با خطا');
    expect(box.textContent).toContain('BRF-999999');
    expect(box.textContent).toContain('الزامی است');
  });

  it('imports as drafts by default and reports what was created', async () => {
    const calls = mount();
    fireEvent.change(screen.getByLabelText('فایل CSV'), { target: { files: [csvFile()] } });
    await screen.findByTestId('bulk-preview');
    fireEvent.click(screen.getByRole('button', { name: /پیش‌نویس/ }));
    const done = await screen.findByTestId('bulk-result');
    expect(calls.at(-1)!.body).toMatchObject({ mode: 'draft' });
    expect(done.textContent).toContain('۲ ثبت شد');
    expect(done.textContent).toContain('۱ ناموفق');
    expect(done.textContent).toContain('FRM-000010');
    await waitFor(() => expect(screen.queryByTestId('bulk-preview')).toBeNull());
  });

  it('offers only template and export to someone who may not submit the form', () => {
    vi.stubGlobal('fetch', vi.fn());
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><ToastProvider><BulkImport code="X" canSubmit={false} /></ToastProvider></QueryClientProvider>);
    expect(screen.getByRole('button', { name: 'قالب CSV' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /ورود از CSV/ })).toBeNull();
  });
});
