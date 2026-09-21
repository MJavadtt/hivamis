import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { RuleLab } from '../src/components/RuleLab';

/** Untick a guard, run, and read what history says. */
const result = {
  replayed: 120, blockedAttempts: 3,
  wouldBlock: [{ entity: 'proposal', entityId: 'p1', action: 'approve', at: '2026-09-10T06:00:00Z', because: 'GUARD_ADDED', detail: 'QC نهایی با نتیجهٔ قبول ثبت شده باشد: ثبت نشده' }],
  wouldAllow: [{ entity: 'proposal', entityId: 'p2', action: 'approve', at: '2026-09-11T06:00:00Z', because: 'GUARD_REMOVED', detail: 'قبلاً با «proposal.pricingApproved» مسدود شد؛ اکنون عبور می‌کرد' }],
  summary: { wouldBlock: 1, wouldAllow: 1, byEntity: { proposal: { wouldBlock: 1, wouldAllow: 1 } } },
  assumptions: ['الف', 'ب', 'ج'], invalid: [],
};
function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }

describe('Rule lab', () => {
  it('sends the edited guard set for the chosen transition and shows both lists', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rules/lab/vocabulary')) return json({ guards: [{ id: 'proposal.finalQcPassed', labelFa: 'QC نهایی' }, { id: 'proposal.pricingApproved', labelFa: 'تأیید قیمت' }] });
      if (url.includes('/rules/lab')) { posts.push(JSON.parse(String(init?.body))); return json(result); }
      return json({});
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ToastProvider><RuleLab /></ToastProvider></QueryClientProvider>);
    // proposal.approve carries both guards; untick one (the vocabulary loads asynchronously).
    const qcGuard = await screen.findByLabelText('proposal.pricingApproved') as HTMLInputElement;
    expect(qcGuard.checked).toBe(true);
    fireEvent.click(qcGuard);
    fireEvent.click(screen.getByRole('button', { name: 'شبیه‌سازی روی تاریخچه' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].edits[0]).toMatchObject({ kind: 'transition', entity: 'proposal', action: 'approve', guards: ['proposal.finalQcPassed'] });
    const summary = await screen.findByTestId('lab-summary');
    expect(summary.textContent).toContain('۱۲۰');
    expect(screen.getByTestId('would-block').textContent).toContain('قانون تازه');
    expect(screen.getByTestId('would-allow').textContent).toContain('proposal.pricingApproved');
  });
});
