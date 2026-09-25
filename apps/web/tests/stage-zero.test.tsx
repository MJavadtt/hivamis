import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StageZero } from '../src/components/StageZero';

const stored = {
  verdict: 'WARN',
  findings: [
    { check: 'draft', severity: 'WARN', messageFa: 'نام «poster-draft.pdf» شبیه پیش‌نویس است — مطمئن شوید نسخهٔ نهایی بارگذاری شده' },
    { check: 'late', severity: 'INFO', messageFa: 'مهلت سفارش کار پیش از این تحویل گذشته است' },
  ],
  checkedFa: ['وجود فایل', 'فرمت‌های خواسته‌شده در سفارش'],
  notCheckedFa: ['محتوای فایل‌ها، هماهنگی با بریف و هویت بصری — کار بازبین انسانی است'],
  archived: [{ name: 'banner.psd' }],
};

function mount(response: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}>
    <StageZero deliverable={{ id: 'd1', stageZeroVerdict: 'WARN', stageZeroAt: '2026-09-25T08:00:00Z', stageZeroFindings: stored as never }} />
  </QueryClientProvider>);
  return fetchMock;
}

describe('StageZero', () => {
  it('shows the stored verdict, its findings, and what was not checked', () => {
    mount(stored);
    const box = screen.getByTestId('stage-zero');
    expect(box.textContent).toContain('با هشدار');
    expect(box.textContent).toContain('شبیه پیش‌نویس');
    // A pass is never mistaken for a review: the unchecked part is always one click away.
    expect(box.textContent).toContain('کار بازبین انسانی است');
    expect(box.textContent).toContain('banner.psd');
  });

  it("re-runs on demand and shows a failure in the reviewer's words", async () => {
    const fetchMock = mount({
      verdict: 'FAIL',
      findings: [{ check: 'format', severity: 'FAIL', messageFa: 'سفارش «PDF» خواسته، اما فایلی با پسوند .pdf نه مستقیم پیوست شده و نه درون فایل فشرده است' }],
      checkedFa: ['وجود فایل'], notCheckedFa: [],
    });
    fireEvent.click(screen.getByText('بررسی دوباره'));
    expect(await screen.findByText('ایراد قطعی')).toBeTruthy();
    expect(screen.getByTestId('stage-zero').textContent).toContain('سفارش «PDF» خواسته');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/deliverables/d1/stage-zero');
  });
});
