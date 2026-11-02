import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GUIDE } from '@hiva/contracts';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { OwlGuide } from '../src/components/owl/OwlGuide';
import { assistantBus, guideBus, stepDuration } from '../src/lib/guide';
import { formatNumber } from '../src/lib/format';

/**
 * Hivamis task 8: Hiva the owl — the guide to the page you are on, a tour that plays by itself, the
 * organisation's videos, and answers from the guide (or the assistant) to "how do I…".
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (permissions: string[]) => ({ id: 'u1', email: 'p@hiva.local', fullName: 'پریسا', jobTitle: null, department: { code: 'OP', nameFa: 'عملیات' }, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['PMO_MANAGER'], permissions, locale: 'fa', mustChangePassword: false });
const VIDEO = { id: 'v1', sectionId: 'forms', locale: 'fa', title: 'فرم‌ها در سه دقیقه', sizeBytes: 3_145_728, createdAt: '2026-10-05T08:00:00Z' };

function mount({ at = '/forms', permissions = ['form.read', 'ai.chat'], videos = [] as unknown[], page = null as React.ReactNode } = {}) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    sent.push({ method: init?.method ?? 'GET', path: p + url.search });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(me(permissions));
    if (p === '/guide/videos') return json(videos);
    if (p === '/guide/videos/v1/link') return json({ url: '/api/v1/guide/videos/v1/stream?exp=1&sig=x', expiresAt: '2026-10-05T11:00:00Z' });
    return json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter initialEntries={[at]}>{page}<OwlGuide /></MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

const owl = () => screen.findByRole('button', { name: 'هیوا — راهنمای این صفحه' });

beforeEach(() => { localStorage.clear(); localStorage.setItem('hiva.owl.greeted', '1'); });
afterEach(() => { vi.useRealTimers(); });

describe('Hiva the owl', () => {
  it('is drawn flat where three dimensions cannot be, and opens the guide to the page it is on', async () => {
    mount();
    const button = await owl();
    expect(button.querySelector('[data-owl="svg"]')).not.toBeNull();
    fireEvent.click(button);
    const panel = await screen.findByTestId('owl-panel');
    expect(panel.textContent).toContain('فرم‌ها');
    expect(panel.textContent).toContain(GUIDE.find((s) => s.id === 'forms')!.summary.fa);
    expect(screen.getByRole('button', { name: /نمایش گام‌به‌گام/ }).textContent).toContain('۴ گام');
  });

  it('answers from the guide — only about what the person may open — and hands the rest to the assistant', async () => {
    const asked: string[] = [];
    const off = assistantBus.on((q) => asked.push(q));
    mount({ permissions: ['form.read', 'ai.chat'] });
    fireEvent.click(await owl());
    fireEvent.change(await screen.findByPlaceholderText('مثلاً: چطور فرمی را تأیید کنم؟'), { target: { value: 'چطور فرمی را تأیید کنم' } });
    const answers = await screen.findByTestId('owl-answers');
    expect(answers.textContent).toContain('مسیر و تأییدکننده');
    // Leads are not this person's: the guide does not send them there.
    fireEvent.change(screen.getByPlaceholderText('مثلاً: چطور فرمی را تأیید کنم؟'), { target: { value: 'ثبت سرنخ جدید' } });
    await waitFor(() => expect(screen.getByTestId('owl-answers').textContent).not.toContain('سرنخ جدید'));
    fireEvent.click(screen.getByRole('button', { name: 'از دستیار بپرسید' }));
    expect(asked).toEqual(['ثبت سرنخ جدید']);
    off();
  });

  it('plays the page step by step, lighting what each step is about, and moves on by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (this as HTMLElement).dataset?.tour === 'today'
        ? ({ top: 100, left: 40, width: 600, height: 120, bottom: 220, right: 640, x: 40, y: 100, toJSON: () => ({}) } as DOMRect)
        : ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    });
    mount({ at: '/', permissions: [], page: <div data-tour="today">امروز</div> });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    fireEvent.click(screen.getByRole('button', { name: 'هیوا — راهنمای این صفحه' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    fireEvent.click(screen.getByRole('button', { name: /نمایش گام‌به‌گام/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const steps = GUIDE.find((s) => s.id === 'dashboard')!.steps;
    expect(screen.getByTestId('tour').textContent).toContain(steps[0]!.title.fa);
    expect(screen.getByTestId('tour').textContent).toContain('گام ۱ از ۵');
    const spot = [...document.querySelectorAll<HTMLElement>('div[aria-hidden]')].find((d) => d.style.boxShadow.includes('9999'));
    expect(spot?.style.top).toBe('94px');

    // It moves on by itself; paused, it waits.
    await act(async () => { await vi.advanceTimersByTimeAsync(stepDuration(steps[0]!.body.fa)); });
    expect(screen.getByTestId('tour').textContent).toContain(steps[1]!.title.fa);
    fireEvent.click(screen.getByRole('button', { name: 'توقف' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByTestId('tour').textContent).toContain(steps[1]!.title.fa);
    // A step whose element is not on screen still speaks, and says why nothing is lit.
    expect(screen.getByTestId('tour').textContent).toContain('این بخش الان روی صفحه نیست');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('tour')).toBeNull();
    rect.mockRestore();
  });

  it('plays the organisation’s video for the section, and lets the administrator manage it', async () => {
    mount({ permissions: ['form.read', 'admin.settings'], videos: [VIDEO] });
    fireEvent.click(await owl());
    fireEvent.click(await screen.findByRole('button', { name: 'ویدیوی این بخش' }));
    const video = await screen.findByTestId('guide-video');
    expect(video.getAttribute('src')).toBe('/api/v1/guide/videos/v1/stream?exp=1&sig=x');
    expect(screen.getByTestId('video-admin').textContent).toContain(`${formatNumber(3, 1)} مگابایت`);
    expect(screen.getByLabelText('ویدیوی English')).toBeDefined();
  });

  it('opens from the ? in the top bar, greets once, and can be hidden', async () => {
    localStorage.removeItem('hiva.owl.greeted');
    mount({ at: '/my-work' });
    expect(await screen.findByText(/سلام! من هیوا هستم/, {}, { timeout: 3000 })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'باشه' }));
    expect(localStorage.getItem('hiva.owl.greeted')).toBe('1');
    act(() => { guideBus.emit({ type: 'open' }); });
    expect((await screen.findByTestId('owl-panel')).textContent).toContain('کارهای من');
    fireEvent.click(screen.getByRole('button', { name: 'پنهان کردن هیوا' }));
    fireEvent.click(screen.getByRole('button', { name: 'بستن' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'هیوا — راهنمای این صفحه' })).toBeNull());
    expect(localStorage.getItem('hiva.owl')).toBe('hidden');
  });

  it('points only at elements that can be found: every step’s target is a valid selector', () => {
    for (const s of GUIDE) for (const st of s.steps) if (st.target) expect(() => document.querySelector(st.target!), `${s.id}: ${st.target}`).not.toThrow();
  });
});
