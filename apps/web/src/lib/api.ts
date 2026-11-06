import { locale, tr, trx } from '../i18n';
/**
 * API client. The access token is held in memory only. The refresh token is a cookie the server sets,
 * HttpOnly, so no script on this page — this one included — can read it (audit SEC-4). A 401 is
 * answered by asking the server to rotate it.
 */

/** A hint, not a credential: whether this browser has a session worth restoring. */
const SIGNED_IN_KEY = 'hiva.signedIn';
/** Where builds before the cookie kept the refresh token itself; traded once for the cookie, then gone. */
const LEGACY_KEY = 'hiva.refresh';

let accessToken: string | null = null;
let refreshing: Promise<RefreshOutcome> | null = null;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export const setAccessToken = (t: string | null) => { accessToken = t; };

/**
 * The system administrator working in someone's account (owner's report, 2026-10-23). That token is
 * never refreshed: when it runs out, the refresh brings back the administrator's own, and the app is
 * told to show their account again.
 */
let acting = false;
export const setActing = (on: boolean) => { acting = on; };
export const isActing = () => acting;
export const ACTING_ENDED_EVENT = 'hiva:acting-ended';
export const getAccessToken = () => accessToken;
export const markSignedIn = (on: boolean) => store.set(SIGNED_IN_KEY, on ? '1' : null);
/** Signed in here before — with the cookie, or with a token from before it. */
export const wasSignedIn = () => store.get(SIGNED_IN_KEY) === '1' || store.get(LEGACY_KEY) !== null;

/** The header the auth routes ask of whatever spends the cookie: it says the request is the app's own. */
const FROM_THE_APP = { 'x-hiva-refresh': '1' } as const;

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: ApiErrorBody) {
    // The server answers in the language the request asked for; this covers one that did not.
    super(trx(body.message));
    this.name = 'ApiError';
  }
  /** The Doc_H clause a governance rejection cites, when the server supplied one. */
  get rule(): string | undefined {
    const rule = this.body.details?.rule as string | undefined;
    return rule === undefined ? undefined : trx(rule);
  }
  get issues(): { path: string; message: string }[] {
    return ((this.body.details?.issues as { path: string; message: string }[]) ?? []).map((i) => ({ ...i, message: trx(i.message) }));
  }
}

/**
 * The API answers every error itself, as JSON. A failure without that body came from something
 * standing in for it — the development server's proxy (a bare 500) or nginx (502–504) while the API
 * is stopped or restarting — and a fetch that throws never reached anything. Both say so in words,
 * instead of «خطای ۵۰۰» or the browser's "Failed to fetch".
 */
const unreachable = (): ApiErrorBody => ({ code: 'UNREACHABLE', message: tr('سرور در دسترس نیست؛ چند لحظهٔ دیگر دوباره تلاش کنید.') });

/** The words for a failure that came without the API's own: the pages outside the session use it too. */
export const fallbackMessage = (status: number): string => (status >= 500 ? unreachable().message : tr('خطای {0}', status));

export async function failure(res: Response): Promise<ApiError> {
  try {
    const parsed = await res.json();
    if (parsed?.error) return new ApiError(res.status, parsed.error as ApiErrorBody);
  } catch { /* not the API's own answer */ }
  return new ApiError(res.status, res.status >= 500 ? unreachable() : { code: 'UNKNOWN', message: fallbackMessage(res.status) });
}

/** Sends, turning "no answer at all" into the same unreachable error. An abort stays an abort. */
async function reach(send: () => Promise<Response>): Promise<Response> {
  try {
    return await send();
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError(0, unreachable());
  }
}

/** How a refresh went: a new pair, a refusal (the session is over), or no answer (try again later). */
export type RefreshOutcome = 'ok' | 'rejected' | 'unreachable';

/**
 * One refresh at a time: concurrent 401s in this tab share a round-trip, and tabs take turns through
 * a Web Lock, each reading the stored token inside it. Without that, two tabs (or React's development
 * double mount) spent the same refresh token twice — the server either minted two sessions or, once
 * rotation was made atomic, read it as theft and signed the person out everywhere (Hivamis task 10).
 */
function refreshOnce(): Promise<RefreshOutcome> {
  refreshing ??= (async () => {
    const run = async (): Promise<RefreshOutcome> => {
      // Read inside the lock: a tab that went first may have traded it already.
      const legacy = store.get(LEGACY_KEY);
      let res: Response;
      try {
        res = legacy
          ? await fetch('/api/v1/auth/refresh/legacy', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...FROM_THE_APP },
            body: JSON.stringify({ refreshToken: legacy }),
          })
          : await fetch('/api/v1/auth/refresh', { method: 'POST', headers: FROM_THE_APP, credentials: 'same-origin' });
      } catch {
        return 'unreachable';
      }
      // A server restarting, a proxy with nothing behind it, the rate limit: the session may well be
      // fine. Only the server saying no ends it.
      if (res.status >= 500 || res.status === 429) return 'unreachable';
      // The old token has had its one trade, whichever way it went.
      if (legacy) store.set(LEGACY_KEY, null);
      if (!res.ok) { markSignedIn(false); return 'rejected'; }
      const data = await res.json();
      setAccessToken(data.accessToken);
      markSignedIn(true);
      // The cookie is the administrator's: a refresh while in someone's account is the way back out.
      if (acting) { acting = false; window.dispatchEvent(new CustomEvent(ACTING_ENDED_EVENT)); }
      // Whatever asked for it — a page, the live stream, an expiring token — the new token says what
      // its holder may now do; the app compares and re-reads the user when that changed (Hivamis task 6).
      window.dispatchEvent(new CustomEvent(TOKEN_REFRESHED_EVENT, { detail: { permissions: tokenPermissions(data.accessToken) } }));
      return 'ok';
    };
    try {
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      return locks ? await locks.request('hiva.refresh', run) : await run();
    } catch {
      return 'unreachable';
    } finally {
      queueMicrotask(() => { refreshing = null; });
    }
  })();
  return refreshing;
}

async function attemptRefresh(): Promise<boolean> {
  if (!wasSignedIn()) return false;
  return (await refreshOnce()) === 'ok';
}

/** Fired after every token refresh, with the permissions the new token carries. */
export const TOKEN_REFRESHED_EVENT = 'hiva:token-refreshed';

/** The permissions an access token carries — read from its payload, which the server signed. */
export function tokenPermissions(token: string): string[] | null {
  try {
    const part = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(part + '='.repeat((4 - (part.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const json = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(json.permissions) ? json.permissions : null;
  } catch {
    return null;
  }
}

/** For callers that hold a connection open themselves — the live stream (roadmap #39). */
export const refreshSession = () => attemptRefresh();
/** Restoring a session on load: tells a refused session from a server that did not answer. */
export const restoreSession = () => refreshOnce();

/** The bearer, and the language the answer — an error message above all — should come in. */
export const baseHeaders = (): Record<string, string> => ({
  'accept-language': locale(),
  ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
});

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  raw?: boolean;
  /** Sent as they are — an `Idempotency-Key`, for a write an offline queue may send again (audit F-7). */
  headers?: Record<string, string>;
}

/** Told of every write that succeeded, before its caller hears: a form is still on screen (ADR-122). */
const mutationListeners = new Set<(path: string) => void>();
export function onMutation(listener: (path: string) => void) {
  mutationListeners.add(listener);
  return () => { mutationListeners.delete(listener); };
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
        ...baseHeaders(),
        // Signing in and out sets and spends the refresh cookie; the server asks such calls to say they are the app's.
        ...(path.startsWith('/auth/') ? FROM_THE_APP : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await reach(send);
  if (res.status === 401 && wasSignedIn()) {
    if (await attemptRefresh()) res = await reach(send);
  }

  if (res.ok && opts.method && opts.method !== 'GET') mutationListeners.forEach((l) => l(path));
  if (res.status === 204) return undefined as T;
  if (!res.ok) throw await failure(res);
  return opts.raw ? ((await res.text()) as T) : ((await res.json()) as T);
}

/** A multipart upload with the same bearer and refresh handling as `api` (the browser sets the boundary). */
export async function apiUpload<T = unknown>(path: string, form: FormData): Promise<T> {
  const send = () => fetch(`/api/v1${path}`, {
    method: 'POST', body: form,
    headers: baseHeaders(),
  });
  let res = await reach(send);
  if (res.status === 401 && wasSignedIn()) {
    if (await attemptRefresh()) res = await reach(send);
  }
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
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

  const send = () => fetch(url, { headers: baseHeaders() });

  let res = await reach(send);
  if (res.status === 401 && wasSignedIn() && (await attemptRefresh())) res = await reach(send);

  if (!res.ok) throw await failure(res);

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
/** A file's bytes behind the session — for an <img>, a <video> or pdf.js to show (roadmap #38). */
export async function apiBlob(path: string): Promise<Blob> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  const send = () => fetch(url, { headers: baseHeaders() });
  let res = await reach(send);
  if (res.status === 401 && wasSignedIn() && (await attemptRefresh())) res = await reach(send);
  if (!res.ok) throw await failure(res);
  return res.blob();
}

export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  const send = () => fetch(url, { headers: baseHeaders() });
  let res = await reach(send);
  if (res.status === 401 && wasSignedIn() && (await attemptRefresh())) res = await reach(send);
  if (!res.ok) throw await failure(res);
  const ascii = /filename="([^"]+)"/i.exec(res.headers.get('content-disposition') ?? '');
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = ascii?.[1] ?? fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** A file that is handed over only for a POSTed body — a reason, under oversight (audit F-5). */
export async function postDownload(path: string, body: unknown, fallbackName: string): Promise<void> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  const send = () => fetch(url, { method: 'POST', headers: { ...baseHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let res = await reach(send);
  if (res.status === 401 && wasSignedIn() && (await attemptRefresh())) res = await reach(send);
  if (!res.ok) throw await failure(res);
  const named = /filename="([^"]+)"/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href; a.download = named ? decodeURIComponent(named) : fallbackName;
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
      ...baseHeaders(),
    },
    body: JSON.stringify(body),
  });

  let res = await reach(send);
  if (res.status === 401 && wasSignedIn() && (await attemptRefresh())) res = await reach(send);

  if (!res.ok) throw await failure(res);

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
