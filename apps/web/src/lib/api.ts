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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
export const apiPut = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const apiPatch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const apiDelete = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * Download a generated PDF.
 *
 * The export endpoint is permission-gated and returns a Bearer-authenticated binary, so it cannot
 * be reached with a plain link; the response is buffered to a blob and handed to the browser.
 * The server sets the Persian filename via RFC 5987, which is preferred over the ASCII fallback.
 */
export async function downloadPdf(kind: string, id: string): Promise<void> {
  const url = new URL(`/api/v1/pdf/${kind}/${id}`, window.location.origin);

  const send = () => fetch(url, { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });

  let res = await send();
  if (res.status === 401 && getRefreshToken() && (await attemptRefresh())) res = await send();

  if (!res.ok) {
    let body: ApiErrorBody = { code: 'UNKNOWN', message: `خطای ${res.status}` };
    try {
      const parsed = await res.json();
      if (parsed?.error) body = parsed.error;
    } catch { /* binary or empty body — keep the fallback */ }
    throw new ApiError(res.status, body);
  }

  const disposition = res.headers.get('content-disposition') ?? '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const ascii = /filename="([^"]+)"/i.exec(disposition);
  const filename = utf8 ? decodeURIComponent(utf8[1]) : (ascii?.[1] ?? `${kind}-${id}.pdf`);

  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick; revoking synchronously can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** GET any file the API serves with a content-disposition — CSV templates and exports. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  const send = () => fetch(url, { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
  let res = await send();
  if (res.status === 401 && getRefreshToken() && (await attemptRefresh())) res = await send();
  if (!res.ok) {
    let body: ApiErrorBody = { code: 'UNKNOWN', message: `خطای ${res.status}` };
    try { const parsed = await res.json(); if (parsed?.error) body = parsed.error; } catch { /* not JSON */ }
    throw new ApiError(res.status, body);
  }
  const ascii = /filename="([^"]+)"/i.exec(res.headers.get('content-disposition') ?? '');
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = ascii?.[1] ?? fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** POST a selection and download the merged PDF it produces. */
export async function downloadPdfBundle(
  kind: string,
  id: string,
  body: { items: { kind: string; id: string }[]; fileIds: string[] },
): Promise<number> {
  const url = new URL(`/api/v1/pdf/${kind}/${id}/bundle`, window.location.origin);

  const send = () => fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });

  let res = await send();
  if (res.status === 401 && getRefreshToken() && (await attemptRefresh())) res = await send();

  if (!res.ok) {
    let err: ApiErrorBody = { code: 'UNKNOWN', message: `خطای ${res.status}` };
    try {
      const parsed = await res.json();
      if (parsed?.error) err = parsed.error;
    } catch { /* binary or empty body */ }
    throw new ApiError(res.status, err);
  }

  const disposition = res.headers.get('content-disposition') ?? '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const filename = utf8 ? decodeURIComponent(utf8[1]) : `bundle-${kind}.pdf`;
  const sections = Number(res.headers.get('x-bundle-sections') ?? 0);

  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return sections;
}
