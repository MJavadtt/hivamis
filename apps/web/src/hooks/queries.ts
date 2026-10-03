import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { apiGet, type Page } from '../lib/api';
import { useToast } from '../components/ui';
import { tr } from '../i18n';

/** Typed list query for the paginated collection endpoints. */
export function useList<T>(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
  options?: Partial<UseQueryOptions<Page<T>>>,
) {
  return useQuery<Page<T>>({
    queryKey: [path, query],
    queryFn: () => apiGet<Page<T>>(path, query),
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
  successMessage: string,
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      toast(successMessage);
      await qc.invalidateQueries();
    },
    onError: (e: any) => toast(e?.message ?? tr('عملیات ناموفق بود.'), 'danger'),
  });
}
