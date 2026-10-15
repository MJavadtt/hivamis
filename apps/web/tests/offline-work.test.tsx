import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { openVault, resumeVault, vaultGet, vaultPut, wipeVault } from '../src/lib/vault';
import { cachedGet, forgetShown, useShownSince } from '../src/lib/offline';
import { enqueue, enqueueOperation, listOutbox, resetOutboxStore, setOutboxOwner } from '../src/lib/outbox';
import { sendOrQueue, syncOutbox } from '../src/lib/sync';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui';
import { Outbox } from '../src/components/Outbox';

/**
 * Audit F-7 on the page. The copy kept for the field is encrypted under a key of this sign-in and
 * unreadable to another; a page reads it only when the server does not answer, and says from when;
 * the queue sends each kind as the request it is, under its key, keeps what the world moved past as
 * a conflict for the person to decide, and sends a person's queue only with their own session.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const KEY_A = Buffer.alloc(32, 7).toString('base64url');
const KEY_B = Buffer.alloc(32, 9).toString('base64url');
const setOnline = (on: boolean) => Object.defineProperty(navigator, 'onLine', { value: on, configurable: true });

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  await wipeVault();
  resetOutboxStore();
  setOutboxOwner(null);
  forgetShown();
  setAccessToken('t'); markSignedIn(true);
});
afterEach(() => { vi.unstubAllGlobals(); setOnline(true); });

describe('The device’s copy', () => {
  it('reads back only under the sign-in that kept it', async () => {
    expect(await openVault('u1', KEY_A)).toBe(true);
    await vaultPut('/me/work', { items: [{ code: 'TSK-000123' }] });
    expect((await vaultGet<{ items: unknown[] }>('/me/work'))?.value.items).toHaveLength(1);
    // Resumed with no network: the same person, the same key.
    expect(await resumeVault()).toBe('u1');
    expect(await vaultGet('/me/work')).not.toBeNull();
    // A new sign-in has a new key: what the old one kept is dropped, not read.
    await openVault('u1', KEY_B);
    expect(await vaultGet('/me/work')).toBeNull();
    await vaultPut('/me/work', { items: [] });
    await wipeVault();
    expect(await resumeVault()).toBeNull();
  });

  it('serves the copy only when the server does not answer, and says from when', async () => {
    await openVault('u1', KEY_A);
    let mode: 'ok' | 'down' | 'refused' = 'ok';
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (mode === 'down') throw new TypeError('Failed to fetch');
      if (mode === 'refused') return json({ error: { code: 'FORBIDDEN', message: 'دسترسی ندارید' } }, 403);
      return json({ items: [{ code: 'TSK-1' }] });
    }));
    const Since = () => { const s = useShownSince('/me/work'); return <span data-testid="since">{s ? 'copy' : 'live'}</span>; };
    render(<Since />);
    expect(await cachedGet('/me/work')).toEqual({ items: [{ code: 'TSK-1' }] });
    expect(screen.getByTestId('since').textContent).toBe('live');
    // Kept in the background; the network goes once it is.
    await waitFor(async () => expect(await vaultGet('/me/work')).not.toBeNull());
    mode = 'down';
    expect(await cachedGet('/me/work')).toEqual({ items: [{ code: 'TSK-1' }] });
    await waitFor(() => expect(screen.getByTestId('since').textContent).toBe('copy'));
    // A refusal is the server's answer, never covered by the copy.
    mode = 'refused';
    await expect(cachedGet('/me/work')).rejects.toThrow('دسترسی ندارید');
  });
});

describe('The queue', () => {
  function server(answer: (path: string) => Response | Promise<Response>) {
    const sent: { path: string; key: string | null; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
      sent.push({ path, key: new Headers(init?.headers).get('idempotency-key'), body: init?.body ? JSON.parse(String(init.body)) : null });
      return answer(path);
    }));
    return sent;
  }

  it('sends each kind as the request it is, under its own key, oldest first', async () => {
    setOutboxOwner('u1');
    const form = await enqueue({ formCode: 'D01', formNameFa: 'گزارش روزانه', data: { a: 1 }, asDraft: false });
    const time = await enqueueOperation({ kind: 'time', path: '/tasks/t1/time', body: { hours: 2 }, label: '۲ ساعت روی TSK-1' });
    const sent = server(() => json({ code: 'X' }, 201));
    expect(await syncOutbox()).toMatchObject({ sent: 2 });
    expect(sent).toEqual([
      { path: '/forms/submissions', key: form.id, body: { formCode: 'D01', data: { a: 1 }, asDraft: false, clientKey: form.id } },
      { path: '/tasks/t1/time', key: time.id, body: { hours: 2 } },
    ]);
  });

  it('keeps what the world moved past as a conflict, a plain refusal as rejected, and waits out no answer', async () => {
    setOutboxOwner('u1');
    const submit = await enqueueOperation({ kind: 'submit', path: '/workflow/task/t1/transitions', body: { action: 'submit' }, label: 'تحویل خروجی', link: '/tasks/t1' });
    const note = await enqueueOperation({ kind: 'comment', path: '/tasks/t1/comments', body: { body: '' }, label: 'یادداشت' });
    const time = await enqueueOperation({ kind: 'time', path: '/tasks/t2/time', body: { hours: 1 }, label: '۱ ساعت' });
    server((p) => {
      if (p.includes('transitions')) return json({ error: { code: 'INVALID_TRANSITION', message: 'وظیفه در این وضعیت نیست' } }, 422);
      if (p.includes('comments')) return json({ error: { code: 'VALIDATION_ERROR', message: 'یادداشت خالی است' } }, 400);
      throw new TypeError('Failed to fetch');
    });
    expect(await syncOutbox()).toMatchObject({ sent: 0, rejected: 1, conflicts: 1, waiting: 1 });
    const items = Object.fromEntries((await listOutbox()).map((i) => [i.id, i]));
    expect(items[submit.id]).toMatchObject({ state: 'CONFLICT', errorFa: 'وظیفه در این وضعیت نیست', errorCode: 'INVALID_TRANSITION' });
    expect(items[note.id]!.state).toBe('REJECTED');
    expect(items[time.id]!.state).toBe('QUEUED');

    // The conflict, shown with the person's three choices.
    render(<QueryClientProvider client={new QueryClient()}><ToastProvider><MemoryRouter><Outbox /></MemoryRouter></ToastProvider></QueryClientProvider>);
    const row = (await screen.findByText('تحویل خروجی')).closest('tr')!;
    expect(row.textContent).toContain('پرونده در این فاصله تغییر کرده');
    expect(row.querySelector('a')!.getAttribute('href')).toBe('/tasks/t1');
    expect(row.textContent).toContain('دوباره بفرست');
    expect(row.textContent).toContain('کنار بگذار');
  });

  it('sends a person’s queue only with their own session', async () => {
    setOutboxOwner('u1');
    await enqueueOperation({ kind: 'time', path: '/tasks/t1/time', body: { hours: 1 }, label: 'من' });
    setOutboxOwner('u2');
    expect(await listOutbox()).toHaveLength(0);
    const sent = server(() => json({}, 201));
    expect(await syncOutbox()).toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it('does it now when it can; queues it, under the same key, when the server does not answer', async () => {
    setOutboxOwner('u1');
    let down = false;
    const sent = server(() => { if (down) throw new TypeError('Failed to fetch'); return json({ id: 'c1' }, 201); });
    expect(await sendOrQueue({ kind: 'comment', path: '/tasks/t1/comments', body: { body: 'سلام' }, label: 'یادداشت' })).toEqual({ queued: false, result: { id: 'c1' } });
    down = true;
    expect(await sendOrQueue({ kind: 'comment', path: '/tasks/t1/comments', body: { body: 'دوباره' }, label: 'یادداشت' })).toEqual({ queued: true });
    const [queued] = await listOutbox();
    expect(queued).toMatchObject({ kind: 'comment', userId: 'u1', state: 'QUEUED' });
    expect(sent.at(-1)!.key).toBe(queued!.id);
    // With the browser saying it is offline, it is not even tried.
    setOnline(false);
    const before = sent.length;
    expect(await sendOrQueue({ kind: 'time', path: '/tasks/t1/time', body: { hours: 1 }, label: 'زمان' })).toEqual({ queued: true });
    expect(sent.length).toBe(before);
  });
});

describe('Opening with no network', () => {
  it('opens from the copy of the last sign-in, says so, and drops it on sign-out', async () => {
    const ME = { id: 'u1', email: 'd@hiva.local', fullName: 'بهراد', jobTitle: null, locale: 'fa', mustChangePassword: false, department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: ['task.read'] };
    let up = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (!up) throw new TypeError('Failed to fetch');
      const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
      if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
      if (p === '/auth/me') return json({ ...ME, offlineKey: KEY_A });
      return json({});
    }));
    const Who = () => { const { user, offline } = useAuth(); return <p data-testid="who">{user ? `${user.fullName}${offline ? ' (copy)' : ''}` : 'none'}</p>; };
    const first = render(<AuthProvider><Who /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('بهراد'));
    await waitFor(async () => expect(await vaultGet('me')).not.toBeNull());
    first.unmount();

    up = false;
    const Out = () => { const { signOut } = useAuth(); return <button onClick={() => void signOut()}>out</button>; };
    render(<AuthProvider><Who /><Out /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('بهراد (copy)'));
    fireEvent.click(screen.getByText('out'));
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('none'));
    expect(await resumeVault()).toBeNull();
  });
});
