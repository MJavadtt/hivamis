import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { Units } from '../src/components/Units';
import { UserEditor } from '../src/components/UserEditor';

/**
 * List 3, item 6 on the page: the administrator renames a unit, chooses its manager from its own
 * people, divides it into teams, and puts a person in one of their own unit's teams.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const UNITS = [
  { id: 'd1', code: 'CR', nameFa: 'خلاقیت', nameEn: 'Creative', color: '#9333ea', tagColor: null, managerId: 'u2', manager: { id: 'u2', fullName: 'سپیده آذر' }, namesOwned: false, _count: { users: 3 } },
  { id: 'd2', code: 'S', nameFa: 'فروش', nameEn: 'Sales', color: '#0891b2', tagColor: null, managerId: null, manager: null, namesOwned: false, _count: { users: 2 } },
];
const TEAMS = [{ id: 't1', departmentCode: 'CR', nameFa: 'طراحی', nameEn: 'Design', color: '#9333ea', lead: { id: 'u1', fullName: 'بهراد مهرنیا' }, members: 1, archivedAt: null }];
const PEOPLE = [
  { id: 'u1', fullName: 'بهراد مهرنیا', department: { code: 'CR' } },
  { id: 'u2', fullName: 'سپیده آذر', department: { code: 'CR' } },
  { id: 'u3', fullName: 'الهام کریمی', department: { code: 'S' } },
];

function mount(ui: React.ReactNode) {
  // The user editor shows the administrator's tabs: someone is signed in.
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't' });
    if (p === '/auth/me') return json({ id: 'a', email: 'a@hiva.local', fullName: 'مدیر', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: ['admin.users'], locale: 'fa', mustChangePassword: false });
    if (p === '/departments') return json(UNITS);
    if (p === '/teams' && method === 'GET') return json(TEAMS);
    if (p === '/people') return json(PEOPLE);
    if (p === '/roles') return json([{ code: 'UNIT_MEMBER', nameFa: 'کارشناس واحد', nameEn: 'Unit member' }]);
    if (p === '/positions') return json([]);
    return json({});
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><AuthProvider><MemoryRouter>{ui}</MemoryRouter></AuthProvider></ToastProvider></QueryClientProvider>);
  return sent;
}

beforeEach(() => localStorage.clear());

describe('Units and teams', () => {
  it('renames a unit and chooses its manager from its own people', async () => {
    const sent = mount(<Units />);
    const units = await screen.findByTestId('units');
    expect(within(units).getByTestId('teams-CR').textContent).toContain('طراحی');
    fireEvent.click(within(units).getAllByRole('button', { name: 'ویرایش واحد' })[0]!);
    const editor = await screen.findByTestId('unit-editor');
    fireEvent.change(within(editor).getAllByRole('textbox')[0]!, { target: { value: 'خلاقه' } });
    const manager = within(editor).getByRole('combobox');
    await waitFor(() => expect(within(manager).getAllByRole('option')).toHaveLength(3)); // «—» and Creative's two
    fireEvent.change(manager, { target: { value: 'u1' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => expect(sent.find((x) => x.method === 'PATCH' && x.path === '/departments/CR')?.body).toEqual({ nameFa: 'خلاقه', nameEn: 'Creative', managerId: 'u1' }));
  });

  it('makes a team in a unit, with a lead from it', async () => {
    const sent = mount(<Units />);
    const units = await screen.findByTestId('units');
    fireEvent.click(within(units).getAllByRole('button', { name: 'تیم تازه' })[0]!);
    const editor = await screen.findByTestId('team-editor');
    fireEvent.change(within(editor).getAllByRole('textbox')[0]!, { target: { value: 'ویدئو' } });
    fireEvent.change(within(editor).getAllByRole('textbox')[1]!, { target: { value: 'Video' } });
    await waitFor(() => expect(within(editor).getAllByRole('option').length).toBe(3));
    fireEvent.change(within(editor).getByRole('combobox'), { target: { value: 'u2' } });
    fireEvent.click(within(editor).getByRole('button', { name: '#16a34a' }));
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => expect(sent.find((x) => x.method === 'POST' && x.path === '/teams')?.body).toEqual({ departmentCode: 'CR', nameFa: 'ویدئو', nameEn: 'Video', leadId: 'u2', color: '#16a34a' }));
  });

  it('puts a person in a team of their own unit, and drops it when the unit changes', async () => {
    const sent = mount(<UserEditor user={{ id: 'u1', fullName: 'بهراد مهرنیا', department: { code: 'CR' }, team: null, roles: [{ role: { code: 'UNIT_MEMBER' } }] }} onClose={() => {}} onSaved={async () => {}} />);
    const team = await screen.findByRole('combobox', { name: 'تیم' });
    fireEvent.change(team, { target: { value: 't1' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => expect(sent.find((x) => x.method === 'PATCH')?.body).toMatchObject({ departmentCode: 'CR', teamId: 't1' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'واحد' }), { target: { value: 'S' } });
    expect(screen.queryByRole('combobox', { name: 'تیم' })).toBeNull(); // Sales has no teams
  });
});
