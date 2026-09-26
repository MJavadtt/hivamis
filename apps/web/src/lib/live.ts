import { useEffect, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { getAccessToken, refreshSession } from './api';

/**
 * Live updates (roadmap #39). One stream per tab from /api/v1/events. It is read with fetch
 * rather than EventSource so the access token travels in a header, never in a URL. An event says
 * only that something moved; the page re-reads what it shows through the ordinary endpoints — the
 * queries on screen, at most every couple of seconds however busy the organisation is.
 */

export type LiveStatus = 'connecting' | 'live' | 'offline';
let status: LiveStatus = 'connecting';
const listeners = new Set<() => void>();
const setStatus = (s: LiveStatus) => { if (s !== status) { status = s; listeners.forEach((l) => l()); } };

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => status, () => status);
}

/** How often a query that live updates cover should still poll: rarely when live, as before when not. */
export const fallbackInterval = (s: LiveStatus, whenOffline = 60_000) => (s === 'live' ? 5 * 60_000 : whenOffline);

export interface LiveEventHandlers { onTransition: () => void; onNotification: () => void; onCatchUp: () => void }

/** Parse one SSE block into its event name and JSON data. */
export function parseBlock(block: string): { event: string; data: unknown } | null {
  const event = /^event: (.*)$/m.exec(block)?.[1];
  if (!event) return null;
  const raw = /^data: (.*)$/m.exec(block)?.[1];
  try { return { event, data: raw ? JSON.parse(raw) : null }; } catch { return { event, data: null }; }
}

export function connectLive(h: LiveEventHandlers, opts: { fetchImpl?: typeof fetch } = {}): () => void {
  const f = opts.fetchImpl ?? fetch;
  let stopped = false;
  let ctrl: AbortController | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = (ms: number) => { if (!stopped) timer = setTimeout(() => void run(), ms); };

  const run = async () => {
    if (stopped) return;
    setStatus('connecting');
    ctrl = new AbortController();
    try {
      let token = getAccessToken();
      if (!token && (await refreshSession())) token = getAccessToken();
      if (!token) { setStatus('offline'); return later(30_000); }
      let res = await f('/api/v1/events', { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
      if (res.status === 401 && (await refreshSession())) {
        res = await f('/api/v1/events', { headers: { authorization: `Bearer ${getAccessToken()}` }, signal: ctrl.signal });
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const e = parseBlock(buf.slice(0, i));
          buf = buf.slice(i + 2);
          if (!e) continue;
          if (e.event === 'ready') {
            attempt = 0;
            setStatus((e.data as { live?: boolean } | null)?.live ? 'live' : 'offline');
            h.onCatchUp();   // whatever moved while we were not listening
          } else if (e.event === 'transition') h.onTransition();
          else if (e.event === 'notification') h.onNotification();
          else if (e.event === 'reset') h.onCatchUp();
        }
      }
      // The server ends a stream when the token that opened it expires: reconnect at once.
      attempt = 0;
      later(0);
    } catch {
      if (stopped) return;
      setStatus('offline');
      later(Math.min(30_000, 1000 * 2 ** attempt++));
    }
  };
  void run();
  return () => { stopped = true; if (timer) clearTimeout(timer); ctrl?.abort(); };
}

/** Mounted once, in the shell. */
export function useLiveUpdates(qc: QueryClient) {
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    // A busy organisation moves many records a second; the screen is re-read at most every 2 s.
    const refreshScreen = () => {
      pending ??= setTimeout(() => { pending = null; void qc.invalidateQueries({ refetchType: 'active' }); }, 2000);
    };
    const stop = connectLive({
      onTransition: refreshScreen,
      onNotification: () => { void qc.invalidateQueries({ queryKey: ['/notifications'] }); void qc.invalidateQueries({ queryKey: ['/me/work'] }); },
      onCatchUp: refreshScreen,
    });
    return () => { stop(); if (pending) clearTimeout(pending); };
  }, [qc]);
}
