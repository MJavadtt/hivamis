import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const refresh = vi.fn(async () => true);
let token: string | null = 'AT-1';
vi.mock('../src/lib/api', () => ({ getAccessToken: () => token, refreshSession: () => refresh() }));
import { connectLive, fallbackInterval, parseBlock, useLiveStatus } from '../src/lib/live';

/** A response whose body is the given SSE text, then stays open until aborted. */
function streamOf(text: string, signal?: AbortSignal) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text));
      signal?.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function Status() { return <span data-testid="s">{useLiveStatus()}</span>; }

afterEach(() => { token = 'AT-1'; refresh.mockClear(); });

describe('The live stream client', () => {
  it('reads blocks, and polls rarely only while live', () => {
    expect(parseBlock('event: transition\ndata: {"entity":"task","id":"t1"}')).toEqual({ event: 'transition', data: { entity: 'task', id: 't1' } });
    expect(parseBlock(': ping')).toBeNull();
    expect(fallbackInterval('live')).toBe(300_000);
    expect(fallbackInterval('offline')).toBe(60_000);
  });

  it('sends the token in a header, goes live on "ready", and hands each event to its handler', async () => {
    const calls: { url: string; auth: string }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string>).authorization });
      return streamOf('retry: 5000\n\nevent: ready\ndata: {"live":true}\n\nevent: transition\ndata: {"entity":"task"}\n\n: ping\n\nevent: notification\ndata: {"kind":"SLA_BREACH"}\n\n', init?.signal ?? undefined);
    }) as unknown as typeof fetch;
    const h = { onTransition: vi.fn(), onNotification: vi.fn(), onCatchUp: vi.fn() };
    render(<Status />);
    const stop = connectLive(h, { fetchImpl });
    await waitFor(() => expect(screen.getByTestId('s').textContent).toBe('live'));
    await waitFor(() => expect(h.onNotification).toHaveBeenCalledTimes(1));
    expect(h.onTransition).toHaveBeenCalledTimes(1);
    expect(h.onCatchUp).toHaveBeenCalledTimes(1);          // on connecting: whatever moved meanwhile
    expect(calls[0]).toEqual({ url: '/api/v1/events', auth: 'Bearer AT-1' });
    expect(calls[0]!.url).not.toContain('AT-1');           // never in the URL
    stop();
  });

  it('refreshes an expired session once, then connects with the new token', async () => {
    const auths: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const a = (init?.headers as Record<string, string>).authorization;
      auths.push(a);
      if (a === 'Bearer AT-1') { token = 'AT-2'; return new Response('{}', { status: 401 }); }
      return streamOf('event: ready\ndata: {"live":true}\n\n', init?.signal ?? undefined);
    }) as unknown as typeof fetch;
    const h = { onTransition: vi.fn(), onNotification: vi.fn(), onCatchUp: vi.fn() };
    const stop = connectLive(h, { fetchImpl });
    await waitFor(() => expect(h.onCatchUp).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(auths).toEqual(['Bearer AT-1', 'Bearer AT-2']);
    stop();
  });

  it('says it is offline when the stream cannot be opened', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    render(<Status />);
    const stop = connectLive({ onTransition: vi.fn(), onNotification: vi.fn(), onCatchUp: vi.fn() }, { fetchImpl });
    await waitFor(() => expect(screen.getAllByTestId('s').at(-1)!.textContent).toBe('offline'));
    stop();
  });
});
