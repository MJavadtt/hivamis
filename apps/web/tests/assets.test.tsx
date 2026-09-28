import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const perms = { current: new Set<string>() };
vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ can: (p: string) => perms.current.has(p), user: { id: 'u1' } }) }));
vi.mock('../src/components/ui', async (orig) => ({ ...(await orig<object>()), useToast: () => () => {} }));
import { VersionsModal, factRows, metadataFa, paperName } from '../src/components/Assets';
import { BrandLibraryCard, inkOn } from '../src/components/BrandLibrary';
import { AnnotationsModal } from '../src/components/Annotations';

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const wrap = (node: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);

type Sent = { url: string; method: string; body: any };
function serve(routes: Record<string, unknown>) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== 'GET') {
      const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : (v as File).name])) : init.body ? JSON.parse(String(init.body)) : null;
      sent.push({ url, method: init.method, body });
      return json({ id: 'new', version: 3 }, 201);
    }
    if (url.includes('/preview')) return new Response('bytes');
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return hit ? json(routes[hit]) : json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404);
  }));
  URL.createObjectURL = vi.fn(() => 'blob:file');
  URL.revokeObjectURL = vi.fn();
  return sent;
}
beforeEach(() => { perms.current = new Set(['document.read', 'document.write', 'qc.read', 'deliverable.write']); });

describe('What a file says, in a designer’s words', () => {
  it('names the paper, the colour space, the length and the typeface', () => {
    expect(paperName({ w: 210, h: 297 })).toBe('A4');
    expect(paperName({ w: 420, h: 297 })).toBe('A3 افقی');
    expect(paperName({ w: 100, h: 50 })).toBe('۱۰۰×۵۰ میلی‌متر افقی');
    expect(metadataFa({ width: 2480, height: 3508, colorSpace: 'CMYK' })).toBe('۲۴۸۰×۳۵۰۸ پیکسل · CMYK (چاپی)');
    expect(metadataFa({ durationSec: 95, width: 1920, height: 1080 })).toBe('۱۹۲۰×۱۰۸۰ پیکسل · مدت ۰۱:۳۵');
    expect(metadataFa({ pageCount: 12, pageSizeMm: { w: 210, h: 297 } })).toBe('۱۲ صفحه · A4');
    expect(metadataFa({ fontFamily: 'Vazirmatn' })).toBe('خانوادهٔ Vazirmatn');
    expect(metadataFa(null)).toBe('');
    expect(factRows({ mimeType: 'image/png', sizeBytes: 2048, metadata: { width: 10, height: 20 } }).slice(0, 2)).toEqual([['ابعاد', '۱۰×۲۰'], ['فضای رنگ', '—']]);
  });

  it('writes on a swatch in the colour that reads on it', () => {
    expect(inkOn('#FFFFFF')).toBe('#111827');
    expect(inkOn('#1A2B3C')).toBe('#FFFFFF');
  });
});

const versions = [
  { id: 'v1', fileName: 'poster.png', mimeType: 'image/png', sizeBytes: 4096, checksum: 'aa', version: 1, metadata: { width: 1080, height: 1350, colorSpace: 'RGB' }, createdAt: '2026-09-20T08:00:00Z', current: false, clientVisible: true, uploadedBy: { fullName: 'سپیده آذر' }, annotations: 2 },
  { id: 'v2', fileName: 'poster-v2.png', mimeType: 'image/png', sizeBytes: 4096, checksum: 'bb', version: 2, metadata: { width: 1080, height: 1920, colorSpace: 'RGB' }, createdAt: '2026-09-25T08:00:00Z', current: true, clientVisible: false, uploadedBy: { fullName: 'بهراد مهرنیا' }, annotations: 0 },
];

describe('A file’s versions', () => {
  it('lists every version, newest first, and compares the last two — what changed is marked', async () => {
    serve({ '/documents/v2/versions': versions });
    wrap(<VersionsModal documentId="v2" onClose={() => {}} />);
    const rows = await screen.findAllByTestId('version-row');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('نسخهٔ ۲ (فعلی)'), expect.stringContaining('نسخهٔ ۱')]);
    expect(rows[1]!.textContent).toContain('۲ یادداشت');
    expect(rows[1]!.textContent).toContain('در پورتال');
    const diff = screen.getByTestId('fact-diff');
    const changed = [...diff.querySelectorAll('tr[data-changed]')].map((r) => r.firstElementChild?.textContent);
    expect(changed).toEqual(['ابعاد']);
    expect(within(diff).queryByText('مدت')).toBeNull();                 // facts neither version has are left out
    await waitFor(() => expect(screen.getAllByTestId('preview-image')).toHaveLength(4));     // two in the list, two side by side
    fireEvent.click(screen.getByLabelText('روی هم'));
    expect(screen.getByTestId('overlay')).toBeTruthy();
  });

  it('uploads a new version in the current one’s place', async () => {
    const sent = serve({ '/documents/v2/versions': versions });
    wrap(<VersionsModal documentId="v2" onClose={() => {}} />);
    const input = await screen.findByTestId('new-version-input-v2');
    fireEvent.change(input, { target: { files: [new File(['x'], 'poster-v3.png', { type: 'image/png' })] } });
    await waitFor(() => expect(sent[0]).toEqual({ url: expect.stringContaining('/api/v1/documents'), method: 'POST', body: { replacesId: 'v2', file: 'poster-v3.png' } }));
  });

  it('offers no new version to someone who cannot upload', async () => {
    perms.current = new Set(['document.read']);
    serve({ '/documents/v2/versions': versions });
    wrap(<VersionsModal documentId="v2" onClose={() => {}} />);
    await screen.findAllByTestId('version-row');
    expect(screen.queryByText('بارگذاری نسخهٔ جدید')).toBeNull();
  });
});

describe('The annotator, across versions', () => {
  it('opens a file at its current version, and shows an older one read-only with its own marks', async () => {
    serve({
      '/deliverables/d1/annotations': {
        deliverable: { id: 'd1', code: 'DLV-1', name: 'پوستر' },
        files: [
          { id: 'p2', fileName: 'poster-v2.png', mimeType: 'image/png', kind: 'image', annotations: 0, version: 2, current: true, lineageId: 'p1', metadata: { width: 1080, height: 1920 } },
          { id: 'p1', fileName: 'poster.png', mimeType: 'image/png', kind: 'image', annotations: 1, version: 1, current: false, lineageId: 'p1', metadata: null },
        ],
        annotations: [{ id: 'a1', documentId: 'p1', kind: 'PIN', number: 1, page: null, x: 0.5, y: 0.5, w: null, h: null, timeSec: null, note: 'لوگو کوچک است', status: 'OPEN', createdAt: '2026-09-20T08:00:00Z', author: { id: 'u2', fullName: 'سپیده آذر' }, qcReviewId: 'q1', revision: { code: 'REV-1' } }],
      },
    });
    wrap(<AnnotationsModal deliverableId="d1" onClose={() => {}} />);
    await screen.findByTestId('image-stage');
    expect(screen.getAllByRole('button', { name: /poster/ })).toHaveLength(1);   // one tab per file
    expect(screen.queryByTestId('old-version')).toBeNull();
    expect(screen.getByTestId('file-versions').textContent).toContain('۱۰۸۰×۱۹۲۰ پیکسل');
    fireEvent.click(screen.getByText(/نسخهٔ ۱ · ۱ یادداشت/));
    expect(await screen.findByTestId('old-version')).toBeTruthy();
    expect(screen.getAllByTestId('pin')).toHaveLength(1);
    expect(screen.queryByText('روی تصویر کلیک کنید تا نشانه بگذارید.')).toBeNull();
    expect(screen.queryByText('نسخهٔ جدید')).toBeNull();                       // a new version builds on the current one only
  });
});

describe('A client’s brand library', () => {
  const brand = {
    company: { id: 'c1', legalName: 'شرکت نمونه' },
    kit: { colors: [{ name: 'سرمه‌ای', hex: '#1A2B3C', role: 'PRIMARY' }], fonts: [{ family: 'Vazirmatn', usage: 'متن' }, { family: 'Lalezar' }], notes: 'لوگو روی زمینهٔ تیره سفید است.', updatedAt: '2026-09-25T08:00:00Z' },
    files: [
      { id: 'logo', fileName: 'logo.png', mimeType: 'image/png', sizeBytes: 900, brandRole: 'LOGO', version: 2, metadata: { width: 512, height: 512 }, createdAt: '2026-09-25T08:00:00Z', uploadedBy: { fullName: 'سپیده آذر' } },
      { id: 'font', fileName: 'Vazirmatn.ttf', mimeType: 'font/ttf', sizeBytes: 900, brandRole: 'FONT', version: 1, metadata: { fontFamily: 'Vazirmatn' }, createdAt: '2026-09-25T08:00:00Z', uploadedBy: null },
    ],
  };

  it('shows palette, typefaces and brand files — and which typeface has no file yet', async () => {
    perms.current = new Set(['document.read']);
    serve({ '/companies/c1/brand': brand });
    wrap(<BrandLibraryCard companyId="c1" />);
    const colors = await screen.findByTestId('brand-colors');
    expect(colors.textContent).toContain('#1A2B3C');
    expect((colors.querySelector('button') as HTMLElement).style.color).toBe('rgb(255, 255, 255)');
    const fonts = screen.getByTestId('brand-fonts').querySelectorAll('li');
    expect(fonts[0]!.textContent).not.toContain('فایل فونت در کتابخانه نیست');
    expect(fonts[1]!.textContent).toContain('فایل فونت در کتابخانه نیست');
    expect(screen.getByTestId('brand-files').textContent).toContain('۵۱۲×۵۱۲ پیکسل');
    expect(screen.getByText('نسخه‌ها (۲)')).toBeTruthy();
    expect((await screen.findByTestId('preview-font')).textContent).toContain('نمونهٔ متن برند');
    expect(screen.queryByText('ویرایش رنگ و فونت')).toBeNull();                  // only for those who keep brands
    expect(screen.queryByText('افزودن فایل برند')).toBeNull();
  });

  it('lets a brand keeper edit the palette — a bad code holds the save — and add a file in its role', async () => {
    perms.current = new Set(['document.read', 'document.write', 'brand.manage']);
    const sent = serve({ '/companies/c1/brand': brand });
    wrap(<BrandLibraryCard companyId="c1" />);
    fireEvent.click(await screen.findByText('ویرایش رنگ و فونت'));
    fireEvent.change(screen.getByLabelText('کد رنگ ۱'), { target: { value: '#12' } });
    expect(screen.getByText(/باید به شکل #RRGGBB باشد/)).toBeTruthy();
    expect((screen.getByText('ذخیره').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('کد رنگ ۱'), { target: { value: '#0f766e' } });
    fireEvent.click(screen.getByText('افزودن رنگ'));
    fireEvent.change(screen.getByLabelText('نام رنگ ۲'), { target: { value: 'طلایی' } });
    fireEvent.change(screen.getByLabelText('کد رنگ ۲'), { target: { value: '#D4AF37' } });
    fireEvent.change(screen.getByLabelText('کاربرد رنگ ۲'), { target: { value: 'ACCENT' } });
    fireEvent.click(screen.getByText('ذخیره'));
    await waitFor(() => expect(sent[0]).toMatchObject({ url: expect.stringContaining('/companies/c1/brand'), method: 'PUT' }));
    expect(sent[0]!.body).toEqual({
      colors: [{ name: 'سرمه‌ای', hex: '#0f766e', role: 'PRIMARY' }, { name: 'طلایی', hex: '#D4AF37', role: 'ACCENT' }],
      fonts: [{ family: 'Vazirmatn', usage: 'متن' }, { family: 'Lalezar' }],
      notes: 'لوگو روی زمینهٔ تیره سفید است.',
    });

    fireEvent.change(screen.getByLabelText('نقش فایل در برند'), { target: { value: 'GUIDELINE' } });
    fireEvent.change(screen.getByTestId('brand-file-input'), { target: { files: [new File(['%PDF'], 'guide.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(sent[1]).toEqual({ url: expect.stringContaining('/api/v1/documents'), method: 'POST', body: { companyId: 'c1', brandRole: 'GUIDELINE', file: 'guide.pdf' } }));
  });
});
