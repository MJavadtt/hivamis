import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import BookingAdmin from '../src/pages/BookingAdmin';
import Reception from '../src/pages/Reception';

/**
 * Audit F-9, step 4: the meeting platform's admin panel, in Hivamis — rooms and things, catering, how
 * the rooms are used — and the reception desk, where checking a guest in tells the organiser.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (permissions: string[]) => ({ id: 'u1', email: 'a@hiva.local', fullName: 'مدیر سیستم', jobTitle: null, locale: 'fa', mustChangePassword: false, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions });

function mount(ui: React.ReactNode, permissions: string[], answer: (path: string, method: string, body: any) => Response | undefined) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, path: p, body });
    if (p === '/auth/refresh') return json({ accessToken: 't' });
    if (p === '/auth/me') return json(me(permissions));
    return answer(p, method, body) ?? json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter>{ui}</MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

beforeEach(() => localStorage.clear());

describe('Running the rooms', () => {
  it('adds a room with its seats, place and features', async () => {
    const sent = mount(<BookingAdmin />, ['resource.manage', 'meeting.book'], (p, method) => {
      if (p === '/booking/resources' && method === 'GET') return json([{ id: 'r1', type: 'ROOM', name: 'اتاق جلسهٔ دماوند', description: null, capacity: 6, floor: '۲', features: ['DISPLAY'], isActive: true, location: { id: 'l1', name: 'دفتر مرکزی' } }]);
      if (p === '/booking/locations') return json([{ id: 'l1', name: 'دفتر مرکزی', kind: 'INSIDE', building: null, isActive: true }]);
      if (p === '/booking/resources' && method === 'POST') return json({ id: 'r2' }, 201);
      return undefined;
    });
    expect((await screen.findByTestId('resources')).textContent).toContain('اتاق جلسهٔ دماوند');
    fireEvent.click(screen.getByRole('button', { name: 'افزودن' }));
    const editor = await screen.findByTestId('resource-editor');
    fireEvent.change(within(editor).getAllByRole('textbox')[0]!, { target: { value: 'اتاق جلسهٔ سهند' } });
    fireEvent.change(within(editor).getByRole('spinbutton'), { target: { value: '10' } });
    fireEvent.change(within(editor).getAllByRole('combobox')[1]!, { target: { value: 'l1' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'ویدئوکنفرانس' }));
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => expect(sent.find((x) => x.path === '/booking/resources' && x.method === 'POST')?.body).toEqual({
      type: 'ROOM', name: 'اتاق جلسهٔ سهند', capacity: 10, locationId: 'l1', features: ['VIDEO_CONFERENCE'],
    }));
  });

  it('shows how each room is used, to someone who oversees bookings without managing rooms', async () => {
    mount(<BookingAdmin />, ['meeting.view_all', 'meeting.book'], (p) => (p === '/booking/analytics' ? json({
      workingHoursPerRoom: 176, bookings: { total: 12, byState: { CONFIRMED: 7, CANCELLED: 2 } },
      rooms: [{ id: 'r1', name: 'اتاق جلسهٔ دماوند', capacity: 6, isActive: true, meetings: 9, hours: 14.5, utilization: 8.2 }],
      startsByHour: Array.from({ length: 24 }, (_, h) => (h === 10 ? 4 : 0)), catering: [{ labelFa: 'چای و قهوه', labelEn: 'Tea and coffee', quantity: 30, cost: 4500000 }],
    }) : undefined));
    // No rooms tab without resource.manage: straight to the report.
    expect(screen.queryByRole('button', { name: 'اتاق‌ها و منابع' })).toBeNull();
    const rooms = await screen.findByTestId('room-use');
    expect(rooms.textContent).toContain('اتاق جلسهٔ دماوند');
    expect(screen.getByTestId('booking-report').textContent).toContain('چای و قهوه');
  });
});

describe('The reception desk', () => {
  it('checks a guest in, and then out', async () => {
    let inAt: string | null = null;
    const sent = mount(<Reception />, ['reception.checkin'], (p, method) => {
      if (p === '/reception') return json([{
        id: 'b1', code: 'BKG-000001', title: 'جلسه با پگاه سبز', startsAt: '2026-10-20T06:30:00.000Z', endsAt: '2026-10-20T07:30:00.000Z', placeNote: null, parkingSpaces: 2,
        room: { name: 'اتاق جلسهٔ البرز', floor: '۳' }, organizer: { id: 'u2', fullName: 'بهراد مهرنیا' },
        guests: [{ id: 'g1', fullName: 'مهسا نوری', company: 'پگاه سبز', isVip: true, checkedInAt: inAt, checkedOutAt: null }],
      }]);
      if (p === '/reception/guests/g1/check-in' && method === 'POST') { inAt = '2026-10-20T06:25:00.000Z'; return json({ id: 'g1' }); }
      return undefined;
    });
    const guests = await screen.findByTestId('reception-guests');
    expect(guests.textContent).toContain('مهسا نوری');
    fireEvent.click(within(guests).getByRole('button', { name: 'ثبت ورود' }));
    await waitFor(() => expect(sent.some((x) => x.path === '/reception/guests/g1/check-in')).toBe(true));
    await screen.findByRole('button', { name: 'ثبت خروج' });
  });
});
