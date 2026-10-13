import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const perms = { current: new Set<string>() };
vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: (p: string) => perms.current.has(p), user: { id: 'u1' } }) }));
vi.mock('../src/components/ui', async (orig) => ({ ...(await orig<object>()), useToast: () => () => {} }));
import { CodeRules, OrgRules, conditionOf } from '../src/components/OrgRules';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
let sent: { url: string; method: string; body: any }[] = [];
const serve = (routes: Record<string, unknown>, posts: Record<string, unknown> = {}) => {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== 'GET') {
      sent.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null });
      const hit = Object.keys(posts).find((k) => url.includes(k));
      return json(hit ? posts[hit] : {}, 201);
    }
    const hit = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.includes(k));
    return hit ? json(routes[hit]) : json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404);
  }));
};
beforeEach(() => { perms.current = new Set(); });

const vocabulary = {
  entities: [{
    entity: 'lead', labelFa: 'سرنخ',
    transitions: [{ action: 'contact', labelFa: 'تماس' }, { action: 'qualify', labelFa: 'واجد شرایط' }],
    fields: [
      { key: 'estimatedValue', labelFa: 'ارزش برآوردی', type: 'number' },
      { key: 'phone', labelFa: 'تلفن', type: 'text' },
      { key: 'ownerId', labelFa: 'مالک', type: 'id' },
      { key: 'actor.id', labelFa: 'انجام‌دهندهٔ این انتقال', type: 'id' },
    ],
  }],
  roles: ['SALES_MANAGER'], operators: [],
};
const rule = {
  id: 'r1', code: 'RUL-000001', version: 2, kind: 'GUARD', entity: 'lead', action: 'qualify', labelFa: 'ارزش برآوردی دست‌کم یک میلیارد',
  messageFa: null, when: { field: 'estimatedValue', op: 'gte', value: 1000000000 }, notifyRoles: [], entityFa: 'سرنخ', transitionFa: 'واجد شرایط',
  whenFa: '«ارزش برآوردی» بزرگ‌تر یا مساوی 1000000000 باشد', createdByName: 'فرشاد بهرامی', createdAt: '2026-09-29T08:00:00Z', current: true, retiredAt: null,
};

describe('The organisation’s rules', () => {
  it('reads each rule back in Persian to everyone, and offers writing only to who keeps the rules', async () => {
    serve({ '/rules/custom': [rule] });
    wrap(<OrgRules />);
    const list = await screen.findByTestId('org-rules');
    expect(list.textContent).toContain('انتقال فقط وقتی مجاز است که «ارزش برآوردی» بزرگ‌تر یا مساوی ۱۰۰۰۰۰۰۰۰۰ باشد');
    expect(list.textContent).toContain('سرنخ ← واجد شرایط');
    expect(screen.queryByText('قانون تازه')).toBeNull();
    expect(screen.queryByText('نسخهٔ تازه')).toBeNull();
    expect(screen.getByText('نسخه‌ها')).toBeTruthy();
  });

  it('builds a condition from fields and comparisons, reads it back, tries it, and publishes it', async () => {
    perms.current = new Set(['rules.manage']);
    serve({ '/rules/custom/vocabulary': vocabulary, '/rules/custom': [] }, {
      '/rules/custom/test': { holds: false, verdictFa: 'برقرار نیست — این قانون انتقال را نگه می‌دارد', values: { estimatedValue: 5000000, 'actor.id': 'u1', ownerId: 'u2' } },
      '/rules/custom/replay': { replayed: 40, count: 12, meaningFa: 'انتقال‌هایی که این قانون نگه می‌داشت', hits: [{ code: 'LEAD-000003' }], assumptionFa: 'هر رکورد با مقدارهای امروزش سنجیده شد.' },
      '/rules/custom': { code: 'RUL-000002' },
    });
    wrap(<OrgRules />);
    fireEvent.click(await screen.findByText('قانون تازه'));
    await screen.findByTestId('rule-editor');
    fireEvent.change(screen.getByLabelText('انتقال'), { target: { value: 'qualify' } });
    fireEvent.change(screen.getByLabelText('نام قانون'), { target: { value: 'سرنخ بزرگ را مالکش واجد شرایط کند' } });
    fireEvent.click(screen.getByText('افزودن شرط'));
    fireEvent.change(screen.getByLabelText('مقدار شرط ۱'), { target: { value: '1,000,000,000' } });
    fireEvent.click(screen.getByText('افزودن شرط'));
    fireEvent.change(screen.getByLabelText('فیلد شرط ۲'), { target: { value: 'actor.id' } });
    fireEvent.change(screen.getByLabelText('سنجش شرط ۲'), { target: { value: 'eqField' } });
    fireEvent.change(screen.getByLabelText('مقدار شرط ۲'), { target: { value: 'ownerId' } });
    fireEvent.change(screen.getByLabelText('ترکیب شرط‌ها'), { target: { value: 'any' } });
    expect(screen.getByTestId('rule-reading').textContent)
      .toBe('انتقال فقط وقتی مجاز است که «ارزش برآوردی» بزرگ‌تر یا مساوی ۱۰۰۰۰۰۰۰۰۰ باشد یا «انجام‌دهندهٔ این انتقال» همان مقدار فیلد «مالک» باشد.');

    fireEvent.change(screen.getByLabelText('کد رکورد برای آزمون'), { target: { value: 'LEAD-000007' } });
    fireEvent.click(screen.getByText('آزمون روی این رکورد'));
    expect((await screen.findByTestId('rule-tried')).textContent).toContain('ارزش برآوردی: 5000000');
    fireEvent.click(screen.getByText('سنجش روی سابقه'));
    expect((await screen.findByTestId('rule-replayed')).textContent).toContain('از ۴۰ انتقالِ گذشته، ۱۲ مورد');

    fireEvent.click(screen.getByText('انتشار'));
    await waitFor(() => expect(sent.at(-1)?.url).toMatch(/\/rules\/custom$/));
    expect(sent.at(-1)!.body).toEqual({
      kind: 'GUARD', entity: 'lead', action: 'qualify', labelFa: 'سرنخ بزرگ را مالکش واجد شرایط کند', messageFa: null,
      when: { any: [{ field: 'estimatedValue', op: 'gte', value: 1000000000 }, { field: 'actor.id', op: 'eqField', value: 'ownerId' }] },
    });
    expect(sent.find((s) => s.url.includes('/test'))!.body.recordId).toBe('LEAD-000007');
  });

  it('publishes a change as the next version of the same rule', async () => {
    perms.current = new Set(['rules.manage']);
    serve({ '/rules/custom/vocabulary': vocabulary, '/rules/custom': [rule] });
    wrap(<OrgRules />);
    fireEvent.click(await screen.findByText('نسخهٔ تازه'));
    await screen.findByTestId('rule-editor');
    expect((screen.getByLabelText('مقدار شرط ۱') as HTMLInputElement).value).toBe('1000000000');
    fireEvent.change(screen.getByLabelText('مقدار شرط ۱'), { target: { value: '500000000' } });
    fireEvent.click(screen.getByText('انتشار نسخهٔ تازه'));
    await waitFor(() => expect(sent.at(-1)).toMatchObject({ method: 'PUT', url: expect.stringContaining('/rules/custom/RUL-000001') }));
    expect(sent.at(-1)!.body.when).toEqual({ field: 'estimatedValue', op: 'gte', value: 500000000 });
  });

  it('writes a single condition alone, several joined, and drops the value where the comparison takes none', () => {
    expect(conditionOf({ join: 'all', leaves: [] })).toBeNull();
    expect(conditionOf({ join: 'all', leaves: [{ field: 'phone', op: 'isSet', value: 'x' }] })).toEqual({ field: 'phone', op: 'isSet' });
    expect(conditionOf({ join: 'all', leaves: [{ field: 'a', op: 'eq', value: '1' }, { field: 'b', op: 'isEmpty' }] })).toEqual({ all: [{ field: 'a', op: 'eq', value: '1' }, { field: 'b', op: 'isEmpty' }] });
  });
});

describe('The rules that come as code', () => {
  it('lists installed extensions with what they add, and Doc_H’s own guards', async () => {
    serve({
      '/rules/registry': {
        extensions: [{ name: 'acme', version: '1.0.0', descriptionFa: 'نمونه', guards: ['acme.budgetWithinContract'], attachments: ['project.activate+acme.budgetWithinContract'], effects: ['deliverable.deliver+acme.shareDeliveredFiles'] }],
        guards: [{ key: 'brief.isComplete', labelFa: 'بریف کامل است', source: 'core', extension: null }, { key: 'acme.budgetWithinContract', labelFa: 'بودجه در سقف قرارداد', source: 'extension', extension: 'acme' }],
        attachments: [{ entity: 'project', action: 'activate', transitionFa: 'فعال‌سازی', guard: 'acme.budgetWithinContract', source: 'extension', extension: 'acme' }],
        effects: [{ key: 'acme.shareDeliveredFiles', labelFa: 'اشتراک فایل‌ها در پورتال', transitionFa: 'تحویل به مشتری', entity: 'deliverable', extension: 'acme' }],
        custom: 0,
      },
    });
    wrap(<CodeRules />);
    const ext = await screen.findByTestId('extensions');
    expect(ext.textContent).toContain('شرط «بودجه در سقف قرارداد» روی «فعال‌سازی»');
    expect(ext.textContent).toContain('اثر «اشتراک فایل‌ها در پورتال» پس از «تحویل به مشتری»');
    expect(screen.getByTestId('core-guards').textContent).toBe('· بریف کامل است');
  });
});
