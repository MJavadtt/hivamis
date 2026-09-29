import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: () => true, user: { id: 'u1' } }) }));
vi.mock('../src/components/ui', async (orig) => ({ ...(await orig<object>()), useToast: () => () => {} }));
import { CalendarStep, ImportPanel, SlaStep, UnitMapStep } from '../src/components/Onboarding';
import Activate from '../src/pages/Activate';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
let sent: { url: string; method: string; body: any }[] = [];
const serve = (gets: Record<string, unknown>, posts: Record<string, unknown> = {}) => {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== 'GET') {
      sent.push({ url, method: init.method, body: init.body instanceof FormData ? 'file' : init.body ? JSON.parse(String(init.body)) : null });
      const hit = Object.keys(posts).sort((a, b) => b.length - a.length).find((k) => url.includes(k));
      return hit ? json(posts[hit]) : json({});
    }
    const hit = Object.keys(gets).sort((a, b) => b.length - a.length).find((k) => url.includes(k));
    return hit ? json(gets[hit]) : json({ error: { code: 'NOT_FOUND', message: 'این پیوند معتبر نیست؛ از مدیر سیستم پیوند تازه بخواهید.' } }, 404);
  }));
};
const pick = (testId: string, name = 'people.xlsx') =>
  fireEvent.change(screen.getByTestId(testId), { target: { files: [new File(['x'], name)] } });
beforeEach(() => { sent = []; });

const preview = {
  kind: 'users', header: { missing: [], unknown: ['ستون اضافه'] },
  rows: [
    { line: 2, label: 'نیلوفر احمدی', status: 'CREATE', issues: [], notes: [] },
    { line: 3, label: 'طراح موجود', status: 'SKIP', issues: [], notes: ['این ایمیل پیش‌تر در سامانه هست؛ دست نخورد'] },
    { line: 4, label: 'بی‌ایمیل', status: 'INVALID', issues: ['ایمیل «x» درست نیست'], notes: [] },
  ],
  summary: { create: 1, skip: 1, invalid: 1 },
};

describe('An import, previewed before anything is written', () => {
  it('shows every row with its reasons, writes the valid ones, and shows each link once', async () => {
    serve({ '/onboarding/columns/users': [{ key: 'email', labelFa: 'ایمیل', required: true, hintFa: 'ایمیل سازمانی' }] }, {
      '/onboarding/import/users/preview': preview,
      '/onboarding/import/users/commit': {
        preview, created: [{ line: 2, label: 'نیلوفر احمدی' }], failed: [],
        activations: [{ line: 2, label: 'نیلوفر احمدی', email: 'niloofar@acme.ir', url: 'http://localhost/activate/abc', emailed: false, expiresAt: '2026-10-06T00:00:00Z' }],
      },
    });
    wrap(<ImportPanel kind="users" />);
    await screen.findByText('ستون‌ها و طرز پر کردن هرکدام');
    pick('file-users');
    expect((await screen.findByTestId('summary-users')).textContent).toBe('۱ ساخته می‌شود · ۱ از قبل هست · ۱ مشکل دارد');
    const rows = screen.getByTestId('rows-users').textContent!;
    expect(rows).toContain('ایمیل «x» درست نیست');
    expect(rows).toContain('این ایمیل پیش‌تر در سامانه هست');
    expect(screen.getByText(/ستون‌هایی که شناخته نشد/).textContent).toContain('ستون اضافه');
    fireEvent.click(screen.getByText(/ساختن ۱ مورد/));
    const links = await screen.findByTestId('activation-links');
    expect(links.textContent).toContain('http://localhost/activate/abc');
    expect(links.textContent).toContain('فقط همین یک بار');
    expect(sent.map((s) => s.url.split('/api/v1')[1])).toEqual(['/onboarding/import/users/preview', '/onboarding/import/users/commit']);
  });
});

describe('The steps around the imports', () => {
  it('reads unit names from the users file, fills in suggestions, and saves only what a person confirms', async () => {
    serve({ '/onboarding/units': { departments: [{ code: 'CR', nameFa: 'خلاقیت' }, { code: 'DM', nameFa: 'دیجیتال مارکتینگ' }], map: {} } }, {
      '/onboarding/units/scan': [
        { name: 'استودیو طراحی', people: 2, resolved: null, suggestion: 'CR' },
        { name: 'CR', people: 1, resolved: 'CR', suggestion: 'CR' },
        { name: 'آبدارخانه', people: 1, resolved: null, suggestion: null },
      ],
    });
    wrap(<UnitMapStep />);
    await screen.findByTestId('unit-map');
    pick('file-units');
    await waitFor(() => expect((screen.getByLabelText('واحد Doc_H برای استودیو طراحی') as HTMLSelectElement).value).toBe('CR'));
    expect((screen.getByLabelText('واحد Doc_H برای آبدارخانه') as HTMLSelectElement).value).toBe('');
    expect(screen.getByTestId('unit-map').textContent).toContain('خودبه‌خود شناخته شد: CR ← CR');
    expect(sent.filter((s) => s.method === 'PUT')).toEqual([]);                 // nothing saved yet
    fireEvent.change(screen.getByLabelText('واحد Doc_H برای آبدارخانه'), { target: { value: 'DM' } });
    fireEvent.click(screen.getByText('ذخیره و تأیید'));
    await waitFor(() => expect(sent.find((s) => s.method === 'PUT')?.body).toEqual({ map: { 'استودیو طراحی': 'CR', 'آبدارخانه': 'DM' } }));
    await waitFor(() => expect(sent.at(-1)?.url).toContain('/onboarding/confirm/units'));
  });

  it('edits the working week and the SLA hours, and confirms each', async () => {
    serve({
      '/organization': { workingDays: [6, 0, 1, 2, 3], workStartHour: 9, workEndHour: 18, breakHours: 1, holidays: [] },
      '/onboarding/columns/holidays': [],
      '/sla-policies': [{ id: 's1', code: 'SLA_TASK_ACCEPTANCE', labelFa: 'پذیرش وظیفه', hours: '4', warnAt: '0.75', docRef: 'Doc_H §11', isActive: true }],
    });
    wrap(<><CalendarStep /><SlaStep /></>);
    fireEvent.click(await screen.findByLabelText('روز کاری پ'));
    fireEvent.change(screen.getByLabelText('پایان'), { target: { value: '17' } });
    fireEvent.click(screen.getAllByText('درست است؛ تأیید')[0]!);
    await waitFor(() => expect(sent.find((s) => s.method === 'PATCH')).toMatchObject({ url: expect.stringContaining('/organization'), body: { workingDays: [6, 0, 1, 2, 3, 4], workStartHour: 9, workEndHour: 17, breakHours: 1 } }));
    fireEvent.change(await screen.findByLabelText('ساعت پذیرش وظیفه'), { target: { value: '6' } });
    fireEvent.click(screen.getAllByText('درست است؛ تأیید')[1]!);
    await waitFor(() => expect(sent.find((s) => s.url.includes('/sla-policies/SLA_TASK_ACCEPTANCE'))?.body).toEqual({ hours: 6 }));
    await waitFor(() => expect(sent.map((s) => s.url)).toEqual(expect.arrayContaining([expect.stringContaining('/onboarding/confirm/calendar'), expect.stringContaining('/onboarding/confirm/sla')])));
  });
});

describe('The first password', () => {
  it('names the person, holds a weak or mismatched password back, and sets a good one', async () => {
    serve({ '/auth/activation/tok123': { fullName: 'نیلوفر احمدی', email: 'niloofar@acme.ir', expiresAt: '2026-10-06T00:00:00Z' } }, { '/auth/activation/tok123': { email: 'niloofar@acme.ir' } });
    wrap(<Activate token="tok123" />);
    expect((await screen.findByTestId('activate')).textContent).toContain('نیلوفر احمدی عزیز');
    const submit = () => screen.getByText('گذاشتن رمز').closest('button') as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('رمز عبور'), { target: { value: 'short' } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('رمز عبور'), { target: { value: 'Niloofar-Hiva-2026' } });
    fireEvent.change(screen.getByLabelText('تکرار رمز عبور'), { target: { value: 'Niloofar-Hiva-2025' } });
    expect(screen.getByText('دو رمز یکی نیستند.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('تکرار رمز عبور'), { target: { value: 'Niloofar-Hiva-2026' } });
    fireEvent.click(submit());
    expect(await screen.findByText(/رمز شما گذاشته شد/)).toBeTruthy();
    expect(sent[0]).toMatchObject({ method: 'POST', body: { password: 'Niloofar-Hiva-2026' } });
  });

  it('says so when the link is no good', async () => {
    serve({});
    wrap(<Activate token="nope-nope-nope-nope-nope" />);
    expect(await screen.findByText(/این پیوند معتبر نیست/)).toBeTruthy();
    expect(screen.queryByLabelText('رمز عبور')).toBeNull();
  });
});
