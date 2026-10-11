import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { markSignedIn, setAccessToken, wasSignedIn } from '../src/lib/api';

const USER = {
  id: 'u1', email: 'account.manager@hiva.local', fullName: 'رضا شریفی',
  jobTitle: 'مدیر اکانت', departmentCode: 'A',
  roles: ['ACCOUNT_MANAGER'],
  permissions: ['project.read', 'project.write', 'qc.account'],
  locale: 'fa',
};

/** Renders the auth helpers as text so assertions read as what a component would see. */
function Probe() {
  const { user, loading, can, canAny, hasRole } = useAuth();
  if (loading) return <span>loading</span>;
  return (
    <ul>
      <li>user:{user?.fullName ?? 'none'}</li>
      <li>can-one:{String(can('project.read'))}</li>
      <li>can-all:{String(can('project.read', 'qc.account'))}</li>
      <li>can-missing:{String(can('project.read', 'pricing.approve'))}</li>
      <li>any:{String(canAny('pricing.approve', 'qc.account'))}</li>
      <li>any-none:{String(canAny('pricing.approve', 'admin.users'))}</li>
      <li>role:{String(hasRole('ACCOUNT_MANAGER'))}</li>
      <li>role-other:{String(hasRole('CEO'))}</li>
    </ul>
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  setAccessToken(null);
  localStorage.clear();
});

describe('Session restore on first paint', () => {
  it('shows a loading state and resolves to signed-out in a browser never signed in', async () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<AuthProvider><Probe /></AuthProvider>);
    // Never signed in here, so it must not call the network at all.
    await waitFor(() => expect(screen.getByText('user:none')).toBeDefined());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('restores the session from the refresh cookie and loads the user', async () => {
    markSignedIn(true);
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/auth/refresh')) {
        return jsonResponse({ accessToken: 'fresh' });
      }
      if (u.includes('/auth/me')) return jsonResponse(USER);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('user:رضا شریفی')).toBeDefined());
  });

  /** A refused session must be forgotten, or the app retries a dead session on every load. */
  it('forgets a session the server refuses', async () => {
    markSignedIn(true);
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'نشست نامعتبر است' } }, 401)));

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('user:none')).toBeDefined());
    expect(wasSignedIn()).toBe(false);
  });
});

describe('Permission helpers', () => {
  beforeEach(() => {
    markSignedIn(true);
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/auth/refresh')) return jsonResponse({ accessToken: 'a' });
      if (u.includes('/auth/me')) return jsonResponse(USER);
      return jsonResponse({}, 404);
    }));
  });

  it('requires every permission for can() and any one for canAny()', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('user:رضا شریفی')).toBeDefined());

    expect(screen.getByText('can-one:true')).toBeDefined();
    expect(screen.getByText('can-all:true')).toBeDefined();
    // can() is an AND — one missing permission fails the whole check, which is what gates a
    // destructive action behind two grants rather than either.
    expect(screen.getByText('can-missing:false')).toBeDefined();
    expect(screen.getByText('any:true')).toBeDefined();
    expect(screen.getByText('any-none:false')).toBeDefined();
  });

  it('matches roles the user actually holds', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('user:رضا شریفی')).toBeDefined());
    expect(screen.getByText('role:true')).toBeDefined();
    expect(screen.getByText('role-other:false')).toBeDefined();
  });
});

describe('useAuth outside a provider', () => {
  it('fails loudly rather than returning a permissive default', () => {
    // A silent default here would render every gated control as permitted.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/AuthProvider/);
    spy.mockRestore();
  });
});
