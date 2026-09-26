import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));
import PortalApp from '../src/pages/Portal';
import { PortalUsersCard } from '../src/components/PortalAdmin';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const home = {
  me: { name: 'مریم احمدی', email: 'maryam@portalia.example', company: 'پورتالیا' },
  projects: [{ id: 'p1', code: 'PRJ-000031', name: 'کمپین پاییزی', stateFa: 'در حال اجرا', plannedStart: null, plannedEnd: '2026-12-01T00:00:00Z', milestones: { done: 1, total: 2 } }],
  approvals: [{ id: 'a1', code: 'CA-000004', subjectType: 'DELIVERABLE', title: 'تیزر ۳۰ ثانیه', expiresAt: '2026-10-10T00:00:00Z', forMe: true }],
  invoices: [{ id: 'i1', number: 'F-1405-12', issueDate: '2026-09-01T00:00:00Z', dueDate: null, total: '1100000000', paidAmount: '0', state: 'SENT', currency: 'IRR', originalTotal: null }],
};
const project = {
  project: { id: 'p1', code: 'PRJ-000031', name: 'کمپین پاییزی', objective: 'افزایش آگاهی از برند', stateFa: 'در حال اجرا', plannedStart: null, plannedEnd: null },
  milestones: [{ id: 'm1', name: 'راه‌اندازی', description: null, dueDate: '2026-09-01T00:00:00Z', completedAt: '2026-09-02T00:00:00Z' }],
  deliverables: [
    { id: 'd1', code: 'DLV-1', name: 'تیزر ۳۰ ثانیه', version: 'v2', clientState: 'DELIVERED', dueDate: null, deliveredAt: '2026-09-20T00:00:00Z' },
    { id: 'd2', code: 'DLV-2', name: 'پوستر', version: 'v1', clientState: 'IN_PROGRESS', dueDate: null, deliveredAt: null },
  ],
  reports: [], documents: [{ id: 'f1', fileName: 'media-plan.pdf', sizeBytes: 4096, createdAt: '2026-09-21T00:00:00Z' }],
  approvals: [{ id: 'a1', code: 'CA-000004', subjectId: 'd1', status: 'PENDING', forMe: true, contactName: 'مریم احمدی', decidedAt: null }],
  messages: [{ id: 'x1', body: 'بله، از شنبه.', createdAt: '2026-09-22T08:00:00Z', fromClient: false, author: 'رضا شریفی' }],
};

beforeEach(() => sessionStorage.clear());

describe('The client portal', () => {
  it('signs in, keeps the token for the tab, and opens on what waits for the client', async () => {
    const calls: { url: string; auth: string | null; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: (init?.headers as any)?.authorization ?? null, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/portal/auth/login')) return json({ token: 'PT' });
      return json(home);
    }));
    render(<MemoryRouter initialEntries={['/portal']}><PortalApp /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('ایمیل'), { target: { value: 'maryam@portalia.example' } });
    fireEvent.change(screen.getByLabelText('رمز عبور'), { target: { value: 'Portal-Client-2026' } });
    fireEvent.click(screen.getByText('ورود'));
    expect((await screen.findByTestId('portal-approvals')).textContent).toContain('تیزر ۳۰ ثانیه');
    expect(sessionStorage.getItem('hiva.portal')).toBe('PT');
    expect(calls.find((c) => c.url.endsWith('/portal/home'))!.auth).toBe('Bearer PT');
    expect(screen.getByTestId('portal-projects').textContent).toContain('نقطه‌های عطف: ۱ از ۲');
    expect(screen.getByTestId('portal-invoices').textContent).toContain('F-1405-12');
  });

  it('shows a project as the client reads it, and sends a message to Account', async () => {
    sessionStorage.setItem('hiva.portal', 'PT');
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push({ url: String(input), body: JSON.parse(String(init.body)) }); return json({}, 201); }
      return json(project);
    }));
    render(<MemoryRouter initialEntries={['/portal/projects/p1']}><PortalApp /></MemoryRouter>);
    const deliverables = await screen.findByTestId('portal-deliverables');
    expect(deliverables.textContent).toContain('تحویل شده — منتظر نظر شما');
    expect(deliverables.textContent).toContain('در حال تهیه');
    expect(deliverables.textContent).toContain('بررسی و تصمیم');
    expect(screen.getByTestId('portal-documents').textContent).toContain('media-plan.pdf');
    expect(screen.getByTestId('portal-messages').textContent).toContain('رضا شریفی');
    fireEvent.change(screen.getByLabelText('پیام شما'), { target: { value: 'زمان پخش قطعی شد؟' } });
    fireEvent.click(screen.getByText('فرستادن'));
    await waitFor(() => expect(posts).toEqual([{ url: expect.stringContaining('/portal/projects/p1/messages'), body: { body: 'زمان پخش قطعی شد؟' } }]));
  });

  it('sends a signed-out visitor to sign in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(home)));
    render(<MemoryRouter initialEntries={['/portal/projects/p1']}><PortalApp /></MemoryRouter>);
    expect(await screen.findByText('ورود به پورتال مشتری')).toBeTruthy();
  });
});

describe('Account’s side', () => {
  it('invites a contact with an address and shows the link once when mail is off', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return json({ user: {}, link: 'http://localhost:5173/portal/invite/abc' }, 201); }
      return json([{ id: 'u1', contactId: 'c1', email: 'ali@portalia.example', status: 'ACTIVE', lastLoginAt: '2026-09-25T08:00:00Z', createdAt: '2026-09-20T08:00:00Z', contact: { fullName: 'علی رضایی' } }]);
    }));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PortalUsersCard companyId="co" contacts={[{ id: 'c1', fullName: 'علی رضایی', email: 'ali@portalia.example' }, { id: 'c2', fullName: 'مریم احمدی', email: 'maryam@portalia.example' }, { id: 'c3', fullName: 'بی‌ایمیل', email: null }]} />
    </QueryClientProvider>);
    const card = await screen.findByTestId('portal-users');
    expect(card.textContent).toContain('فعال');
    const select = screen.getByLabelText('مخاطب برای دعوت') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['c2']);          // not the one already in, not the one without email
    fireEvent.click(screen.getByText('دعوت به پورتال'));
    expect((await screen.findByTestId('portal-invite-link')).textContent).toContain('/portal/invite/abc');
    expect(posts).toEqual([{ contactId: 'c2' }]);
  });
});
