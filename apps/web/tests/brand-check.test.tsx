import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: () => true, user: { id: 'u1' } }) }));
vi.mock('../src/components/ui', async (orig) => ({ ...(await orig<object>()), useToast: () => () => {} }));
import { BrandCheckPanel, inkToCss } from '../src/components/BrandCheck';
import { BrandLibraryCard, parseInk } from '../src/components/BrandLibrary';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
let sent: { url: string; method: string; body: any }[] = [];
const serve = (routes: Record<string, unknown>) => {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== 'GET') { sent.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null }); return json({}); }
    if (url.includes('/preview')) return new Response('bytes');
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return hit ? json(routes[hit]) : json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404);
  }));
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
};
beforeEach(() => { sent = []; });

describe('One file against the brand', () => {
  it('names each colour against the brand, the typefaces, and what it could not judge', async () => {
    serve({
      '/documents/d1/brand-check': {
        supported: true, company: { legalName: 'بانک آینده‌سازان' }, noteFa: null,
        check: {
          kind: 'pdf', verdict: 'WARN', offShare: 0.17,
          colours: [
            { hex: '#1A2B3C', share: 0.33, status: 'BRAND', brand: { name: 'سرمه‌ای', hex: '#1A2B3C' }, distance: 0 },
            { hex: '#1F3044', share: 0.17, status: 'NEAR', brand: { name: 'سرمه‌ای', hex: '#1A2B3C' }, distance: 2.2 },
            { hex: '#E63836', share: 0.17, status: 'OFF', brand: { name: 'طلایی', hex: '#D4AF37' }, distance: 43.7 },
            { cmyk: [0, 0, 0, 100], share: 0.17, status: 'NEUTRAL' },
          ],
          fonts: [{ name: 'Helvetica-Bold', share: 0.5, status: 'BRAND', brand: 'Helvetica' }, { name: 'Times-Roman', share: 0.5, status: 'OFF' }],
          spots: [{ name: 'PANTONE 286 C', share: 0.1, status: 'UNCHECKED' }],
          notesFa: ['تصاویر درون PDF خوانده نمی‌شوند — رنگ‌ها از متن و اشکال برداری است'],
        },
      },
    });
    wrap(<BrandCheckPanel documentId="d1" />);
    const panel = await screen.findByTestId('brand-check');
    expect(panel.textContent).toContain('بیرون از برند');
    expect(panel.textContent).toContain('۱۷٪ از رنگ‌گذاری‌ها بیرون از پالت');
    const chips = [...screen.getByTestId('brand-colours').querySelectorAll('li')].map((li) => li.textContent);
    expect(chips).toEqual(['#1A2B3C۳۳٪رنگ برند: سرمه‌ای', '#1F3044۱۷٪نزدیک به رنگ برند: سرمه‌ای', '#E63836۱۷٪بیرون از پالت', 'C0 M0 Y0 K100۱۷٪خنثی']);
    expect(screen.getByTestId('brand-fonts-used').textContent).toBe('فونت‌ها: Helvetica-Bold ✓، Times-Roman (بیرون از برند)');
    expect(panel.textContent).toContain('PANTONE 286 C');
    expect(panel.textContent).toContain('تصاویر درون PDF خوانده نمی‌شوند');
  });

  it('says plainly when the file cannot be judged', async () => {
    serve({ '/documents/d2/brand-check': { supported: false, check: null, company: null, noteFa: 'هویت بصری این نوع فایل سنجیده نمی‌شود؛ فقط PNG، JPEG و PDF.' } });
    wrap(<BrandCheckPanel documentId="d2" />);
    expect((await screen.findByTestId('brand-check')).textContent).toContain('فقط PNG، JPEG و PDF');
  });

  it('shows ink on screen by the naive formula, and reads CMYK as the brand keeper types it', () => {
    expect(inkToCss([0, 0, 0, 100])).toBe('rgb(0, 0, 0)');
    expect(inkToCss([100, 0, 0, 0])).toBe('rgb(0, 255, 255)');
    expect(parseInk('89 67 37 51')).toEqual([89, 67, 37, 51]);
    expect(parseInk('۸۹،۶۷،۳۷،۵۱')).toEqual([89, 67, 37, 51]);
    expect(parseInk('  ')).toBeNull();
    expect(parseInk('89 67 37')).toBe('invalid');
    expect(parseInk('89 67 37 151')).toBe('invalid');
  });
});

describe('The brand kit keeps a colour’s ink', () => {
  it('shows CMYK on the swatch, and saves what is typed — refusing what is not four inks', async () => {
    serve({
      '/companies/c1/brand': {
        company: { id: 'c1', legalName: 'شرکت نمونه' }, files: [],
        kit: { colors: [{ name: 'سرمه‌ای', hex: '#1A2B3C', role: 'PRIMARY', cmyk: [89, 67, 37, 51] }], fonts: [], notes: null, updatedAt: null },
      },
    });
    wrap(<BrandLibraryCard companyId="c1" />);
    expect((await screen.findByTestId('brand-colors')).textContent).toContain('C89 M67 Y37 K51');
    fireEvent.click(screen.getByText('ویرایش رنگ و فونت'));
    expect((screen.getByLabelText('CMYK رنگ ۱') as HTMLInputElement).value).toBe('89 67 37 51');
    fireEvent.change(screen.getByLabelText('CMYK رنگ ۱'), { target: { value: '89 67' } });
    expect(screen.getByText(/باید چهار عدد بین ۰ تا ۱۰۰ باشد/)).toBeTruthy();
    expect((screen.getByText('ذخیره').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('CMYK رنگ ۱'), { target: { value: '۹۰، ۶۸، ۳۶، ۵۰' } });
    fireEvent.click(screen.getByText('افزودن رنگ'));
    fireEvent.change(screen.getByLabelText('نام رنگ ۲'), { target: { value: 'طلایی' } });
    fireEvent.click(screen.getByText('ذخیره'));
    await waitFor(() => expect(sent[0]?.method).toBe('PUT'));
    expect(sent[0]!.body.colors).toEqual([
      { name: 'سرمه‌ای', hex: '#1A2B3C', role: 'PRIMARY', cmyk: [90, 68, 36, 50] },
      { name: 'طلایی', hex: '#000000', role: 'SECONDARY', cmyk: null },
    ]);
  });
});
