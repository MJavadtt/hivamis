import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { AssistantButton } from '../src/components/AssistantChat';
import { assistantBus } from '../src/lib/guide';

/**
 * Hivamis task 5: the assistant answers as it thinks, says what it is looking at, knows the page it
 * was opened from, and turns what it offers into a click — a form already filled in, or a page.
 */

const PROJECT = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (events: [string, unknown][]) => new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const me = (permissions: string[]) => ({ id: 'u1', email: 'p@hiva.local', fullName: 'پریسا', jobTitle: null, department: { code: 'OP', nameFa: 'عملیات' }, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['PMO_MANAGER'], permissions, locale: 'fa', mustChangePassword: false });
const READY = { mode: 'ollama', ready: true, model: 'qwen3:14b', reachable: true, modelPresent: true, busy: 0, waiting: 0 };
const DEFINITION = {
  id: 'd1', no: 90, code: 'K01_STATUS', nameFa: 'گزارش وضعیت پروژه', nameEn: 'Project status report', category: 'K', module: 'REPORTING_CUSTOMER_SUCCESS',
  senderDepts: ['OP'], receiverDepts: ['A'], approverRoles: ['PMO_MANAGER'], slaCode: null, binding: null, nextProcessFa: null, canSubmit: true, sla: null,
  schema: [{ key: 'projectId', labelFa: 'پروژه', labelEn: 'Project', type: 'entityRef', entity: 'project', required: true }, { key: 'summary', labelFa: 'خلاصه', labelEn: 'Summary', type: 'textarea' }],
};

function mount({ at = '/', permissions = ['ai.chat', 'form.read', 'form.submit', 'project.read'], status = READY, reply = [] as [string, unknown][] } = {}) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    sent.push({ method: init?.method ?? 'GET', path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(me(permissions));
    if (p === '/ai/chat/status') return json(status);
    if (p === '/ai/chat') return sse(reply);
    if (p === '/ai/conversations') return json([{ id: 'c1', title: 'کارهای امروز من', updatedAt: '2026-10-04T09:00:00Z' }]);
    if (p === '/ai/conversations/c1') return json({ id: 'c1', messages: [{ role: 'user', content: 'کارهای امروز من', actions: [] }, { role: 'assistant', content: 'سه کار دارید.', actions: [] }] });
    if (p === '/forms/definitions/K01_STATUS') return json(DEFINITION);
    if (p === '/projects') return json({ items: [{ id: 'p1', code: 'PRJ-1', name: 'کمپین پاییز' }] });
    if (p === '/forms/submissions') return json({ id: 's1' }, 201);
    return json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter initialEntries={[at]}><AssistantButton /></MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

const ask = async (text: string) => {
  const box = await screen.findByRole('textbox', { name: 'پیام به دستیار' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'فرستادن' }).hasAttribute('disabled')).toBe(true));
  fireEvent.change(box, { target: { value: text } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'فرستادن' }).hasAttribute('disabled')).toBe(false));
  fireEvent.keyDown(box, { key: 'Enter' });
};

describe('The assistant', () => {
  it('answers as it goes, says what it looked at, and knows the record on screen', async () => {
    const sent = mount({ at: `/projects/${PROJECT}`, reply: [
      ['meta', { conversationId: 'c9', model: 'qwen3:14b' }],
      ['tool', { name: 'get_record', args: { kind: 'project', id: PROJECT } }],
      ['delta', { text: 'پروژه در مرحلهٔ ' }], ['delta', { text: 'اجراست.' }],
      ['done', { messageId: 'm1', actions: [] }],
    ] });
    fireEvent.click(await screen.findByRole('button', { name: 'دستیار' }));
    await ask('وضعیت این پروژه؟');
    expect(await screen.findByText('پروژه در مرحلهٔ اجراست.')).toBeDefined();
    expect(screen.getByText('خواندن پرونده…')).toBeDefined();
    expect(sent.find((x) => x.path === '/ai/chat')?.body).toMatchObject({ conversationId: null, message: 'وضعیت این پروژه؟', context: { path: `/projects/${PROJECT}`, entity: 'project', id: PROJECT } });
  });

  it('turns an offered form into a click that opens it filled in, and an offered page into a link', async () => {
    const sent = mount({ reply: [
      ['meta', { conversationId: 'c9', model: 'qwen3:14b' }],
      ['action', { type: 'form', label: 'گزارش وضعیت پروژه', code: 'K01_STATUS', prefill: { projectId: 'p1' } }],
      ['action', { type: 'link', label: 'کارهای من', path: '/my-work' }],
      ['delta', { text: 'فرم آماده است.' }],
      ['done', { messageId: 'm1', actions: [] }],
    ] });
    fireEvent.click(await screen.findByRole('button', { name: 'دستیار' }));
    await ask('گزارش وضعیت بفرستم');
    const offer = await screen.findByRole('button', { name: 'باز کردن «گزارش وضعیت پروژه»' });
    fireEvent.click(offer);
    await screen.findByRole('button', { name: 'ثبت و ارسال' });
    // Escape belongs to the form while it is open: it closes the form, and the conversation stays.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ثبت و ارسال' })).toBeNull());
    expect(screen.getByTestId('assistant')).toBeDefined();
    fireEvent.click(offer);
    fireEvent.click(await screen.findByRole('button', { name: 'ثبت و ارسال' }));
    await waitFor(() => expect(sent.find((x) => x.method === 'POST' && x.path === '/forms/submissions')?.body)
      .toMatchObject({ formCode: 'K01_STATUS', data: { projectId: 'p1' }, asDraft: false }));
    fireEvent.click(screen.getByRole('button', { name: 'کارهای من' }));
    await waitFor(() => expect(screen.queryByTestId('assistant')).toBeNull());
  });

  it('says plainly when the local model is not running, and does not let a question go nowhere', async () => {
    mount({ permissions: ['ai.chat', 'admin.settings'], status: { ...READY, ready: false, reachable: false } });
    fireEvent.click(await screen.findByRole('button', { name: 'دستیار' }));
    // Audit F-1: the model is in the stack — the administrator is told what to start, or what to fetch.
    expect((await screen.findByTestId('assistant-offline')).textContent).toContain('docker compose up -d ollama');
    fireEvent.change(screen.getByRole('textbox', { name: 'پیام به دستیار' }), { target: { value: 'سلام' } });
    expect(screen.getByRole('button', { name: 'فرستادن' }).hasAttribute('disabled')).toBe(true);
  });

  it('tells the administrator to fetch the model when the server answers but does not have it', async () => {
    mount({ permissions: ['ai.chat', 'admin.settings'], status: { ...READY, ready: false, reachable: true, modelPresent: false } });
    fireEvent.click(await screen.findByRole('button', { name: 'دستیار' }));
    expect((await screen.findByTestId('assistant-offline')).textContent).toContain('infrastructure/hivamis model pull qwen3:14b');
  });

  it('reopens an earlier conversation', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'دستیار' }));
    fireEvent.click(await screen.findByRole('button', { name: 'گفت‌وگوهای پیشین' }));
    fireEvent.click(await screen.findByRole('button', { name: /کارهای امروز من/ }));
    expect(await screen.findByText('سه کار دارید.')).toBeDefined();
  });

  it('takes over a question the owl’s guide could not answer, and asks it at once', async () => {
    const sent = mount({ reply: [['meta', { conversationId: 'c9', model: 'qwen3:14b' }], ['delta', { text: 'بله.' }], ['done', { messageId: 'm1', actions: [] }]] });
    await screen.findByRole('button', { name: 'دستیار' });
    act(() => { assistantBus.ask('گزارش وضعیت را کی بفرستم؟'); });
    expect(await screen.findByText('بله.')).toBeDefined();
    expect(sent.find((x) => x.path === '/ai/chat')?.body).toMatchObject({ message: 'گزارش وضعیت را کی بفرستم؟' });
  });

  it('is not there for someone the administrator has not given it to', async () => {
    mount({ permissions: ['project.read'] });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'دستیار' })).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'دستیار' })).toBeNull();
  });
});
