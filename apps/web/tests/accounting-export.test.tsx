import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));
import { AccountingTab } from '../src/components/AccountingExport';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const layout = { dateFormat: 'JALALI', columns: [{ field: 'voucherNo', header: 'شماره سند' }, { field: 'accountCode', header: 'کد حساب' }, { field: 'debit', header: 'بدهکار' }, { field: 'credit', header: 'بستانکار' }] };
const settings = { accounts: { receivable: '1104', revenue: '6101' }, clientCodes: {}, layout, saved: true, defaultLayout: layout, clients: [{ id: 'c1', legalName: 'شرکت نمونه' }] };
const voucher = {
  kind: 'INVOICE', sourceId: 'i1', reference: 'INV-000007', date: '2026-09-20T00:00:00Z', description: 'فاکتور F-7 — شرکت نمونه',
  lines: [{ account: 'receivable', detail: null, description: '', debit: 1_100_000, credit: 0 }, { account: 'revenue', detail: null, description: '', debit: 0, credit: 1_000_000 }, { account: 'vat', detail: null, description: '', debit: 0, credit: 100_000 }],
};
const preview = (over: Record<string, unknown> = {}) => ({
  counts: { invoices: 1, reversals: 0, receipts: 0, payments: 0 }, lines: 3, debitTotal: 1_100_000, creditTotal: 1_100_000,
  problems: [], warnings: [], vouchers: [voucher], more: 0, accounts: settings.accounts, ...over,
});
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AccountingTab /></QueryClientProvider>);

describe('Export to the accounting package', () => {
  it('shows each voucher line against its account, and holds the batch back while a code is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/accounting/settings')) return json(settings);
      if (url.includes('/accounting/preview')) return json(preview({ problems: [{ code: 'ACCOUNT_CODE_MISSING', message: 'کد حساب این سرفصل‌ها تعیین نشده است: مالیات بر ارزش افزودهٔ فروش' }] }));
      return json([{ id: 'e1', number: 3, periodTo: '2026-09-01T00:00:00Z', vouchers: 12, lines: 30, debitTotal: '5000000', fileName: 'f.csv', createdBy: 'لیلا موسوی', createdAt: '2026-09-01T10:00:00Z' }]);
    }));
    mount();
    expect((await screen.findByTestId('accounting-problems')).textContent).toContain('مالیات بر ارزش افزودهٔ فروش');
    expect((screen.getByText('ثبت خروجی و دریافت فایل').closest('button') as HTMLButtonElement).disabled).toBe(true);
    const lines = screen.getByTestId('accounting-vouchers');
    expect(lines.textContent).toContain('حساب‌های دریافتنی (مشتریان)');
    expect(lines.textContent).toContain('1104');
    expect(lines.textContent).toContain('۱٬۱۰۰٬۰۰۰ ریال');
    expect(lines.textContent).toContain('؟');                            // VAT has no code yet
    expect(screen.getByTestId('accounting-history').textContent).toContain('لیلا موسوی');
  });

  it('posts the batch up to the chosen day and downloads its file', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === 'POST') return json({ id: 'e9', number: 4, vouchers: 1, fileName: 'hiva-accounting-4.csv' }, 201);
      if (url.includes('/file')) return new Response('﻿شماره سند\r\n', { headers: { 'content-disposition': 'attachment; filename="hiva-accounting-4.csv"' } });
      if (url.includes('/accounting/settings')) return json(settings);
      if (url.includes('/accounting/preview')) return json(preview());
      return json([]);
    }));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    mount();
    fireEvent.click(await screen.findByText('ثبت خروجی و دریافت فایل'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/accounting/exports/e9/file'))).toBe(true));
    const posted = calls.find((c) => c.method === 'POST')!;
    expect(posted.body).toEqual({ to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(calls.find((c) => c.url.includes('/accounting/preview'))!.url).toContain(`to=${(posted.body as any).to}`);
  });

  it('arranges the file’s columns and sets codes, then saves them together', async () => {
    const puts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return json({}); }
      if (url.includes('/accounting/settings')) return json(settings);
      if (url.includes('/accounting/preview')) return json(preview());
      return json([]);
    }));
    mount();
    fireEvent.click(await screen.findByText('ویرایش'));
    const form = await screen.findByTestId('accounting-settings-form');
    fireEvent.change(within(form).getByLabelText('مالیات بر ارزش افزودهٔ فروش'), { target: { value: '2301' } });
    fireEvent.change(within(form).getByLabelText('کد تفصیلی شرکت نمونه'), { target: { value: 'T-17' } });
    fireEvent.click(within(form).getByText('افزودن ستون'));                                   // the first field not yet used: date
    fireEvent.change(within(form).getByLabelText('عنوان ستون 5'), { target: { value: 'Date' } });
    fireEvent.click(within(form).getAllByLabelText('بالاتر')[4]!);                             // date moves before credit
    fireEvent.change(within(form).getByLabelText('قالب تاریخ'), { target: { value: 'GREGORIAN' } });
    fireEvent.click(screen.getByText('ذخیره'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      accounts: { receivable: '1104', revenue: '6101', vat: '2301' },
      clientCodes: { c1: 'T-17' },
      layout: { dateFormat: 'GREGORIAN', columns: [layout.columns[0], layout.columns[1], layout.columns[2], { field: 'date', header: 'Date' }, layout.columns[3]] },
    });
  });
});
