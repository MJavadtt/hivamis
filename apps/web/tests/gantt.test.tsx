import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { Gantt } from '../src/components/Gantt';

/** The chart's one job: make the critical chain unmistakable, and show the float everyone else has. */
const ME = { id: 'u', email: 'p@hiva.local', fullName: 'PMO', jobTitle: '', departmentCode: 'OP', roles: [], permissions: ['project.read', 'task.write'], locale: 'fa' };
const schedule = {
  projectId: 'p1', start: '2026-09-26T05:30:00Z', plannedEnd: '2026-09-30T13:30:00Z', projectedEnd: '2026-10-03T05:30:00Z', slipHours: 12, criticalPath: ['a', 'b'],
  cycles: [],
  tasks: [
    { taskId: 'a', code: 'TSK-000001', title: 'استراتژی', state: 'ASSIGNED', assigneeName: null, departmentCode: 'ST', estimateHours: 24, estimateAssumed: false, earliestStart: '2026-09-26T05:30:00Z', earliestFinish: '2026-09-29T05:30:00Z', latestStart: '2026-09-26T05:30:00Z', latestFinish: '2026-09-29T05:30:00Z', floatHours: 0, critical: true, dueDate: null, missesDueDate: false, prerequisites: [], done: false },
    { taskId: 'b', code: 'TSK-000002', title: 'طراحی', state: 'ASSIGNED', assigneeName: null, departmentCode: 'CR', estimateHours: 24, estimateAssumed: false, earliestStart: '2026-09-29T05:30:00Z', earliestFinish: '2026-10-03T05:30:00Z', latestStart: '2026-09-29T05:30:00Z', latestFinish: '2026-10-03T05:30:00Z', floatHours: 0, critical: true, dueDate: '2026-09-30T13:30:00Z', missesDueDate: true, prerequisites: ['a'], done: false },
    { taskId: 'd', code: 'TSK-000004', title: 'لوگو', state: 'ASSIGNED', assigneeName: null, departmentCode: 'CR', estimateHours: 4, estimateAssumed: false, earliestStart: '2026-09-26T05:30:00Z', earliestFinish: '2026-09-26T09:30:00Z', latestStart: '2026-10-02T05:30:00Z', latestFinish: '2026-10-03T05:30:00Z', floatHours: 36, critical: false, dueDate: null, missesDueDate: false, prerequisites: [], done: false },
  ],
};
function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
beforeEach(() => { setAccessToken('t'); markSignedIn(true); });

describe('Gantt', () => {
  it('draws the critical chain in red, the float as a lighter stretch, and names the slip', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return json({ accessToken: 't', refreshToken: 'r' });
      if (url.includes('/auth/me')) return json(ME);
      return json(schedule);
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ToastProvider><AuthProvider><Gantt projectId="p1" /></AuthProvider></ToastProvider></QueryClientProvider>);
    const svg = await screen.findByTestId('gantt');
    const bars = [...svg.querySelectorAll('[data-testid="gantt-bar"]')];
    expect(bars).toHaveLength(3);
    expect(bars.filter((b) => b.getAttribute('data-critical') === 'true')).toHaveLength(2);
    expect(bars[0]!.querySelector('rect:last-of-type')!.getAttribute('fill')).toBe('#e11d48');
    // The floating task has a float rectangle; a critical one does not.
    expect(bars[2]!.querySelectorAll('rect')).toHaveLength(2);
    expect(bars[0]!.querySelectorAll('rect')).toHaveLength(1);
    expect(screen.getByText(/۱۲ س کاری دیرتر از برنامه/)).toBeTruthy();
    expect(screen.getByTestId('dependencies').textContent).toContain('طراحی');
  });
});
