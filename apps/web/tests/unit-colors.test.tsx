import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_UNIT_COLORS, textOn } from '@hiva/contracts';
import { ToastProvider } from '../src/components/ui';
import { setAccessToken } from '../src/lib/api';
import { UnitTag } from '../src/components/UnitTag';
import { UnitColors } from '../src/components/UnitColors';

/**
 * Hivamis task 9: each unit has a tag colour the system administrator chooses, and that tag is how
 * the unit appears on every screen — legible whatever the colour.
 */
const UNITS = [
  { id: 'd1', code: 'CR', nameFa: 'خلاقیت / گرافیک / تولید', nameEn: 'Creativity', tagColor: '#ffeb3b', color: '#ffeb3b' },
  { id: 'd2', code: 'ME', nameFa: 'رسانه', nameEn: 'Media', tagColor: null, color: DEFAULT_UNIT_COLORS.ME },
];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function mount(ui: React.ReactNode, units: unknown = UNITS) {
  setAccessToken('t');
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    sent.push({ method: init?.method ?? 'GET', path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (p === '/departments') return json(units);
    if (p.endsWith('/color')) return json({});
    return json([]);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

describe('A unit’s tag', () => {
  it('shows the unit in the colour chosen for it, with text that reads on it', async () => {
    mount(<UnitTag code="CR" />);
    const tag = await screen.findByText('خلاقیت / گرافیک / تولید');
    const box = tag.closest('[data-unit]') as HTMLElement;
    await waitFor(() => expect(box.style.backgroundColor).toBe(rgb('#ffeb3b')));
    expect(box.style.color).toBe(rgb(textOn('#ffeb3b')));
    expect(box.title).toBe('خلاقیت / گرافیک / تولید (CR)');
  });

  it('shows a unit in its default colour before the list arrives, and a dash for no unit', () => {
    mount(<><UnitTag code="ME" /><UnitTag code={null} /></>, new Promise(() => undefined));
    expect((document.querySelector('[data-unit="ME"]') as HTMLElement).style.backgroundColor).toBe(rgb(DEFAULT_UNIT_COLORS.ME));
    expect(screen.getByText('—')).toBeDefined();
  });
});

describe('Choosing unit colours', () => {
  it('saves a swatch with one click', async () => {
    const sent = mount(<UnitColors />);
    const group = await screen.findByRole('radiogroup', { name: 'رنگ برچسب «رسانه»' });
    fireEvent.click(group.querySelector(`[aria-label="${DEFAULT_UNIT_COLORS.S}"]`)!);
    await waitFor(() => expect(sent.some((x) => x.method === 'PATCH')).toBe(true));
    expect(sent.find((x) => x.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/departments/ME/color', body: { color: DEFAULT_UNIT_COLORS.S } });
  });

  it('returns a unit to its default, and offers that only where a colour was chosen', async () => {
    const sent = mount(<UnitColors />);
    await screen.findByTestId('unit-colors');
    const defaults = screen.getAllByRole('button', { name: 'پیش‌فرض' });
    expect(defaults).toHaveLength(1); // CR has a chosen colour; ME is already at its default
    fireEvent.click(defaults[0]!);
    await waitFor(() => expect(sent.find((x) => x.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/departments/CR/color', body: { color: null } }));
  });

  it('saves a hand-picked colour once the picker comes to rest, not for every shade it passes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const sent = mount(<UnitColors />);
      const picker = await screen.findByLabelText('رنگ دلخواه برای «رسانه»');
      for (const c of ['#100000', '#200000', '#300000']) fireEvent.change(picker, { target: { value: c } });
      await act(async () => { vi.advanceTimersByTime(700); });
      await waitFor(() => expect(sent.filter((x) => x.method === 'PATCH')).toHaveLength(1));
      expect(sent.find((x) => x.method === 'PATCH')!.body).toEqual({ color: '#300000' });
    } finally {
      vi.useRealTimers();
    }
  });
});
