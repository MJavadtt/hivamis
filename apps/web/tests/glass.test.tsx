import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Badge, Button, Card, StatTile, ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { ThemeProvider } from '../src/lib/theme';
import { setAccessToken, setRefreshToken } from '../src/lib/api';
import { Shell } from '../src/components/Shell';
import { HelpDrawer } from '../src/components/HelpDrawer';

/**
 * Hivamis, the third list (item 7): the kit applied in full — tile and card footers, the sidebar's
 * counts, the page footer — and then glass over a pastel light, in both themes.
 */

const css = readFileSync(path.resolve(__dirname, '../src/index.css'), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', email: 'p@hiva.local', fullName: 'پریسا نوری', jobTitle: null, department: { code: 'OP', nameFa: 'عملیات' }, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['PMO_MANAGER'], permissions: ['project.read', 'task.read', 'form.read'], locale: 'fa', mustChangePassword: false };

afterEach(() => vi.unstubAllGlobals());

describe('The glass look', () => {
  it('lays translucent glass over a pastel light, near-opaque glass for overlays, in both dark blocks alike', () => {
    expect(css).toMatch(/--color-surface: rgb\(255 255 255 \/ 0\.\d+\)/);
    expect(css).toMatch(/--color-panel: rgb\(255 255 255 \/ 0\.9\)/);
    expect(css).toMatch(/body::before \{[^}]*position: fixed;[^}]*var\(--glow-1\)/s);
    // The switch and «هماهنگ با سیستم» define the night glass the same way.
    for (const token of ['--color-surface: rgb(36 33 62 / 0.55)', '--color-panel: rgb(26 24 47 / 0.94)', '--color-canvas: #0d0c1a', '--glow-1: rgb(108 82 255 / 0.34)']) {
      expect(css.split(token).length - 1, token).toBe(2);
    }
    // Glass is blurred; where transparency is unwelcome or unsupported it turns solid.
    expect(css).toMatch(/\.rounded-xl\.bg-surface,[\s\S]*?backdrop-filter: var\(--glass-blur\)/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*:root \{\s*--color-surface: var\(--color-panel\);/);
    expect(css).toMatch(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  });

  it('makes the main action the accent gradient and status marks pastel pills', () => {
    render(<><Button variant="primary">ثبت</Button><Badge tone="success">تأییدشده</Badge></>);
    expect(screen.getByRole('button', { name: 'ثبت' }).className).toContain('btn-accent');
    expect(screen.getByText('تأییدشده').className).toContain('rounded-full');
    expect(css).toMatch(/\.btn-accent \{[^}]*background-image: var\(--grad-accent\);[^}]*color: var\(--color-on-accent\);/s);
  });
});

describe('The kit, in full', () => {
  it('gives a card the kit’s footer bar, held to the bottom of a card stretched to its row', () => {
    render(<Card title="وظایف من" footer={<a href="/tasks">همه وظایف</a>}><p>متن</p></Card>);
    const card = screen.getByText('متن').closest('section')!;
    expect(card.className).toContain('flex-col');
    expect(card.className).toContain('ring-edge');
    const footer = card.querySelector('footer')!;
    expect(footer.className).toContain('mt-auto');
    expect(within(footer).getByRole('link', { name: 'همه وظایف' })).toBeTruthy();
  });

  it('sets a tile’s hint in a footer row under a hairline, with a pastel tile for its icon', () => {
    const { container } = render(<StatTile label="نقض روند" value="۱" tone="danger" hint="۱ نقض‌شده" icon={<svg />} />);
    expect(screen.getByText('۱ نقض‌شده').className).toContain('border-t');
    expect(container.querySelector('svg')!.parentElement!.className).toContain('bg-rose-100');
  });

  it('counts what is waiting beside «کارهای من» and «فرم‌ها», and closes every page with the footer', async () => {
    localStorage.setItem('hiva.owl.greeted', '1');
    setAccessToken('t'); setRefreshToken('r');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
      if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
      if (p === '/auth/me') return json(ME);
      if (p === '/notifications') return json({ items: [], unread: 0 });
      if (p === '/me/work') return json({ items: [{}, {}, {}], counts: { task: 1, formApproval: 2 } });
      return json({ items: [] });
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider><ToastProvider><LocaleProvider><AuthProvider><MemoryRouter><Shell><p>محتوا</p></Shell></MemoryRouter></AuthProvider></LocaleProvider></ToastProvider></ThemeProvider>
      </QueryClientProvider>,
    );
    const work = await screen.findByRole('link', { name: /کارهای من/ });
    await vi.waitFor(() => expect(work.textContent).toContain('۳'));
    expect(screen.getByRole('link', { name: /فرم‌ها/ }).textContent).toContain('۲');
    const footer = screen.getByTestId('page-footer');
    expect(within(footer).getByRole('link', { name: 'قوانین سازمان' }).getAttribute('href')).toBe('/rules');
    expect(footer.textContent).toContain('هیوامیس');
  });
});

describe('Overlays over glass', () => {
  it('opens the written guide at the root of the page, even from inside a glass card', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    render(<AuthProvider><section data-testid="card" className="glass rounded-xl bg-surface"><HelpDrawer open onClose={() => {}} /></section></AuthProvider>);
    const dialog = screen.getByRole('dialog');
    expect(screen.getByTestId('card').contains(dialog)).toBe(false);
    expect(dialog.className).toContain('bg-panel');
  });
});
