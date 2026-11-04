import type { ListMeta } from './types';

const BASE = '/api/v1';

export type QueryParams = Record<string, unknown>;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field errors from `details.fieldErrors`: { fieldName: message | message[] }. */
  get fieldErrors(): Record<string, string> {
    const raw = (this.details as { fieldErrors?: Record<string, string | string[]> } | null | undefined)?.fieldErrors;
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(
      Object.entries(raw).map(([field, value]) => [field, Array.isArray(value) ? value.join(', ') : String(value)]),
    );
  }
}

export interface RequestOptions {
  params?: QueryParams;
  /** Replays safely if the same request is sent twice (offline outbox). */
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

interface AuthEvents {
  /** A refresh succeeded: the server's session payload, if it sent one. */
  onRefreshed?: (session: unknown) => void;
  /** Refresh failed: the user must sign in again. */
  onSignedOut?: () => void;
}

let accessToken: string | null = null;
let events: AuthEvents = {};
let refreshInFlight: Promise<RefreshResult | null> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setAuthEvents(next: AuthEvents): void {
  events = next;
}

export function buildQuery(params?: QueryParams): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) search.append(key, String(v));
    } else {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export interface RefreshResult {
  accessToken: string;
  session: unknown;
}

async function callRefresh(): Promise<RefreshResult | null> {
  try {
    const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Partial<RefreshResult> };
    return body.data?.accessToken ? { accessToken: body.data.accessToken, session: body.data.session } : null;
  } catch {
    return null;
  }
}

/**
 * Exchange the refresh cookie for a new access token. Refresh tokens rotate, and replaying a used one
 * looks like theft to the server. So there is one flight per tab (StrictMode, parallel 401s) and a Web
 * Lock across tabs: the second tab runs after the first and sends the already-rotated cookie.
 */
export function refreshSession(): Promise<RefreshResult | null> {
  refreshInFlight ??= (async () => {
    try {
      const result = navigator.locks
        ? await navigator.locks.request('yap.auth.refresh', callRefresh)
        : await callRefresh();
      if (result) {
        accessToken = result.accessToken;
        events.onRefreshed?.(result.session);
      }
      return result;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body.error) {
      return new ApiError(res.status, body.error.code ?? 'ERROR', body.error.message ?? res.statusText, body.error.details);
    }
  } catch {
    // Not JSON: fall through to a generic error.
  }
  return new ApiError(res.status, 'HTTP_ERROR', res.statusText || `HTTP ${res.status}`);
}

async function send(path: string, init: RequestInit, opts: RequestOptions): Promise<Response> {
  const url = `${BASE}${path}${buildQuery(opts.params)}`;
  const isAuthCall = path.startsWith('/auth/login') || path.startsWith('/auth/refresh') || path.startsWith('/auth/2fa/verify');

  const attempt = (): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    if (opts.idempotencyKey) headers.set('Idempotency-Key', opts.idempotencyKey);
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
    return fetch(url, { ...init, headers, credentials: 'include', signal: opts.signal });
  };

  let res: Response;
  try {
    res = await attempt();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error');
  }

  if (res.status === 401 && !isAuthCall) {
    if (await refreshSession()) {
      try {
        res = await attempt();
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', 'Network error');
      }
    } else {
      accessToken = null;
      events.onSignedOut?.();
    }
  }
  return res;
}

async function request<T>(path: string, init: RequestInit, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, init, opts);
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return (JSON.parse(text) as { data: T }).data;
}

function jsonInit(method: string, body: unknown): RequestInit {
  if (body === undefined) return { method };
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export interface UploadedFile {
  id: string;
  name: string;
  mimeType: string;
  /** Short-lived signed link, usable directly as an <img> src. */
  url: string;
}

export const api = {
  /** GET a single resource; returns the unwrapped `data`. */
  get<T>(path: string, params?: QueryParams, opts?: Omit<RequestOptions, 'params'>): Promise<T> {
    return request<T>(path, { method: 'GET' }, { ...opts, params });
  },

  /** GET a paginated list; returns `{ data, meta }`. */
  async list<T>(path: string, params?: QueryParams, opts?: Omit<RequestOptions, 'params'>): Promise<{ data: T[]; meta: ListMeta }> {
    const res = await send(path, { method: 'GET' }, { ...opts, params });
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as { data: T[]; meta: ListMeta };
  },

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>(path, jsonInit('POST', body), opts);
  },

  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>(path, jsonInit('PATCH', body), opts);
  },

  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>(path, jsonInit('PUT', body), opts);
  },

  delete<T = void>(path: string, opts?: RequestOptions): Promise<T> {
    return request<T>(path, { method: 'DELETE' }, opts);
  },

  /** Multipart upload to POST /files; returns the stored file. */
  upload(file: File | Blob, name?: string, opts?: RequestOptions): Promise<UploadedFile> {
    const form = new FormData();
    form.append('file', file, name ?? (file instanceof File ? file.name : 'file'));
    return request<UploadedFile>('/files', { method: 'POST', body: form }, opts);
  },

  /** Multipart POST to any endpoint, e.g. spreadsheet import. Returns the unwrapped `data`. */
  postFile<T>(path: string, file: File | Blob, fields?: Record<string, string>, opts?: RequestOptions): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields ?? {})) form.append(k, v);
    form.append('file', file, file instanceof File ? file.name : 'file');
    return request<T>(path, { method: 'POST', body: form }, opts);
  },

  /** Authenticated file download: fetches with the access token and saves through the browser. */
  async download(path: string, filename?: string, params?: QueryParams): Promise<void> {
    const res = await send(path, { method: 'GET' }, { params });
    if (!res.ok) throw await toApiError(res);
    const blob = await res.blob();
    const fromHeader = res.headers.get('content-disposition')?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? (fromHeader ? decodeURIComponent(fromHeader) : 'download');
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  /** Authenticated fetch of a protected file as an object URL, for <img> previews. Caller revokes it. */
  async blobUrl(path: string): Promise<string> {
    const res = await send(path, { method: 'GET' }, {});
    if (!res.ok) throw await toApiError(res);
    return URL.createObjectURL(await res.blob());
  },
};
