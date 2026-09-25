import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SecurityAlerts } from '../src/components/SecurityAlerts';

const payload = {
  counts: [{ status: 'OPEN', severity: 'HIGH', count: 1 }, { status: 'OPEN', severity: 'MEDIUM', count: 1 }],
  alerts: [
    {
      id: 'a1', kind: 'DENIAL_SURGE', kindFa: 'جهش دسترسی‌های ردشده', severity: 'HIGH', status: 'OPEN',
      messageFa: '۱۵ درخواست ردشده برای ۵ دسترسی متفاوت در ۲۴ ساعت — الگوی آزمودن درهای مختلف',
      ipAddress: '10.0.0.7', windowStart: '2026-09-01T20:00:00Z', windowEnd: '2026-09-02T20:00:00Z', createdAt: '2026-09-02T20:00:00Z',
      evidence: { count: 15, distinctPermissions: 5 },
      actor: { id: 'u1', fullName: 'کاربر آزمون', email: 'u@hiva.local', department: { code: 'CR' } },
      reviewedBy: null, reviewedAt: null, reviewNote: null,
    },
  ],
};

describe('SecurityAlerts', () => {
  it('shows each case with its person and evidence, and will not dismiss without a reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><SecurityAlerts /></QueryClientProvider>);

    const list = await screen.findByTestId('security-alerts');
    expect(list.textContent).toContain('جهش دسترسی‌های ردشده');
    expect(list.textContent).toContain('کاربر آزمون (CR)');
    expect(list.textContent).toContain('آزمودن درهای مختلف');
    expect(list.textContent).toContain('"distinctPermissions": 5');

    fireEvent.click(screen.getByText('مشکلی نبود'));
    const panel = await screen.findByTestId('alert-review');
    const submit = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'ثبت') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(panel.querySelector('textarea')!, { target: { value: 'نقش این فرد اصلاح شد' } });
    expect(([...panel.querySelectorAll('button')].find((b) => b.textContent === 'ثبت') as HTMLButtonElement).disabled).toBe(false);
  });
});
