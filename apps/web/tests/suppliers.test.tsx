import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import Suppliers from '../src/pages/Suppliers';

/** The supplier 360 turns three tables into four numbers a manager can act on. */
const profile = {
  supplier: { id: 's1', name: 'نگار تصویرگر', kind: 'FREELANCER', departmentCode: 'CR', specialty: 'تصویرسازی', dayRate: '18000000', isActive: true, contactName: null, phone: null, email: null },
  evaluations: { count: 3, quality: 4.7, timeliness: 3.3, communication: 5, costValue: 4, overall: 4.25, reuseRate: 67, latest: [{ comments: 'دقیق', overall: 4.5, createdAt: '2026-09-01T00:00:00Z', evaluatedBy: 'سپیده آذر' }] },
  requests: { total: 4, byState: { FULFILLED: 3, APPROVED: 1 }, fulfilled: 3, onTimeRate: 67, open: 1, averageCost: 90000000, projects: 2 },
  timeline: [{ at: '2026-09-10T00:00:00Z', kind: 'EVALUATION', code: null, label: 'ارزیابی ۴٫۵ از ۵' }, { at: '2026-09-01T00:00:00Z', kind: 'REQUEST', code: 'OSR-000004', label: 'تصویرسازی ۶ فریم' }],
};
const suggestions = [{ ...profile, score: 78 }, { ...profile, supplier: { ...profile.supplier, id: 's2', name: 'تازه‌وارد' }, evaluations: { ...profile.evaluations, overall: null }, requests: { ...profile.requests, onTimeRate: null, open: 0 }, score: 10 }];

function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
function mount(path: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/suppliers/suggest')) return json(suggestions);
    if (url.includes('/360')) return json(profile);
    return json({ items: [], total: 0, page: 1, pageSize: 20 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}><ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/suppliers" element={<Suppliers />} /><Route path="/suppliers/:id" element={<Suppliers />} /></Routes>
      </MemoryRouter>
    </ToastProvider></QueryClientProvider>,
  );
}

describe('Suppliers', () => {
  it('shows the four numbers of the 360, in Persian, with the count behind each', async () => {
    mount('/suppliers/s1');
    const stats = await screen.findByTestId('supplier-stats');
    expect(stats.textContent).toContain('۴٫۲۵ از ۵');
    expect(stats.textContent).toContain('۳ ارزیابی');
    expect(stats.textContent).toContain('۶۷٪');
    expect(stats.textContent).toContain('۳ تأمین انجام‌شده');
    expect(stats.textContent).toContain('۲ پروژه');
    expect(screen.getByTestId('supplier-timeline').textContent).toContain('OSR-000004');
  });

  it('ranks suggestions with their evidence and score', async () => {
    mount('/suppliers');
    const list = await screen.findByTestId('suggestions');
    const rows = [...list.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(rows[0]).toContain('نگار تصویرگر');
    expect(rows[0]).toContain('امتیاز ۴٫۲۵ از ۵');
    expect(rows[0]).toContain('به‌موقع ۶۷٪');
    expect(rows[0]).toContain('۷۸');
    expect(rows[1]).toContain('تازه‌وارد');
    expect(rows[1]).toContain('امتیاز —');
    expect(rows[1]).toContain('۱۰');
  });
});
