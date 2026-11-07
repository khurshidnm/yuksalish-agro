/*
 * Service worker: keeps the app opening with no connection. Hand-written. The only thing the build does
 * is fill in BUILD below (scripts/shell-files.mjs), which makes every deploy a new worker.
 *
 *   Update      A new worker downloads the new page and every file in BUILD.required, and only then takes
 *               over. If the link drops, its install fails and the worker in charge carries on with the
 *               complete version it has, so what is stored can always start. What did arrive stays, and
 *               the next attempt fetches only the rest. The app says when a new version is ready.
 *   Navigation  The stored page, at once: a bad link hangs rather than fails, and must not hold up the
 *               start. The server's own pages come from the network, with the stored page as a stand-in.
 *   /assets/    Cache first. File names carry a content hash, so a cached file never goes stale. Files
 *               of past builds are removed when a new worker takes over, and nothing else ever is.
 *   /api/       Never cached and never touched here, with one exception below. Records saved offline
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
const BUILD = { version: 'unbuilt', required: [], files: [] };

const SHELL_CACHE = `yap-shell-${BUILD.version}`;
const ASSET_CACHE = 'yap-assets-v1';
const SESSION_CACHE = 'yap-session-v1';
const KNOWN_CACHES = [SHELL_CACHE, ASSET_CACHE, SESSION_CACHE];

const SHELL_KEY = '/app';
/** Pages the server answers itself, however they are reached. */
const SERVER_PAGES = new Set(['/', '/ru', '/en', '/uz-cyrl', '/healthz']);
const SESSION_KEY = '/__yap/session';
/** Nice to have with no connection, but no reason to refuse a new version. */
const SHELL_EXTRAS = ['/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

/** On a weak link files then finish one by one, so a dropped connection still leaves some behind. */
const DOWNLOADS_AT_ONCE = 4;
const NAVIGATION_TIMEOUT_MS = 3_500;
const REFRESH_TIMEOUT_MS = 4_000;
/** The refresh token lasts 30 days, so an older snapshot can no longer be a live session. */
const SESSION_MAX_AGE_MS = 30 * 86_400_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isThisBuild = (html) => html.includes(`<meta name="yap-build" content="${BUILD.version}"`);

async function storeRequiredFiles() {
  const cache = await caches.open(ASSET_CACHE);
  const queue = [...BUILD.required];
  const downloadNext = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      if (!(await cache.match(url))) await cache.add(url);
    }
  };
  await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, downloadNext));
}

async function storeShell() {
  const response = await fetch(SHELL_KEY, { cache: 'no-cache' });
  // Another deploy may have landed since this worker was fetched: then the next worker is the one to install.
  if (!response.ok || !isThisBuild(await response.clone().text())) throw new Error('The server is on another version');
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(SHELL_KEY, response);
  await Promise.allSettled(SHELL_EXTRAS.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await storeRequiredFiles();
      await storeShell();
      await self.skipWaiting();
    })(),
  );
});

async function dropPastBuilds() {
  const cache = await caches.open(ASSET_CACHE);
  const current = new Set(BUILD.files);
  const keys = await cache.keys();
  await Promise.all(keys.filter((key) => !current.has(new URL(key.url).pathname)).map((key) => cache.delete(key)));
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('yap-') && !KNOWN_CACHES.includes(n)).map((n) => caches.delete(n)));
      await dropPastBuilds();
      await self.clients.claim();
    })(),
  );
});

async function assetFirst(event) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  // A full disk must not cost the page a file the network did deliver.
  if (response.ok) event.waitUntil(cache.put(event.request, response.clone()).catch(() => undefined));
  return response;
}

/** The same build can still get new headers from the server, such as a changed content security policy. */
async function refreshShellHeaders(cache) {
  const response = await fetch(SHELL_KEY, { cache: 'no-cache' });
  if (response.ok && isThisBuild(await response.clone().text())) await cache.put(SHELL_KEY, response);
}

async function openApp(event) {
  const cache = await caches.open(SHELL_CACHE);
  const shell = await cache.match(SHELL_KEY);
  if (!shell) return fetch(event.request);
  event.waitUntil(refreshShellHeaders(cache).catch(() => undefined));
  return shell;
}

async function serverPageOrShell(event) {
  const cache = await caches.open(SHELL_CACHE);
  const network = (async () => {
    const response = await fetch(event.request);
    if (response.status >= 500) throw new Error(`Server error ${response.status}`);
    return response;
  })();
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

  if (request.mode === 'navigate') {
    // An address with a dot is a file, such as /robots.txt, and never a page of the app.
    if (SERVER_PAGES.has(url.pathname)) event.respondWith(serverPageOrShell(event));
    else if (!url.pathname.includes('.')) event.respondWith(openApp(event));
  } else if (url.pathname.startsWith('/assets/')) event.respondWith(assetFirst(event));
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
