import { ApiError, baseHeaders, refreshSession } from './api';
import { trx } from '../i18n';

/**
 * Talking to the assistant (Hivamis task 5). The answer arrives as server-sent events over a POST —
 * read here from the response body, since EventSource cannot send one.
 */

export interface ChatAction { type: 'form' | 'link'; label: string; code?: string; prefill?: Record<string, string>; path?: string }
export type ChatEvent =
  | { event: 'meta'; data: { conversationId: string; model: string } }
  | { event: 'queue'; data: { position: number } }
  | { event: 'tool'; data: { name: string; args: Record<string, unknown> } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'action'; data: ChatAction }
  | { event: 'done'; data: { messageId: string; actions: ChatAction[] } }
  | { event: 'error'; data: { code: string; message: string } };

export interface ChatRequest {
  conversationId?: string | null;
  message: string;
  context?: { path?: string | null; entity?: string | null; id?: string | null; title?: string | null } | null;
}

export async function streamChat(body: ChatRequest, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const send = () => fetch('/api/v1/ai/chat', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...baseHeaders() },
    body: JSON.stringify(body),
  });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  if (!res.ok || !res.body) {
    let error = { code: 'UNKNOWN', message: `HTTP ${res.status}` };
    try { const parsed = await res.json(); if (parsed?.error) error = parsed.error; } catch { /* not JSON */ }
    throw new ApiError(res.status, { ...error, message: trx(error.message) });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (\w+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) onEvent({ event, data: JSON.parse(data) } as ChatEvent);
    }
  }
}
