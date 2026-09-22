import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Memory from '../src/pages/Memory';

const status = {
  serviceConfigured: false, localModel: 'local-hash-v1', total: 42,
  byKind: [
    { key: 'lessonLearned', labelFa: 'درس آموخته', count: 7, models: ['local-hash-v1'], lastIndexedAt: '2026-09-22T09:00:00Z' },
    { key: 'brief', labelFa: 'بریف', count: 20, models: ['local-hash-v1'], lastIndexedAt: '2026-09-22T09:00:00Z' },
  ],
};
const results = {
  query: 'صنایع غذایی', candidates: 42, model: 'local-hash-v1', usedService: false,
  basisFa: 'سرویس embedding پیکربندی نشده — بردارها محلی و واژه‌محورند؛ نتایج بیشتر بر پایهٔ شباهت متنی‌اند',
  kinds: [{ key: 'lessonLearned', labelFa: 'درس آموخته' }, { key: 'brief', labelFa: 'بریف' }],
  hits: [{
    entityType: 'lessonLearned', entityId: 'l1', titleFa: 'استراتژی مشتریان صنایع غذایی', kindFa: 'درس آموخته',
    projectId: 'p1', href: '/projects/p1', score: 0.62, semantic: 0.71, lexical: 0.45,
    snippetFa: 'در صنایع غذایی، محتوای دستور پخت بیشترین تعامل را می‌گیرد.',
    indexedAt: '2026-09-22T09:00:00Z', model: 'local-hash-v1',
  }],
};

describe('Memory page', () => {
  it('shows what was found, both halves of its score, and which embedder answered', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      JSON.stringify(String(url).includes('/memory/status') ? status : results),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<MemoryRouter><QueryClientProvider client={qc}><Memory /></QueryClientProvider></MemoryRouter>);

    // The status tiles say plainly that no embedding service is configured.
    expect(await screen.findByText('محلی')).toBeTruthy();
    expect(screen.getByText(/local-hash-v1 — واژه‌محور/)).toBeTruthy();

    // Asking a question runs the search and lists what came back.
    (screen.getAllByRole('button').find((b) => b.textContent?.includes('صنایع غذایی'))!).click();
    const hits = await screen.findByTestId('memory-hits');
    expect(hits.textContent).toContain('استراتژی مشتریان صنایع غذایی');
    expect(hits.textContent).toContain('دستور پخت');
    expect(hits.textContent).toContain('شباهت معنایی ۷۱٪');
    expect(hits.textContent).toContain('شباهت متنی ۴۵٪');
    expect(screen.getByText(/بردارها محلی و واژه‌محورند/)).toBeTruthy();
  });
});
