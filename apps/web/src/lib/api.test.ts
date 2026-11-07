import { MAX_UPLOAD_BYTES } from '@yap/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  bindTabIdentity,
  buildQuery,
  deliverSignOut,
  forgetOpenSaves,
  oweSignOut,
  refreshSession,
  setAccessToken,
  setAuthEvents,
  settleSignOut,
  signOutOwed,
} from './api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const authHeader = (init?: RequestInit) => new Headers(init?.headers).get('Authorization');

describe('buildQuery', () => {
  it('skips empty values and repeats arrays', () => {
    expect(buildQuery({ a: 1, b: '', c: null, d: undefined, e: ['x', 'y'], f: 0, g: false })).toBe('?a=1&e=x&e=y&f=0&g=false');
    expect(buildQuery()).toBe('');
    expect(buildQuery({ a: '' })).toBe('');
  });
});

const lostAnswer = () => new Response('<html>504</html>', { status: 504 });
const keyOf = (init?: RequestInit) => new Headers(init?.headers).get('Idempotency-Key');
/** A server that keeps what it stored under a key, as routes() does, and replays it. */
function ledger() {
  const stored = new Map<string, unknown>();
  const seen: (string | null)[] = [];
  const answer = vi.fn(async (_url: string, init?: RequestInit) => {
    const key = keyOf(init);
    seen.push(key);
    if (key && stored.has(key)) {
      return new Response(JSON.stringify({ data: stored.get(key) }), { status: 201, headers: { 'idempotent-replay': 'true' } });
    }
    const row = JSON.parse(String(init?.body)) as unknown;
    if (key) stored.set(key, row);
    return json(201, { data: row });
  });
  return { answer, seen, stored };
}

describe('postOnce', () => {
  beforeEach(() => {
    forgetOpenSaves();
    setAccessToken('t');
    setAuthEvents({});
    vi.unstubAllGlobals();
  });

  it('a press after a lost answer carries the same key, and the record is booked once', async () => {
    const server = ledger();
    let first = true;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const res = await server.answer(url, init);
      if (!first) return res;
      first = false;
      return lostAnswer();
    });
    await expect(api.postOnce('/finance/debts/settle', { amount: 1_000_000 })).rejects.toMatchObject({ status: 504 });
    await expect(api.postOnce('/finance/debts/settle', { amount: 1_000_000 })).resolves.toEqual({ amount: 1_000_000 });
    expect(server.stored.size).toBe(1);
    expect(server.seen[0]).toBe(server.seen[1]);
  });

  it('no signal at the first press changes nothing: the next press keeps the key', async () => {
    const server = ledger();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    await expect(api.postOnce('/inventory/receipts', { qty: 100 })).rejects.toMatchObject({ status: 0 });
    vi.stubGlobal('fetch', server.answer);
    await api.postOnce('/inventory/receipts', { qty: 100 });
    expect(server.stored.size).toBe(1);
  });

  it('a success ends the key, so the next entry is a new record', async () => {
    const server = ledger();
    vi.stubGlobal('fetch', server.answer);
    await api.postOnce('/finance/transactions', { amount: 5 });
    await api.postOnce('/finance/transactions', { amount: 5 });
    expect(server.stored.size).toBe(2);
  });

  it('a corrected figure after a lost answer is not reported as saved', async () => {
    const server = ledger();
    let first = true;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const res = await server.answer(url, init);
      if (!first) return res;
      first = false;
      return lostAnswer();
    });
    await expect(api.postOnce('/finance/debts/settle', { amount: 1_000_000 })).rejects.toMatchObject({ status: 504 });
    await expect(api.postOnce('/finance/debts/settle', { amount: 2_000_000 })).rejects.toMatchObject({ status: 409, code: 'SAVED_EARLIER' });
    expect(server.stored.size).toBe(1);
    // Told what happened, the person may still mean a second record.
    await expect(api.postOnce('/finance/debts/settle', { amount: 2_000_000 })).resolves.toEqual({ amount: 2_000_000 });
    expect(server.stored.size).toBe(2);
  });

  it('a refused press does not use up the key, and a correction books', async () => {
    const server = ledger();
    vi.stubGlobal('fetch', async () => json(400, { error: { code: 'INVALID', message: 'x' } }));
    await expect(api.postOnce('/finance/transactions', { amount: -1 })).rejects.toMatchObject({ status: 400 });
    vi.stubGlobal('fetch', server.answer);
    await expect(api.postOnce('/finance/transactions', { amount: 1 })).resolves.toEqual({ amount: 1 });
  });

  it('each path has its own key', async () => {
    const server = ledger();
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      await server.answer(url, init);
      return lostAnswer();
    });
    await api.postOnce('/a', { x: 1 }).catch(() => undefined);
    await api.postOnce('/b', { x: 1 }).catch(() => undefined);
    expect(new Set(server.seen).size).toBe(2);
  });

  it('a change of person leaves the open key behind', async () => {
    const server = ledger();
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      await server.answer(url, init);
      return lostAnswer();
    });
    await api.postOnce('/a', { x: 1 }).catch(() => undefined);
    forgetOpenSaves();
    await api.postOnce('/a', { x: 1 }).catch(() => undefined);
    expect(new Set(server.seen).size).toBe(2);
  });
});

describe('a sign-out the server has not heard', () => {
  const refreshed = (user: string, farm: string | null = 'F') => json(200, { data: { accessToken: `token-${user}`, session: { user: { id: user }, farm: farm && { id: farm } } } });

  beforeEach(() => {
    settleSignOut();
    bindTabIdentity(null);
    setAccessToken(null);
    setAuthEvents({});
    vi.unstubAllGlobals();
  });

  it('startup, a 401 and the chat all find refresh closed, so the cookie brings nobody back', async () => {
    const fetchMock = vi.fn(async () => refreshed('A'));
    vi.stubGlobal('fetch', fetchMock);
    oweSignOut();
    await expect(refreshSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 401 while it is owed signs out, and does not retry as the last person', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    });
    const onSignedOut = vi.fn();
    setAuthEvents({ onSignedOut });
    oweSignOut();
    await api.get('/ai/proposals').catch(() => undefined);
    expect(calls).toEqual(['/api/v1/ai/proposals']);
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it('stays owed through a failed attempt, and ends when the server hears it', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    oweSignOut();
    await deliverSignOut();
    expect(signOutOwed()).toBe(true);

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(200, { data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);
    await deliverSignOut();
    expect(signOutOwed()).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/auth/logout');
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include');
  });

  it('a server that answers with an error has not heard it', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 502 }));
    oweSignOut();
    await deliverSignOut();
    expect(signOutOwed()).toBe(true);
  });

  it('asks nothing of the server when nothing is owed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await deliverSignOut();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refresh that left before the sign-out cannot bring the session back', async () => {
    let answer: (res: Response) => void = () => undefined;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => (answer = resolve)));
    const onRefreshed = vi.fn();
    setAuthEvents({ onRefreshed });
    bindTabIdentity({ userId: 'A', farmId: 'F' });
    const flying = refreshSession();
    oweSignOut();
    bindTabIdentity(null);
    settleSignOut();
    answer(refreshed('A'));
    await expect(flying).resolves.toBeNull();
    expect(onRefreshed).not.toHaveBeenCalled();
  });
});

describe('a tab whose cookie now belongs to someone else', () => {
  const refreshed = (user: string, farm: string | null = 'F') => json(200, { data: { accessToken: `token-${user}`, session: { user: { id: user }, farm: farm && { id: farm } } } });
  const events = () => ({ onRefreshed: vi.fn(), onSignedOut: vi.fn(), onSomeoneElse: vi.fn() });

  beforeEach(() => {
    settleSignOut();
    bindTabIdentity({ userId: 'A', farmId: 'F' });
    setAccessToken('token-A');
    vi.unstubAllGlobals();
  });

  it('never takes the next person\'s token, and starts over', async () => {
    const seen = events();
    setAuthEvents(seen);
    vi.stubGlobal('fetch', async () => refreshed('B'));
    await expect(refreshSession()).resolves.toBeNull();
    expect(seen.onSomeoneElse).toHaveBeenCalledOnce();
    expect(seen.onRefreshed).not.toHaveBeenCalled();
  });

  it('a queued request of the last person does not go out under the next person', async () => {
    const seen = events();
    setAuthEvents(seen);
    const sentWith: (string | null)[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/refresh')) return refreshed('B');
      sentWith.push(authHeader(init));
      return json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    });
    await api.post('/livestock/daily-logs', { x: 1 }).catch(() => undefined);
    expect(sentWith).toEqual(['Bearer token-A']);
    expect(seen.onSomeoneElse).toHaveBeenCalledOnce();
  });

  it('another farm counts: this tab holds the last farm\'s screens', async () => {
    const seen = events();
    setAuthEvents(seen);
    vi.stubGlobal('fetch', async () => refreshed('A', 'G'));
    await expect(refreshSession()).resolves.toBeNull();
    expect(seen.onSomeoneElse).toHaveBeenCalledOnce();
  });

  it('the same person and farm refresh as ever', async () => {
    const seen = events();
    setAuthEvents(seen);
    vi.stubGlobal('fetch', async () => refreshed('A'));
    await expect(refreshSession()).resolves.toMatchObject({ accessToken: 'token-A' });
    expect(seen.onRefreshed).toHaveBeenCalledOnce();
    expect(seen.onSomeoneElse).not.toHaveBeenCalled();
  });

  it('a tab that shows nobody yet takes whoever the cookie holds', async () => {
    bindTabIdentity(null);
    const seen = events();
    setAuthEvents(seen);
    vi.stubGlobal('fetch', async () => refreshed('B'));
    await expect(refreshSession()).resolves.toMatchObject({ accessToken: 'token-B' });
    expect(seen.onSomeoneElse).not.toHaveBeenCalled();
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

  describe('a 401 that is not about the session', () => {
    const answers = (status: number, body: unknown) => {
      const fetchMock = vi.fn(async (_url: string) => (status === 401 && body === null ? new Response('Unauthorized', { status }) : json(status, body)));
      vi.stubGlobal('fetch', fetchMock);
      const onSignedOut = vi.fn();
      setAuthEvents({ onSignedOut });
      return { fetchMock, onSignedOut };
    };

    it('comes back to the person, sent once, with no refresh and no sign-out', async () => {
      const { fetchMock, onSignedOut } = answers(401, { error: { code: 'INVALID_CODE', message: 'Wrong code' } });
      await expect(api.post('/auth/2fa/enable', { code: '000000' })).rejects.toMatchObject({ status: 401, code: 'INVALID_CODE' });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/auth/2fa/enable']);
      expect(onSignedOut).not.toHaveBeenCalled();
    });

    it('a page from a proxy, which is no statement about the session, gets the same', async () => {
      const { fetchMock, onSignedOut } = answers(401, null);
      await expect(api.get('/a')).rejects.toMatchObject({ status: 401 });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(onSignedOut).not.toHaveBeenCalled();
    });
  });

  it.each(['INVALID_TOKEN', 'UNAUTHORIZED', 'ACCOUNT_BLOCKED'])('%s is a real session failure: refresh, then send once more', async (code) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/auth/refresh')) return json(200, { data: { accessToken: 'fresh', session: {} } });
      return authHeader(init) === 'Bearer fresh' ? json(200, { data: 'ok' }) : json(401, { error: { code, message: 'x' } });
    });
    await expect(api.get('/a')).resolves.toBe('ok');
    expect(calls).toEqual(['/api/v1/a', '/api/v1/auth/refresh', '/api/v1/a']);
  });

  describe('a refresh nobody answered', () => {
    const expired = () => json(401, { error: { code: 'INVALID_TOKEN', message: 'Expired' } });

    it.each([
      ['the reply is lost', () => Promise.reject(new TypeError('Failed to fetch'))],
      ['the reply is cut off', async () => new Response('{"data":{"accessTo', { status: 200 })],
      ['the server is restarting', async () => json(502, {})],
      ['the farm is rate limited', async () => json(429, {})],
    ])('keeps the session when %s', async (_case, refresh) => {
      vi.stubGlobal('fetch', async (url: string) => (url.endsWith('/auth/refresh') ? refresh() : expired()));
      const onSignedOut = vi.fn();
      setAuthEvents({ onSignedOut });
      await expect(api.post('/things', {})).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
      expect(onSignedOut).not.toHaveBeenCalled();
    });

    it('tries again on the next request, and that one gets through', async () => {
      let refreshes = 0;
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url.endsWith('/auth/refresh')) {
          refreshes += 1;
          if (refreshes === 1) throw new TypeError('Failed to fetch');
          return json(200, { data: { accessToken: 'fresh', session: {} } });
        }
        return authHeader(init) === 'Bearer fresh' ? json(200, { data: 'ok' }) : expired();
      });
      await expect(api.get('/a')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      await expect(api.get('/a')).resolves.toBe('ok');
    });

    it('a real refusal still signs out', async () => {
      vi.stubGlobal('fetch', async (url: string) =>
        url.endsWith('/auth/refresh') ? json(401, { error: { code: 'SESSION_REVOKED', message: 'x' } }) : expired(),
      );
      const onSignedOut = vi.fn();
      setAuthEvents({ onSignedOut });
      await expect(api.get('/a')).rejects.toMatchObject({ status: 401, code: 'INVALID_TOKEN' });
      expect(onSignedOut).toHaveBeenCalledOnce();
    });

    it('startup and the chat still read it as no session, and nothing is thrown at them', async () => {
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('Failed to fetch');
      });
      await expect(refreshSession()).resolves.toBeNull();
    });
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

  it('refuses a file over the limit without sending it, and says what the limit is', async () => {
    const fetchMock = vi.fn(async () => json(200, { data: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const tooBig = new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)]);
    await expect(api.upload(tooBig)).rejects.toMatchObject({ status: 413, code: 'FILE_TOO_LARGE', details: { maxMb: 15 } });
    await expect(api.postFile('/import/animals', tooBig)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(fetchMock).not.toHaveBeenCalled();

    await api.upload(new Blob([new Uint8Array(MAX_UPLOAD_BYTES)]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads a proxy's own 413 page as the same refusal", async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>413 Request Entity Too Large</html>', { status: 413 }));
    await expect(api.upload(new Blob(['x']))).rejects.toMatchObject({ status: 413, code: 'FILE_TOO_LARGE', details: { maxMb: 15 } });
  });
});
