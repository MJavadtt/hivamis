import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BriefQuality } from '../src/components/BriefQuality';

const payload = {
  completeness: { score: 100, missing: [] },
  quality: {
    score: 46, band: 'WEAK', bandFa: 'ضعیف',
    fixFirst: { key: 'businessObjective', labelFa: 'هدف کسب‌وکار', lostPoints: 12 },
    fields: [
      { key: 'businessObjective', labelFa: 'هدف کسب‌وکار', weight: 22, score: 45, words: 2, findingsFa: ['هدف عدد ندارد — «افزایش فروش» قابل‌سنجش نیست؛ چقدر؟'] },
      { key: 'scope', labelFa: 'Scope درخواستی', weight: 16, score: 46, words: 3, findingsFa: ['عبارت مبهم: «جذاب» — به‌جایش بگویید دقیقاً چه چیزی'] },
    ],
  },
  benchmark: {
    briefs: 12, enoughHistory: false, noteFa: 'تنها ۲ بریف تا امروز به قرارداد رسیده — مقایسه با تاریخچه هنوز معنادار نیست',
    winners: { count: 2, meanScore: 81, medianWords: {} },
    returnRateByBand: [
      { band: 'STRONG', briefs: 3, returned: 0, rate: null },
      { band: 'ADEQUATE', briefs: 2, returned: 0, rate: null },
      { band: 'WEAK', briefs: 6, returned: 4, rate: 0.67 },
      { band: 'INCOMPLETE', briefs: 1, returned: 1, rate: null },
    ],
  },
  example: {
    id: 'b9', code: 'BRF-000009', title: 'بریف کمپین فصلی', similarity: 0.6,
    businessObjective: 'افزایش ۱۵ درصدی فروش در تابستان', targetAudience: null, scope: null, expectedDeliverables: null, successCriteria: null,
  },
};

describe('BriefQuality', () => {
  it('shows what to fix first, the quoted vagueness, and the organisation’s own evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<MemoryRouter><QueryClientProvider client={qc}><BriefQuality briefId="b1" /></QueryClientProvider></MemoryRouter>);

    expect((await screen.findByTestId('fix-first')).textContent).toContain('اول «هدف کسب‌وکار» را دقیق کنید');
    const fields = screen.getByTestId('quality-fields');
    expect(fields.textContent).toContain('«افزایش فروش» قابل‌سنجش نیست');
    expect(fields.textContent).toContain('عبارت مبهم: «جذاب»');
    expect(screen.getByText('ضعیف — ۴۶ از ۱۰۰')).toBeTruthy();

    // History is shown with its limits: too few wins is said, and a band with data shows a rate.
    const history = screen.getByTestId('quality-history');
    expect(history.textContent).toContain('هنوز معنادار نیست');
    expect(history.textContent).toContain('۶۷٪');
    expect(history.textContent).toContain('(کم‌داده)');

    // The example shows the winning brief's version of the very field to fix first.
    expect(screen.getByTestId('quality-example').textContent).toContain('افزایش ۱۵ درصدی فروش در تابستان');
  });
});
