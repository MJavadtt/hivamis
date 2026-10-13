import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatModelStatus } from '@hiva/contracts';
import { ModelCard } from '../src/components/ModelStatus';

/** Audit F-1: the administrator sees the model the installation runs, its size, and its load. */

const base: ChatModelStatus = {
  mode: 'ollama', ready: true, reachable: true, modelPresent: true, model: 'qwen3:8b',
  parameterSize: '8.2B', quantization: 'Q4_K_M', sizeBytes: 5.2 * 1024 ** 3,
  loaded: true, vramBytes: 2.6 * 1024 ** 3, loadedUntil: '2026-10-13T12:00:00Z', busy: 1, waiting: 2,
};

function show(status: ChatModelStatus) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ModelCard /></QueryClientProvider>);
  return screen.findByTestId('model-card');
}

afterEach(() => vi.unstubAllGlobals());

describe('The model card', () => {
  it('shows the model, its size, how much of it is on the GPU, and the queue', async () => {
    const card = (await show(base)).textContent!;
    expect(card).toContain('qwen3:8b');
    expect(card).toContain('آماده');
    expect(card).toContain('8.2B · Q4_K_M');
    expect(card).toContain('۵٫۲ گیگابایت');
    expect(card).toContain('بخشی روی GPU (۲٫۶ گیگابایت)');
    expect(card).toMatch(/در حال پاسخ\s*۱/);
    expect(card).toMatch(/در صف\s*۲/);
  });

  it('says what is wrong when it cannot answer: the server silent, or the model missing', async () => {
    expect((await show({ ...base, ready: false, reachable: false, modelPresent: false, loaded: false })).textContent).toContain('سرور مدل پاسخ نمی‌دهد');
  });

  it('says so when the model is missing from the server', async () => {
    expect((await show({ ...base, ready: false, modelPresent: false, loaded: false })).textContent).toContain('مدل روی سرور نیست');
  });

  it('says when the model is not loaded, so the next question will be slower', async () => {
    expect((await show({ ...base, loaded: false, vramBytes: null })).textContent).toContain('بارگذاری نشده');
  });
});
