import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));
import ApprovePublic from '../src/pages/ApprovePublic';
import { ClientApprovalsPanel } from '../src/components/ClientApprovals';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const TOKEN = 'a'.repeat(43);
const view = (over: Record<string, unknown> = {}) => ({
  code: 'CA-000007', status: 'PENDING', organization: 'آژانس هیوا', message: 'لطفاً تا پنجشنبه', contactName: 'مریم احمدی', contactEmail: 'ma…@client.example',
  subject: { type: 'DELIVERABLE', code: 'DLV-000031', title: 'استوری‌بورد تیزر', version: 'v3', context: 'PRJ-000004 — کمپین نوروزی' },
  content: { description: 'نسخهٔ نهایی', format: null }, expiresAt: '2026-10-10T08:00:00Z', manifestHash: 'm'.repeat(64), verification: 'EMAIL_CODE',
  files: [{ id: 'd1', fileName: 'storyboard.pdf', sizeBytes: 20480, sha256: 'f'.repeat(64), viewed: false }],
  decision: null, decidedAt: null, signerName: null, evidenceHash: null, ...over,
});

describe('The client’s page', () => {
  it('holds approval back until each file is opened and a code is entered, then shows the receipt with both hashes', async () => {
    const posts: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/files/d1')) return new Response('%PDF-1.4');
      if (init?.method === 'POST') {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/code')) return json({ sentTo: 'ma…@client.example', expiresInMinutes: 10 });
        return json({ code: 'CA-000007', status: 'APPROVED', decision: 'APPROVE', decidedAt: '2026-09-27T09:00:00Z', manifestHash: 'm'.repeat(64), evidenceHash: 'e'.repeat(64) });
      }
      return json(view());
    }));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    render(<ApprovePublic token={TOKEN} />);
    expect(await screen.findByText('استوری‌بورد تیزر')).toBeTruthy();
    expect(screen.getByTestId('approve-files').textContent).toContain('f'.repeat(64));
    fireEvent.change(screen.getByLabelText('نام و نام خانوادگی'), { target: { value: 'مریم احمدی' } });
    fireEvent.click(screen.getByRole('checkbox'));
    const submit = () => screen.getByText('ثبت تصمیم').closest('button') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);                               // file not opened, no code
    expect(screen.getByTestId('approve-form').textContent).toContain('پیش از تأیید، هر فایل را دریافت');
    fireEvent.click(screen.getByText('دریافت'));
    await waitFor(() => expect(screen.getByTestId('approve-files').textContent).toContain('✓ دریافت شد'));
    expect(submit().disabled).toBe(true);                               // still no code
    fireEvent.click(screen.getByText('ارسال کد'));
    expect((await screen.findByTestId('approve-note')).textContent).toContain('ma…@client.example');
    fireEvent.change(screen.getByLabelText('کد یک‌بارمصرف'), { target: { value: '482913' } });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    const receipt = await screen.findByTestId('approve-receipt');
    expect(receipt.textContent).toContain('تأیید شما ثبت شد');
    expect(receipt.textContent).toContain('e'.repeat(64));
    expect(posts.at(-1)).toEqual({ url: expect.stringContaining(`/public/approvals/${TOKEN}/decision`), body: { decision: 'APPROVE', signerName: 'مریم احمدی', code: '482913', confirm: true } });
  });

  it('says plainly when the link is not valid, or the request has closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'NOT_FOUND', message: 'درخواست تأیید یافت نشد' } }, 404)));
    const { unmount } = render(<ApprovePublic token={TOKEN} />);
    expect((await screen.findByTestId('approve-error')).textContent).toBe('این پیوند معتبر نیست.');
    unmount();
    vi.stubGlobal('fetch', vi.fn(async () => json(view({ status: 'EXPIRED' }))));
    render(<ApprovePublic token={TOKEN} />);
    expect((await screen.findByTestId('approve-closed')).textContent).toContain('مهلت این درخواست گذشته است');
  });
});

describe('The staff panel', () => {
  it('lists each request with who decided, how they were verified, and the log — and re-checks the hashes on demand', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/verify')) return json({ ok: true, problems: [], checkedAt: '2026-09-27T10:00:00Z' });
      return json([{
        id: 'a1', code: 'CA-000007', status: 'APPROVED', contactName: 'مریم احمدی', contactEmail: 'maryam@client.example', createdAt: '2026-09-26T08:00:00Z',
        requestedBy: { fullName: 'رضا شریفی' }, decision: 'APPROVE', signerName: 'مریم احمدی', decidedAt: '2026-09-27T09:00:00Z', decidedIp: '5.160.1.2',
        verification: 'EMAIL_CODE', comment: null, manifestHash: 'm'.repeat(64), evidenceHash: 'e'.repeat(64), sequence: 3, transitionError: null,
        evidence: { staffAddress: false }, manifest: { files: [{ documentId: 'd1', fileName: 'storyboard.pdf', sha256: 'f'.repeat(64) }] },
        events: [{ id: 'e1', kind: 'FILE_VIEWED', documentId: 'd1', ip: '5.160.1.2', at: '2026-09-27T08:58:00Z' }],
      }]);
    }));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ClientApprovalsPanel subjectType="DELIVERABLE" subjectId="x" /></QueryClientProvider>);
    const row = await screen.findByTestId('approval-row');
    expect(row.textContent).toContain('تأیید شد');
    expect(row.textContent).toContain('با کد یک‌بارمصرف ایمیل‌شده');
    expect(row.textContent).toContain('5.160.1.2');
    fireEvent.click(screen.getByText('جزئیات'));
    expect(screen.getByTestId('approval-events').textContent).toContain('فایل دریافت شد «storyboard.pdf»');
    fireEvent.click(screen.getByText('بررسی دوباره'));
    expect((await screen.findByTestId('approval-check')).textContent).toContain('یکی است');
    expect(screen.getByText('درخواست تأیید از مشتری')).toBeTruthy();   // decided and none pending: a new request may be made
  });
});
