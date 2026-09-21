import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { WorkCalendars } from '../src/components/WorkCalendars';

/** A blank override inherits; ticking a day on an inheriting unit starts from the organisation's week. */
const org = { workingDays: [6, 0, 1, 2, 3], workStartHour: 9, workEndHour: 18, breakHours: 1 };
const departments = [
  { id: 'd1', code: 'CR', nameFa: 'خلاقیت', workingDays: [], workStartHour: null, workEndHour: null, breakHours: null },
  { id: 'd2', code: 'ME', nameFa: 'رسانه', workingDays: [6, 0, 1, 2, 3, 4], workStartHour: 10, workEndHour: null, breakHours: null },
];

function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
function mount() {
  const calls: { url: string; method: string; body?: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/organization')) return json(org);
    if (url.includes('/departments/') && method === 'PATCH') return json({});
    if (url.includes('/departments')) return json(departments);
    if (url.includes('/users')) return json({ items: [] });
    return json({});
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ToastProvider><WorkCalendars /></ToastProvider></QueryClientProvider>);
  return calls;
}

describe('Work calendars', () => {
  it('shows an inheriting unit with the organisation’s days ticked, and an overriding one with its own', async () => {
    mount();
    await screen.findByTestId('unit-calendars');
    expect((screen.getByLabelText('CR پ') as HTMLInputElement).checked).toBe(false);   // Thursday: org does not work it
    expect((screen.getByLabelText('ME پ') as HTMLInputElement).checked).toBe(true);    // Media does
    expect(screen.getByText(/روزها مثل سازمان/)).toBeTruthy();
    expect((screen.getByLabelText('ME شروع') as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText('CR شروع') as HTMLInputElement).placeholder).toBe('9');
  });

  it('turns a ticked Thursday on an inheriting unit into an explicit six-day week, and blanks into null', async () => {
    const calls = mount();
    await screen.findByTestId('unit-calendars');
    fireEvent.click(screen.getByLabelText('CR پ'));
    fireEvent.click(screen.getAllByRole('button', { name: 'ذخیره' })[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/departments/CR/calendar');
    expect(patch.body).toEqual({ workingDays: [6, 0, 1, 2, 3, 4], workStartHour: null, workEndHour: null, breakHours: null });
  });
});
