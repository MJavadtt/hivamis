import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EstimateCheck } from '../src/components/EstimateCheck';

const estimate = {
  basis: 'SIMILAR',
  noteFa: 'بر پایهٔ ۴ سفارش تمام‌شدهٔ مشابه در همین واحد',
  comparables: [{
    workOrderId: 'w1', code: 'WO-000031', title: 'خرید رسانه دیجیتال کمپین', similarity: 0.7,
    declaredCost: 40_000_000, actualCost: 50_000_000, workingDays: 6, whyFa: ['همان واحد (ME)', 'همان نوع خروجی: پلن رسانه'],
  }],
  summary: {
    count: 4,
    declared: { p25: 38_000_000, median: 41_000_000, p75: 44_000_000, mean: 41_000_000 },
    actual: { p25: 48_000_000, median: 50_000_000, p75: 55_000_000, mean: 51_000_000 },
    workingDays: { p25: 5, median: 6, p75: 7, mean: 6 },
    overrunRatio: 1.22,
  },
  verdict: {
    band: 'LOW', ratioToMedian: 0.56,
    messageFa: '۴ سفارش مشابه به‌طور میانه ۵۰ میلیون ریال واقعاً هزینه برده‌اند و ۶ روز کاری برده‌اند؛ برآورد شما ۲۸ میلیون ریال است — کمتر از ۷۵٪ سفارش‌های مشابه.',
  },
  schedule: { tight: true, messageFa: 'تا مهلت ۴ روز کاری مانده، در حالی که سفارش‌های مشابه به‌طور میانه ۶ روز کاری برده‌اند.' },
};

describe('EstimateCheck', () => {
  it('puts the figure being typed beside what similar work really cost and took', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(estimate), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><EstimateCheck workOrderId="w9" proposed={28_000_000} /></QueryClientProvider>);

    const box = await screen.findByTestId('estimate-check');
    expect(box.textContent).toContain('پایین‌تر از سابقه');
    expect(box.textContent).toContain('هزینهٔ واقعی (میانه)');
    expect(box.textContent).toContain('برآورد شما ۲۸ میلیون ریال است');
    // The unit's habit of under-declaring is named, and so is a tight deadline.
    expect(box.textContent).toContain('۲۲٪ کمتر از هزینهٔ واقعی');
    expect(box.textContent).toContain('تا مهلت ۴ روز کاری مانده');
    // The proposed figure travels to the server as the thing to judge.
    expect(String(fetchMock.mock.calls[0]![0])).toContain('proposedCost=28000000');
  });
});
