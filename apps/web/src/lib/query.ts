import {
  type QueryKey,
  QueryClient,
  type UseQueryOptions,
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { NAMESPACES } from '@yap/shared/i18n';
import { toast } from 'sonner';
import { ApiError, api, type QueryParams } from './api';
import i18n from './i18n';
import type { ListMeta } from './types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failures, error) => {
        // Client errors will not fix themselves; only retry network and server failures.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failures < 2;
      },
    },
    mutations: { retry: false },
  },
});

/**
 * Query keys are the path split into segments, so invalidating '/finance/counterparties'
 * also covers its lists and every '/finance/counterparties/:id'.
 */
export function pathKey(path: string, params?: QueryParams): QueryKey {
  const segments = path.split('/').filter(Boolean);
  return params ? [...segments, params] : segments;
}

/**
 * The message to show for any thrown value. The API sends a stable code plus an English fallback, so
 * the text comes from `errors.<CODE>` in whichever namespace defines it: add new codes to your module's
 * dictionary. Plain-object `details` are available as placeholders, e.g. {{available}}.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return i18n.t('common:errors.generic');
  if (error.status === 0) return i18n.t('common:errors.network');
  if (error.status === 429) return i18n.t('common:errors.rateLimit');
  if (error.status >= 500) return i18n.t('common:errors.server');
  const details = error.details && typeof error.details === 'object' ? (error.details as Record<string, unknown>) : {};
  return i18n.t(
    NAMESPACES.map((ns) => `${ns}:errors.${error.code}`),
    { ...details, defaultValue: error.message || i18n.t('common:errors.generic') },
  );
}

export function useList<T>(
  path: string,
  params?: QueryParams,
  options?: Omit<UseQueryOptions<{ data: T[]; meta: ListMeta }>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<{ data: T[]; meta: ListMeta }>({
    queryKey: pathKey(path, params ?? {}),
    queryFn: () => api.list<T>(path, params),
    placeholderData: keepPreviousData,
    ...options,
  });
}

export function useDetail<T>(
  path: string | null | undefined,
  params?: QueryParams,
  options?: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<T>({
    queryKey: pathKey(path ?? '', params),
    queryFn: () => api.get<T>(path as string, params),
    enabled: Boolean(path),
    ...options,
  });
}

export interface ApiMutationConfig<TVars, TResult> {
  mutationFn: (vars: TVars) => Promise<TResult>;
  /** API paths whose cached queries become stale on success. */
  invalidate?: string[];
  /** Toast on success: an i18n key or literal already-translated text. */
  successMessage?: string;
  /** Keep errors out of toasts, e.g. when a form displays them inline. */
  silentError?: boolean;
  onSuccess?: (result: TResult, vars: TVars) => void;
  onError?: (error: unknown, vars: TVars) => void;
}

export function useApiMutation<TVars = void, TResult = unknown>(config: ApiMutationConfig<TVars, TResult>) {
  const client = useQueryClient();
  return useMutation<TResult, unknown, TVars>({
    mutationFn: config.mutationFn,
    onSuccess: async (result, vars) => {
      await Promise.all((config.invalidate ?? []).map((path) => client.invalidateQueries({ queryKey: pathKey(path) })));
      if (config.successMessage) toast.success(i18n.t(config.successMessage));
      config.onSuccess?.(result, vars);
    },
    onError: (error, vars) => {
      if (!config.silentError) toast.error(errorMessage(error));
      config.onError?.(error, vars);
    },
  });
}
