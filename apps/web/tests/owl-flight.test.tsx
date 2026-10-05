import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { setAccessToken, setRefreshToken } from '../src/lib/api';
import { OwlGuide } from '../src/components/owl/OwlGuide';
import { flightPath, hover } from '../src/components/owl/flight';

/**
 * Hiva gets about by flying: up and over along an arc, banking into the turn, wings beating — never
 * a slide across the glass.
 */

const at = (k: Keyframe) => {
  const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(String(k.transform))!;
  return { x: Number(m[1]), y: Number(m[2]) };
};
const bank = (k: Keyframe) => Number(/rotate\((-?[\d.]+)deg\)/.exec(String(k.transform))?.[1] ?? 0);

describe('The flight path', () => {
  it('leaves from one place and lands exactly on the other, rising above both on the way', () => {
    const f = flightPath({ x: 1200, y: 700 }, { x: 300, y: 260 });
    expect(at(f.keyframes[0]!)).toEqual({ x: 1200, y: 700 });
    expect(at(f.keyframes.at(-1)!)).toEqual({ x: 300, y: 260 });
    const top = Math.min(...f.keyframes.map((k) => at(k).y));
    expect(top).toBeLessThan(260);
    expect(f.keyframes.every((k, i) => k.offset === i / (f.keyframes.length - 1))).toBe(true);
  });

  it('banks into the direction of travel, level at take-off and landing, and faces where it is going', () => {
    const left = flightPath({ x: 1200, y: 700 }, { x: 300, y: 700 });
    const mid = left.keyframes[Math.floor(left.keyframes.length / 2)]!;
    expect(bank(mid)).toBeLessThan(0);
    expect(bank(left.keyframes[0]!)).toBe(0);
    expect(bank(left.keyframes.at(-1)!)).toBe(0);
    expect(left.heading).toBe(-1);
    expect(flightPath({ x: 100, y: 500 }, { x: 900, y: 500 }).heading).toBe(1);
  });

  it('takes longer the further it goes, within what a person will wait for', () => {
    const short = flightPath({ x: 0, y: 0 }, { x: 30, y: 0 });
    const long = flightPath({ x: 0, y: 0 }, { x: 4000, y: 3000 });
    expect(short.duration).toBe(700);
    expect(long.duration).toBe(1700);
    expect(flightPath({ x: 0, y: 0 }, { x: 600, y: 0 }).duration).toBeGreaterThan(short.duration);
    // Even a short hop clears the ground.
    expect(Math.min(...short.keyframes.map((k) => at(k).y))).toBeLessThanOrEqual(-18);
  });

  it('answers a click by rising off its perch and settling back on the same spot', () => {
    const h = hover({ x: 16, y: 696 });
    expect(at(h.keyframes[0]!)).toEqual({ x: 16, y: 696 });
    expect(at(h.keyframes.at(-1)!)).toEqual({ x: 16, y: 696 });
    expect(Math.min(...h.keyframes.map((k) => at(k).y))).toBeLessThan(696);
  });
});

describe('Hiva in flight', () => {
  const real = { animate: HTMLElement.prototype.animate };
  afterEach(() => { HTMLElement.prototype.animate = real.animate; vi.useRealTimers(); sessionStorage.clear(); });

  function mount() {
    setAccessToken('t'); setRefreshToken('r');
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
      if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
      if (p === '/auth/me') return json({ id: 'u1', email: 'p@hiva.local', fullName: 'پریسا', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: [], locale: 'fa', mustChangePassword: false });
      return json([]);
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter initialEntries={['/']}><div data-tour="tiles">کاشی‌ها</div><OwlGuide /></MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('flies to what a tour step is about with its wings beating, and lands there', async () => {
    localStorage.setItem('hiva.owl.greeted', '1');
    sessionStorage.setItem('hiva.owl.arrived', '1');
    const flights: { keyframes: Keyframe[]; anim: { onfinish: ((e: unknown) => void) | null; cancel: () => void } }[] = [];
    HTMLElement.prototype.animate = function (keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
      const anim = { onfinish: null as ((e: unknown) => void) | null, cancel: vi.fn() };
      flights.push({ keyframes: keyframes as Keyframe[], anim });
      return anim as unknown as Animation;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (this as HTMLElement).dataset?.tour === 'tiles'
        ? ({ top: 100, left: 40, width: 600, height: 120, bottom: 220, right: 640, x: 40, y: 100, toJSON: () => ({}) } as DOMRect)
        : ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    });
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    const owl = screen.getByRole('button', { name: 'هیوا — راهنمای این صفحه' });
    const perch = owl.style.transform;
    expect(perch).toMatch(/^translate3d\(/);

    // A click: up off the perch and back.
    fireEvent.click(owl);
    expect(owl.dataset.mood).toBe('fly');
    const hop = flights.at(-1)!;
    expect(at(hop.keyframes.at(-1)!)).toEqual(at({ transform: perch }));
    act(() => hop.anim.onfinish?.({}));
    expect(owl.dataset.mood).not.toBe('fly');

    // A tour: it flies from its corner to the step, over the top.
    fireEvent.click(screen.getByRole('button', { name: /نمایش گام‌به‌گام/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const trip = flights.at(-1)!;
    expect(owl.dataset.mood).toBe('fly');
    const ys = trip.keyframes.map((k) => at(k).y);
    expect(at(trip.keyframes[0]!)).toEqual(at({ transform: perch }));
    expect(Math.min(...ys)).toBeLessThan(Math.min(ys[0]!, ys.at(-1)!));
    act(() => trip.anim.onfinish?.({}));
    expect(owl.dataset.mood).not.toBe('fly');
    const landed = at({ transform: owl.style.transform });
    expect(landed).toEqual(at(trip.keyframes.at(-1)!));
    rect.mockRestore();
  });

  it('keeps still for people who asked for less motion: it is simply there', async () => {
    localStorage.setItem('hiva.owl.greeted', '1');
    const animate = vi.fn();
    HTMLElement.prototype.animate = animate as never;
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, onchange: null, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList);
    mount();
    const owl = await screen.findByRole('button', { name: 'هیوا — راهنمای این صفحه' });
    fireEvent.click(owl);
    expect(animate).not.toHaveBeenCalled();
    expect(owl.style.transform).toMatch(/^translate3d\(/);
    mm.mockRestore();
  });
});
