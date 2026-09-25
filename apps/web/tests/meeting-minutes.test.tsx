import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MinutesDialog } from '../src/components/MeetingMinutes';

const meeting = {
  id: 'm1', code: 'MTG-000009', subject: 'هماهنگی کمپین پاییز', heldAt: '2026-09-20T09:00:00Z', kind: 'INTERNAL',
  attendees: 'تیم پروژه', decisions: null, minutesRecordedAt: null, actions: [],
};
const draft = {
  meetingId: 'm1', projectId: 'p1', canCreateTasks: true,
  decisions: [{ text: 'مفهوم دوم انتخاب شد' }],
  actions: [
    {
      title: 'نسخهٔ نهایی پوستر', assigneeId: 'u-behrad', assigneeName: 'بهراد مهرنیا', ownerRaw: 'بهراد مهرنیا', candidates: [],
      departmentCode: 'CR', dueDate: '2026-09-27T00:00:00.000Z', dueRaw: 'تا شنبه', confidence: 'HIGH', sourceLine: 'بهراد مهرنیا نسخهٔ نهایی پوستر را تا شنبه بفرستد',
    },
    {
      title: 'گزارش رقبا', assigneeId: null, assigneeName: null, ownerRaw: 'آرش',
      candidates: [{ id: 'u-arash1', fullName: 'آرش نیک‌بین' }, { id: 'u-arash2', fullName: 'آرش کاظمی' }],
      departmentCode: null, dueDate: null, dueRaw: null, confidence: 'LOW', sourceLine: 'آرش گزارش رقبا را آماده کند',
    },
  ],
  unresolvedFa: ['باید با مشتری دربارهٔ بودجه صحبت شود'],
};

describe('MinutesDialog', () => {
  it('drafts from notes, asks which of two people was meant, and sends only what the person confirmed', async () => {
    const posted: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
      if (url.includes('/meetings/capabilities')) return json({ transcription: false });
      if (url.includes('/users')) return json({ items: [], total: 0, page: 1, pageSize: 200, pageCount: 0 });
      if (url.includes('/draft-minutes')) { posted.push({ url, body: JSON.parse(String(init?.body)) }); return json(draft); }
      if (url.includes('/minutes')) { posted.push({ url, body: JSON.parse(String(init?.body)) }); return json({ meeting, tasks: [{}, {}] }, 201); }
      return json({});
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MinutesDialog meeting={meeting} onClose={() => {}} /></QueryClientProvider>);

    expect(await screen.findByText(/رونویسی صوت پیکربندی نشده/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('یادداشت‌های جلسه'), { target: { value: 'بهراد مهرنیا نسخهٔ نهایی پوستر را تا شنبه بفرستد\nآرش گزارش رقبا را آماده کند' } });
    fireEvent.click(screen.getByText('ساخت پیش‌نویس'));

    const box = await screen.findByTestId('minutes-draft');
    expect((screen.getByLabelText('تصمیم‌ها') as HTMLTextAreaElement).value).toBe('مفهوم دوم انتخاب شد');
    const cards = screen.getAllByTestId('minutes-action');
    expect(cards).toHaveLength(2);
    // The ambiguous owner is a choice between the two real people, not a guess.
    const pick = cards[1].querySelector('select[aria-label="مسئول"]') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['— کدام آرش؟ —', 'آرش نیک‌بین', 'آرش کاظمی']);
    expect(box.textContent).toContain('باید با مشتری دربارهٔ بودجه صحبت شود');
    fireEvent.change(pick, { target: { value: 'u-arash1' } });

    // The first action stays a record only.
    fireEvent.click(cards[0].querySelector('input[type="checkbox"]')!);
    fireEvent.click(screen.getByText(/ثبت صورتجلسه/, { selector: 'button' }));

    await waitFor(() => expect(posted.some((p) => p.url.endsWith('/meetings/m1/minutes'))).toBe(true));
    const sent = posted.find((p) => p.url.endsWith('/meetings/m1/minutes'))!.body;
    expect(sent.decisions).toBe('مفهوم دوم انتخاب شد');
    expect(sent.source).toContain('آرش گزارش رقبا');
    expect(sent.actions).toEqual([
      { title: 'نسخهٔ نهایی پوستر', assigneeId: 'u-behrad', departmentCode: 'CR', dueDate: '2026-09-27T00:00:00.000Z', createTask: false },
      { title: 'گزارش رقبا', assigneeId: 'u-arash1', departmentCode: undefined, dueDate: undefined, createTask: true },
    ].map((a) => JSON.parse(JSON.stringify(a))));
  });
});
