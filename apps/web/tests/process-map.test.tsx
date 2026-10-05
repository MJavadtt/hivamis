import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProcessMap } from '../src/components/ProcessMap';

/** The map draws what was mined: one node per state, one edge per move, and the conformance findings beside it. */
const mined = {
  entity: 'lead', labelFa: 'سرنخ', cases: 5, events: 14,
  nodes: [
    { state: 'NEW', visits: 5, meanDwellHours: 2, open: 0, declared: true, initial: true, terminal: false },
    { state: 'CONTACTED', visits: 5, meanDwellHours: 9.5, open: 1, declared: true, initial: false, terminal: false },
    { state: 'QUALIFIED', visits: 3, meanDwellHours: 1, open: 0, declared: true, initial: false, terminal: false },
    { state: 'CONVERTED', visits: 3, meanDwellHours: null, open: 0, declared: true, initial: false, terminal: true },
    { state: 'DISQUALIFIED', visits: 1, meanDwellHours: null, open: 0, declared: true, initial: false, terminal: true },
  ],
  edges: [
    { from: 'NEW', to: 'CONTACTED', action: 'contact', count: 5, cases: 5, meanHours: 2, declared: true, cascade: false },
    { from: 'CONTACTED', to: 'QUALIFIED', action: 'qualify', count: 3, cases: 3, meanHours: 9.5, declared: true, cascade: false },
    { from: 'QUALIFIED', to: 'CONVERTED', action: 'convert', count: 3, cases: 3, meanHours: 1, declared: true, cascade: false },
    { from: 'CONTACTED', to: 'DISQUALIFIED', action: 'disqualify', count: 1, cases: 1, meanHours: 4, declared: true, cascade: false },
  ],
  unusedDeclared: [{ from: 'NEW', to: 'DISQUALIFIED', action: 'disqualify', labelFa: 'رد سرنخ' }],
  loops: [],
  variants: [{ path: ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED'], count: 3, share: 60, meanHours: 12.5 }, { path: ['NEW', 'CONTACTED', 'DISQUALIFIED'], count: 1, share: 20, meanHours: 6 }],
  happyPath: ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED'],
  cycleTime: { meanHours: 10.9, medianHours: 12.5, completed: 4 },
  bottlenecks: [{ state: 'CONTACTED', meanDwellHours: 9.5, visits: 5 }, { state: 'NEW', meanDwellHours: 2, visits: 5 }],
};

describe('Process map', () => {
  it('draws a node per state and an edge per move, and lists the conformance findings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(mined), { status: 200, headers: { 'content-type': 'application/json' } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ProcessMap /></QueryClientProvider>);
    const svg = await screen.findByTestId('process-map');
    expect(svg.querySelectorAll('[data-testid="node"]')).toHaveLength(5);
    expect(svg.querySelectorAll('[data-testid="edge"]')).toHaveLength(4);
    // The most frequent edge is the widest.
    const widths = [...svg.querySelectorAll('[data-testid="edge"] path')].map((p) => Number(p.getAttribute('stroke-width')));
    expect(Math.max(...widths)).toBe(6);
    expect(screen.getByTestId('bottlenecks').textContent).toContain('۹٫۵ س');
    expect(screen.getByTestId('unused').textContent).toContain('رد سرنخ');
    expect(screen.getByTestId('variants').textContent).toContain('۶۰٪');
    expect(screen.getByText('حلقه‌ای ثبت نشده')).toBeTruthy();
  });
});
