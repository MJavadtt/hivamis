import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AskReports } from '../src/components/AskReports';

const catalog = {
  modelFallback: false,
  periods: [{ key: 'LAST_3_MONTHS', labelFa: 'سه ماه گذشته' }],
  metrics: [
    { key: 'win_rate', labelFa: 'نرخ برد', definitionFa: 'برد ÷ برد + باخت', unit: 'PERCENT', example: 'نرخ برد امسال', dims: [{ key: 'person', labelFa: 'مسئول فروش' }, { key: 'month', labelFa: 'ماه' }], filters: ['companyId', 'personId'], allowed: true, lockedFa: null, asOfNow: false },
    { key: 'margin', labelFa: 'حاشیهٔ سود', definitionFa: '…', unit: 'PERCENT', example: 'حاشیه سود', dims: [], filters: ['units'], allowed: false, lockedFa: 'نیازمند دسترسی «مشاهده اطلاعات مالی»', asOfNow: false },
  ],
};
const plan = { metric: 'win_rate', filters: {}, period: { preset: null, from: '2026-03-21T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' }, groupBy: null, compare: false, sort: null };
const answered = (extra: Record<string, unknown> = {}) => ({
  status: 'ANSWERED', question: 'نرخ برد کمپین‌های تلویزیونی امسال', planner: 'RULES', plan,
  understoodFa: ['شاخص: نرخ برد', 'بازه: امسال'], metric: { key: 'win_rate', labelFa: 'نرخ برد', definitionFa: 'برد ÷ برد + باخت', unit: 'PERCENT' },
  value: 60, valueFa: '۶۰٪', countFa: '۳ برد از ۵ فرصت', answerFa: 'نرخ برد، امسال: ۶۰٪', periodFa: 'امسال',
  basis: { count: 1, items: [{ entity: 'opportunity', id: 'o1', label: 'OPP-000001 — کمپین پاییز', href: '/opportunities/o1' }] },
  caveatsFa: [], ignoredFa: ['کمپین', 'تلویزیونی'], ...extra,
});

function setup(responses: unknown[]) {
  const posted: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/reports/ask/catalog')) return json(catalog);
    posted.push(JSON.parse(String(init?.body)));
    return json(responses.shift());
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><AskReports /></MemoryRouter></QueryClientProvider>);
  return posted;
}

describe('AskReports', () => {
  it('shows the number with what it understood, and never lets the unapplied part of a question go quiet — even after a correction', async () => {
    const posted = setup([answered(), answered({ planner: 'EXPLICIT', ignoredFa: [], groupByFa: 'مسئول فروش', rows: [{ key: 'u1', labelFa: 'نیما فروزان', value: 60, valueFa: '۶۰٪', countFa: '۳ برد از ۵ فرصت' }] })]);
    // Only what the person may ask is offered as an example; the locked metric says why.
    expect(await screen.findByText('نرخ برد امسال')).toBeTruthy();
    expect(screen.getByTestId('ask-catalog').textContent).toContain('نیازمند دسترسی «مشاهده اطلاعات مالی»');

    fireEvent.change(screen.getByLabelText('پرسش'), { target: { value: 'نرخ برد کمپین‌های تلویزیونی امسال' } });
    fireEvent.click(screen.getByText('بپرس'));
    expect((await screen.findByTestId('ask-unapplied')).textContent).toContain('کمپین تلویزیونی');
    expect(screen.getByTestId('ask-answer').textContent).toContain('۶۰٪');
    expect(screen.getByTestId('ask-understood').textContent).toContain('شاخص: نرخ برد');
    expect(posted[0]).toEqual({ question: 'نرخ برد کمپین‌های تلویزیونی امسال' });

    // Correcting by choosing sends a plan, not a new sentence — and the warning stays.
    fireEvent.change(screen.getByLabelText('تفکیک'), { target: { value: 'person' } });
    await screen.findByTestId('ask-rows');
    expect(posted[1]).toEqual({ plan: { ...plan, groupBy: 'person' } });
    expect(screen.getByTestId('ask-unapplied').textContent).toContain('تلویزیونی');
    expect(screen.getByTestId('ask-rows').textContent).toContain('نیما فروزان');
  });

  it('turns a question back into a choice, and a refusal into a plain sentence', async () => {
    const posted = setup([
      { status: 'NEEDS_CLARIFICATION', question: 'مطالبات پارس', planner: 'RULES', plan: { ...plan, metric: 'outstanding' }, understoodFa: [], caveatsFa: [], ignoredFa: [],
        clarify: { kind: 'client', questionFa: 'منظور کدام مشتری است؟', options: [{ value: 'c1', labelFa: 'پارس نوین' }, { value: 'c2', labelFa: 'پارس گستر' }] } },
      answered({ planner: 'EXPLICIT', ignoredFa: [] }),
      { status: 'REFUSED', question: 'حاشیه سود', planner: 'RULES', plan: null, understoodFa: [], caveatsFa: [], ignoredFa: [],
        metric: { key: 'margin', labelFa: 'حاشیهٔ سود', definitionFa: '', unit: 'PERCENT' }, refusal: { permissions: ['finance.read'], messageFa: 'این عدد برای شما محاسبه نشد.' } },
    ]);
    await screen.findByText('نرخ برد امسال');
    fireEvent.change(screen.getByLabelText('پرسش'), { target: { value: 'مطالبات پارس' } });
    fireEvent.click(screen.getByText('بپرس'));
    fireEvent.click(await screen.findByText('پارس گستر'));
    await waitFor(() => expect(posted[1]).toEqual({ plan: { ...plan, metric: 'outstanding', filters: { companyId: 'c2' } } }));

    fireEvent.change(screen.getByLabelText('پرسش'), { target: { value: 'حاشیه سود' } });
    fireEvent.click(screen.getByText('بپرس'));
    expect((await screen.findByTestId('ask-refused')).textContent).toContain('محاسبه نشد');
  });
});
