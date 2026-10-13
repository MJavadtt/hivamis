import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { WriteAssist } from '../src/components/WriteAssist';
import { ImageMaker } from '../src/components/ImageMaker';

/**
 * Audit F-2: writing and pictures with the assistant. Nothing goes into the form until the person
 * says so, and neither is there for someone without the permission — or, for pictures, where no
 * image server is set up.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (events: [string, unknown][]) => new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const me = (permissions: string[]) => ({ id: 'u1', email: 'p@hiva.local', fullName: 'پریسا', jobTitle: null, department: { code: 'A', nameFa: 'اکانت' }, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['ACCOUNT_EXEC'], permissions, locale: 'fa', mustChangePassword: false });

function mount(ui: React.ReactNode, { permissions = ['ai.write', 'ai.image', 'document.write'], imageMode = 'local' } = {}) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    sent.push({ method: init?.method ?? 'GET', path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (p === '/auth/refresh') return json({ accessToken: 't' });
    if (p === '/auth/me') return json(me(permissions));
    if (p === '/ai/write') return sse([['meta', { model: 'qwen3:8b' }], ['delta', { text: 'بریف کمپین: ' }], ['delta', { text: 'هدف [ ]' }], ['done', {}]]);
    if (p === '/ai/image/status') return json({ mode: imageMode, ready: imageMode === 'local', model: 'sd-1.5-ggml' });
    if (p === '/ai/image') return json({ id: 'd1' }, 201);
    return json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider>{ui}</AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

function Brief() {
  const [text, setText] = useState('');
  return <><textarea aria-label="بریف" value={text} readOnly /><WriteAssist value={text} onUse={setText} kind="brief" /></>;
}

afterEach(() => vi.unstubAllGlobals());

describe('Writing with the assistant', () => {
  it('drafts from an instruction, lets the person edit it, and puts it in the form only when asked', async () => {
    const sent = mount(<Brief />);
    fireEvent.click(await screen.findByTestId('write-assist'));
    fireEvent.change(screen.getByPlaceholderText(/بریف کمپین معرفی محصول/), { target: { value: 'بریف کمپین معرفی محصول' } });
    fireEvent.click(screen.getByRole('button', { name: 'بنویس' }));
    const draft = await screen.findByTestId('write-draft') as HTMLTextAreaElement;
    await waitFor(() => expect(draft.value).toBe('بریف کمپین: هدف [ ]'));
    expect(sent.find((s) => s.path === '/ai/write')?.body).toMatchObject({ kind: 'brief', instruction: 'بریف کمپین معرفی محصول', text: null, locale: 'fa' });
    // Not in the form yet.
    expect((screen.getByLabelText('بریف') as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(draft, { target: { value: 'بریف کمپین: هدف — آگاهی از برند' } });
    fireEvent.click(screen.getByRole('button', { name: 'گذاشتن در فرم' }));
    await waitFor(() => expect((screen.getByLabelText('بریف') as HTMLTextAreaElement).value).toBe('بریف کمپین: هدف — آگاهی از برند'));
  });

  it('is not there for someone the administrator has not given it to', async () => {
    mount(<Brief />, { permissions: ['document.write'] });
    await waitFor(() => expect(screen.queryByTestId('write-assist')).toBeNull());
  });
});

describe('Making a picture', () => {
  it('asks the server for the project’s picture with the description and size', async () => {
    const done = vi.fn();
    const sent = mount(<ImageMaker projectId="p1" onDone={done} />);
    fireEvent.click(await screen.findByTestId('image-maker'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a red bicycle at dusk' } });
    fireEvent.click(screen.getByRole('button', { name: 'بساز' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(sent.find((s) => s.path === '/ai/image')?.body).toMatchObject({ prompt: 'a red bicycle at dusk', size: '512x512', projectId: 'p1' });
  });

  it('is not shown where no image server is set up, nor to someone without the permission', async () => {
    mount(<ImageMaker projectId="p1" onDone={() => undefined} />, { imageMode: 'off' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('image-maker')).toBeNull();
    vi.unstubAllGlobals();
    mount(<ImageMaker projectId="p1" onDone={() => undefined} />, { permissions: ['ai.write', 'document.write'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('image-maker')).toBeNull();
  });
});
