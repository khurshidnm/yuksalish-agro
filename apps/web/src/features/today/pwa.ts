/**
 * Installs the service worker and makes sure this page's code is cached, so the app opens with no
 * connection. Everything here is best effort: the app must work the same where none of it exists.
 */
import type { Session } from '@/lib/types';

/** Must match public/sw.js, which reads this snapshot when the server cannot be reached. */
const SESSION_CACHE = 'yap-session-v1';
const SESSION_KEY = '/__yap/session';

const CONTROLLER_TIMEOUT_MS = 10_000;

type Load = () => Promise<unknown>;

/**
 * Screens that work with no connection. The first load of the app happens before the worker exists,
 * so these are fetched again through it. The list stays short: on a poor connection it is downloaded
 * in the background.
 */
const OFFLINE_SCREENS: Load[] = [
  () => import('@/features/auth/LoginPage'),
  () => import('./TodayPage'),
  () => import('./DailyLogPage'),
  () => import('./ReportSickPage'),
  () => import('./DeathPage'),
  () => import('./WeightPage'),
  () => import('./LambingPage'),
  () => import('./SyncPage'),
];

const animals: Load = () => import('@/features/livestock/AnimalsPage');
const tasks: Load = () => import('@/features/tasks/TasksPage');
const operations: Load = () => import('@/features/crops/OperationsPage');

/**
 * Each role's bottom bar (BOTTOM_BY_ROLE in app/nav.ts). These need the server for their data, but
 * with their code on the phone an offline tap gives a retry card, not the crash page.
 */
const BOTTOM_BAR_SCREENS: Record<string, Load[]> = {
  shepherd: [() => import('@/features/livestock/DailyLogsPage'), animals, tasks],
  zootechnician: [animals, () => import('@/features/livestock/HerdsPage'), () => import('@/features/livestock/BreedingPage')],
  veterinarian: [() => import('@/features/livestock/HealthPage'), animals, tasks],
  agronomist: [() => import('@/features/farm/FieldsPage'), operations, tasks],
  storekeeper: [() => import('@/features/inventory/StockPage'), () => import('@/features/inventory/MovementsPage'), tasks],
  mechanic: [tasks, operations, () => import('@/features/assets/AssetsPage')],
};

export async function saveSessionSnapshot(session: Session): Promise<void> {
  if (!('caches' in window)) return;
  const cache = await caches.open(SESSION_CACHE);
  const body = JSON.stringify({ savedAt: Date.now(), session });
  await cache.put(SESSION_KEY, new Response(body, { headers: { 'content-type': 'application/json' } }));
}

export async function clearSessionSnapshot(): Promise<void> {
  if (!('caches' in window)) return;
  const cache = await caches.open(SESSION_CACHE);
  await cache.delete(SESSION_KEY);
}

function waitForController(): Promise<ServiceWorker | null> {
  const { serviceWorker } = navigator;
  if (serviceWorker.controller) return Promise.resolve(serviceWorker.controller);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), CONTROLLER_TIMEOUT_MS);
    serviceWorker.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(timer);
        resolve(serviceWorker.controller);
      },
      { once: true },
    );
  });
}

let workerReady: Promise<boolean> = Promise.resolve(false);

/** Fetch this role's screens through the worker. Called once the role is known. */
export async function cacheScreensFor(roleKey: string): Promise<void> {
  if (!(await workerReady)) return;
  await Promise.allSettled((BOTTOM_BAR_SCREENS[roleKey] ?? []).map((load) => load()));
}

async function register(): Promise<boolean> {
  await navigator.serviceWorker.register('/sw.js');
  const controller = await waitForController();
  if (!controller) return false;

  // Loaded before the worker took control, so it never saw them.
  const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
  controller.postMessage({ type: 'CACHE_ASSETS', urls: urls.filter((url) => new URL(url).origin === location.origin) });

  // These now pass through the worker, which keeps them.
  await Promise.allSettled(OFFLINE_SCREENS.map((load) => load()));

  // Cheap phones evict site data under pressure, and the queue lives there.
  await navigator.storage?.persist?.();
  return true;
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // Set now, not on load: sign-in can finish first, and it waits on this.
  workerReady = new Promise((resolve) => {
    const start = () => {
      register().then(resolve, (error: unknown) => {
        console.warn('Offline mode is unavailable', error);
        resolve(false);
      });
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
  });
}
