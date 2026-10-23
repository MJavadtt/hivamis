import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { AssistantButton } from '../src/components/AssistantChat';
import { spoken } from '../src/lib/voice';

/**
 * Audit F-4: speaking to the assistant, and approving what it proposes. What was said comes back as
 * text for the person to send; a plan writes nothing until its steps are ticked and confirmed, and
 * then says what became of each.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (events: [string, unknown][]) => new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const ME = { id: 'u1', email: 'd@hiva.local', fullName: 'دنیا', jobTitle: null, department: { code: 'CR', nameFa: 'خلاقیت' }, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['DESIGNER'], permissions: ['ai.chat'], locale: 'fa', mustChangePassword: false };
const READY = { mode: 'ollama', ready: true, model: 'qwen3:14b', reachable: true, modelPresent: true, busy: 0, waiting: 0 };
const PLAN = {
  type: 'plan', label: 'تغییرات پیشنهادی', planId: 'p1',
  steps: [
    { kind: 'task_submit', summary: 'تحویل خروجی: وظیفهٔ «پیش‌نویس لوگو» (TSK-000123)', request: { method: 'POST', path: '/workflow/task/t1/transitions', body: { action: 'submit' } } },
    { kind: 'log_time', summary: 'ثبت ۳ ساعت کار روی «پیش‌نویس لوگو» (TSK-000123) برای ۱۴۰۵/۰۷/۲۱', request: { method: 'POST', path: '/tasks/t1/time', body: { hours: 3, workedOn: '2026-10-13' } } },
    { kind: 'create_task', summary: 'ساخت وظیفهٔ «نسخهٔ نهایی» در PRJ-000016', request: { method: 'POST', path: '/tasks', body: {} }, issue: 'Doc_H §6: هر وظیفه از سند مبدأش می‌آید.' },
  ],
};

function mount({ voice = true, plan = { status: 'PROPOSED', outcome: null, expired: false } as Record<string, unknown> } = {}) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    sent.push({ method: init?.method ?? 'GET', path: p, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(ME);
    if (p === '/ai/chat/status') return json(READY);
    if (p === '/ai/voice/status') return json({ configured: voice });
    if (p === '/ai/voice/transcribe') return json({ text: 'امروز پیش‌نویس لوگو را تمام کردم و سه ساعت رویش کار کردم' });
    if (p === '/ai/chat') return sse([['meta', { conversationId: 'c1', model: 'qwen3:14b' }], ['action', PLAN], ['delta', { text: 'دو کار آماده است؛ بررسی و تأیید کنید.' }], ['done', { messageId: 'm1', actions: [PLAN] }]]);
    if (p === '/ai/plans/p1') return json(plan);
    if (p === '/ai/plans/p1/execute') return json({ status: 'PARTIAL', outcome: [{ index: 0, status: 'DONE' }, { index: 1, status: 'FAILED', code: 'WORKFLOW', message: 'وظیفه در این وضعیت نیست.' }, { index: 2, status: 'DECLINED' }] });
    if (p === '/ai/plans/p1/decline') return json({ status: 'DECLINED', outcome: [0, 1, 2].map((index) => ({ index, status: 'DECLINED' })) });
    return json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter><AssistantButton /></MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

async function ask(text: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'دستیار' }));
  const box = await screen.findByRole('textbox', { name: 'پیام به دستیار' });
  fireEvent.change(box, { target: { value: text } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'فرستادن' }).hasAttribute('disabled')).toBe(false));
  fireEvent.keyDown(box, { key: 'Enter' });
  return screen.findByTestId('plan');
}

/** A browser that records: the microphone, and a recorder that hands back what it heard on stop. */
function microphone() {
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  class Recorder {
    static isTypeSupported = (t: string) => t === 'audio/webm;codecs=opus';
    state = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(public stream: unknown, public opts?: { mimeType?: string }) {}
    get mimeType() { return this.opts?.mimeType ?? ''; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['opus'], { type: this.mimeType }) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  return { getUserMedia, stopTrack };
}

afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, 'mediaDevices'); Reflect.deleteProperty(window, 'speechSynthesis'); });

describe('Proposed changes', () => {
  it('shows each step with what it will write, and runs only the ticked ones on confirmation', async () => {
    const sent = mount();
    const card = await ask('امروز پیش‌نویس لوگو را تمام کردم و سه ساعت رویش کار کردم');
    expect(within(card).getByText('هیچ‌کدام انجام نشده است. آنچه را می‌خواهید علامت بزنید و «انجام موارد انتخاب‌شده» را بزنید — یا بنویسید «بله»؛ هر مورد با نام شما و مثل صفحهٔ خودش انجام می‌شود.')).toBeDefined();
    const boxes = within(card).getAllByRole('checkbox') as HTMLInputElement[];
    await waitFor(() => expect(boxes[0]!.disabled).toBe(false));
    // The step that cannot be approved says why, and cannot be ticked.
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[true, false], [true, false], [false, true]]);
    expect(within(card).getByText('انجام‌شدنی نیست: Doc_H §6: هر وظیفه از سند مبدأش می‌آید.')).toBeDefined();
    // The exact request, for whoever wants to see it.
    expect(card.textContent).toContain('POST /api/v1/tasks/t1/time');
    expect(card.textContent).toContain('"hours": 3');
    // Nothing has been written yet.
    expect(sent.some((x) => x.path.startsWith('/ai/plans/p1/') || x.path.startsWith('/tasks') || x.path.startsWith('/workflow'))).toBe(false);

    fireEvent.click(within(card).getByRole('button', { name: 'انجام موارد انتخاب‌شده' }));
    await waitFor(() => expect(sent.find((x) => x.path === '/ai/plans/p1/execute')?.body).toEqual({ steps: [0, 1] }));
    const outcomes = await within(card).findAllByTestId('plan-outcome');
    expect(outcomes.map((o) => o.textContent)).toEqual(['انجام شد', 'انجام نشد: وظیفه در این وضعیت نیست.', 'کنار گذاشته شد']);
    // Decided: no second run from the same card.
    expect(within(card).queryByRole('button', { name: 'انجام موارد انتخاب‌شده' })).toBeNull();
  });

  it('runs what is left ticked, and declines the lot with "none"', async () => {
    const sent = mount();
    const card = await ask('ثبت کن');
    const boxes = within(card).getAllByRole('checkbox');
    await waitFor(() => expect((boxes[1] as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(boxes[1]!);
    fireEvent.click(within(card).getByRole('button', { name: 'انجام موارد انتخاب‌شده' }));
    await waitFor(() => expect(sent.find((x) => x.path === '/ai/plans/p1/execute')?.body).toEqual({ steps: [0] }));
  });

  it('declines with "none", and a card reopened later says it was decided', async () => {
    const sent = mount();
    const card = await ask('ثبت کن');
    await waitFor(() => expect(within(card).getByRole('button', { name: 'هیچ‌کدام' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(card).getByRole('button', { name: 'هیچ‌کدام' }));
    await waitFor(() => expect(sent.some((x) => x.method === 'POST' && x.path === '/ai/plans/p1/decline')).toBe(true));
    expect(await within(card).findByText('دربارهٔ این پیشنهاد تصمیم گرفته شد.')).toBeDefined();
  });

  it('says when a proposal has gone stale, and offers nothing to run', async () => {
    mount({ plan: { status: 'PROPOSED', outcome: null, expired: true } });
    const card = await ask('ثبت کن');
    expect(await within(card).findByText('این پیشنهاد کهنه شده است؛ اگر هنوز لازم است دوباره بخواهید.')).toBeDefined();
    expect(within(card).queryByRole('button', { name: 'انجام موارد انتخاب‌شده' })).toBeNull();
  });
});

describe('Speaking to the assistant', () => {
  it('records on one press, writes it down on the next, and leaves it for the person to send', async () => {
    const mic = microphone();
    const sent = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'دستیار' }));
    fireEvent.click(await screen.findByRole('button', { name: 'گفتن با صدا' }));
    const stop = await screen.findByRole('button', { name: 'پایان و نوشتن' });
    expect(mic.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(stop);
    const box = screen.getByRole('textbox', { name: 'پیام به دستیار' }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe('امروز پیش‌نویس لوگو را تمام کردم و سه ساعت رویش کار کردم'));
    // The microphone is let go, the audio went to the installation's own route, and nothing was sent.
    expect(mic.stopTrack).toHaveBeenCalled();
    const upload = sent.find((x) => x.path === '/ai/voice/transcribe')!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect((upload.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(sent.some((x) => x.path === '/ai/chat')).toBe(false);
  });

  it('says so when the microphone is refused', async () => {
    const mic = microphone();
    mic.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'دستیار' }));
    fireEvent.click(await screen.findByRole('button', { name: 'گفتن با صدا' }));
    expect((await screen.findByRole('alert')).textContent).toBe('اجازهٔ میکروفون داده نشد. آن را در تنظیمات مرورگر برای این نشانی باز کنید.');
  });

  it('waits, without a second request, while the browser asks; and tells a missing microphone from a refusal', async () => {
    const mic = microphone();
    let answer: (v: unknown) => void = () => {};
    mic.getUserMedia.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'دستیار' }));
    fireEvent.click(await screen.findByRole('button', { name: 'گفتن با صدا' }));
    const asking = await screen.findByRole('button', { name: 'در انتظار اجازهٔ میکروفون…' });
    expect(asking.hasAttribute('disabled')).toBe(true);
    fireEvent.click(asking);
    expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
    answer({ getTracks: () => [{ stop: mic.stopTrack }] });
    await screen.findByRole('button', { name: 'پایان و نوشتن' });

    mic.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' }));
    fireEvent.click(screen.getByRole('button', { name: 'پایان و نوشتن' }));
    fireEvent.click(await screen.findByRole('button', { name: 'گفتن با صدا' }));
    expect((await screen.findByRole('alert')).textContent).toBe('میکروفون در دسترس نیست؛ وصل بودنش را بررسی کنید.');
  });

  it('offers no microphone where the installation has no speech server', async () => {
    microphone();
    mount({ voice: false });
    fireEvent.click(await screen.findByRole('button', { name: 'دستیار' }));
    await screen.findByRole('textbox', { name: 'پیام به دستیار' });
    await waitFor(() => expect(screen.queryByTestId('voice')).toBeNull());
  });

  it('reads a reply aloud only with a voice on the device itself', async () => {
    const said: string[] = [];
    vi.stubGlobal('SpeechSynthesisUtterance', class { voice: unknown; lang = ''; onend: unknown; onerror: unknown; constructor(public text: string) {} });
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [{ lang: 'fa-IR', localService: false, name: 'online' }, { lang: 'fa-IR', localService: true, name: 'device' }],
        speak: (u: { text: string; voice: { name: string } }) => said.push(`${u.voice.name}: ${u.text}`),
        cancel: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      },
    });
    mount();
    await ask('ثبت کن');
    fireEvent.click(await screen.findByRole('button', { name: 'خواندن با صدا' }));
    expect(said).toEqual(['device: دو کار آماده است؛ بررسی و تأیید کنید.']);
  });

  it('reads the words of a reply, not its marks', () => {
    expect(spoken('**دو کار** آماده است:\n\n| کد | وضعیت |\n|---|---|\n| `TSK-1` | باز |\n\n[صفحه](/my-work)')).toBe('دو کار آماده است: کد وضعیت TSK-1 باز صفحه');
  });
});
