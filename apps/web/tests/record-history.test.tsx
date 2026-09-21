import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecordHistory } from '../src/components/RecordHistory';

/**
 * The history panel renders the audit trail as evidence: each change with its actor, field by
 * field, states by their Persian label, and withheld figures as withheld rather than blank.
 */
const history = {
  withheld: ['cost'],
  events: [
    { id: 'e1', at: '2026-09-05T05:30:00.000Z', action: 'CREATE', reason: null, actorName: 'سارا کریمی', changes: [], details: null },
    { id: 'e0', at: '2026-09-05T06:00:00.000Z', action: 'EXPORT', reason: null, actorName: 'سارا کریمی', changes: [], details: { format: 'pdf', included: [{ kind: 'lead' }] } },
    {
      id: 'e2', at: '2026-09-06T06:00:00.000Z', action: 'UPDATE', reason: null, actorName: 'سارا کریمی', details: null,
      changes: [
        { field: 'estimatedValue', before: '1000000', after: '2500000' },
        { field: 'totalCost', withheld: 'cost' },
      ],
    },
    {
      id: 'e3', at: '2026-09-07T07:00:00.000Z', action: 'STATE_TRANSITION', reason: 'تماس گرفته شد', actorName: 'رضا شریفی', details: null,
      changes: [{ field: 'state', before: 'NEW', after: 'CONTACTED' }],
    },
  ],
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function mount() {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return json(history);
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RecordHistory entityType="lead" entityId="lead-1" />
    </QueryClientProvider>,
  );
  return urls;
}

describe('Record history panel', () => {
  it('fetches nothing until opened, then asks for the record’s history', async () => {
    const urls = mount();
    expect(urls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'تاریخچه' }));
    await screen.findByTestId('history-timeline');
    expect(urls.some((u) => u.includes('/history/lead/lead-1'))).toBe(true);
  });

  it('shows changes newest first, with actor, action and the before → after of each field', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'تاریخچه' }));
    const list = await screen.findByTestId('history-timeline');
    const items = [...list.querySelectorAll(':scope > li')];
    expect(items).toHaveLength(4);
    expect(items[0]!.textContent).toContain('تغییر وضعیت');
    expect(items[0]!.textContent).toContain('رضا شریفی');
    expect(items[0]!.textContent).toContain('تماس گرفته شد');
    // States by their label, not their code.
    expect(items[0]!.textContent).toContain('جدید');
    expect(items[0]!.textContent).not.toContain('CONTACTED');
    // Numbers in Persian digits.
    expect(items[1]!.textContent).toContain('۱۰۰۰۰۰۰');
    expect(items[1]!.textContent).toContain('۲۵۰۰۰۰۰');
    expect(items[3]!.textContent).toContain('ایجاد');
  });

  it('shows an event about the record as details, not as changed fields', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'تاریخچه' }));
    await screen.findByTestId('history-timeline');
    const details = screen.getByTestId('history-details');
    expect(details.textContent).toContain('format: pdf');
    expect(details.textContent).not.toContain('included');   // nested metadata is not a field
    expect(details.closest('li')!.querySelector('ul')).toBeNull();
  });

  it('shows a withheld figure as withheld, never as an empty change', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'تاریخچه' }));
    const list = await screen.findByTestId('history-timeline');
    expect(list.textContent).toContain('totalCost');
    expect(list.textContent).toContain('خارج از سطح دسترسی');
  });

  it('asks for the record as of the chosen instant', async () => {
    const urls = mount();
    fireEvent.click(screen.getByRole('button', { name: 'تاریخچه' }));
    await screen.findByTestId('history-timeline');
    const input = document.getElementById('history-as-of') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '۱۴۰۵/۰۶/۱۵ ۱۰:۳۰' } });
    fireEvent.blur(input);
    await waitFor(() => expect(urls.some((u) => u.includes('/history/lead/lead-1/at?'))).toBe(true));
    const at = urls.find((u) => u.includes('/at?'))!;
    expect(at).toMatch(/ts=2026-09-06T/);
  });
});
