import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BudgetByOrder } from '../src/components/BudgetByOrder';

/** The table names the unit and the amount — the project bar alone cannot. */
const budget = {
  project: { plannedBudget: 300_000_000, allocated: 180_000_000, declared: 185_000_000, unallocated: 120_000_000, status: 'UNDER' },
  units: [
    { departmentCode: 'CR', budget: 100_000_000, declared: 115_000_000, orders: 1, status: 'OVER' },
    { departmentCode: 'ST', budget: 80_000_000, declared: 70_000_000, orders: 1, status: 'NEAR' },
  ],
  workOrders: [
    { workOrderId: 'w1', code: 'WO-000001', title: 'طراحی UI', departmentCode: 'CR', state: 'IN_PROGRESS', budget: 100_000_000, declared: 115_000_000, variance: -15_000_000, variancePercent: 15, status: 'OVER', declarations: 3 },
    { workOrderId: 'w2', code: 'WO-000002', title: 'استراتژی', departmentCode: 'ST', state: 'ACCEPTED', budget: 80_000_000, declared: 70_000_000, variance: 10_000_000, variancePercent: -12.5, status: 'NEAR', declarations: 1 },
    { workOrderId: 'w3', code: 'WO-000003', title: 'بدون بودجه', departmentCode: 'DM', state: 'DRAFT', budget: null, declared: 0, variance: null, variancePercent: null, status: 'NO_BUDGET', declarations: 0 },
  ],
};

describe('Budget by work order', () => {
  it('shows each order against its budget with the variance and a status, and the unit totals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(budget), { status: 200, headers: { 'content-type': 'application/json' } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><BudgetByOrder projectId="p1" /></QueryClientProvider>);
    const rows = await screen.findByTestId('budget-rows');
    const text = rows.textContent ?? '';
    expect(text).toContain('WO-000001');
    expect(text).toContain('عبور کرده');
    expect(text).toContain('(۱۵٪)');
    expect(text).toContain('نزدیک سقف');
    expect(text).toContain('بدون بودجه');
    expect(text).toContain('(۳)');            // three declarations behind the CR figure
    expect(screen.getAllByText('جمع واحد')).toHaveLength(2);
  });
});
