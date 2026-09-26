import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: () => true }) }));
import { ESignCard } from '../src/components/ESign';
import ESignSandbox from '../src/pages/ESignSandbox';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const options = {
  mode: 'sandbox', state: 'PENDING_SIGNATURE', eligible: true, inFlight: null, mailOn: false,
  documents: [{ id: 'doc1', fileName: 'contract.pdf' }],
  contacts: [{ id: 'c1', fullName: 'مریم احمدی', email: 'maryam@sign.example' }],
  signatories: [{ id: 'u1', fullName: 'سعید تقوی', email: 'legal@hiva.local' }],
};
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ESignCard contractId="k1" /></QueryClientProvider>);

describe('Signing a contract electronically', () => {
  it('says plainly that the sandbox is not a signature, sends with the chosen signers, and hands the links over once', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ envelope: { code: 'ESG-000001' }, links: [{ name: 'مریم احمدی', email: 'maryam@sign.example', url: 'http://localhost:5173/esign-sandbox/aaa' }, { name: 'سعید تقوی', email: 'legal@hiva.local', url: 'http://localhost:5173/esign-sandbox/bbb' }] }, 201);
      }
      if (url.includes('signature-options')) return json(options);
      return json([]);
    }));
    mount();
    expect((await screen.findByTestId('esign')).textContent).toContain('امضای حقوقی نیست');
    fireEvent.click(screen.getByText('فرستادن برای امضا'));
    expect((await screen.findByTestId('esign-links')).textContent).toContain('/esign-sandbox/bbb');
    expect(posts[0]).toEqual({ url: expect.stringContaining('/contracts/k1/signatures'), body: { documentId: 'doc1', clientContactId: 'c1', agencyUserId: 'u1', expiresInDays: 14 } });
  });

  it('shows each signer, the certificate the provider reported, and the signed file', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('signature-options')) return json({ ...options, eligible: false, state: 'SIGNED' });
      return json([{
        id: 'e1', code: 'ESG-000001', status: 'COMPLETED', provider: 'http', createdAt: '2026-09-27T08:00:00Z', createdBy: { fullName: 'سعید تقوی' },
        document: { id: 'doc1', fileName: 'contract.pdf' }, signedDocument: { id: 'doc2', fileName: 'CNT-1-ESG-000001-signed.pdf' },
        originalSha256: 'a'.repeat(64), signedSha256: 'b'.repeat(64), transitionError: null,
        signers: [{ id: 's1', order: 1, name: 'مریم احمدی', email: 'maryam@sign.example', status: 'SIGNED', signedAt: '2026-09-28T08:00:00Z', certificate: { subject: 'CN=Maryam Ahmadi', issuer: 'CA-1', serial: '01AB' } }],
        events: [{ kind: 'SENT', at: '2026-09-27T08:00:00Z' }, { kind: 'COMPLETED', at: '2026-09-28T08:00:00Z' }, { kind: 'APPLIED', at: '2026-09-28T08:00:01Z' }],
      }]);
    }));
    mount();
    const env = await screen.findByTestId('esign-envelope');
    expect(env.textContent).toContain('امضا شد');
    expect(env.textContent).toContain('CN=Maryam Ahmadi');
    expect(env.textContent).toContain('قرارداد امضاشده ثبت شد');
    expect(screen.getByText('فایل امضاشده')).toBeTruthy();
    expect(screen.queryByTestId('esign-form')).toBeNull();
  });
});

describe('The sandbox signing page', () => {
  const view = (over: Record<string, unknown> = {}) => ({
    sandbox: true, issuer: 'Hiva Sandbox CA — آزمایشی، بدون اعتبار حقوقی', organization: 'هیوا', envelope: 'ESG-000001', status: 'SENT', expiresAt: '2026-10-10T00:00:00Z',
    contract: { title: 'قرارداد خدمات', code: 'CNT-000009' }, document: { fileName: 'contract.pdf', sha256: 'a'.repeat(64) },
    signer: { name: 'مریم احمدی', email: 'maryam@sign.example', party: 'CLIENT', status: 'PENDING', signedAt: null },
    signers: [{ order: 1, name: 'مریم احمدی', party: 'CLIENT', status: 'PENDING', signedAt: null }, { order: 2, name: 'سعید تقوی', party: 'AGENCY', status: 'PENDING', signedAt: null }],
    waitingFor: null, ...over,
  });

  it('carries the sandbox banner, waits its turn, and signs with a name and the acknowledgement', async () => {
    let signed = false;
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push({ url: String(input), body: JSON.parse(String(init.body)) }); signed = true; return json({ status: 'SENT' }); }
      return json(signed ? view({ signer: { ...view().signer, status: 'SIGNED', signedAt: '2026-09-28T08:00:00Z' } }) : view());
    }));
    render(<ESignSandbox token={'t'.repeat(43)} />);
    expect((await screen.findByTestId('esign-sandbox-banner')).textContent).toContain('امضای حقوقی نیست');
    const button = () => screen.getByText('امضای آزمایشی').closest('button') as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('نام امضاکننده'), { target: { value: 'مریم احمدی' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button());
    expect((await screen.findByTestId('esign-sandbox-done')).textContent).toContain('ثبت شد');
    expect(posts[0]).toEqual({ url: expect.stringContaining('/sign'), body: { signerName: 'مریم احمدی', confirm: true } });
  });

  it('tells the second signer who has to sign first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(view({ signer: { name: 'سعید تقوی', email: 'legal@hiva.local', party: 'AGENCY', status: 'PENDING', signedAt: null }, waitingFor: 'مریم احمدی' }))));
    render(<ESignSandbox token={'t'.repeat(43)} />);
    await waitFor(() => expect(screen.getByTestId('esign-sandbox-wait').textContent).toContain('نخست مریم احمدی'));
  });
});
