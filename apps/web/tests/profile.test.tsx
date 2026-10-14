import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui';
import { AuthProvider } from '../src/lib/auth';
import { LocaleProvider } from '../src/lib/locale';
import { markSignedIn, setAccessToken } from '../src/lib/api';
import { Avatar } from '../src/components/Avatar';
import Me from '../src/pages/Me';
import { PersonPage } from '../src/pages/People';

/**
 * Audit F-6: the profile on the page. A photo is sent as it is and comes back as the server made
 * it; the few words are saved as written — skills split on commas, links one a line; a colleague's
 * page shows them, its links opened apart and not vouched for; a photo that will not load is the
 * initials again.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const AVATAR = '/api/v1/avatars/d1?exp=1&sig=s';
const ME = { id: 'u1', email: 'd@hiva.local', fullName: 'بهراد مهرنیا', jobTitle: 'طراح', avatarUrl: AVATAR, department: { code: 'CR', nameFa: 'خلاقیت' }, organization: { id: 'o', name: 'o', currency: 'IRR' }, roles: ['UNIT_MEMBER'], permissions: [], locale: 'fa', mustChangePassword: false };

function mount(at: string) {
  setAccessToken('t'); markSignedIn(true);
  const sent: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    sent.push({ method, path: p, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    if (p === '/auth/refresh') return json({ accessToken: 't', refreshToken: 'r' });
    if (p === '/auth/me') return json(ME);
    if (p === '/me/profile') return json({ id: 'u1', phone: null, phoneVerified: false, hasPassword: true, identities: [], sessions: [], available: { phone: false, google: false } });
    if (p === '/me/about' && method === 'GET') return json({ avatarUrl: AVATAR, bio: 'طراح هویت بصری', pronouncedName: null, skills: ['تایپوگرافی'], links: [] });
    if (p === '/me/about') return json({ avatarUrl: AVATAR, bio: 'x', pronouncedName: null, skills: [], links: [] });
    if (p === '/me/avatar') return json({ avatarUrl: '/api/v1/avatars/d2?exp=1&sig=s' });
    if (p === '/people/u2') return json({
      id: 'u2', fullName: 'نگار حیدری', jobTitle: 'مدیر دیجیتال', email: 'n@hiva.local', isActive: true, joinedAt: '2026-01-01T00:00:00Z', department: null, roles: [], self: false, private: null,
      avatarUrl: AVATAR, bio: 'کمپین‌های پرفورمنس', pronouncedName: 'نِگار', skills: ['Google Ads', 'سئو'], links: ['https://example.com/negar'],
      work: { openTasks: null, overdueTasks: null, tasks: null, projects: null },
    });
    return json([]);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><LocaleProvider><AuthProvider><MemoryRouter initialEntries={[at]}>
        <Routes><Route path="/me" element={<Me />} /><Route path="/people/:id" element={<PersonPage />} /></Routes>
      </MemoryRouter></AuthProvider></LocaleProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe('The profile', () => {
  it('sends a photo as it is, and saves the words as written', async () => {
    const sent = mount('/me');
    const about = await screen.findByTestId('about-me');
    const input = about.querySelector('input[type=file]') as HTMLInputElement;
    expect(input.accept).toBe('image/jpeg,image/png,image/webp,image/gif');
    fireEvent.change(input, { target: { files: [new File(['jpeg'], 'me.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect((sent.find((s) => s.path === '/me/avatar')?.body as FormData)?.get('file')).toBeInstanceOf(File));

    fireEvent.change(screen.getByRole('textbox', { name: /نامتان چطور خوانده می‌شود/ }), { target: { value: 'بِهراد' } });
    fireEvent.change(screen.getByRole('textbox', { name: /مهارت‌ها/ }), { target: { value: 'تایپوگرافی، Figma, موشن' } });
    fireEvent.change(screen.getByRole('textbox', { name: /پیوندها/ }), { target: { value: 'https://behance.net/b\nhttps://dribbble.com/b' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    await waitFor(() => expect(sent.find((s) => s.method === 'PATCH' && s.path === '/me/about')?.body).toEqual({
      bio: 'طراح هویت بصری', pronouncedName: 'بِهراد', skills: ['تایپوگرافی', 'Figma', 'موشن'], links: ['https://behance.net/b', 'https://dribbble.com/b'],
    }));
  });

  it('shows a colleague’s photo and words, and opens their links apart', async () => {
    mount('/people/u2');
    const about = await screen.findByTestId('about');
    expect(about.textContent).toContain('کمپین‌های پرفورمنس');
    expect(screen.getByText('خوانده می‌شود: نِگار')).toBeDefined();
    const link = screen.getByRole('link', { name: 'example.com/negar' });
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(document.querySelector(`img[src="${AVATAR}"]`)).not.toBeNull();
  });

  it('falls back to the initials when a photo will not load', () => {
    const { container } = render(<Avatar name="نگار حیدری" src="/broken" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('نح');
  });
});
