import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuleVersions } from '../src/components/RuleVersions';

/** An auditor reads which version is current, since when, and what changed. */
const listing = {
  kinds: { workflows: 'ماشین‌های حالت', permissions: 'نقش‌ها و دسترسی‌ها', sla: 'سیاست‌های SLA' },
  current: { workflows: 'w2', permissions: 'p1', sla: 's1' },
  versions: [
    { id: 'w2', kind: 'workflows', version: 2, hash: 'abcdef1234567890', effectiveFrom: '2026-09-21T06:00:00Z', note: 'QC نهایی برای تأیید پروپوزال حذف شد' },
    { id: 'w1', kind: 'workflows', version: 1, hash: '0123456789abcdef', effectiveFrom: '2026-09-01T06:00:00Z', note: null },
    { id: 'p1', kind: 'permissions', version: 1, hash: 'ffff', effectiveFrom: '2026-09-01T06:00:00Z', note: null },
    { id: 's1', kind: 'sla', version: 1, hash: 'eeee', effectiveFrom: '2026-09-01T06:00:00Z', note: null },
  ],
};
function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }

describe('Rule versions', () => {
  it('lists versions per kind with the current one marked, and shows the diff on demand', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rules/diff')) return json({ changes: ['proposal.approve: «guards» از ["a","b"] به ["b"] تغییر کرد'] });
      return json(listing);
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><RuleVersions /></QueryClientProvider>);
    const box = await screen.findByTestId('rule-versions');
    expect(box.textContent).toContain('ماشین‌های حالت');
    expect(box.textContent).toContain('نسخهٔ ۲');
    expect(box.textContent).toContain('نسخهٔ جاری ۲');
    expect(box.textContent).toContain('QC نهایی برای تأیید پروپوزال حذف شد');
    expect(screen.getAllByText('جاری')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'تغییرات نسبت به نسخهٔ قبل' }));
    const diff = await screen.findByTestId('rule-diff');
    expect(diff.textContent).toContain('proposal.approve');
  });
});
