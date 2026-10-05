import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { setAccessToken, setRefreshToken } from '../src/lib/api';
import { forgetPushOnSignOut } from '../src/lib/push';
import Mobile from '../src/pages/Mobile';
import { UnitQcNote } from '../src/pages/Quality';

/**
 * The phone's three loops (roadmap #49): each is one sheet that does its one thing through the
 * same endpoints as the full interface, and a tapped notice lands on the item it is about.
 */
const sla = (left: number) => ({ policyCode: 'SLA_TASK_ACCEPTANCE', labelFa: 'پذیرش سفارش', state: 'RUNNING', dueAt: '2026-09-30T00:00:00.000Z', budgetHours: 4, controlledHours: 4 - left });
const queue = {
  kinds: {}, counts: {}, breached: 0, atRisk: 0,
  items: [
    { kind: 'workOrder', entityType: 'workOrder', entityId: 'w-1', code: 'WO-000003', title: 'طراحی پوستر', state: 'ISSUED', projectCode: 'PRJ-2', projectName: 'کمپین پاییز', dueAt: null, href: '', sla: sla(2.5),
      availableTransitions: [{ action: 'accept', labelFa: 'پذیرش سفارش', requiresReason: false }, { action: 'request_clarification', labelFa: 'اعلام ابهام', requiresReason: true }] },
    // Accepted already: not an acceptance to make, so not on the phone.
    { kind: 'workOrder', entityType: 'workOrder', entityId: 'w-2', code: 'WO-000004', title: 'سفارش در حال اجرا', state: 'IN_PROGRESS', projectCode: null, projectName: null, dueAt: null, href: '', sla: null, availableTransitions: [] },
    { kind: 'formApproval', entityType: 'formSubmission', entityId: 'f-1', code: 'FRM-000004', title: 'فرم تکمیل بریف', state: 'PENDING_APPROVAL', projectCode: null, projectName: null, dueAt: null, href: '', sla: null, availableTransitions: [] },
    { kind: 'qcUnit', entityType: 'deliverable', entityId: 'd-1', code: 'DLV-000031', title: 'پوستر نهایی', state: 'SUBMITTED', projectCode: null, projectName: null, dueAt: null, href: '', sla: null, availableTransitions: [] },
    { kind: 'task', entityType: 'task', entityId: 't-1', code: 'TSK-000001', title: 'وظیفهٔ میزکار', state: 'ASSIGNED', projectCode: null, projectName: null, dueAt: null, href: '', sla: null, availableTransitions: [] },
  ],
};

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const serverKey = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const USER = { id: 'u1', email: 'c@hiva.local', fullName: 'سپیده آذر', jobTitle: '', department: null, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: [], permissions: [], locale: 'fa', mustChangePassword: false };

interface Sent { method: string; path: string; body: unknown }

function mount(entry = '/m', opts: { uploadFails?: boolean } = {}) {
  setAccessToken('t'); setRefreshToken('r');
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, path: url.pathname.replace('/api/v1', '') + url.search, body });
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(USER);
    if (p === '/events') return json({}, 503);
    if (p === '/me/work') return json(queue);
    if (p === '/push/key') return json({ publicKey: b64u(serverKey), delivery: 'on' });
    if (p === '/push/subscriptions' && method === 'GET') return json([]);
    if (p === '/push/subscriptions') return json({ id: 's-1', host: 'fcm.googleapis.com' }, 201);
    if (p === '/push/test') return json({ delivery: 'on', results: [{ subscriptionId: 's-1', host: 'fcm.googleapis.com', status: 'SENT', error: null }] });
    if (p === '/work-orders/w-1') return json({ id: 'w-1', code: 'WO-000003', title: 'طراحی پوستر', state: 'ISSUED', scopeOfWork: 'طراحی پوستر رویداد', brief: 'بریف کامل پوستر', expectedOutput: 'فایل چاپی', outputFormat: 'PDF', deadline: '2026-10-05T08:00:00.000Z', requiredResources: null, project: { code: 'PRJ-2', name: 'کمپین پاییز', company: { legalName: 'شرکت نمونه' } } });
    if (p === '/forms/submissions/f-1') {
      return json({
        id: 'f-1', code: 'FRM-000004', state: 'PENDING_APPROVAL', createdAt: '2026-09-29T06:00:00.000Z', documents: [],
        project: { id: 'p-1', code: 'PRJ-000002', name: 'کمپین پاییز' },
        data: { addedInformation: 'مخاطب جوان‌تر', urgent: true, channel: 'TV', empty: '', projectId: 'p-1', briefId: 'b-9' },
        definition: { nameFa: 'فرم تکمیل بریف', schema: [] },
        schema: [{ key: 'addedInformation', labelFa: 'اطلاعات افزوده', type: 'textarea' }, { key: 'urgent', labelFa: 'فوری', type: 'checkbox' }, { key: 'channel', labelFa: 'کانال', type: 'select', options: [{ value: 'TV', labelFa: 'تلویزیون' }] },
          { key: 'projectId', labelFa: 'پروژه', type: 'entityRef', entity: 'project' }, { key: 'briefId', labelFa: 'بریف', type: 'entityRef', entity: 'brief' }],
        submittedBy: { fullName: 'الهام کریمی' },
      });
    }
    if (p === '/deliverables/d-1') return json({ id: 'd-1', code: 'DLV-000031', name: 'پوستر نهایی', format: 'PDF', dueDate: null, stageZeroVerdict: 'PASS', description: null });
    if (p === '/documents' && method === 'GET') return json([{ id: 'doc-1', fileName: 'poster.pdf', mimeType: 'application/pdf' }]);
    if (p === '/documents') return opts.uploadFails ? json({ error: { code: 'X', message: 'نشد' } }, 500) : json({ id: 'doc-2' }, 201);
    if (p === '/qc-reviews') return json({ review: { id: 'r-1' }, revision: null }, 201);
    if (p.startsWith('/workflow/') || p.endsWith('/decision')) return json({});
    return json({});
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider><MemoryRouter initialEntries={[entry]}><Mobile /></MemoryRouter></AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

const posted = (sent: Sent[], path: string) => sent.filter((s) => s.method !== 'GET' && s.path === path);

afterEach(() => { delete (navigator as { serviceWorker?: unknown }).serviceWorker; });

describe('The phone’s three loops', () => {
  it('shows only the three loops, each with its count — not the desk’s work, not an accepted order', async () => {
    mount();
    await screen.findByText('طراحی پوستر');
    const nav = screen.getByRole('navigation', { name: 'سه کار' });
    const tabs = within(nav).getAllByRole('button').map((b) => b.textContent);
    expect(tabs).toEqual(['پذیرش سفارش۱', 'تأیید فرم۱', 'QC واحد۱']);
    expect(screen.queryByText('سفارش در حال اجرا')).toBeNull();
    expect(screen.queryByText('وظیفهٔ میزکار')).toBeNull();
    expect(screen.getByTestId('mobile-list').textContent).toContain('۲٫۵ ساعت مانده');
  });

  it('accepts a work order from its sheet, through the workflow engine', async () => {
    const sent = mount();
    fireEvent.click(await screen.findByText('طراحی پوستر'));
    const sheet = await screen.findByRole('dialog', { name: 'طراحی پوستر' });
    expect(await within(sheet).findByText('بریف کامل پوستر')).toBeTruthy();
    expect(within(sheet).getByText('کمپین پاییز — شرکت نمونه')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'پذیرش سفارش' }));
    expect(await screen.findByText('سفارش WO-000003 پذیرفته شد.')).toBeTruthy();
    expect(posted(sent, '/workflow/workOrder/w-1/transitions')).toEqual([{ method: 'POST', path: '/workflow/workOrder/w-1/transitions', body: { action: 'accept' } }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('asks for the ambiguity in words before it stops the acceptance clock', async () => {
    const sent = mount();
    fireEvent.click(await screen.findByText('طراحی پوستر'));
    const sheet = await screen.findByRole('dialog', { name: 'طراحی پوستر' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'اعلام ابهام' }));
    const record = within(sheet).getByRole('button', { name: 'ثبت ابهام' }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(sheet).getByRole('textbox'), { target: { value: 'ابعاد مشخص نیست' } });
    fireEvent.click(record);
    await screen.findByText('ابهام سفارش WO-000003 برای اکانت ثبت شد.');
    expect(posted(sent, '/workflow/workOrder/w-1/transitions')[0]!.body).toEqual({ action: 'request_clarification', reason: 'ابعاد مشخص نیست' });
  });

  it('shows a form as it was filled — labels, choices in words — and will not reject it without a reason', async () => {
    const sent = mount();
    await screen.findByText('طراحی پوستر');
    fireEvent.click(screen.getByRole('button', { name: /تأیید فرم/ }));
    fireEvent.click(await screen.findByText('فرم تکمیل بریف'));
    const sheet = await screen.findByRole('dialog', { name: 'فرم تکمیل بریف' });
    expect(await within(sheet).findByText('مخاطب جوان‌تر')).toBeTruthy();
    expect(within(sheet).getByText('تلویزیون')).toBeTruthy();
    expect(within(sheet).getByText('بله')).toBeTruthy();
    // A linked record by what it is, never by its id.
    expect(within(sheet).getByText('کمپین پاییز (PRJ-000002)')).toBeTruthy();
    expect(within(sheet).getByText('رکورد پیوست‌شده — در نسخهٔ کامل')).toBeTruthy();
    expect(sheet.textContent).not.toContain('b-9');
    const reject = within(sheet).getByRole('button', { name: 'رد' }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('توضیح تصمیم'), { target: { value: 'بودجه ذکر نشده' } });
    fireEvent.click(reject);
    await screen.findByText('فرم FRM-000004 رد شد.');
    expect(posted(sent, '/forms/submissions/f-1/decision')[0]!.body).toEqual({ decision: 'REJECT', comment: 'بودجه ذکر نشده' });
  });

  it('records a level-1 QC, then sends the photo from the set as that review’s evidence', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:photo');
    URL.revokeObjectURL = vi.fn();
    const sent = mount();
    await screen.findByText('طراحی پوستر');
    fireEvent.click(screen.getByRole('button', { name: /QC واحد/ }));
    fireEvent.click(await screen.findByText('پوستر نهایی'));
    const sheet = await screen.findByRole('dialog', { name: 'پوستر نهایی' });
    expect(await within(sheet).findByText('poster.pdf')).toBeTruthy();
    expect(within(sheet).getByText('مرحلهٔ صفر: بدون ایراد مکانیکی')).toBeTruthy();

    const submit = () => within(sheet).getByRole('button', { name: /ثبت QC/ }) as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    fireEvent.click(within(sheet).getByLabelText('مطابق بریف است'));
    fireEvent.click(within(sheet).getByRole('radio', { name: 'رد — نیاز به اصلاح' }));
    expect(submit().disabled).toBe(true); // a failed check says what failed
    fireEvent.change(within(sheet).getByLabelText(/یافته‌ها/), { target: { value: 'رنگ‌ها خارج از برند' } });
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'set.jpg', { type: 'image/jpeg' });
    fireEvent.change(within(sheet).getByLabelText('افزودن عکس'), { target: { files: [photo] } });
    expect(within(sheet).getByAltText('عکس ۱')).toBeTruthy();

    fireEvent.click(submit());
    await screen.findByText('QC واحد DLV-000031 رد شد و اصلاحیه صادر شد.');
    expect(posted(sent, '/qc-reviews')[0]!.body).toEqual({
      level: 'UNIT', deliverableId: 'd-1', verdict: 'FAILED', findings: 'رنگ‌ها خارج از برند',
      checklist: { matchesBrief: true, technicallySound: false, brandCompliant: false, completeDeliverable: false },
    });
    const upload = posted(sent, '/documents')[0]!.body as FormData;
    expect(upload.get('qcReviewId')).toBe('r-1');
    expect((upload.get('file') as File).name).toBe('set.jpg');
  });

  it('keeps a recorded review when its photo does not go, and offers to send the photo again', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:photo');
    URL.revokeObjectURL = vi.fn();
    const sent = mount('/m', { uploadFails: true });
    await screen.findByText('طراحی پوستر');
    fireEvent.click(screen.getByRole('button', { name: /QC واحد/ }));
    fireEvent.click(await screen.findByText('پوستر نهایی'));
    const sheet = await screen.findByRole('dialog', { name: 'پوستر نهایی' });
    fireEvent.click(within(sheet).getByRole('radio', { name: 'قبول' }));
    expect(within(sheet).getByText(/۴ مورد چک‌لیست تیک نخورده/)).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText('افزودن عکس'), { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(within(sheet).getByRole('button', { name: /ثبت QC/ }));
    expect(await within(sheet).findByText('QC ثبت شد، اما ۱ عکس نرسید. دوباره بفرستید یا بدون آن ببندید.')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'ارسال دوبارهٔ عکس' }));
    await waitFor(() => expect(posted(sent, '/documents')).toHaveLength(2));
    // One review, however many times the photo is tried.
    expect(posted(sent, '/qc-reviews')).toHaveLength(1);
    expect((posted(sent, '/documents')[1]!.body as FormData).get('qcReviewId')).toBe('r-1');
  });

  it('opens the item a tapped notice is about', async () => {
    mount('/m?open=formSubmission:f-1');
    expect(await screen.findByRole('dialog', { name: 'فرم تکمیل بریف' })).toBeTruthy();
  });

  it('says so when the notice’s item has already been dealt with', async () => {
    mount('/m?open=workOrder:w-gone');
    expect(await screen.findByText('این کار دیگر در صف شما نیست — پیش‌تر انجام شده یا به کس دیگری رسیده است.')).toBeTruthy();
  });
});

describe('Notices on this phone', () => {
  it('explains, rather than failing, where the browser has no Web Push', async () => {
    mount();
    await screen.findByText('طراحی پوستر');
    fireEvent.click(screen.getByRole('button', { name: 'اعلان روی این گوشی' }));
    const panel = await screen.findByRole('dialog', { name: 'اعلان روی این گوشی' });
    expect(await within(panel).findByText(/این مرورگر اعلان وب \(Web Push\) ندارد/)).toBeTruthy();
  });

  /** A browser with the Push API, as far as the page can see one. */
  function pushCapable() {
    let current: { endpoint: string; options: { applicationServerKey: ArrayBuffer }; toJSON: () => unknown; unsubscribe: () => Promise<boolean> } | null = null;
    const unsubscribe = vi.fn(async () => { current = null; return true; });
    const subscribe = vi.fn(async (o: { applicationServerKey: Uint8Array; userVisibleOnly: boolean }) => {
      current = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc', options: { applicationServerKey: o.applicationServerKey.buffer as ArrayBuffer },
        toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BPUB', auth: 'AUTH' } }), unsubscribe,
      };
      return current;
    });
    const reg = { pushManager: { getSubscription: async () => current, subscribe } };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => reg, register: vi.fn(async () => reg), ready: Promise.resolve(reg), addEventListener: () => {}, removeEventListener: () => {} },
    });
    vi.stubGlobal('PushManager', function PushManager() {});
    const N = Object.assign(function Notification() {}, { permission: 'default' as NotificationPermission, requestPermission: vi.fn(async () => { N.permission = 'granted'; return 'granted' as const; }) });
    vi.stubGlobal('Notification', N);
    return { subscribe, unsubscribe, current: () => current };
  }

  it('asks, subscribes with the server’s key, tells the server where this browser is, and sends a test', async () => {
    const push = pushCapable();
    const sent = mount();
    await screen.findByText('طراحی پوستر');
    fireEvent.click(screen.getByRole('button', { name: 'اعلان روی این گوشی' }));
    const panel = await screen.findByRole('dialog', { name: 'اعلان روی این گوشی' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'روشن کردن' }));
    expect(await within(panel).findByText('اعلان روشن است')).toBeTruthy();

    const [options] = push.subscribe.mock.calls[0]!;
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([...serverKey]);
    expect(posted(sent, '/push/subscriptions')[0]!.body).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BPUB', auth: 'AUTH' } });

    fireEvent.click(within(panel).getByRole('button', { name: 'ارسال اعلان آزمایشی' }));
    expect(await within(panel).findByText('سرویس اعلان پذیرفت؛ تا چند ثانیهٔ دیگر روی ۱ مرورگر می‌رسد.')).toBeTruthy();
  });

  it('signing out takes this browser off the person’s notices', async () => {
    const push = pushCapable();
    await (navigator.serviceWorker as unknown as { getRegistration: () => Promise<{ pushManager: { subscribe: (o: unknown) => Promise<unknown> } }> })
      .getRegistration().then((r) => r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey }));
    setAccessToken('t');
    const calls: { method?: string; url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, url: String(input), body: init?.body as string | undefined });
      return json({ removed: 1 });
    }));
    await forgetPushOnSignOut();
    expect(calls).toEqual([{ method: 'DELETE', url: 'http://localhost:3000/api/v1/push/subscriptions', body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }) }]);
    expect(push.unsubscribe).toHaveBeenCalled();
    expect(push.current()).toBeNull();
  });
});

describe('The unit’s check, on the desk', () => {
  it('shows Account the level-1 verdict, who made it, and each photo from the set', () => {
    render(<UnitQcNote review={{
      id: 'r-1', code: 'QC-000009', verdict: 'PASSED', findings: null, reviewedAt: new Date().toISOString(), reviewer: { fullName: 'سپیده آذر' },
      documents: [{ id: 'a', fileName: 'set-1.jpg', mimeType: 'image/jpeg' }, { id: 'b', fileName: 'set-2.jpg', mimeType: 'image/jpeg' }],
    }} />);
    const note = screen.getByTestId('unit-qc-note');
    expect(note.textContent).toContain('QC سطح ۱: قبول');
    expect(note.textContent).toContain('سپیده آذر');
    expect(within(note).getAllByRole('button').map((b) => b.textContent)).toEqual(['عکس ۱', 'عکس ۲']);
  });

  it('shows nothing where the unit has not checked yet', () => {
    const { container } = render(<UnitQcNote review={undefined} />);
    expect(container.textContent).toBe('');
  });
});
