import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { OohJourney, reportPlan } from '../src/pages/OohJourney';

/**
 * The owner's «فرآیند محیطی» (2026-11-02): an out-of-home campaign carried out — the execution order to
 * the out-of-home unit, the display's dates and its reports, the artwork with who prepares it, the
 * client's approval, the files handed to the unit — each step a record the system already keeps.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 25, pageCount: 1 });
const move = (action: string, labelFa: string, requiresReason = false) => ({ action, labelFa, labelEn: action, requiresReason, to: 'X' });
const USER = {
  id: 'u-am', email: 'am@hiva.local', fullName: 'x', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [],
  permissions: ['project.read', 'project.authorize', 'workorder.read', 'workorder.issue', 'deliverable.read', 'deliverable.write', 'deliverable.deliver', 'document.read', 'document.write', 'task.write', 'qc.account'],
  locale: 'fa', mustChangePassword: false,
};
const C360 = {
  project: {
    id: 'pr-1', code: 'PRJ-1', name: 'کمپین بیلبورد بانک', state: 'ACTIVE', inScope: 'ده بیلبورد در تهران', objective: 'معرفی کارت', plannedStart: '2026-11-10T00:00:00.000Z', plannedEnd: '2026-12-01T00:00:00.000Z',
    proposalId: 'p-1', company: { id: 'co-1', legalName: 'بانک آینده‌سازان' }, accountOwner: { fullName: 'رضا شریفی' },
    authorizations: [{ basis: 'CONTRACT', referenceDocument: 'Q-12' }], proposal: { code: 'PRP-3', title: 'پروپوزال بیلبورد' },
  },
  availableTransitions: [],
};
const EXEC = { id: 'w-x', code: 'WO-000020', title: 'اجرای محیطی', state: 'ACCEPTED', targetDepartmentCode: 'ME', proposalId: null, owner: { id: 'u-me', fullName: 'حمید صابری' }, availableTransitions: [] };
const deliverable = (over: Record<string, unknown>) => ({ id: 'd', code: 'DLV-1', name: 'x', state: 'PLANNED', kind: null, departmentCode: 'ME', workOrderId: 'w-x', dueDate: null, description: null, availableTransitions: [], ...over });

function mount(api: (p: string, method: string) => unknown) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(USER);
    if (p.endsWith('/preflight')) return json({ state: 'x', transitions: [] });
    if (p === '/projects/pr-1/360') return json(C360);
    if (p === '/client-approvals') return json([]);
    const answer = api(p, method);
    if (answer !== undefined) return json(answer, method === 'POST' ? 201 : 200);
    if (p === '/documents') return json([]);
    return json(method === 'GET' ? page([]) : { id: 'new', code: 'NEW-1' }, method === 'GET' ? 200 : 201);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter initialEntries={['/projects/pr-1/ooh']}><Routes><Route path="/projects/:id/ooh" element={<OohJourney />} /></Routes></MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}
const posts = (sent: { method: string; path: string; body: any }[], path: string) => sent.filter((s) => s.method === 'POST' && s.path === path);

describe('The out-of-home journey', () => {
  it('plans a report at the start, one every so many days, and one at the end', () => {
    expect(reportPlan('2026-11-10', '2026-12-01', 7)).toEqual([
      { kind: 'OOH_START_REPORT', due: '2026-11-10' },
      { kind: 'OOH_PERIODIC_REPORT', due: '2026-11-17', n: 1 },
      { kind: 'OOH_PERIODIC_REPORT', due: '2026-11-24', n: 2 },
      { kind: 'OOH_END_REPORT', due: '2026-12-01' },
    ]);
    expect(reportPlan('2026-11-10', '2026-12-01', 0).map((r) => r.kind)).toEqual(['OOH_START_REPORT', 'OOH_END_REPORT']);
  });

  it('turns the display’s dates into its reports, each under the execution order', async () => {
    const sent = mount((p) => (p === '/work-orders' ? page([EXEC]) : undefined));
    const plan = await screen.findByTestId('ooh-report-plan');
    expect(plan.textContent).toContain('۴ گزارش ساخته می‌شود: شروع، ۲ دوره‌ای، پایان.');
    fireEvent.click(within(plan).getByRole('button', { name: 'ثبت زمان اکران و گزارش‌ها' }));
    await waitFor(() => expect(posts(sent, '/deliverables')).toHaveLength(4));
    expect(posts(sent, '/deliverables').map((s) => [s.body.kind, s.body.dueDate, s.body.workOrderId, s.body.departmentCode])).toEqual([
      ['OOH_START_REPORT', '2026-11-10', 'w-x', 'ME'], ['OOH_PERIODIC_REPORT', '2026-11-17', 'w-x', 'ME'],
      ['OOH_PERIODIC_REPORT', '2026-11-24', 'w-x', 'ME'], ['OOH_END_REPORT', '2026-12-01', 'w-x', 'ME'],
    ]);
  });

  it('asks who prepares the artwork; the client’s own files need no studio', async () => {
    const sent = mount((p) => (p === '/work-orders' ? page([EXEC]) : undefined));
    const chooser = await screen.findByTestId('ooh-preparer');
    fireEvent.click(within(chooser).getByRole('radio', { name: /خود مشتری/ }));
    fireEvent.change(within(chooser).getByLabelText('ابعاد سازه‌ها و توضیح'), { target: { value: 'سازهٔ ۱۲×۴ متر' } });
    fireEvent.click(within(chooser).getByRole('button', { name: 'ثبت' }));
    await waitFor(() => expect(posts(sent, '/deliverables')).toHaveLength(1));
    expect(posts(sent, '/deliverables')[0]!.body).toMatchObject({ kind: 'OOH_ARTWORK', departmentCode: 'A', description: 'سازهٔ ۱۲×۴ متر', projectId: 'pr-1' });
    // The studio is asked through its own order.
    fireEvent.click(within(chooser).getByRole('radio', { name: /آتلیهٔ هیوا/ }));
    fireEvent.click(within(chooser).getByRole('button', { name: 'نوشتن سفارش آتلیه' }));
    expect((within(chooser).getByLabelText('عنوان سفارش') as HTMLInputElement).value).toBe('ری‌سایز طرح اکران — کمپین بیلبورد بانک');
  });

  it('shows the studio’s order beside the artwork, to issue it', async () => {
    const studio = { id: 'w-cr', code: 'WO-000021', title: 'ری‌سایز طرح اکران', state: 'DRAFT', targetDepartmentCode: 'CR', proposalId: null, owner: { id: 'u-cr', fullName: 'سپیده آذر' }, availableTransitions: [move('issue', 'صدور سفارش'), move('cancel', 'لغو سفارش', true)] };
    mount((p) => {
      if (p === '/work-orders') return page([EXEC, studio]);
      if (p === '/deliverables') return page([deliverable({ id: 'd-art', kind: 'OOH_ARTWORK', name: 'طرح اکران', departmentCode: 'CR', workOrderId: 'w-cr' })]);
      return undefined;
    });
    const artwork = await screen.findByTestId('ooh-artwork');
    expect(artwork.textContent).toContain('آماده‌سازی یا ری‌سایز: آتلیهٔ هیوا');
    expect(within(artwork).getByRole('link', { name: 'ری‌سایز طرح اکران' }).getAttribute('href')).toBe('/work-orders/w-cr');
    expect(within(artwork).getByRole('button', { name: 'صدور سفارش' })).toBeTruthy();
    expect(within(artwork).queryByRole('button', { name: 'لغو سفارش' })).toBeNull();
  });

  it('hands the ready artwork to the out-of-home unit as a task on its order', async () => {
    const art = deliverable({ id: 'd-art', kind: 'OOH_ARTWORK', name: 'طرح اکران', departmentCode: 'A', workOrderId: null });
    const sent = mount((p) => {
      if (p === '/work-orders') return page([EXEC]);
      if (p === '/deliverables') return page([art]);
      if (p === '/documents') return [{ id: 'doc-1', fileName: 'billboard.pdf', mimeType: 'application/pdf' }];
      return undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: 'ارسال فایل‌ها برای واحد محیطی' }));
    await waitFor(() => expect(posts(sent, '/tasks')).toHaveLength(1));
    expect(posts(sent, '/tasks')[0]!.body).toMatchObject({ projectId: 'pr-1', workOrderId: 'w-x', deliverableId: 'd-art', departmentCode: 'ME', assigneeId: 'u-me', sourceType: 'ORDER_FORM', sourceRef: 'WO-000020' });
  });

  it('sends a delivered report for the client’s approval, with what the client may answer', async () => {
    mount((p) => {
      if (p === '/work-orders') return page([EXEC]);
      if (p === '/deliverables') return page([deliverable({ id: 'd-s', kind: 'OOH_START_REPORT', name: 'گزارش شروع اکران', state: 'DELIVERED', availableTransitions: [move('client_accept', 'تأیید مشتری'), move('client_reject', 'عدم تأیید مشتری', true)] })]);
      return undefined;
    });
    const report = await screen.findByTestId('ooh-report');
    expect(await within(report).findByRole('button', { name: 'درخواست تأیید از مشتری' })).toBeTruthy();
    expect(within(report).getByRole('button', { name: 'تأیید مشتری' })).toBeTruthy();
    expect(within(report).getByRole('button', { name: 'عدم تأیید مشتری' })).toBeTruthy();
  });
});
