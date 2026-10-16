import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import Bookings, { BookingPage } from '../src/pages/Bookings';

/**
 * Audit F-9 on the page: a booking is written with the rooms free at its time and what is in its way,
 * the next free times one click away; it is saved and sent for approval; and once it is the person's
 * meeting, they say whether they will come, and a new time goes back for approval.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', email: 'd@hiva.local', fullName: 'بهراد', jobTitle: null, locale: 'fa', mustChangePassword: false, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: ['meeting.book'] };
const ROOM = { id: 'r1', name: 'اتاق جلسهٔ دماوند', capacity: 6, floor: '۲', features: ['DISPLAY'], location: null };

type Handler = (path: string, method: string, body: any) => Response | undefined;
function mount(path: string, handler: Handler) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, path: p, body });
    if (p === '/auth/refresh') return json({ accessToken: 't' });
    if (p === '/auth/me') return json(ME);
    return handler(p, method, body) ?? json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes><Route path="/bookings" element={<Bookings />} /><Route path="/bookings/:id" element={<BookingPage />} /></Routes>
        </MemoryRouter>
      </AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

beforeEach(() => localStorage.clear());

describe('Booking a meeting', () => {
  it('shows the free rooms and what is in the way, offers the next free times, and sends it for approval', async () => {
    let clash = true;
    const sent = mount('/bookings', (p, method) => {
      if (p === '/bookings' && method === 'GET') return json({ items: [], total: 0, page: 1, pageSize: 25 });
      if (p === '/bookings/approvers') return json({ approvers: [{ id: 'm1', fullName: 'سپیده آذر' }], suggested: 'm1' });
      if (p === '/booking/catering') return json([{ id: 'c1', labelFa: 'چای و قهوه', labelEn: 'Tea and coffee' }]);
      if (p === '/people') return json([{ id: 'u2', fullName: 'الهام کریمی', jobTitle: 'کارشناس فروش' }]);
      if (p === '/bookings/availability') {
        return json(clash
          ? { available: false, conflicts: [{ kind: 'PERSON', subjectId: 'u2', nameFa: 'الهام کریمی', messageFa: 'الهام کریمی در این زمان در جلسهٔ دیگری است.' }], freeRooms: [ROOM], suggestions: [{ startsAt: '2026-10-20T07:30:00.000Z', endsAt: '2026-10-20T08:30:00.000Z' }] }
          : { available: true, conflicts: [], freeRooms: [ROOM], suggestions: [] });
      }
      if (p === '/bookings' && method === 'POST') return json({ id: 'b1', code: 'BKG-000001' }, 201);
      if (p === '/workflow/booking/b1/transitions') return json({ toState: 'PENDING_APPROVAL' });
      return undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: 'رزرو تازه' }));
    const editor = await screen.findByTestId('booking-editor');
    fireEvent.change(within(editor).getAllByRole('textbox')[0]!, { target: { value: 'بازبینی کمپین پاییز' } });
    fireEvent.click(await within(editor).findByText('الهام کریمی'));
    fireEvent.click(await within(editor).findByText('اتاق جلسهٔ دماوند'));

    const conflicts = await screen.findByTestId('booking-conflicts');
    expect(conflicts.textContent).toContain('در جلسهٔ دیگری است');
    // The next free time, one click away.
    clash = false;
    fireEvent.click(within(conflicts).getAllByRole('button')[0]!);
    await screen.findByTestId('booking-free');

    fireEvent.click(screen.getByRole('button', { name: 'ذخیره و فرستادن برای تأیید' }));
    await waitFor(() => expect(sent.some((x) => x.path === '/workflow/booking/b1/transitions')).toBe(true));
    const made = sent.find((x) => x.path === '/bookings' && x.method === 'POST')!.body;
    expect(made).toMatchObject({ title: 'بازبینی کمپین پاییز', roomId: 'r1', participantIds: ['u2'], approverId: 'm1', startsAt: '2026-10-20T07:30:00.000Z', endsAt: '2026-10-20T08:30:00.000Z' });
    expect(sent.find((x) => x.path === '/workflow/booking/b1/transitions')!.body).toEqual({ action: 'submit' });
  });

  it('lets a participant answer the invitation, and sends a new time back for approval', async () => {
    const B = {
      id: 'b1', code: 'BKG-000001', state: 'CONFIRMED', title: 'بازبینی کمپین پاییز', description: null, kind: 'INTERNAL',
      startsAt: '2026-10-20T07:30:00.000Z', endsAt: '2026-10-20T08:30:00.000Z', placeNote: null, organizerId: 'u9', approverId: 'm1',
      organizer: { id: 'u9', fullName: 'نیما فروزان' }, approver: { id: 'm1', fullName: 'سپیده آذر' }, room: ROOM, parking: null, parkingSpaces: 0,
      project: null, company: null, meeting: { id: 'mt1', code: 'MTG-000004' }, resources: [], guests: [{ id: 'g1', fullName: 'مهسا نوری', company: 'پگاه سبز', email: null, phone: null, isVip: true }],
      catering: [], decisionNote: null, cancelReason: null, editable: false,
      participants: [{ userId: 'u1', fullName: 'بهراد', response: 'PENDING' }],
      availableTransitions: [{ action: 'reschedule', labelFa: 'تغییر زمان', labelEn: 'Reschedule', requiresReason: true, to: 'PENDING_APPROVAL' }, { action: 'complete', labelFa: 'برگزار شد', labelEn: 'Mark as held', requiresReason: false, to: 'COMPLETED' }],
    };
    const sent = mount('/bookings/b1', (p) => {
      if (p === '/bookings/b1') return json(B);
      if (p === '/workflow/booking/b1/preflight') return json({ transitions: [] });
      if (p === '/bookings/availability') return json({ available: true, conflicts: [], freeRooms: [ROOM], suggestions: [] });
      return undefined;
    });
    const page = await screen.findByTestId('booking');
    expect(page.textContent).toContain('MTG-000004');
    expect(screen.getByTestId('booking-people').textContent).toContain('مهسا نوری');
    fireEvent.click(screen.getByRole('button', { name: 'می‌آیم' }));
    await waitFor(() => expect(sent.find((x) => x.path === '/bookings/b1/respond')?.body).toEqual({ response: 'ACCEPTED' }));

    // Rescheduling is its own dialog: a time and a reason, checked before it is sent.
    fireEvent.click(screen.getByRole('button', { name: 'تغییر زمان' }));
    await screen.findByTestId('booking-free');
    fireEvent.change(screen.getByRole('textbox', { name: 'دلیل' }), { target: { value: 'مشتری دیرتر می‌رسد' } });
    fireEvent.click(screen.getByRole('button', { name: 'فرستادن برای تأیید' }));
    await waitFor(() => expect(sent.find((x) => x.path === '/workflow/booking/b1/transitions')?.body).toMatchObject({
      action: 'reschedule', reason: 'مشتری دیرتر می‌رسد', payload: { startsAt: B.startsAt, endsAt: B.endsAt },
    }));
  });
});
