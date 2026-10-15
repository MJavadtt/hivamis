import { useSyncExternalStore } from 'react';
import { ApiError, apiGet, type RequestOptions } from './api';
import { vaultGet, vaultPut } from './vault';

/**
 * Reading without a connection (audit F-7). A page that people use in the field reads through
 * `cachedGet`: the server's answer when there is one — kept in the encrypted copy (lib/vault.ts) —
 * and the last kept answer when there is not, marked with when it was kept so the page can say so.
 * A refusal is not "no connection": a 403 or a 404 is shown as itself, never papered over.
 */

/** The server did not answer — no network, or nothing behind the proxy — as opposed to answering no. */
export const unreached = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 500);

const shownSince = new Map<string, number>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const nameOf = (path: string, query?: RequestOptions['query']) =>
  query ? `${path}?${JSON.stringify(Object.entries(query).filter(([, v]) => v !== undefined).sort())}` : path;

export async function cachedGet<T>(path: string, query?: RequestOptions['query']): Promise<T> {
  const name = nameOf(path, query);
  try {
    const value = await apiGet<T>(path, query);
    void vaultPut(name, value);
    if (shownSince.delete(name)) changed();
    return value;
  } catch (e) {
    if (!unreached(e)) throw e;
    const copy = await vaultGet<T>(name);
    if (!copy) throw e;
    shownSince.set(name, copy.savedAt);
    changed();
    return copy.value;
  }
}

/** A query a person may need offline: it is asked even when the browser says there is no network. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the result type is the useQuery call's own.
export const offlineQuery = <T = any,>(path: string, query?: RequestOptions['query']) => ({
  queryKey: query ? [path, query] : [path],
  queryFn: () => cachedGet<T>(path, query),
  networkMode: 'offlineFirst' as const,
});

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** When the copy on screen was kept, if the server could not be asked; otherwise null. */
export function useShownSince(path: string, query?: RequestOptions['query']): number | null {
  const name = nameOf(path, query);
  return useSyncExternalStore(subscribe, () => shownSince.get(name) ?? null, () => null);
}

/** Whether anything on screen is the kept copy. */
export function useShowingCopy(): boolean {
  return useSyncExternalStore(subscribe, () => shownSince.size > 0, () => false);
}

/** For tests, and sign-out. */
export function forgetShown() { shownSince.clear(); changed(); }
