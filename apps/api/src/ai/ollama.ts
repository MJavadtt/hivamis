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

export interface ModelStatus { reachable: boolean; modelPresent: boolean; model: string }

/** Is the server up, and does it have the model? Two seconds at most. */
export async function modelStatus(): Promise<ModelStatus> {
  try {
    const res = await fetch(`${ollama.url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { reachable: false, modelPresent: false, model: ollama.model };
    const body = await res.json() as { models?: { name: string; model?: string }[] };
    const names = (body.models ?? []).flatMap((m) => [m.name, m.model ?? '']);
    const want = ollama.model.includes(':') ? ollama.model : `${ollama.model}:latest`;
    return { reachable: true, modelPresent: names.includes(want) || names.includes(ollama.model), model: ollama.model };
  } catch {
    return { reachable: false, modelPresent: false, model: ollama.model };
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
