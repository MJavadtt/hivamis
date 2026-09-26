import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiKeys, Webhooks } from '../src/components/Integrations';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe('Integrations', () => {
  it('creates a key from what the admin may grant, and shows its secret exactly once', async () => {
    const posted: any[] = [];
    let keys: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        keys = [{ id: 'k1', name: 'حسابداری', display: 'hiva_abcdefghij_…', permissions: ['finance.read'], rateLimitPerMinute: 60, expiresAt: null, lastUsedAt: null, lastUsedIp: null, status: 'ACTIVE', revokeReason: null, createdAt: '2026-09-26T08:00:00Z', createdBy: { fullName: 'مدیر سیستم' } }];
        return json({ id: 'k1', key: 'hiva_abcdefghij_SECRETSECRETSECRETSECRETSECRETSECRETSECRET123' }, 201);
      }
      if (url.includes('/grantable')) return json([{ code: 'finance.read', labelFa: 'مشاهده اطلاعات مالی' }, { code: 'project.read', labelFa: 'مشاهده پروژه' }]);
      return json(keys);
    }));
    wrap(<ApiKeys />);
    fireEvent.click(await screen.findByText('کلید تازه'));
    fireEvent.change(screen.getByLabelText('نام کلید'), { target: { value: 'حسابداری' } });
    const list = await screen.findByTestId('grantable');
    await waitFor(() => expect(list.textContent).toContain('مشاهده اطلاعات مالی'));
    expect(list.textContent).not.toContain('admin.keys');
    fireEvent.click(within(list).getAllByRole('checkbox')[0]!);
    fireEvent.click(screen.getByText('ساخت'));
    expect((await screen.findByTestId('once-secret')).textContent).toContain('SECRETSECRET');
    expect(posted[0]).toEqual({ name: 'حسابداری', permissions: ['finance.read'], rateLimitPerMinute: 60 });
    fireEvent.click(screen.getByText('ذخیره کردم'));
    const rows = await screen.findByTestId('api-keys');
    expect(rows.textContent).toContain('hiva_abcdefghij_…');
    expect(document.body.textContent).not.toContain('SECRETSECRET');                  // gone once the dialog closes
  });

  it('offers only events the admin may read, and "all" of an entity instead of each of its moves', async () => {
    const posted: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return json({ id: 'w1', secret: 'whsec_abc' }, 201); }
      if (url.includes('/events')) return json([
        { event: 'invoice.issue', entity: 'invoice', entityLabelFa: 'سند مالی', labelFa: 'صدور', allowed: true },
        { event: 'invoice.cancel', entity: 'invoice', entityLabelFa: 'سند مالی', labelFa: 'ابطال', allowed: true },
        { event: 'contract.sign', entity: 'contract', entityLabelFa: 'قرارداد', labelFa: 'امضا', allowed: false },
      ]);
      return json([]);
    }));
    wrap(<Webhooks />);
    fireEvent.click(await screen.findByText('Webhook تازه'));
    const picker = await screen.findByTestId('event-picker');
    await waitFor(() => expect(picker.textContent).toContain('صدور'));
    expect((within(picker).getByText(/قرارداد — همهٔ گذارها/).closest('label')!.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(picker).getByText(/سند مالی — همهٔ گذارها/));
    expect(picker.textContent).not.toContain('صدور');                                 // all of it, not each move
    fireEvent.change(screen.getByLabelText('نام Webhook'), { target: { value: 'حسابداری' } });
    fireEvent.change(screen.getByLabelText('نشانی'), { target: { value: 'https://acc.example.com/hiva' } });
    fireEvent.click(screen.getByText('ساخت'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ name: 'حسابداری', url: 'https://acc.example.com/hiva', events: ['invoice.*'] });
    expect((await screen.findByTestId('once-secret')).textContent).toBe('whsec_abc');
  });
});
