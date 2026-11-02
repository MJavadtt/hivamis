import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import Home from '../src/pages/Home';

/**
 * The first page (the owner's brief, 2026-11-02): what is yours today and what is coming, in plain
 * words — not figures. Read from the same routes as the rest of the app.
 */
const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
const ME = { id: 'u1', email: 'x@hiva.local', fullName: 'نگار حیدری', jobTitle: '', locale: 'fa', mustChangePassword: false, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: ['task.read', 'meeting.book'] };
const WORK = {
  items: [
    { kind: 'task', entityType: 'task', entityId: 't-back', code: 'TSK-1', title: 'لوگوی کمپین', state: 'REVISION_REQUIRED', projectCode: null, projectName: 'کمپین پاییز', dueAt: null, href: '/tasks/t-back', sla: null, availableTransitions: [] },
    { kind: 'task', entityType: 'task', entityId: 't-next', code: 'TSK-2', title: 'پست اینستاگرام', state: 'IN_PROGRESS', projectCode: null, projectName: null, dueAt: '2026-12-20T00:00:00.000Z', href: '/tasks/t-next', sla: null,
      availableTransitions: [{ action: 'submit', labelFa: 'تحویل خروجی', labelEn: 'Submit output', requiresReason: false, to: 'SUBMITTED' }] },
  ],
};

function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }

function mount() {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    sent.push({ method: init?.method ?? 'GET', path: p });
    if (p === '/auth/refresh') return json({ accessToken: 't' });
    if (p === '/auth/me') return json(ME);
    if (p === '/me/work') return json(WORK);
    if (p === '/notifications') return json({ unread: 1, items: [{ id: 'n1', kind: 'BOOKING_INVITED', title: 'دعوت به جلسه: بازبینی کمپین', body: null, entityType: 'booking', entityId: 'b1', severity: 'INFO', readAt: null, createdAt: new Date().toISOString() }] });
    if (p === '/reports/my-dashboard') return json({ projects: [{ id: 'p1', code: 'PRJ-1', name: 'کمپین پاییز', state: 'ACTIVE', healthStatus: 'AMBER', plannedEnd: null, company: { legalName: 'بانک نمونه' } }] });
    if (p === '/bookings') return json({ items: [{ id: 'b1', code: 'BKG-1', title: 'بازبینی کمپین', state: 'CONFIRMED', startsAt: soon, placeNote: null, room: { name: 'اتاق دماوند' } }], total: 1, page: 1, pageSize: 20 });
    if (p === '/tasks') return json({ items: [{ id: 't9', title: 'بروشور', closedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), project: { name: 'کمپین پاییز' } }], total: 1, page: 1, pageSize: 20 });
    if (p.endsWith('/history')) return json([]);
    if (p.endsWith('/preflight')) return json({ transitions: [] });
    return json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter><Home /></MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

describe('The workspace', () => {
  it('says what is yours today, what came back and what is next', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('today').textContent).toBe('۲ کار با شماست، ۱ کار برای اصلاح برگشته.'));
    expect(screen.getByRole('region', { name: 'برگشت برای اصلاح' }).textContent).toContain('لوگوی کمپین');
    const next = screen.getByRole('region', { name: 'کارهای بعدی' });
    expect(within(next).getByRole('button', { name: 'تحویل خروجی' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /همهٔ کارهای من/ }).getAttribute('href')).toBe('/my-work');
  });

  it('shows the meetings ahead, the projects in plain words, and what was just finished', async () => {
    mount();
    expect((await screen.findByRole('link', { name: /بازبینی کمپین.*اتاق دماوند/ })).getAttribute('href')).toBe('/bookings/b1');
    const project = await screen.findByTestId('home-project');
    expect(project.textContent).toContain('در حال انجام');
    expect(project.textContent).toContain('نیازمند توجه');
    expect((await screen.findByText('بروشور')).closest('a')?.getAttribute('href')).toBe('/tasks/t9');
    expect(screen.getByRole('link', { name: 'نمای آماری من' }).getAttribute('href')).toBe('/overview');
  });

  it('opens a notification’s record, and marks it read', async () => {
    const sent = mount();
    const notice = await screen.findByTestId('notice');
    expect(notice.getAttribute('href')).toBe('/bookings/b1');
    fireEvent.click(notice);
    await waitFor(() => expect(sent.some((x) => x.method === 'POST' && x.path === '/notifications/n1/read')).toBe(true));
  });
});
