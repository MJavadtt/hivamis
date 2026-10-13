import { env } from '../env.js';

/**
 * A local language model served by Ollama (Hivamis task 5): free, unlimited, and on the
 * organisation's own machine — nothing said to it leaves the network. The address and model are
 * settings, not constants, so a test can stand in for the server.
 */

export const ollama = { url: env.OLLAMA_URL.replace(/\/$/, ''), model: env.OLLAMA_MODEL };

export interface ToolCall { function: { name: string; arguments: Record<string, unknown> } }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  /** For a tool's answer: which tool it was. */
  tool_name?: string;
}
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } };
}

export interface ModelStatus {
  reachable: boolean; modelPresent: boolean; model: string;
  /** What the model is, from the store: e.g. "8.2B", "Q4_K_M", and its size on disk. */
  parameterSize: string | null; quantization: string | null; sizeBytes: number | null;
  /** Whether it is in memory now, how much of it in GPU memory, and until when it stays (audit F-1). */
  loaded: boolean; vramBytes: number | null; loadedUntil: string | null;
}

interface Listed { name: string; model?: string; size?: number; size_vram?: number; expires_at?: string; details?: { parameter_size?: string; quantization_level?: string } }

const named = (want: string) => (m: Listed) => {
  const full = want.includes(':') ? want : `${want}:latest`;
  return [m.name, m.model].some((n) => n === want || n === full);
};

/** Is the server up, does it have the model, and is the model loaded? Two seconds at most. */
export async function modelStatus(): Promise<ModelStatus> {
  const none: ModelStatus = {
    reachable: false, modelPresent: false, model: ollama.model,
    parameterSize: null, quantization: null, sizeBytes: null, loaded: false, vramBytes: null, loadedUntil: null,
  };
  try {
    const [tags, ps] = await Promise.all([
      fetch(`${ollama.url}/api/tags`, { signal: AbortSignal.timeout(2000) }),
      // What is loaded now. An older server has no /api/ps; the rest of the answer does not need it.
      fetch(`${ollama.url}/api/ps`, { signal: AbortSignal.timeout(2000) }).catch(() => null),
    ]);
    if (!tags.ok) return none;
    const stored = ((await tags.json()) as { models?: Listed[] }).models?.find(named(ollama.model));
    const running = ps?.ok ? ((await ps.json()) as { models?: Listed[] }).models?.find(named(ollama.model)) : undefined;
    return {
      ...none, reachable: true, modelPresent: Boolean(stored),
      parameterSize: stored?.details?.parameter_size ?? null,
      quantization: stored?.details?.quantization_level ?? null,
      sizeBytes: stored?.size ?? null,
      loaded: Boolean(running), vramBytes: running?.size_vram ?? null, loadedUntil: running?.expires_at ?? null,
    };
  } catch {
    return none;
  }
}

export interface Chunk { delta?: string; toolCalls?: ToolCall[]; done?: { tokensIn: number | null; tokensOut: number | null } }

/**
 * One turn of the model, streamed. Thinking is turned off: a person waiting for a reply on a laptop
 * is better served by an answer now than by a better-reasoned one in a minute.
 */
export async function* chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncGenerator<Chunk> {
  const res = await fetch(`${ollama.url}/api/chat`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ollama.model, messages, tools, stream: true, think: false,
      options: { temperature: 0.3, num_ctx: 8192 },
      keep_alive: '30m',
    }),
  });
  if (!res.ok || !res.body) throw new Error(`ollama ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const part = JSON.parse(line) as {
        message?: { content?: string; tool_calls?: ToolCall[] }; done?: boolean; error?: string;
        prompt_eval_count?: number; eval_count?: number;
      };
      if (part.error) throw new Error(`ollama: ${part.error}`);
      if (part.message?.content) yield { delta: part.message.content };
      if (part.message?.tool_calls?.length) yield { toolCalls: part.message.tool_calls };
      if (part.done) yield { done: { tokensIn: part.prompt_eval_count ?? null, tokensOut: part.eval_count ?? null } };
    }
  }
}

/** One answer at a time per slot; the rest wait in order and can see their place. */
export class Turns {
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly slots: number) {}
  get busy() { return this.running; }
  get queued() { return this.waiting.length; }
  /** Resolves when it is this request's turn; `onWait` hears its place while it waits. */
  async acquire(onWait: (position: number) => void, signal: AbortSignal): Promise<() => void> {
    if (this.running < this.slots) { this.running++; return this.release(); }
    await new Promise<void>((resolve, reject) => {
      const go = () => { signal.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => { this.waiting = this.waiting.filter((w) => w !== go); reject(new Error('aborted')); };
      this.waiting.push(go);
      signal.addEventListener('abort', cancel, { once: true });
      onWait(this.waiting.length);
    });
    this.running++;
    return this.release();
  }
  private release() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.running--;
      this.waiting.shift()?.();
    };
  }
}

/**
 * The model's turns, shared by everything that asks it — the chat and writing (audit F-2) — so
 * CHAT_CONCURRENCY counts every answer being written, whichever feature asked.
 */
export const turns = new Turns(env.CHAT_CONCURRENCY);
