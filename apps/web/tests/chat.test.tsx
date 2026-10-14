import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OVERSIGHT_NOTICE } from '@hiva/contracts';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import Chat from '../src/pages/Chat';
import ChatOversight from '../src/pages/ChatOversight';
import Rules from '../src/pages/Rules';
import { pieces } from '../src/lib/teamChat';

/**
 * Audit F-5: team chat on the page. Unread counts in the list; a conversation read while it is on
 * screen; codes that link and names that stand out; files shared by naming the conversation first;
 * and the owner's words about oversight wherever people chat. A reviewer reads only after giving a
 * reason, and is told the look was recorded.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = (permissions: string[]) => ({ id: 'u1', email: 'd@hiva.local', fullName: 'بهراد مهرنیا', jobTitle: null, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['UNIT_MEMBER'], permissions, locale: 'fa', mustChangePassword: false });
const LIST = [
  { id: 'c1', kind: 'DIRECT', title: 'فرشاد بهرامی', topic: null, peer: { id: 'u2', fullName: 'فرشاد بهرامی' }, memberCount: 2, unread: 3, muted: false, notify: 'ALL', role: 'MEMBER', lastMessage: { authorName: 'فرشاد بهرامی', body: 'نظرت؟', at: '2026-10-14T08:00:00Z' }, archived: false },
  { id: 'c2', kind: 'CHANNEL', title: 'اطلاعیه‌ها', topic: null, peer: null, memberCount: 9, unread: 0, muted: true, notify: 'MENTIONS', role: 'MEMBER', lastMessage: null, archived: false },
];
const DETAIL = {
  id: 'c1', kind: 'DIRECT', title: 'فرشاد بهرامی', topic: null, archived: false, createdAt: '2026-10-01T08:00:00Z', peer: { id: 'u2', fullName: 'فرشاد بهرامی' },
  me: { role: 'MEMBER', muted: false, notify: 'ALL', lastReadAt: null },
  members: [{ id: 'u1', fullName: 'بهراد مهرنیا', jobTitle: 'طراح', role: 'MEMBER', joinedAt: '' }, { id: 'u2', fullName: 'فرشاد بهرامی', jobTitle: 'مدیر PMO', role: 'MEMBER', joinedAt: '' }],
};
const msg = (id: string, author: { id: string; fullName: string }, body: string, extra: object = {}) => ({ id, author, body, replyTo: null, attachments: [], mentionIds: [], editedAt: null, deleted: false, createdAt: '2026-10-14T08:00:00Z', ...extra });
const PAGE = {
  items: [
    msg('m1', { id: 'u2', fullName: 'فرشاد بهرامی' }, 'برای PRJ-000016 و PRJ-999999 لطفاً، @بهراد مهرنیا'),
    msg('m2', { id: 'u2', fullName: 'فرشاد بهرامی' }, '', { deleted: true }),
  ],
  hasMore: false,
  records: { 'PRJ-000016': { type: 'project', id: 'p16', title: 'کمپین پاییز' } },
};

function mount(at: string, permissions = ['chat.use', 'document.write']) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(ME(permissions));
    if (p === '/chat/conversations' && method === 'GET') return json(LIST);
    if (p === '/chat/conversations' && method === 'POST') return json({ id: 'c9', existing: false }, 201);
    if (p === '/chat/conversations/c1') return json(DETAIL);
    if (p === '/chat/conversations/c1/messages' && method === 'GET') return json(PAGE);
    if (p === '/chat/conversations/c1/messages') return json(msg('m3', { id: 'u1', fullName: 'بهراد مهرنیا' }, 'باشد'), 201);
    if (p === '/chat/conversations/c1/read') return json({ lastReadAt: '2026-10-14T08:01:00Z' });
    if (p === '/documents') return json({ id: 'f1', fileName: 'brief.pdf' }, 201);
    if (p === '/people') return json([{ id: 'u3', fullName: 'الهام کریمی', jobTitle: 'کارشناس فروش' }]);
    if (p === '/chat/oversight/conversations') return json([{ id: 'c1', kind: 'DIRECT', title: null, lastMessageAt: '2026-10-14T08:00:00Z', archived: false, messageCount: 4, members: [{ id: 'u1', fullName: 'بهراد مهرنیا' }, { id: 'u2', fullName: 'فرشاد بهرامی' }] }]);
    if (p === '/chat/oversight/conversations/c1/view') return json({
      conversation: { id: 'c1', kind: 'DIRECT', title: null, topic: null, members: DETAIL.members.map((m) => ({ ...m, leftAt: null })) },
      items: [{ ...msg('m2', { id: 'u2', fullName: 'فرشاد بهرامی' }, 'متنی که برداشته شد', { deleted: true }), deletedAt: '2026-10-14T09:00:00Z', edits: [{ body: 'نسخهٔ اول', editedAt: '2026-10-14T08:30:00Z' }] }],
      hasMore: false,
    });
    return json([]);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><AuthProvider><MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/chat" element={<Chat />} />
          <Route path="/chat/oversight" element={<ChatOversight />} />
          <Route path="/chat/:id" element={<Chat />} />
          <Route path="/rules" element={<Rules />} />
        </Routes>
      </MemoryRouter></AuthProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe('Team chat', () => {
  it('lists conversations with what is unread, and tells everyone about oversight in the owner’s words', async () => {
    mount('/chat');
    const list = await screen.findByTestId('chat-list');
    const direct = within(list).getByRole('link', { name: /فرشاد بهرامی/ });
    expect(direct.textContent).toContain('۳');
    expect(direct.textContent).toContain('فرشاد بهرامی: نظرت؟');
    expect(within(list).getByRole('link', { name: /اطلاعیه‌ها/ }).textContent).toContain('کانال');
    expect(screen.getByTestId('oversight-notice').textContent).toBe(OVERSIGHT_NOTICE.fa);
    // Nobody here reviews: no way in to oversight.
    expect(screen.queryByRole('link', { name: 'بازبینی گفت‌وگوها' })).toBeNull();
  });

  it('reads a conversation as it opens; links the records the reader may open; names stand out', async () => {
    const sent = mount('/chat/c1');
    const link = await screen.findByRole('link', { name: 'PRJ-000016' });
    expect(link.getAttribute('href')).toBe('/projects/p16');
    // A code this reader may not open stays words.
    expect(screen.queryByRole('link', { name: 'PRJ-999999' })).toBeNull();
    expect(screen.getByText('@بهراد مهرنیا').tagName).toBe('STRONG');
    expect(screen.getByText('این پیام برداشته شد.')).toBeDefined();
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && s.path === '/chat/conversations/c1/read')).toBe(true));
  });

  it('sends with Enter, names a member with @, and shares a file by naming the conversation first', async () => {
    const sent = mount('/chat/c1');
    const box = await screen.findByRole('textbox', { name: 'متن پیام' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'سلام @فرش' } });
    box.setSelectionRange(box.value.length, box.value.length);
    fireEvent.change(box, { target: { value: 'سلام @فرش' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'فرشاد بهرامی' }));
    expect(box.value).toBe('سلام @فرشاد بهرامی ');

    const file = new File(['%PDF-1.4'], 'brief.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText('brief.pdf');
    const upload = sent.find((s) => s.path === '/documents')!.body as FormData;
    expect([...upload.keys()]).toEqual(['chatConversationId', 'file']);
    expect(upload.get('chatConversationId')).toBe('c1');

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sent.find((s) => s.method === 'POST' && s.path === '/chat/conversations/c1/messages')?.body)
      .toEqual({ body: 'سلام @فرشاد بهرامی', attachmentIds: ['f1'], mentionIds: ['u2'] }));
  });

  it('starts a direct conversation with a colleague', async () => {
    const sent = mount('/chat');
    fireEvent.click(await screen.findByRole('button', { name: 'گفت‌وگوی تازه' }));
    fireEvent.click(await screen.findByRole('button', { name: /الهام کریمی/ }));
    fireEvent.click(screen.getByRole('button', { name: 'شروع گفت‌وگو' }));
    await waitFor(() => expect(sent.find((s) => s.method === 'POST' && s.path === '/chat/conversations')?.body).toEqual({ kind: 'DIRECT', memberIds: ['u3'] }));
    // A channel is for those who may make one.
    expect(screen.queryByRole('tab', { name: 'کانال' })).toBeNull();
  });

  it('opens a conversation to a reviewer only for a reason, and says the look was recorded', async () => {
    const sent = mount('/chat/oversight', ['chat.use', 'chat.oversight']);
    expect((await screen.findByTestId('oversight-notice')).textContent).toContain(OVERSIGHT_NOTICE.fa);
    fireEvent.click(await screen.findByRole('button', { name: 'بازبینی…' }));
    const go = screen.getByRole('button', { name: 'ثبت دلیل و خواندن' });
    fireEvent.change(screen.getByRole('textbox', { name: /دلیل/ }), { target: { value: 'کوتاه' } });
    expect(go.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: /دلیل/ }), { target: { value: 'شکایت شمارهٔ ۱۲ دربارهٔ رفتار' } });
    fireEvent.click(go);
    expect((await screen.findByTestId('oversight-recorded')).textContent).toContain('شکایت شمارهٔ ۱۲ دربارهٔ رفتار');
    expect(sent.find((s) => s.path === '/chat/oversight/conversations/c1/view')?.body).toEqual({ reason: 'شکایت شمارهٔ ۱۲ دربارهٔ رفتار' });
    // All of it, read-only: the deleted message and what it said before an edit.
    const transcript = screen.getByTestId('oversight-transcript');
    expect(transcript.textContent).toContain('متنی که برداشته شد');
    expect(transcript.textContent).toContain('نسخهٔ اول');
    expect(within(transcript).queryByRole('textbox')).toBeNull();
  });

  it('states the usage policy, oversight included, on the rules page', async () => {
    mount('/rules');
    fireEvent.click(await screen.findByRole('tab', { name: 'سیاست استفاده' }));
    expect((await screen.findByTestId('usage-policy')).textContent).toContain(OVERSIGHT_NOTICE.fa);
  });

  it('turns a message into words, records and names', () => {
    expect(pieces('ببین PRJ-000016 را @نگار', { 'PRJ-000016': { type: 'project', id: 'p', title: 't' } }, ['نگار'])).toEqual([
      { kind: 'text', text: 'ببین ' }, { kind: 'record', text: 'PRJ-000016', path: '/projects/p', title: 't' }, { kind: 'text', text: ' را ' }, { kind: 'person', text: '@نگار' },
    ]);
  });
});
