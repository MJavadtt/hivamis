import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { WorkflowActions } from '../src/components/common';
import { QuickCreateButton, RECORD_KINDS, fieldsOf } from '../src/components/QuickCreate';
import { createProjectSchema, createTaskSchema } from '@hiva/contracts';

/**
 * The owner's instruction (2026-10-28) on the page: the system administrator sees what a move lacks but
 * is not stopped by it, can put a record into any state directly, and makes a project without its steps.
 * Nobody else is offered either.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (roles: string[]) => ({ id: 'u1', email: 'a@hiva.local', fullName: 'مدیر', jobTitle: null, locale: 'fa', mustChangePassword: false, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles, permissions: ['project.read', 'project.write', 'project.execute'] });

function mount(roles: string[], ui: JSX.Element) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't' });
    if (p === '/auth/me') return json(me(roles));
    if (p.endsWith('/preflight')) return json({ transitions: [{ action: 'activate', ready: false, permitted: true, checks: [{ guard: 'project.hasRaci', labelFa: 'RACI ثبت شده باشد', ok: false, messageFa: 'RACI ثبت نشده است.' }] }] });
    if (p.endsWith('/force')) return json({ fromState: 'PLANNING', toState: 'ACTIVE', action: 'admin_force' });
    if (p === '/companies') return json({ items: [{ id: 'c1', legalName: 'شرکت نمونه', brandName: null }], total: 1, page: 1, pageSize: 200, pageCount: 1 });
    if (p === '/people') return json([{ id: 'u2', fullName: 'رضا شریفی', jobTitle: null }]);
    if (p === '/projects' && method === 'POST') return json({ id: 'np1' }, 201);
    return json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter>{ui}</MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

const MOVES = [{ action: 'activate', labelFa: 'شروع اجرای پروژه', labelEn: 'Activate project', requiresReason: false, to: 'ACTIVE' }];

beforeEach(() => localStorage.clear());

describe('The system administrator above the process', () => {
  it('says what a move lacks, and offers any state directly', async () => {
    const sent = mount(['SUPER_ADMIN'], <WorkflowActions entity="project" id="p1" transitions={MOVES} />);
    expect(await screen.findByText(/شما مدیر سیستم هستید/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'تغییر مستقیم وضعیت' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('وضعیت تازه'), { target: { value: 'ACTIVE' } });
    fireEvent.click(dialog.getByRole('button', { name: 'تغییر وضعیت' }));
    await waitFor(() => expect(sent.some((s) => s.path === '/workflow/project/p1/force')).toBe(true));
    expect(sent.find((s) => s.path === '/workflow/project/p1/force')!.body).toEqual({ toState: 'ACTIVE' });
  });

  it('offers neither to anyone else', async () => {
    mount(['CEO'], <><WorkflowActions entity="project" id="p1" transitions={MOVES} /><QuickCreateButton path="/projects" /></>);
    expect(await screen.findByRole('button', { name: /شروع اجرای پروژه/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'تغییر مستقیم وضعیت' })).toBeNull();
    expect(screen.queryByRole('button', { name: /پروژه تازه/ })).toBeNull();
  });

  it('adds a record of any kind directly, from the kind’s own create schema', async () => {
    const sent = mount(['SUPER_ADMIN'], <QuickCreateButton path="/projects" />);
    fireEvent.click(await screen.findByRole('button', { name: 'پروژه تازه' }));
    const dialog = within(await screen.findByRole('dialog'));
    const save = dialog.getByRole('button', { name: 'ساختن' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/^نام/), { target: { value: 'پروژهٔ مستقیم' } });
    await waitFor(() => expect(dialog.getByRole('option', { name: 'شرکت نمونه' })).toBeTruthy());
    fireEvent.change(dialog.getByLabelText('مشتری'), { target: { value: 'c1' } });
    await waitFor(() => expect(dialog.getByRole('option', { name: 'رضا شریفی' })).toBeTruthy());
    fireEvent.change(dialog.getByLabelText('مالک اکانت'), { target: { value: 'u2' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(sent.some((x) => x.path === '/projects' && x.method === 'POST')).toBe(true));
    expect(sent.find((x) => x.path === '/projects' && x.method === 'POST')!.body).toEqual({ name: 'پروژهٔ مستقیم', companyId: 'c1', accountOwnerId: 'u2' });
  });
});

describe('Every kind, read from its schema', () => {
  it('knows what each kind requires and what its fields point at', () => {
    expect(RECORD_KINDS.length).toBeGreaterThanOrEqual(19);
    const project = fieldsOf(createProjectSchema);
    expect(project.filter((f) => f.required).map((f) => f.key).sort()).toEqual(['accountOwnerId', 'companyId', 'name']);
    expect(project.find((f) => f.key === 'companyId')!.kind).toBe('record');
    expect(project.find((f) => f.key === 'accountOwnerId')!.kind).toBe('person');
    expect(project.find((f) => f.key === 'plannedStart')!.kind).toBe('date');
    const task = fieldsOf(createTaskSchema);
    expect(task.find((f) => f.key === 'departmentCode')!.kind).toBe('enum');
    expect(task.find((f) => f.key === 'estimateHours')!.kind).toBe('number');
  });
});
