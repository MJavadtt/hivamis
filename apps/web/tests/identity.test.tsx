import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { getAccessToken, markSignedIn, setAccessToken, wasSignedIn } from '../src/lib/api';
import Login from '../src/pages/Login';
import Signup from '../src/pages/Signup';
import GoogleReturn from '../src/pages/GoogleReturn';
import Me from '../src/pages/Me';
import { PersonPage } from '../src/pages/People';
import { SignupRequests } from '../src/components/SignupRequests';

/**
 * Hivamis task 4: signing in with a code sent to one's mobile or with Google, asking to join, one's
 * own page with the ways in and the devices, a page for each colleague, and the administrator's queue.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', email: 'p@hiva.local', fullName: 'پریسا نیک', jobTitle: 'کارشناس', department: { code: 'S', nameFa: 'فروش' }, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['SALES_REP'], permissions: ['task.read', 'admin.users', 'admin.settings'], locale: 'fa', mustChangePassword: false };
const METHODS = { organization: 'هیوا', password: true, phone: true, google: true, signup: { open: true, phone: true, google: true } };

type Handler = (path: string, method: string, body: any) => Response | undefined;
function mount(ui: React.ReactNode, handler: Handler, { path = '/', signedIn = false } = {}) {
  if (signedIn) { setAccessToken('t'); markSignedIn(true); } else { setAccessToken(null); markSignedIn(false); }
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const p = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, path: p + url.search, body });
    if (p === '/auth/refresh') return json({ accessToken: 't' });
    if (p === '/auth/me') return json(ME);
    if (p === '/auth/methods') return json(METHODS);
    if (p === '/departments') return json([]);
    return handler(p, method, body) ?? json({});
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider>
        <MemoryRouter initialEntries={[path]}><Routes><Route path="*" element={ui} /><Route path="/people/:id" element={ui} /></Routes></MemoryRouter>
      </AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

beforeEach(() => { localStorage.clear(); window.location.hash = ''; });

describe('Signing in by mobile', () => {
  it('sends a code, then signs in with it', async () => {
    const sent = mount(<Login />, (p) => {
      if (p === '/auth/phone/start') return json({ sent: true, resendAfterSeconds: 60 }, 202);
      if (p === '/auth/phone/verify') return json({ accessToken: 'a2' });
      return undefined;
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'شمارهٔ همراه' }));
    fireEvent.change(screen.getByPlaceholderText('0912 123 4567'), { target: { value: '09121234567' } });
    fireEvent.click(screen.getByRole('button', { name: 'فرستادن کد' }));
    fireEvent.change(await screen.findByLabelText('کد پیامک‌شده'), { target: { value: '123456' } });
    expect(screen.getByText(/فرستادن دوبارهٔ کد تا/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'ورود' }));
    await waitFor(() => expect(sent.some((x) => x.path === '/auth/phone/verify')).toBe(true));
    expect(sent.find((x) => x.path === '/auth/phone/verify')!.body).toEqual({ phone: '09121234567', code: '123456' });
    // Signed in: the access token held in memory, the refresh token in the cookie the answer set.
    await waitFor(() => expect(getAccessToken()).toBe('a2'));
    expect(wasSignedIn()).toBe(true);
    expect(JSON.stringify(localStorage)).not.toContain('a2');
  });

  it('says whose sign-in it is — on an installation with several organisations, this address’s (roadmap #50)', async () => {
    mount(<Login />, () => undefined);
    expect((await screen.findByTestId('login-org')).textContent).toBe('هیوا');
  });

  it('offers Google and joining only where the installation does', async () => {
    mount(<Login />, () => undefined);
    expect(await screen.findByRole('button', { name: /ورود با حساب گوگل/ })).toBeDefined();
    expect(screen.getByRole('link', { name: 'درخواست عضویت' }).getAttribute('href')).toBe('/signup');
  });
});

describe('Asking to join', () => {
  it('proves the mobile with a code and records a request — granting nothing', async () => {
    const sent = mount(<Signup />, (p) => {
      if (p === '/auth/signup/options') return json({ organization: 'هیوا', open: true, phone: true, google: false, units: [{ code: 'S', nameFa: 'فروش', nameEn: 'Sales' }] });
      if (p === '/auth/signup/phone/start') return json({ sent: true, resendAfterSeconds: 60 }, 202);
      if (p === '/auth/signup') return json({ status: 'PENDING' }, 201);
      return undefined;
    });
    fireEvent.change(await screen.findByLabelText(/نام و نام خانوادگی/), { target: { value: 'نیلوفر احمدی' } });
    fireEvent.change(screen.getByLabelText(/ایمیل کاری/), { target: { value: 'n@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('0912 123 4567'), { target: { value: '09121234567' } });
    fireEvent.click(screen.getByRole('button', { name: 'فرستادن کد' }));
    fireEvent.change(await screen.findByLabelText('کد پیامک‌شده'), { target: { value: '654321' } });
    fireEvent.change(screen.getByLabelText('واحد'), { target: { value: 'S' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت درخواست' }));
    expect((await screen.findByTestId('signup-done')).textContent).toContain('پس از تأیید مدیر سیستم');
    expect(sent.find((x) => x.path === '/auth/signup')!.body).toMatchObject({ fullName: 'نیلوفر احمدی', email: 'n@example.com', phone: '09121234567', code: '654321', departmentCode: 'S' });
  });

  it('says so when joining is closed', async () => {
    mount(<Signup />, (p) => (p === '/auth/signup/options' ? json({ organization: 'هیوا', open: false, phone: false, google: false, units: [] }) : undefined));
    expect(await screen.findByText(/درخواست عضویت در این سازمان بسته است/)).toBeDefined();
  });
});

describe('Back from Google', () => {
  it('trades the ticket in the fragment for a session and opens the app', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, hash: '#ticket=abc', pathname: '/auth/google', replace });
    const sent = mount(<GoogleReturn />, (p) => (p === '/auth/ticket' ? json({ accessToken: 'g' }) : undefined));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(sent.find((x) => x.path === '/auth/ticket')!.body).toEqual({ ticket: 'abc' });
    expect(wasSignedIn()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('asks the owner of a work address to prove the account once before linking Google to it (audit SEC-5)', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, hash: '#link=offer-1', pathname: '/auth/google', replace });
    const sent = mount(<GoogleReturn />, (p) => {
      if (p === '/auth/google/offer') return json({ email: 'legal@hiva.local', fullName: 'سعید تقوی', password: true, phone: '•••••••••01' });
      if (p === '/auth/google/offer/confirm') return json({ accessToken: 'g' });
      return undefined;
    });
    expect(await screen.findByText(/همان نشانی حساب سعید تقوی/)).toBeDefined();
    // Nothing is linked, and nobody signed in, by the address alone.
    expect(sent.some((x) => x.path === '/auth/ticket')).toBe(false);
    fireEvent.change(screen.getByLabelText('رمز عبور هیوامیس'), { target: { value: 'Hiva@Dev2026!' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'وصل کن و وارد شو' })[0]!);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(sent.find((x) => x.path === '/auth/google/offer/confirm')!.body).toEqual({ token: 'offer-1', password: 'Hiva@Dev2026!' });
    expect(wasSignedIn()).toBe(true);
    vi.unstubAllGlobals();
  });

  it('explains an account Google knows but Hivamis does not', async () => {
    vi.stubGlobal('location', { ...window.location, hash: '#error=NO_ACCOUNT', pathname: '/auth/google', replace: vi.fn() });
    mount(<GoogleReturn />, () => undefined);
    expect((await screen.findByRole('alert')).textContent).toContain('به هیچ حسابی در هیوامیس وصل نیست');
    vi.unstubAllGlobals();
  });
});

describe('My page', () => {
  const PROFILE = {
    id: 'u1', phone: '09121234567', phoneVerified: true, hasPassword: false, identities: [],
    sessions: [{ id: 's1', userAgent: 'Mozilla (Macintosh)', ipAddress: '10.0.0.1', createdAt: '2026-10-04T08:00:00Z', current: true },
      { id: 's2', userAgent: 'Mozilla (Android)', ipAddress: '10.0.0.2', createdAt: '2026-10-03T08:00:00Z', current: false }],
    available: { phone: true, google: true },
  };

  it('keeps the only way in, and signs out a device that is not this one', async () => {
    const sent = mount(<Me />, (p) => (p === '/me/profile' ? json(PROFILE) : undefined), { signedIn: true });
    const phone = await screen.findByTestId('way-phone');
    expect((phone.querySelector('button') as HTMLButtonElement).disabled).toBe(true); // «برداشتن»: the only way in
    expect(screen.getByText('همین دستگاه')).toBeDefined();
    const devices = screen.getByTestId('devices');
    fireEvent.click(devices.querySelectorAll('li')[1]!.querySelector('button')!);
    await waitFor(() => expect(sent.some((x) => x.method === 'DELETE' && x.path === '/me/sessions/s2')).toBe(true));
  });

  it('shows Telegram as a way into the Mini App, never counted as the last way in (audit F-9)', async () => {
    const withTelegram = { ...PROFILE, available: { ...PROFILE.available, telegram: true }, identities: [{ id: 'tg1', provider: 'telegram', email: null, createdAt: '2026-10-15T08:00:00Z', lastUsedAt: '2026-10-15T09:00:00Z' }] };
    const sent = mount(<Me />, (p) => (p === '/me/profile' ? json(withTelegram) : undefined), { signedIn: true });
    const telegram = await screen.findByTestId('way-telegram');
    expect(telegram.textContent).toContain('برنامهٔ هیوامیس درون تلگرام');
    // The mobile is still the only way in: Telegram does not make it removable.
    expect((screen.getByTestId('way-phone').querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    const remove = telegram.querySelector('button') as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    await waitFor(() => expect(sent.some((x) => x.method === 'DELETE' && x.path === '/me/identities/tg1')).toBe(true));
  });

  it('sets a first password for someone who joined without one', async () => {
    const sent = mount(<Me />, (p) => (p === '/me/profile' ? json(PROFILE) : undefined), { signedIn: true });
    const section = await screen.findByTestId('way-password');
    fireEvent.change(section.querySelector('input[type=password]')!, { target: { value: 'Tazeh-Ramz-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'گذاشتن رمز' }));
    await waitFor(() => expect(sent.find((x) => x.path === '/me/password')?.body).toEqual({ newPassword: 'Tazeh-Ramz-2026' }));
  });
});

describe("A colleague's page", () => {
  it('shows who they are and their work, without what is theirs alone', async () => {
    mount(<PersonPage />, (p) => (p === '/people/u2' ? json({
      id: 'u2', fullName: 'رضا شریفی', jobTitle: 'مدیر اکانت', email: 'am@hiva.local', isActive: true, joinedAt: '2026-01-01T00:00:00Z',
      department: { code: 'A', nameFa: 'اکانت', nameEn: 'Account', color: '#7c3aed' }, roles: ['ACCOUNT_MANAGER'], self: false, private: null,
      work: { openTasks: 2, overdueTasks: 1, tasks: [{ id: 't1', code: 'TSK-1', title: 'بازبینی بریف', state: 'IN_PROGRESS', dueDate: null }], projects: [] },
    }) : undefined), { path: '/people/u2', signedIn: true });
    expect(await screen.findByText('بازبینی بریف')).toBeDefined();
    expect(screen.getByRole('link', { name: 'am@hiva.local' }).getAttribute('href')).toBe('mailto:am@hiva.local');
    expect(screen.queryByText('شمارهٔ همراه')).toBeNull();
    expect(screen.queryByText('آخرین ورود')).toBeNull();
  });
});

describe('The administrator’s queue', () => {
  it('approves with a unit and roles, never offering system administration', async () => {
    const sent = mount(<SignupRequests />, (p) => {
      if (p === '/signup-requests') return json([{ id: 'q1', method: 'PHONE', fullName: 'نیلوفر احمدی', email: 'n@example.com', phone: '09121234567', departmentCode: 'S', note: null, status: 'PENDING', createdAt: '2026-10-04T08:00:00Z', decidedAt: null, decisionNote: null, decidedBy: null }]);
      if (p === '/settings/signup') return json({ enabled: true, phone: true, google: false });
      return undefined;
    }, { signedIn: true });
    fireEvent.click(await screen.findByRole('button', { name: 'تأیید و ساخت حساب' }));
    expect(screen.queryByLabelText('مدیر سیستم')).toBeNull();
    fireEvent.click(screen.getByLabelText('کارشناس فروش'));
    fireEvent.click(screen.getByRole('button', { name: 'ساخت حساب' }));
    await waitFor(() => expect(sent.find((x) => x.path === '/signup-requests/q1/approve')?.body).toEqual({ departmentCode: 'S', roles: ['SALES_REP'], jobTitle: null }));
  });
});
