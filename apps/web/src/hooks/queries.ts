import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { cachedGet } from '../lib/offline';
import { apiGet, type Page } from '../lib/api';
import { useToast } from '../components/ui';
import { tr } from '../i18n';

/** Typed list query for the paginated collection endpoints. */
export function useList<T>(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
  options?: Partial<UseQueryOptions<Page<T>>>,
  /** Kept on the device for reading without a connection (audit F-7) — for the lists used in the field. */
  offline = false,
) {
  return useQuery<Page<T>>({
    queryKey: [path, query],
    queryFn: () => (offline ? cachedGet<Page<T>>(path, query) : apiGet<Page<T>>(path, query)),
    ...(offline ? { networkMode: 'offlineFirst' as const } : {}),
    ...options,
  });
}

export function useOne<T>(path: string | null, options?: Partial<UseQueryOptions<T>>) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => apiGet<T>(path!),
    enabled: !!path,
    ...options,
  });
}

export interface Transition {
  action: string;
  labelFa: string;
  labelEn: string;
  requiresReason: boolean;
  to: string;
}

/** Generic create/update mutation with toast + cache invalidation. */
export function useAction<TInput, TResult = unknown>(
  fn: (input: TInput) => Promise<TResult>,
  successMessage: string | ((result: TResult) => string),
  /** `offline`: run even with no network — for an action that queues itself (audit F-7). */
  opts: { offline?: boolean } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    ...(opts.offline ? { networkMode: 'always' as const } : {}),
    onSuccess: async (result) => {
      toast(typeof successMessage === 'function' ? successMessage(result) : successMessage);
      await qc.invalidateQueries();
    },
    onError: (e: any) => toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'),
  });
}
