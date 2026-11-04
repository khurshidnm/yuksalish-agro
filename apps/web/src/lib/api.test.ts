import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildQuery, refreshSession, setAccessToken, setAuthEvents } from './api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const authHeader = (init?: RequestInit) => new Headers(init?.headers).get('Authorization');

describe('buildQuery', () => {
  it('skips empty values and repeats arrays', () => {
    expect(buildQuery({ a: 1, b: '', c: null, d: undefined, e: ['x', 'y'], f: 0, g: false })).toBe('?a=1&e=x&e=y&f=0&g=false');
    expect(buildQuery()).toBe('');
    expect(buildQuery({ a: '' })).toBe('');
  });
});

describe('api client', () => {
  beforeEach(() => {
    setAccessToken('old');
    setAuthEvents({});
    vi.unstubAllGlobals();
  });

  it('attaches the token and unwraps data', async () => {
    const fetchMock = vi.fn(async () => json(200, { data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.get('/things')).resolves.toEqual({ ok: true });
    expect(authHeader(fetchMock.mock.calls[0][1 as never])).toBe('Bearer old');
  });

  it('turns the error envelope into ApiError with field errors', async () => {
    vi.stubGlobal('fetch', async () => json(422, { error: { code: 'INVALID', message: 'Bad', details: { fieldErrors: { tin: ['Taken', 'Short'], name: 'Empty' } } } }));
    const error = await api.post('/things', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).code).toBe('INVALID');
    expect((error as ApiError).fieldErrors).toEqual({ tin: 'Taken, Short', name: 'Empty' });
  });

  it('reports a dropped connection as NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(api.get('/things')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('parallel 401s share one refresh, and each request retries with the new token', async () => {
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return json(200, { data: { accessToken: 'new', session: { user: 1 } } });
      }
      return authHeader(init) === 'Bearer new' ? json(200, { data: url }) : json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onRefreshed = vi.fn();
    setAuthEvents({ onRefreshed });

    const results = await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);

    expect(results).toEqual(['/api/v1/a', '/api/v1/b', '/api/v1/c']);
    expect(refreshCalls).toBe(1);
    expect(onRefreshed).toHaveBeenCalledTimes(1);
  });

  it('two simultaneous refreshSession calls send one request, as StrictMode would', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return json(200, { data: { accessToken: 'new', session: null } });
    });
    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it('a failed refresh signs out and surfaces the original 401', async () => {
    vi.stubGlobal('fetch', async () => json(401, { error: { code: 'UNAUTHORIZED', message: 'Expired' } }));
    const onSignedOut = vi.fn();
    setAuthEvents({ onSignedOut });
    await expect(api.get('/a')).rejects.toMatchObject({ status: 401 });
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('does not try to refresh after a failed login', async () => {
    const fetchMock = vi.fn(async () => json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'No' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.post('/auth/login', {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the idempotency key', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(201, { data: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.post('/x', { a: 1 }, { idempotencyKey: 'abc' });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('abc');
  });

  it('handles 204 and an empty body', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
    await expect(api.delete('/x')).resolves.toBeUndefined();
  });
});
