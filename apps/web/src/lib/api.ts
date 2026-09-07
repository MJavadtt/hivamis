/**
 * API client. Holds the access token in memory (not localStorage, so an XSS cannot read it)
 * and keeps only the refresh token in storage, transparently rotating on 401.
 */
const REFRESH_KEY = 'hiva.refresh';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export const setAccessToken = (t: string | null) => { accessToken = t; };
export const getAccessToken = () => accessToken;
export const setRefreshToken = (t: string | null) =>
  t ? localStorage.setItem(REFRESH_KEY, t) : localStorage.removeItem(REFRESH_KEY);
export const getRefreshToken = () => localStorage.getItem(REFRESH_KEY);

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
  }
  /** The Doc_H clause a governance rejection cites, when the server supplied one. */
  get rule(): string | undefined {
    return this.body.details?.rule as string | undefined;
  }
  get issues(): { path: string; message: string }[] {
    return (this.body.details?.issues as { path: string; message: string }[]) ?? [];
  }
}

async function attemptRefresh(): Promise<boolean> {
  const token = getRefreshToken();
  if (!token) return false;
  // Collapse concurrent 401s into a single refresh round-trip.
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      setAccessToken(data.accessToken);
      setRefreshToken(data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      queueMicrotask(() => { refreshing = null; });
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  raw?: boolean;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const send = async (): Promise<Response> =>
    fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await send();
  if (res.status === 401 && getRefreshToken()) {
    if (await attemptRefresh()) res = await send();
  }

  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let body: ApiErrorBody = { code: 'UNKNOWN', message: `خطای ${res.status}` };
    try {
      const parsed = await res.json();
      if (parsed?.error) body = parsed.error;
    } catch { /* keep the fallback message */ }
    throw new ApiError(res.status, body);
  }
  return opts.raw ? ((await res.text()) as T) : ((await res.json()) as T);
}

export const apiGet = <T>(path: string, query?: RequestOptions['query']) => api<T>(path, { query });
export const apiPost = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const apiPatch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const apiDelete = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}
