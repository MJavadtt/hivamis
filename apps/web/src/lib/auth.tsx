import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TOKEN_REFRESHED_EVENT, apiGet, apiPost, markSignedIn, restoreSession, setAccessToken, wasSignedIn } from './api';
import { adoptAccountLocale } from './locale';
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
  /** The stored session could not be checked: the server did not answer. It is kept, and tried again. */
  unreachable: boolean;
  retry: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  /** Takes up a session another way in produced — a code sent to the mobile (Hivamis task 4). */
  signInWith: (session: { accessToken: string }) => Promise<void>;
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
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const loadUser = useCallback(async () => {
    try {
      const me = await apiGet<CurrentUser>('/auth/me');
      setUser(me);
      adoptAccountLocale(me.locale);
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

  // Restore the session from the refresh cookie on first paint. A server that does not answer —
  // restarting, a deploy, the network — is not a refusal: it is tried again, rather than signing the
  // person out (Hivamis task 10).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    (async () => {
      if (!wasSignedIn()) { setLoading(false); return; }
      const outcome = await restoreSession();
      if (cancelled) return;
      if (outcome === 'ok') {
        setUnreachable(false);
        await loadUser();
      } else if (outcome === 'rejected') {
        setUnreachable(false);
      } else {
        setUnreachable(true);
        timer = setTimeout(() => setAttempt((n) => n + 1), Math.min(30_000, 3_000 * 2 ** Math.min(attempt, 4)));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [loadUser, attempt]);

  const signInWith = useCallback(async (session: { accessToken: string }) => {
    // The refresh token came as a cookie with the same answer; only the access token is ours to hold.
    setAccessToken(session.accessToken);
    markSignedIn(true);
    await loadUser();
  }, [loadUser]);

  const signIn = useCallback(async (email: string, password: string) => {
    await signInWith(await apiPost<{ accessToken: string }>('/auth/login', { email, password }));
  }, [signInWith]);

  const signOut = useCallback(async () => {
    // While the session still stands: this browser stops receiving this person's notices (#49).
    await forgetPushOnSignOut();
    try {
      // The server ends this device's session from its cookie, and clears the cookie.
      await apiPost('/auth/logout');
    } catch { /* the local session is cleared regardless */ }
    setAccessToken(null);
    markSignedIn(false);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(() => {
    const perms = new Set(user?.permissions ?? []);
    return {
      user,
      loading,
      unreachable,
      retry: () => setAttempt((n) => n + 1),
      signIn,
      signInWith,
      signOut,
      refreshUser: loadUser,
      can: (...need) => need.every((p) => perms.has(p)),
      canAny: (...need) => need.some((p) => perms.has(p)),
      hasRole: (...roles) => roles.some((r) => user?.roles.includes(r)),
    };
  }, [user, loading, unreachable, signIn, signInWith, signOut, loadUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
