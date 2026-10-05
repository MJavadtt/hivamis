import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StateBadge, Tabs, ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { ThemeProvider } from '../src/lib/theme';
import { setAccessToken, setRefreshToken } from '../src/lib/api';
import { Shell } from '../src/components/Shell';
import { HalfGauge } from '../src/components/Gauge';

/**
 * Hivamis task 3: the interface after the Figma kit — the sidebar that folds to a rail of icons,
 * the phone's bar where search opens over it, the half gauge, and status tints that hold in the dark.
 */

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', email: 'p@hiva.local', fullName: 'پریسا نوری', jobTitle: null, department: { code: 'OP', nameFa: 'عملیات' }, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['PMO_MANAGER'], permissions: ['project.read', 'task.read'], locale: 'fa', mustChangePassword: false };

function desktop(on: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: on && query.includes('min-width: 1024px'), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }) as MediaQueryList);
}

function mount() {
  setAccessToken('t'); setRefreshToken('r');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(ME);
    if (p === '/notifications') return json({ items: [], unread: 0 });
    return json({ items: [] });
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider><ToastProvider><LocaleProvider><AuthProvider><MemoryRouter><Shell><p>محتوا</p></Shell></MemoryRouter></AuthProvider></LocaleProvider></ToastProvider></ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('The interface after the kit', () => {
  it('folds the sidebar to a rail of icons and back, and remembers it', async () => {
    localStorage.setItem('hiva.owl.greeted', '1');
    desktop(true);
    mount();
    const projects = await screen.findByRole('link', { name: 'پروژه‌ها' });
    expect(projects.textContent).toBe('پروژه‌ها');
    fireEvent.click(screen.getByRole('button', { name: 'جمع کردن منو' }));
    // Folded, the item keeps its name for the ear and the tooltip, and shows only its icon.
    await waitFor(() => expect(screen.getByRole('link', { name: 'پروژه‌ها' }).textContent).toBe(''));
    expect(screen.getByRole('link', { name: 'پروژه‌ها' }).getAttribute('title')).toBe('پروژه‌ها');
    expect(localStorage.getItem('hiva.sidebar')).toBe('rail');
    fireEvent.click(screen.getByRole('button', { name: 'باز کردن منو' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'پروژه‌ها' }).textContent).toBe('پروژه‌ها'));
    expect(localStorage.getItem('hiva.sidebar')).toBe('full');
  });

  it('on a phone, opens search over the bar', async () => {
    localStorage.setItem('hiva.owl.greeted', '1');
    desktop(false);
    mount();
    expect(await screen.findAllByRole('searchbox')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'جستجو' }));
    const boxes = await screen.findAllByRole('searchbox');
    expect(boxes).toHaveLength(2);
    expect(document.activeElement).toBe(boxes[1]);
    fireEvent.click(screen.getAllByRole('button', { name: 'بستن' }).at(-1)!);
    await waitFor(() => expect(screen.getAllByRole('searchbox')).toHaveLength(1));
  });

  it('draws the half gauge to the share it is given, with its legend', () => {
    const { container } = render(<HalfGauge value={3} total={4} label="در مسیر" legend={[{ label: 'در مسیر', value: 3, tone: 'brand' }, { label: 'نقض‌شده', value: 1, tone: 'danger' }]} />);
    const arc = container.querySelectorAll('path')[1]!;
    const length = Math.PI * 80;
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(length / 4, 3);
    expect(container.querySelector('figure')?.getAttribute('aria-label')).toBe('در مسیر: 3 / 4');
    expect(container.textContent).toContain('نقض‌شده');
    // Nothing to measure is an empty arc, not a division by zero.
    const empty = render(<HalfGauge value={0} total={0} label="—" />).container.querySelectorAll('path')[1]!;
    expect(Number(empty.getAttribute('stroke-dashoffset'))).toBeCloseTo(length, 3);
  });

  it('brings a chosen tab into view by scrolling the strip sideways, never the page', () => {
    const page = vi.fn();
    Element.prototype.scrollIntoView = page;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const r = this.getAttribute('role') === 'tablist' ? { left: 0, right: 300 } : (this as HTMLElement).getAttribute('aria-selected') === 'true' ? { left: 380, right: 460 } : { left: 0, right: 0 };
      return { ...r, top: 0, bottom: 30, width: r.right - r.left, height: 30, x: r.left, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    render(<Tabs active="c" onChange={() => {}} tabs={[{ key: 'a', label: 'الف' }, { key: 'b', label: 'ب' }, { key: 'c', label: 'پ' }]} />);
    expect(screen.getByRole('tablist').scrollLeft).toBe(160);
    expect(page).not.toHaveBeenCalled();
  });

  it('keeps status colours legible in the dark: the status palettes are tokens, tinted there', () => {
    const css = readFileSync(path.resolve(__dirname, '../src/index.css'), 'utf8');
    const { container } = render(<StateBadge state="BREACHED" />);
    expect(container.firstElementChild!.className).toContain('bg-rose-50');
    // Both dark blocks — the switch and «هماهنگ با سیستم» — wash the tint and lift the text.
    for (const token of ['--color-rose-50: #301e21', '--color-rose-700: #fda4af', '--color-amber-50: #302718', '--color-emerald-700: #6ee7b7', '--color-sky-200: #164458']) {
      expect(css.split(token).length - 1, token).toBe(2);
    }
    // A fill keeps its colour, so a danger button stays red under white text.
    expect(css).not.toContain('--color-rose-600:');
  });
});
