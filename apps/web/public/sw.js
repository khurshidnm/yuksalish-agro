/*
 * Service worker: keeps the app opening with no connection. Hand-written, no build step.
 *
 *   Navigation  network first, falling back to the cached shell after a few seconds, because a bad
 *               link hangs rather than fails.
 *   /assets/    cache first. File names carry a content hash, so a cached file never goes stale.
 *   /api/       never cached and never touched here, with one exception below. Records saved offline
 *               live in the app's outbox (src/lib/outbox.ts), not in this file.
 *
 * The exception is POST /api/v1/auth/refresh. The app asks it on every start, and an unreachable
 * server would otherwise look like "signed out" and drop a shepherd at the login screen in the barn.
 * So when the network fails, and only then, this answers from a snapshot of the session the app saved
 * deliberately (src/features/today/pwa.ts), which is deleted on sign-out. A real refusal from the server
 * passes through untouched. The placeholder token authorises nothing: the first request that reaches
 * the server gets a 401, which triggers a real refresh.
 *
 * Deploy note: serve this file with Cache-Control: no-cache, or updates reach phones late.
 */
const SHELL_CACHE = 'yap-shell-v1';
const ASSET_CACHE = 'yap-assets-v1';
const SESSION_CACHE = 'yap-session-v1';
const KNOWN_CACHES = [SHELL_CACHE, ASSET_CACHE, SESSION_CACHE];

const SHELL_KEY = '/';
const SESSION_KEY = '/__yap/session';
const SHELL_FILES = [SHELL_KEY, '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

const NAVIGATION_TIMEOUT_MS = 3_500;
const REFRESH_TIMEOUT_MS = 4_000;
/** The refresh token lasts 30 days, so an older snapshot can no longer be a live session. */
const SESSION_MAX_AGE_MS = 30 * 86_400_000;
const MAX_ASSETS = 400;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.allSettled(SHELL_FILES.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('yap-') && !KNOWN_CACHES.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

async function trimAssets(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((key) => cache.delete(key)));
}

async function assetFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimAssets(cache);
  }
  return response;
}

async function shellFirstIfSlow(event) {
  const cache = await caches.open(SHELL_CACHE);
  const network = (async () => {
    const response = await fetch(event.request);
    if (response.status >= 500) throw new Error(`Server error ${response.status}`);
    if (response.ok && (response.headers.get('content-type') ?? '').includes('text/html')) {
      await cache.put(SHELL_KEY, response.clone());
    }
    return response;
  })();
  // Let a slow response finish, so the next start gets the newer shell.
  event.waitUntil(network.catch(() => undefined));

  const slow = wait(NAVIGATION_TIMEOUT_MS).then(async () => (await cache.match(SHELL_KEY)) ?? network);
  try {
    return await Promise.race([network, slow]);
  } catch (error) {
    const cached = await cache.match(SHELL_KEY);
    if (cached) return cached;
    throw error;
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request).then(async (response) => {
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }
  return network;
}

async function readSessionSnapshot() {
  const cache = await caches.open(SESSION_CACHE);
  const stored = await cache.match(SESSION_KEY);
  if (!stored) return null;
  try {
    const { savedAt, session } = await stored.json();
    return Date.now() - savedAt < SESSION_MAX_AGE_MS ? session : null;
  } catch {
    return null;
  }
}

async function refreshOrSnapshot(event) {
  const session = await readSessionSnapshot();
  const network = fetch(event.request);
  // Even if a slow answer is ignored here, its rotated cookie must still reach the browser.
  event.waitUntil(network.catch(() => undefined));
  if (!session) return network;

  const offline = () =>
    new Response(JSON.stringify({ data: { accessToken: 'offline', session } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-yap-offline': '1' },
    });
  try {
    const response = await Promise.race([network, wait(REFRESH_TIMEOUT_MS).then(() => null)]);
    return response && response.status < 500 ? response : offline();
  } catch {
    return offline();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/api/v1/auth/refresh' && request.method === 'POST') {
    event.respondWith(refreshOrSnapshot(event));
    return;
  }
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') event.respondWith(shellFirstIfSlow(event));
  else if (url.pathname.startsWith('/assets/')) event.respondWith(assetFirst(request));
  else event.respondWith(staleWhileRevalidate(event));
});

/* Files the page loaded before this worker took control would otherwise never be cached. */
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_ASSETS') return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      await Promise.allSettled(
        event.data.urls.map(async (url) => {
          if (new URL(url).pathname.startsWith('/assets/') && !(await cache.match(url))) await cache.add(url);
        }),
      );
    })(),
  );
});
