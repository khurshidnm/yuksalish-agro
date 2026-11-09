import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindTabIdentity, oweSignOut, restoreSession, setAccessToken, setAuthEvents, settleSignOut } from './api';
import { languageAsked } from './i18n';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('the refresh on load tells a refusal from no answer', () => {
  beforeEach(() => {
    settleSignOut();
    bindTabIdentity(null);
    setAccessToken(null);
    setAuthEvents({});
    vi.unstubAllGlobals();
  });

  it('a 401 is the server ending the session (expired, revoked, a new password)', async () => {
    vi.stubGlobal('fetch', async () => json(401, { error: { code: 'INVALID_TOKEN', message: 'x' } }));
    await expect(restoreSession()).resolves.toBe('refused');
  });

  it('offline, a server error or a rate limit say nothing about the session, so field staff keep theirs', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    await expect(restoreSession()).resolves.toBeNull();
    vi.stubGlobal('fetch', async () => new Response('<html>502</html>', { status: 502 }));
    await expect(restoreSession()).resolves.toBeNull();
    vi.stubGlobal('fetch', async () => json(429, { error: { code: 'RATE_LIMITED', message: 'x' } }));
    await expect(restoreSession()).resolves.toBeNull();
  });

  it('a sign-out still owed asks the server nothing, so nothing was refused', async () => {
    const fetchMock = vi.fn(async () => json(401, {}));
    vi.stubGlobal('fetch', fetchMock);
    oweSignOut();
    await expect(restoreSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a good cookie restores the session', async () => {
    vi.stubGlobal('fetch', async () => json(200, { data: { accessToken: 'token-A', session: { user: { id: 'A' }, farm: { id: 'F' } } } }));
    await expect(restoreSession()).resolves.toMatchObject({ accessToken: 'token-A' });
  });

  it('both StrictMode runs hear one refusal, from one request', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const first = restoreSession();
    const second = restoreSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    answer(json(401, {}));
    await expect(Promise.all([first, second])).resolves.toEqual(['refused', 'refused']);
  });

  it('a refusal heard earlier does not make a later silence a refusal', async () => {
    vi.stubGlobal('fetch', async () => json(401, {}));
    await restoreSession();
    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
    await expect(restoreSession()).resolves.toBeNull();
  });
});

describe('?lang= from the public pages', () => {
  const visit = (href: string) => {
    const replaced: string[] = [];
    const history = { state: { idx: 0 }, replaceState: (_state: unknown, _title: string, url?: string | URL | null) => void replaced.push(String(url)) };
    return { language: languageAsked({ href }, history), replaced };
  };

  it('sign-in speaks the language of the page the visitor came from, and the address drops it', () => {
    expect(visit('https://agropanel.uz/login?lang=ru')).toEqual({ language: 'ru', replaced: ['/login'] });
    expect(visit('https://agropanel.uz/login?lang=en')).toEqual({ language: 'en', replaced: ['/login'] });
    expect(visit('http://localhost:5173/login?lang=uz-Cyrl&utm_source=x#top')).toEqual({ language: 'uz-Cyrl', replaced: ['/login?utm_source=x#top'] });
  });

  it('ignores a language the app does not speak, and an address without one', () => {
    expect(visit('https://agropanel.uz/login?lang=de')).toEqual({ language: null, replaced: ['/login'] });
    expect(visit('https://agropanel.uz/login')).toEqual({ language: null, replaced: [] });
    expect(languageAsked(undefined, undefined)).toBeNull();
  });
});
