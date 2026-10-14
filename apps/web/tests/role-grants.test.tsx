import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '@hiva/contracts';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { RoleGrants } from '../src/components/RoleGrants';

/**
 * Who may do what (Hivamis task 6): the full-access roles are fixed; every other role is what the
 * administrator ticks — saved as their grant, with a note.
 */
const ROLES = [
  { id: 'r1', code: 'CEO', nameFa: 'مدیرعامل', nameEn: 'CEO', userCount: 1, fullAccess: true, permissions: ALL_PERMISSIONS, defaults: ALL_PERMISSIONS, differsFromDefault: false, review: null },
  { id: 'r2', code: 'SALES_REP', nameFa: 'کارشناس فروش', nameEn: 'Sales rep', userCount: 3, fullAccess: false, permissions: ROLE_PERMISSIONS.SALES_REP, defaults: ROLE_PERMISSIONS.SALES_REP, differsFromDefault: false, review: null },
  { id: 'r3', code: 'VIEWER', nameFa: 'مشاهده‌گر', nameEn: 'Viewer', userCount: 0, fullAccess: false, permissions: ['report.read'], defaults: ROLE_PERMISSIONS.VIEWER, differsFromDefault: true,
    review: { at: '2026-10-02T08:00:00.000Z', note: 'فقط گزارش', grantedBy: { id: 'u0', fullName: 'مدیر سیستم' } } },
];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function mount(permissions: string[], roles: string[] = []) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    sent.push({ method: init?.method ?? 'GET', path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json({ id: 'u', email: 'a@hiva.local', fullName: 'مدیر', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles, permissions, locale: 'fa', mustChangePassword: false });
    if (p === '/roles') return json(ROLES);
    if (p.endsWith('/permissions')) return json({ added: ['report.executive'], removed: ['crm.lead.convert'] });
    return json([]);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter><RoleGrants /></MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

const roleButton = (name: RegExp) => screen.findByRole('option', { name });

describe('Who may do what', () => {
  it('says which roles hold everything, which the administrator approved, and which nobody has reviewed', async () => {
    mount(['admin.roles']);
    expect((await roleButton(/مدیرعامل/)).textContent).toContain('دسترسی کامل');
    expect((await roleButton(/کارشناس فروش/)).textContent).toContain('پیش‌فرض — بازبینی نشده');
    expect((await roleButton(/مشاهده‌گر/)).textContent).toContain('تأیید مدیر سیستم');
  });

  // Audit F-5: reading others' conversations is given by the system administrator, and only by them.
  it('leaves oversight to the system administrator: off for anyone else, and never in "all"', async () => {
    mount(['admin.roles']);
    fireEvent.click(await roleButton(/کارشناس فروش/));
    const box = await screen.findByLabelText('بازبینی گفت‌وگوها (با ثبت دلیل در سابقهٔ حسابرسی)') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/فقط مدیر سیستم آن را می‌دهد/)).toBeDefined();
    const group = box.closest('fieldset')!;
    fireEvent.click(within(group).getByRole('button', { name: 'همه' }));
    expect(box.checked).toBe(false);
    expect((within(group).getByLabelText('گفت‌وگو با همکاران') as HTMLInputElement).checked).toBe(true);
  });

  it('lets the system administrator give oversight', async () => {
    mount(['admin.roles'], ['SUPER_ADMIN']);
    fireEvent.click(await roleButton(/کارشناس فروش/));
    expect((await screen.findByLabelText('بازبینی گفت‌وگوها (با ثبت دلیل در سابقهٔ حسابرسی)') as HTMLInputElement).disabled).toBe(false);
  });

  it('keeps a full-access role fixed', async () => {
    mount(['admin.roles']);
    fireEvent.click(await roleButton(/مدیرعامل/));
    const box = await screen.findByLabelText('تبدیل سرنخ به فرصت فروش');
    expect((box as HTMLInputElement).checked).toBe(true);
    expect((box as HTMLInputElement).matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /تأیید|ذخیره/ })).toBeNull();
  });

  it('saves exactly what the administrator ticked, with a note, as their grant', async () => {
    const sent = mount(['admin.roles']);
    fireEvent.click(await roleButton(/کارشناس فروش/));
    fireEvent.click(await screen.findByLabelText('تبدیل سرنخ به فرصت فروش'));
    fireEvent.click(screen.getByLabelText('داشبورد مدیریتی'));
    expect(screen.getByTestId('grant-changes').textContent).toBe('۱ افزوده، ۱ برداشته');
    fireEvent.change(screen.getByLabelText('یادداشت'), { target: { value: 'تبدیل با مدیر فروش' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره و تأیید' }));
    await waitFor(() => expect(sent.find((s) => s.method === 'PUT')).toBeTruthy());
    const put = sent.find((s) => s.method === 'PUT')!;
    expect(put.path).toBe('/roles/SALES_REP/permissions');
    expect(put.body.note).toBe('تبدیل با مدیر فروش');
    expect(put.body.permissions).toContain('report.executive');
    expect(put.body.permissions).not.toContain('crm.lead.convert');
  });

  it('puts a changed role back to its default in one click', async () => {
    mount(['admin.roles']);
    fireEvent.click(await roleButton(/مشاهده‌گر/));
    expect(screen.getByTestId('grant-changes').textContent).toBe('بدون تغییر');
    fireEvent.click(screen.getByRole('button', { name: 'پیش‌فرض Doc_H' }));
    expect(screen.getByTestId('grant-changes').textContent).toMatch(/افزوده/);
  });

  it('shows the matrix read-only to someone who may read the audit but not grant', async () => {
    mount(['admin.audit']);
    fireEvent.click(await roleButton(/کارشناس فروش/));
    const card = (await screen.findByLabelText('تبدیل سرنخ به فرصت فروش')).closest('fieldset')!;
    expect(card.disabled).toBe(true);
    expect(within(screen.getByTestId('role-grants')).queryByRole('button', { name: /تأیید|ذخیره/ })).toBeNull();
  });
});
