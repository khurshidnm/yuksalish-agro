import { MAX_UPLOAD_BYTES } from '@yap/shared';
import type { ListMeta } from './types';
import { storageGet, storageRemove, storageSet } from './utils';

const BASE = '/api/v1';
const SIGN_OUT_OWED_KEY = 'yap.signOutOwed';

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
  /** The cookie now belongs to someone else, or to another farm. This tab must start over. */
  onSomeoneElse?: () => void;
}

/** Whose screens this tab shows. */
export interface TabIdentity {
  userId: string;
  farmId: string | null;
}

/** A save nobody has answered yet: its key, and the body that may already be in the books. */
interface OpenSave {
  key: string;
  body: string;
}

let accessToken: string | null = null;
let events: AuthEvents = {};
const openSaves = new Map<string, OpenSave>();
let tabIdentity: TabIdentity | null = null;
/** Counts sessions ended here, so a refresh that left before the end cannot bring the session back. */
let sessionsEnded = 0;
let signOutPending = false;
let signingOut: Promise<void> | null = null;
let refreshInFlight: Promise<RefreshResult | null> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setAuthEvents(next: AuthEvents): void {
  events = next;
}

export function bindTabIdentity(next: TabIdentity | null): void {
  if (!next) sessionsEnded += 1;
  tabIdentity = next;
}

/** A person signed out and the server has not heard it. Storage carries this past a restart and to other tabs. */
export const signOutOwed = (): boolean => signOutPending || storageGet(SIGN_OUT_OWED_KEY) !== null;

export function oweSignOut(): void {
  signOutPending = true;
  storageSet(SIGN_OUT_OWED_KEY, '1');
}

/** The server heard it, or a new sign-in replaced the cookie. */
export function settleSignOut(): void {
  signOutPending = false;
  storageRemove(SIGN_OUT_OWED_KEY);
}

/** Only /auth/logout ends the refresh cookie, which is HttpOnly. Safe to call at any time. */
export function deliverSignOut(): Promise<void> {
  if (!signOutOwed()) return Promise.resolve();
  signingOut ??= fetch(`${BASE}/auth/logout`, { method: 'POST', credentials: 'include' })
    .then(
      (res) => {
        if (res.ok) settleSignOut();
      },
      () => undefined,
    )
    .finally(() => {
      signingOut = null;
    });
  return signingOut;
}

/** A key belongs to one person on one farm, so a change of either leaves open saves behind. */
export function forgetOpenSaves(): void {
  openSaves.clear();
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

/**
 * Null is the server refusing. Anything else that goes wrong throws, because no answer says nothing
 * about the session: the reply may be lost on the way, with the cookie still good.
 */
async function callRefresh(): Promise<RefreshResult | null> {
  const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Refresh answered ${res.status}`);
  const body = (await res.json()) as { data?: Partial<RefreshResult> };
  return body.data?.accessToken ? { accessToken: body.data.accessToken, session: body.data.session } : null;
}

function isSomeoneElse(session: unknown): boolean {
  const next = session as { user?: { id?: string }; farm?: { id?: string } | null } | null | undefined;
  if (!tabIdentity || !next?.user?.id) return false;
  return next.user.id !== tabIdentity.userId || (next.farm?.id ?? null) !== tabIdentity.farmId;
}

/**
 * Exchange the refresh cookie for a new access token. Refresh tokens rotate, and replaying a used one
 * looks like theft to the server. So there is one flight per tab (StrictMode, parallel 401s) and a Web
 * Lock across tabs: the second tab runs after the first and sends the already-rotated cookie.
 *
 * Every tab shares that cookie, so what comes back may be the next person's. Their token never enters
 * this tab: whatever it still holds, a card or a queued record, would go out under their name.
 */
function attemptRefresh(): Promise<RefreshResult | null> {
  // Startup, a 401 and the chat all come through here, and none may undo a sign-out.
  if (signOutOwed()) return Promise.resolve(null);
  refreshInFlight ??= (async () => {
    const ended = sessionsEnded;
    try {
      const result = navigator.locks
        ? await navigator.locks.request('yap.auth.refresh', callRefresh)
        : await callRefresh();
      if (!result || ended !== sessionsEnded || signOutOwed()) return null;
      if (isSomeoneElse(result.session)) {
        accessToken = null;
        events.onSomeoneElse?.();
        return null;
      }
      accessToken = result.accessToken;
      events.onRefreshed?.(result.session);
      return result;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export const refreshSession = (): Promise<RefreshResult | null> => attemptRefresh().catch(() => null);

const fileTooLarge = () => new ApiError(413, 'FILE_TOO_LARGE', 'This file is too large', { maxMb: MAX_UPLOAD_BYTES / 1024 / 1024 });

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body.error) {
      return new ApiError(res.status, body.error.code ?? 'ERROR', body.error.message ?? res.statusText, body.error.details);
    }
  } catch {
    // Not JSON: fall through to a generic error.
  }
  // A proxy refuses a body over its limit with a page of its own, before the API sees it.
  if (res.status === 413) return fileTooLarge();
  return new ApiError(res.status, 'HTTP_ERROR', res.statusText || `HTTP ${res.status}`);
}

/** The 401s that are about the session. Any other is about what was typed: sent again, it would count as a second guess. */
const SESSION_FAILURES = new Set(['UNAUTHORIZED', 'INVALID_TOKEN', 'ACCOUNT_BLOCKED']);

async function isSessionFailure(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body = (await res.clone().json().catch(() => null)) as { error?: { code?: string } } | null;
  return SESSION_FAILURES.has(body?.error?.code ?? '');
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

  if (!isAuthCall && (await isSessionFailure(res))) {
    let refreshed: RefreshResult | null;
    try {
      refreshed = await attemptRefresh();
      if (refreshed) res = await attempt();
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Network error');
    }
    if (!refreshed) {
      accessToken = null;
      events.onSignedOut?.();
    }
  }
  return res;
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return (JSON.parse(text) as { data: T }).data;
}

async function request<T>(path: string, init: RequestInit, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, init, opts);
  if (!res.ok) throw await toApiError(res);
  return unwrap<T>(res);
}

/** crypto.randomUUID exists only on HTTPS and localhost, and a farm server on the LAN may have neither. */
const newRequestKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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

  /**
   * POST for money and stock, which must happen once however many presses it takes. A retry, a lost
   * answer, or Cancel and the same entry typed again all carry one key until a press is answered, so
   * routes() replays the record instead of booking a second. A replay answers for the first body,
   * so a press that says something else is told it was not saved.
   */
  async postOnce<T>(path: string, body?: unknown): Promise<T> {
    const sent = JSON.stringify(body ?? null);
    const save = openSaves.get(path) ?? { key: newRequestKey(), body: sent };
    openSaves.set(path, save);
    const res = await send(path, jsonInit('POST', body), { idempotencyKey: save.key });
    if (!res.ok) throw await toApiError(res);
    openSaves.delete(path);
    if (res.headers.has('idempotent-replay') && save.body !== sent) {
      throw new ApiError(409, 'SAVED_EARLIER', 'An earlier press was saved with other figures, and this one was not');
    }
    return unwrap<T>(res);
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
  async upload(file: File | Blob, name?: string, opts?: RequestOptions): Promise<UploadedFile> {
    if (file.size > MAX_UPLOAD_BYTES) throw fileTooLarge();
    const form = new FormData();
    form.append('file', file, name ?? (file instanceof File ? file.name : 'file'));
    return request<UploadedFile>('/files', { method: 'POST', body: form }, opts);
  },

  /** Multipart POST to any endpoint, e.g. spreadsheet import. Returns the unwrapped `data`. */
  async postFile<T>(path: string, file: File | Blob, fields?: Record<string, string>, opts?: RequestOptions): Promise<T> {
    if (file.size > MAX_UPLOAD_BYTES) throw fileTooLarge();
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
