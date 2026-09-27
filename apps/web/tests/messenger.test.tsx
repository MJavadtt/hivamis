import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessengerModal } from '../src/components/Messenger';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MessengerModal onClose={() => {}} /></QueryClientProvider>);

describe('The messenger, from the app', () => {
  it('gives a one-time code to link, and in the sandbox shows the bot’s messages with buttons that decide', async () => {
    const posts: { url: string; body: any }[] = [];
    let linked = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/messenger/link')) return json({ mode: 'sandbox', code: 'HV-7K2Q9M', expiresAt: '2026-09-27T10:15:00Z', deepLink: null, bot: null });
        if (url.endsWith('/sandbox/send')) { linked = true; return json({ reply: 'اتصال برقرار شد' }); }
        return json({ answer: '✅ تأیید شد.' });
      }
      if (url.includes('/messenger/me')) return json({ mode: 'sandbox', linked, link: linked ? { username: null, linkedAt: '2026-09-27T10:01:00Z' } : null, bot: null });
      return json([
        { id: 'm1', direction: 'OUT', text: 'فرم در انتظار تأیید: ثبت سرنخ', at: '2026-09-27T10:02:00Z', buttons: [[{ text: 'تأیید', action: 'tokA' }, { text: 'رد', action: 'tokR' }], [{ text: 'باز کردن در سیستم', url: 'http://localhost:5173/forms?submission=s1' }]] },
      ]);
    }));
    mount();
    fireEvent.click(await screen.findByText('اتصال پیام‌رسان'));
    expect((await screen.findByTestId('messenger-code')).textContent).toContain('HV-7K2Q9M');

    fireEvent.change(screen.getByLabelText('پیام به ربات'), { target: { value: 'HV-7K2Q9M' } });
    fireEvent.click(screen.getByText('فرستادن'));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith('/sandbox/send') && p.body.text === 'HV-7K2Q9M')).toBe(true));
    expect(await screen.findByTestId('messenger-linked')).toBeTruthy();

    const chat = screen.getByTestId('sandbox-chat');
    expect(chat.textContent).toContain('فرم در انتظار تأیید');
    expect(screen.getByText('باز کردن در سیستم').getAttribute('href')).toContain('/forms?submission=s1');
    fireEvent.click(screen.getByText('تأیید'));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: expect.stringContaining('/messenger/sandbox/press'), body: { action: 'tokA' } }));
  });

  it('says so when the messenger is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ mode: 'off', linked: false, link: null, bot: null })));
    mount();
    expect((await screen.findByTestId('messenger')).textContent).toContain('خاموش است');
    expect(screen.queryByText('اتصال پیام‌رسان')).toBeNull();
  });
});
