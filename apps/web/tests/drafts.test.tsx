import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, ToastProvider } from '../src/components/ui';
import { JalaliDateInput } from '../src/components/JalaliDateInput';
import { AuthProvider } from '../src/lib/auth';
import { apiPost, markSignedIn, setAccessToken } from '../src/lib/api';
import { DraftNotice, DraftProvider, useDraftState } from '../src/lib/drafts';
import Drafts from '../src/pages/Drafts';

/**
 * ADR-122 (the owner, 2026-11-06): whatever is typed in any form is kept as a draft until the form is
 * saved or the person deletes it — and never a password, and never another record's.
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const USER = { id: 'u1', email: 'x@hiva.local', fullName: 'x', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: [], locale: 'fa', mustChangePassword: false };

function mount(node: React.ReactNode, { at = '/leads', stored = [] as unknown[] } = {}) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(USER);
    if (p === '/me/drafts' && method === 'GET') return json(stored);
    if (p === '/me/drafts' && method === 'PUT') return json({ id: 'draft-1', key: 'k', updatedAt: new Date().toISOString() });
    return json({ id: 'made' }, method === 'POST' ? 201 : 200);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter initialEntries={[at]}><DraftProvider>{node}</DraftProvider></MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}
const saves = (sent: { method: string; path: string; body: any }[]) => sent.filter((s) => s.method === 'PUT' && s.path === '/me/drafts');

/** A form as the app writes them: one object of state, each change built from the last render's. */
function LeadForm({ name = '', title = 'ثبت سرنخ', draftKey }: { name?: string; title?: string; draftKey?: string }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ name, need: '', kind: '', date: '', urgent: false, pass: '' });
  return (
    <>
      <button onClick={() => setOpen(true)}>باز کردن</button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} draftKey={draftKey}
        footer={<Button onClick={() => void apiPost('/leads', v).then(() => setOpen(false))}>ثبت</Button>}>
        <Field label="نام"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="نیاز"><Textarea value={v.need} onChange={(e) => setV({ ...v, need: e.target.value })} /></Field>
        <Field label="نوع"><Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}><option value="">—</option><option value="A">الف</option></Select></Field>
        <Field label="تاریخ"><JalaliDateInput mode="date" value={v.date || null} onChange={(d) => setV({ ...v, date: d })} /></Field>
        <Checkbox label="فوری" checked={v.urgent} onChange={(e) => setV({ ...v, urgent: e.target.checked })} />
        <Field label="رمز عبور"><Input type="text" value={v.pass} onChange={(e) => setV({ ...v, pass: e.target.value })} /></Field>
      </Modal>
      <output data-testid="state">{JSON.stringify(v)}</output>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!);
const stored = (over: Record<string, unknown> = {}) => [{
  id: 'draft-1', key: '/leads#ثبت سرنخ', title: 'ثبت سرنخ', path: '/leads', updatedAt: '2026-11-05T10:00:00.000Z',
  fields: {
    'نام': { label: 'نام', value: 'کمپین پاییز', base: '' }, 'نیاز': { label: 'نیاز', value: 'تیزر', base: '' },
    'نوع': { label: 'نوع', value: 'A', base: '' }, 'تاریخ': { label: 'تاریخ', value: '2026-11-20', base: '' }, 'فوری': { label: 'فوری', value: true, base: false },
  }, ...over,
}];

describe('Drafts', () => {
  it('keeps what is typed without asking, in a dialog and in every kind of field', async () => {
    const sent = mount(<LeadForm />);
    fireEvent.click(screen.getByText('باز کردن'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('نام'), { target: { value: 'کمپین پاییز' } });
    fireEvent.change(within(dialog).getByLabelText('نوع'), { target: { value: 'A' } });
    fireEvent.click(within(dialog).getByLabelText('فوری'));
    await waitFor(() => expect(saves(sent).length).toBeGreaterThan(0), { timeout: 2500 });
    const { body } = saves(sent).at(-1)!;
    expect(body).toMatchObject({ key: '/leads#ثبت سرنخ', title: 'ثبت سرنخ', path: '/leads' });
    expect(body.fields['نام'].value).toBe('کمپین پاییز');
    expect(body.fields['نوع'].value).toBe('A');
    expect(body.fields['فوری — فوری'] ?? body.fields['فوری']).toMatchObject({ value: true });
    expect(await within(dialog).findByTestId('draft-notice')).toBeTruthy();
  });

  it('gives every field back through its own onChange, even a form that builds on its last state', async () => {
    mount(<LeadForm />, { stored: stored() });
    fireEvent.click(screen.getByText('باز کردن'));
    await waitFor(() => expect(state()).toMatchObject({ name: 'کمپین پاییز', need: 'تیزر', kind: 'A', date: '2026-11-20', urgent: true }), { timeout: 2000 });
    expect((await screen.findByTestId('draft-notice')).textContent).toContain('برگردانده شد');
  });

  it('never keeps a password, whatever the field’s type says', async () => {
    const sent = mount(<LeadForm />);
    fireEvent.click(screen.getByText('باز کردن'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('رمز عبور'), { target: { value: 'hunter2' } });
    fireEvent.change(within(dialog).getByLabelText('نام'), { target: { value: 'x y' } });
    await waitFor(() => expect(saves(sent).length).toBeGreaterThan(0), { timeout: 2500 });
    expect(JSON.stringify(saves(sent))).not.toContain('hunter2');
  });

  it('does not take a filter or a search for a form', async () => {
    function Filters() {
      const [q, setQ] = useState(''); const [s, setS] = useState('');
      return <><Input aria-label="فیلتر" value={q} onChange={(e) => setQ(e.target.value)} /><Field label="پروژه"><Input aria-label="جستجوی پروژه" value={s} onChange={(e) => setS(e.target.value)} /></Field></>;
    }
    const sent = mount(<Filters />);
    fireEvent.change(screen.getByLabelText('فیلتر'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText('جستجوی پروژه'), { target: { value: 'abc' } });
    await new Promise((r) => { setTimeout(r, 1000); });
    expect(saves(sent)).toEqual([]);
  });

  it('keeps it when the dialog is closed, and lets it go when the form is really saved', async () => {
    const sent = mount(<LeadForm />);
    fireEvent.click(screen.getByText('باز کردن'));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('نام'), { target: { value: 'کمپین' } });
    await waitFor(() => expect(saves(sent).length).toBeGreaterThan(0), { timeout: 2500 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'بستن' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByText('باز کردن'));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ثبت' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'DELETE' && s.path === '/me/drafts/draft-1')).toBe(true));
  });

  it('does not let a failed save or an unrelated call take the draft', async () => {
    const sent = mount(<LeadForm />, { stored: stored() });
    fireEvent.click(screen.getByText('باز کردن'));
    await screen.findByTestId('draft-notice');
    await apiPost('/leads', {}); // No click led to this.
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
  });

  it('does not put one record’s draft into the same dialog on another record', async () => {
    mount(<LeadForm name="سرنخ دیگر" />, { stored: stored() });
    fireEvent.click(screen.getByText('باز کردن'));
    await screen.findByRole('dialog');
    await new Promise((r) => { setTimeout(r, 50); });
    expect(state()).toMatchObject({ name: 'سرنخ دیگر', need: '', kind: '' });
  });

  it('tells rows apart by the key a dialog is given', async () => {
    const sent = mount(<LeadForm title="دلیل" draftKey="lead:l-7:reject" />);
    fireEvent.click(screen.getByText('باز کردن'));
    fireEvent.change(within(await screen.findByRole('dialog')).getByLabelText('نام'), { target: { value: 'x y' } });
    await waitFor(() => expect(saves(sent).at(-1)?.body.key).toBe('/leads#lead:l-7:reject'), { timeout: 2500 });
  });

  it('throws it away on the person’s word, and the fields go back', async () => {
    const sent = mount(<LeadForm />, { stored: stored() });
    fireEvent.click(screen.getByText('باز کردن'));
    await waitFor(() => expect(state().name).toBe('کمپین پاییز'), { timeout: 2000 });
    fireEvent.click(await screen.findByRole('button', { name: 'حذف پیش‌نویس' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'DELETE' && s.path === '/me/drafts/draft-1')).toBe(true));
    await waitFor(() => expect(state()).toMatchObject({ name: '', need: '', kind: '', urgent: false }), { timeout: 2000 });
    expect(screen.queryByTestId('draft-notice')).toBeNull();
  });

  it('keeps a choice that is no input', async () => {
    function Choice() {
      const [who, setWho] = useDraftState<string | null>('چه کسی', null);
      return <><button onClick={() => setWho('CR')}>آتلیه</button><output data-testid="who">{who}</output></>;
    }
    const sent = mount(<Choice />, { at: '/projects/p-1/ooh' });
    fireEvent.click(screen.getByText('آتلیه'));
    await waitFor(() => expect(saves(sent).at(-1)?.body.fields['چه کسی'].value).toBe('CR'), { timeout: 2500 });
  });

  it('keeps nothing in conversations, the assistant or system settings', async () => {
    function Message() {
      const [t, setT] = useState('');
      return <Field label="پیام"><Textarea value={t} onChange={(e) => setT(e.target.value)} /></Field>;
    }
    const sent = mount(<Message />, { at: '/chat/c-1' });
    fireEvent.change(screen.getByLabelText('پیام'), { target: { value: 'سلام' } });
    await new Promise((r) => { setTimeout(r, 1000); });
    expect(saves(sent)).toEqual([]);
  });

  it('shows the page’s notice for the page’s draft', async () => {
    function Page() {
      const [t, setT] = useState('');
      return <><DraftNotice /><section aria-label="بخش"><Field label="یادداشت"><Textarea value={t} onChange={(e) => setT(e.target.value)} /></Field></section></>;
    }
    const sent = mount(<Page />, { at: '/tasks/t-1' });
    fireEvent.change(screen.getByLabelText('یادداشت'), { target: { value: 'متن' } });
    expect((await screen.findByTestId('draft-notice')).textContent).toContain('پیش‌نویس خودکار ذخیره می‌شود.');
    await waitFor(() => expect(saves(sent).at(-1)?.body).toMatchObject({ key: '/tasks/t-1' }), { timeout: 2500 });
    expect(Object.keys(saves(sent).at(-1)!.body.fields)).toEqual(['بخش / یادداشت']);
  });
});

describe('My drafts', () => {
  it('shows what each draft says and where it belongs, and deletes on request', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const sent = mount(<Drafts />, { at: '/drafts', stored: stored() });
    const row = await screen.findByTestId('draft-row');
    expect(row.textContent).toContain('ثبت سرنخ');
    expect(row.textContent).toContain('کمپین پاییز');
    expect(within(row).getByRole('link').getAttribute('href')).toBe('/leads');
    fireEvent.click(within(row).getByRole('button', { name: 'حذف' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'DELETE' && s.path === '/me/drafts/draft-1')).toBe(true));
    expect(await screen.findByText('پیش‌نویسی ندارید')).toBeTruthy();
    expect(confirm).toHaveBeenCalled();
  });
});
