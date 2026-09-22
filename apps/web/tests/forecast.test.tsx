import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Forecast } from '../src/components/Forecast';

const forecast = {
  runs: 2000, openTasks: 3, deterministicHours: 32,
  percentiles: { p50: '2026-10-05T05:30:00Z', p85: '2026-10-08T05:30:00Z', p95: '2026-10-12T05:30:00Z', p50Hours: 32, p85Hours: 48, p95Hours: 64 },
  plannedEnd: '2026-10-07T13:30:00Z', probabilityOnTime: 0.72,
  histogram: Array.from({ length: 10 }, (_, i) => ({ fromHours: i * 8, toHours: (i + 1) * 8, from: '2026-10-01T05:30:00Z', to: '2026-10-02T05:30:00Z', runs: [0, 0, 0, 900, 500, 300, 150, 90, 40, 20][i]! })),
  samples: [{ departmentCode: 'CR', count: 14, source: 'department' }],
};

describe('Forecast', () => {
  it('shows three dates to promise and the odds of the plan', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(forecast), { status: 200, headers: { 'content-type': 'application/json' } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><Forecast projectId="p1" /></QueryClientProvider>);
    const tiles = await screen.findByTestId('forecast-tiles');
    expect(tiles.textContent).toContain('۵۰٪ احتمال تا');
    expect(tiles.textContent).toContain('۷۲٪');
    expect(tiles.textContent).toContain('۴۸ ساعت کاری — تعهد امن');
    expect(tiles.textContent).toContain('یک عدد قطعی می‌گفت ۳۲ ساعت');
    expect(screen.getByTestId('forecast-histogram').children).toHaveLength(10);
    expect(screen.getByText(/سابقهٔ همان واحد \(۱۴\)/)).toBeTruthy();
  });
});
