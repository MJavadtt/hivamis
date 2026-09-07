import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { apiGet, apiPost, type Page } from '../lib/api';
import { useToast } from '../components/ui';

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

/**
 * Drives an entity through the workflow engine and invalidates every affected view.
 * All lifecycle changes in the UI funnel through here, matching the server's single write path.
 */
export function useTransition(entity: string, id: string | undefined) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { action: string; reason?: string; payload?: Record<string, unknown> }) =>
      apiPost(`/workflow/${entity}/${id}/transitions`, input),
    onSuccess: async (result: any) => {
      toast(`وضعیت به «${result?.toState ? stateLabel(result.toState) : 'وضعیت جدید'}» تغییر کرد.`);
      await qc.invalidateQueries();
    },
    onError: (e: any) => toast(e?.message ?? 'انجام این عملیات ممکن نشد.', 'danger'),
  });
}

function stateLabel(state: string): string {
  // Kept local to avoid a circular import with the UI module's STATE_META.
  return state;
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
    onError: (e: any) => toast(e?.message ?? 'عملیات ناموفق بود.', 'danger'),
  });
}
