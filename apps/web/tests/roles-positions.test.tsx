import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_PERMISSIONS } from '@hiva/contracts';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { RoleGrants } from '../src/components/RoleGrants';
import { UserEditor } from '../src/components/UserEditor';

/**
 * Audit F-3: roles the administrator makes, copies, edits and deletes — told what still names a
 * role it cannot delete — and positions whose usual roles are offered, never granted unseen.
 */

const ROLES = [
  { id: 'r2', code: 'UNIT_MANAGER', nameFa: 'مدیر واحد', nameEn: 'Unit manager', userCount: 4, fullAccess: false, custom: false, color: null, description: null, permissions: ROLE_PERMISSIONS.UNIT_MANAGER, defaults: ROLE_PERMISSIONS.UNIT_MANAGER, differsFromDefault: false, review: null },
  { id: 'r9', code: 'C_K3P9QZ2A', nameFa: 'خلاقه', nameEn: 'Creative lead', userCount: 1, fullAccess: false, custom: true, color: '#7a69f2', description: 'سرپرستی تیم خلاقه', permissions: ['project.read'], defaults: [], differsFromDefault: true,
    review: { at: '2026-10-12T08:00:00.000Z', note: null, grantedBy: { id: 'u0', fullName: 'مدیر سیستم' } } },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mount(ui: React.ReactNode, extra: (path: string, method: string) => Response | null = () => null) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answered = extra(p, method);
    if (answered) return answered;
    if (p === '/auth/refresh') return json({ accessToken: 't' });
    if (p === '/auth/me') return json({ id: 'u', email: 'a@hiva.local', fullName: 'مدیر', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: ['admin.roles', 'admin.users'], locale: 'fa', mustChangePassword: false });
    if (p === '/roles') return json(ROLES);
    // The organisation's units and teams (list 3, item 6), which the user editor offers.
    if (p === '/departments' || p === '/teams') return json([]);
    if (p === '/positions') return json([{ id: 'p1', nameFa: 'طراح ارشد', nameEn: '', departmentCode: 'CR', defaultRoleCodes: ['C_K3P9QZ2A'], archived: false, holders: 2 }]);
    return json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter>{ui}</MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe('Roles the organisation makes', () => {
  it('makes a role as a copy of the one selected', async () => {
    const sent = mount(<RoleGrants />, (p, m) => (p === '/roles' && m === 'POST' ? json({ code: 'C_NEWROLE1', nameFa: 'خلاقیت ارشد' }, 201) : null));
    fireEvent.click(await screen.findByTestId('new-role'));
    const form = await screen.findByTestId('role-form');
    fireEvent.change(within(form).getAllByRole('textbox')[0]!, { target: { value: 'خلاقیت ارشد' } });
    fireEvent.click(within(form).getByRole('button', { name: 'ساختن' }));
    await waitFor(() => expect(sent.find((s) => s.method === 'POST' && s.path === '/roles')?.body).toMatchObject({ nameFa: 'خلاقیت ارشد', copyFrom: 'UNIT_MANAGER', color: '#7a69f2' }));
  });

  it('edits and deletes only its own roles — and says what still names one it cannot delete', async () => {
    mount(<RoleGrants />, (p, m) => (p === '/roles/C_K3P9QZ2A' && m === 'DELETE'
      ? json({ error: { code: 'ROLE_IN_USE', message: 'این نقش هنوز به کار رفته است.', details: { holders: 1, delegations: 0, forms: 2, pendingSubmissions: 0, rules: 0 } } }, 409)
      : null));
    // The code's role: no edit, no delete.
    fireEvent.click(await screen.findByRole('option', { name: /مدیر واحد/ }));
    expect(screen.queryByRole('button', { name: 'حذف' })).toBeNull();
    // Its own: both, and its description.
    fireEvent.click(screen.getByRole('option', { name: /خلاقه/ }));
    expect(await screen.findByText('سرپرستی تیم خلاقه')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'حذف' }));
    fireEvent.click(within(await screen.findByTestId('delete-role')).getByRole('button', { name: 'حذف' }));
    const refs = await screen.findByTestId('role-references');
    expect(refs.textContent).toContain('۱ نفر این نقش را دارند');
    expect(refs.textContent).toContain('۲ فرم آن را تأییدکننده می‌داند');
    expect(refs.textContent).not.toContain('تفویض');
  });
});

describe('A person’s position and roles', () => {
  it('offers a position’s usual roles when it is chosen, and saves position and roles together', async () => {
    const onSaved = vi.fn(async () => undefined);
    const sent = mount(<UserEditor user={{ id: 'u7', fullName: 'بهراد مهرنیا', department: { code: 'CR' }, positionId: null, roles: [{ role: { code: 'UNIT_MANAGER' } }] }} onClose={() => undefined} onSaved={onSaved} />);
    const editor = await screen.findByTestId('user-editor');
    await waitFor(() => expect(within(editor).getByRole('option', { name: 'طراح ارشد' })).toBeTruthy());
    expect((within(editor).getByLabelText('خلاقه') as HTMLInputElement).checked).toBe(false);
    fireEvent.change(within(editor).getByLabelText('سمت'), { target: { value: 'p1' } });
    expect((within(editor).getByLabelText('خلاقه') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent.find((s) => s.method === 'PATCH' && s.path === '/users/u7')?.body).toMatchObject({ positionId: 'p1', roleCodes: ['UNIT_MANAGER', 'C_K3P9QZ2A'], departmentCode: 'CR' });
  });
});
