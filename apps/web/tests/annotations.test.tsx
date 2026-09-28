import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: () => true, user: { id: 'u1' } }) }));
import { AnnotationsModal, timecodeFa } from '../src/components/Annotations';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const data = {
  deliverable: { id: 'd1', code: 'DLV-1', name: 'پوستر پاییز' },
  files: [
    { id: 'img', fileName: 'poster.png', mimeType: 'image/png', kind: 'image', annotations: 1, version: 1, current: true, lineageId: 'img', metadata: null },
    { id: 'vid', fileName: 'teaser.mp4', mimeType: 'video/mp4', kind: 'video', annotations: 0, version: 1, current: true, lineageId: 'vid', metadata: null },
    { id: 'txt', fileName: 'notes.txt', mimeType: 'text/plain', kind: null, annotations: 0, version: 1, current: true, lineageId: 'txt', metadata: null },
  ],
  annotations: [{
    id: 'a1', documentId: 'img', kind: 'PIN', number: 1, page: null, x: 0.8, y: 0.1, w: null, h: null, timeSec: null, note: 'لوگو کوچک است',
    status: 'OPEN', createdAt: '2026-09-27T08:00:00Z', author: { id: 'u2', fullName: 'سپیده آذر' }, qcReviewId: 'q1', revision: { code: 'REV-000004' },
  }],
};

describe('Annotating a deliverable', () => {
  it('shows the pins on the image and places a new one where it is clicked, as fractions of the image', async () => {
    const posts: { url: string; method: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== 'GET') { posts.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null }); return json({}, 201); }
      if (url.includes('/preview')) return new Response('png');
      return json(data);
    }));
    URL.createObjectURL = vi.fn(() => 'blob:img');
    URL.revokeObjectURL = vi.fn();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AnnotationsModal deliverableId="d1" onClose={() => {}} /></QueryClientProvider>);

    const stage = await screen.findByTestId('image-stage');
    expect(screen.queryByText('notes.txt')).toBeNull();                 // only what can be marked
    expect(screen.getAllByTestId('pin')).toHaveLength(1);
    expect(screen.getByTestId('annotation-list').textContent).toContain('REV-000004');
    stage.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250, x: 100, y: 50, toJSON: () => ({}) });
    fireEvent.click(stage, { clientX: 200, clientY: 100 });
    fireEvent.change(await screen.findByLabelText('متن یادداشت'), { target: { value: 'رنگ پس‌زمینه تیره‌تر شود' } });
    fireEvent.click(screen.getByText('ثبت یادداشت'));
    await waitFor(() => expect(posts[0]).toEqual({
      url: expect.stringContaining('/deliverables/d1/annotations'), method: 'POST',
      body: { kind: 'PIN', documentId: 'img', x: 0.25, y: 0.25, note: 'رنگ پس‌زمینه تیره‌تر شود' },
    }));

    fireEvent.click(screen.getByText('رفع شد'));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: expect.stringContaining('/annotations/a1'), method: 'PATCH', body: { status: 'RESOLVED' } }));
    expect(screen.queryByText('حذف')).toBeNull();                        // carried by a review, and not the viewer's own
  });

  it('writes timecodes in Persian digits', () => {
    expect(timecodeFa(72.9)).toBe('۰۱:۱۲');
  });
});
