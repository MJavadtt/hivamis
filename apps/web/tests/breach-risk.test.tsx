import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BreachRisk } from '../src/components/BreachRisk';

const body = {
  generatedAt: '2026-09-22T09:00:00Z',
  model: 'نسبت نقض در مهلت‌های مشابه',
  counts: { total: 2, critical: 1, likely: 1, earlierThanThreshold: 1 },
  predictions: [
    {
      clockId: 'c1', policyCode: 'SLA_ACCOUNT_QC', policyFa: 'کنترل کیفیت اکانت', entityType: 'task', entityId: 't1',
      departmentCode: 'CR', budgetHours: 8, consumedHours: 2, ratio: 0.25, probability: 0.82, risk: 'CRITICAL',
      basis: { source: 'POLICY_AND_UNIT', samples: 10, survivors: 10, breachRate: 0.8, medianHours: 14, p85Hours: 18 },
      expectedFinish: '2026-09-24T10:00:00Z', expectedOverrunHours: 6, loadFactor: 1.1, beatsWarnAt: true,
      becauseFa: ['از ۱۰ مهلت مشابه در واحد CR که تا این مرحله باز بودند، ۸۰٪ نقض شد'],
    },
    {
      clockId: 'c2', policyCode: 'SLA_TASK_ACCEPTANCE', policyFa: 'پذیرش وظیفه', entityType: 'task', entityId: 't2',
      departmentCode: 'ST', budgetHours: 4, consumedHours: 3, ratio: 0.75, probability: 0.55, risk: 'LIKELY',
      basis: { source: 'POLICY', samples: 20, survivors: 6, breachRate: 0.3, medianHours: 5, p85Hours: 9 },
      expectedFinish: null, expectedOverrunHours: null, loadFactor: 1, beatsWarnAt: false, becauseFa: ['از ۶ مهلت مشابه…'],
    },
  ],
};

describe('BreachRisk', () => {
  it('ranks the deadlines heading for a breach and shows the evidence behind each', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<MemoryRouter><QueryClientProvider client={qc}><BreachRisk /></QueryClientProvider></MemoryRouter>);

    expect(await screen.findByText('پیش‌بینی نقض SLA')).toBeTruthy();
    expect(screen.getByText(/۸۲٪ — بسیار محتمل/)).toBeTruthy();
    // The one the fixed threshold cannot see yet is marked as such.
    expect(screen.getByText('پیش از آستانهٔ ثابت')).toBeTruthy();
    expect(screen.getByText(/از ۱۰ مهلت مشابه در واحد CR/)).toBeTruthy();
    expect(screen.getByText(/۶ س فراتر از مهلت/)).toBeTruthy();
    expect(screen.getByText(/۵۵٪ — محتمل/)).toBeTruthy();
  });
});
