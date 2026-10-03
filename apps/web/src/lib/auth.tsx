import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TOKEN_REFRESHED_EVENT, api, apiGet, apiPost, getRefreshToken, setAccessToken, setRefreshToken } from './api';
import { forgetPushOnSignOut } from './push';

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string;
  jobTitle: string | null;
  locale: string;
  mustChangePassword: boolean;
  department: { code: string; nameFa: string } | null;
  organization: { id: string; name: string; currency: string };
  roles: string[];
  permissions: string[];
  /** permission → who delegated it; absent for what the user holds in their own right. */
  delegated?: Record<string, string>;
  delegatedRoles?: Record<string, string>;
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  /** True when the signed-in user holds every listed permission. */
  can: (...perms: string[]) => boolean;
  /** True when the user holds at least one of the listed permissions. */
  canAny: (...perms: string[]) => boolean;
  hasRole: (...roles: string[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    try {
      setUser(await apiGet<CurrentUser>('/auth/me'));
    } catch {
      setUser(null);
    }
  }, []);

  // A fresh token carries what the user may do now; when that is not what the screen shows — the
  // administrator changed a role, a delegation began or ended — re-read who the user is (Hivamis task 6).
  const shown = useRef<CurrentUser | null>(null);
  shown.current = user;
  useEffect(() => {
    const onRefresh = (e: Event) => {
      const now = (e as CustomEvent<{ permissions: string[] | null }>).detail?.permissions;
      const u = shown.current;
      if (u && now && (now.length !== u.permissions.length || now.some((p) => !u.permissions.includes(p)))) void loadUser();
    };
    window.addEventListener(TOKEN_REFRESHED_EVENT, onRefresh);
    return () => window.removeEventListener(TOKEN_REFRESHED_EVENT, onRefresh);
  }, [loadUser]);

  // Restore the session from the stored refresh token on first paint.
  useEffect(() => {
    (async () => {
      if (!getRefreshToken()) { setLoading(false); return; }
      try {
        const data = await api<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: getRefreshToken() },
        });
        setAccessToken(data.accessToken);
        setRefreshToken(data.refreshToken);
        await loadUser();
      } catch {
        setRefreshToken(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadUser]);

  const signIn = useCallback(async (email: string, password: string) => {
    const data = await apiPost<{
      accessToken: string; refreshToken: string; user: CurrentUser;
    }>('/auth/login', { email, password });
    setAccessToken(data.accessToken);
    setRefreshToken(data.refreshToken);
    await loadUser();
  }, [loadUser]);

  const signOut = useCallback(async () => {
    // While the session still stands: this browser stops receiving this person's notices (#49).
    await forgetPushOnSignOut();
    try {
      await apiPost('/auth/logout', { refreshToken: getRefreshToken() });
    } catch { /* the local session is cleared regardless */ }
    setAccessToken(null);
    setRefreshToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(() => {
    const perms = new Set(user?.permissions ?? []);
    return {
      user,
      loading,
      signIn,
      signOut,
      refreshUser: loadUser,
      can: (...need) => need.every((p) => perms.has(p)),
      canAny: (...need) => need.some((p) => perms.has(p)),
      hasRole: (...roles) => roles.some((r) => user?.roles.includes(r)),
    };
  }, [user, loading, signIn, signOut, loadUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
