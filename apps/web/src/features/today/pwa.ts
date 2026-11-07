/**
 * Installs the service worker, notices new versions, and gets the app back on its feet when a deploy
 * took away code it still wanted. Everything here is best effort: the app must work the same where none
 * of it exists. The worker itself stores what a start and the offline screens need: see public/sw.js and
 * offline-screens.json.
 */
import { useSyncExternalStore } from 'react';
import type { Session } from '@/lib/types';

/** Must match public/sw.js, which reads this snapshot when the server cannot be reached. */
const SESSION_CACHE = 'yap-session-v1';
const SESSION_KEY = '/__yap/session';

/** For an app left open all day: phones also check each time the app comes back to the screen. */
const UPDATE_CHECK_MS = 3_600_000;
/** How long a page waits for a new version to arrive before saying so. The download carries on regardless. */
const UPDATE_WAIT_MS = 15_000;
const RESTART_KEY = 'yap.restartedForCode';
/** A restart that did not help must not repeat, or a dead link would reload the screen for ever. */
const RESTART_GAP_MS = 60_000;

type Load = () => Promise<unknown>;

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

/** Waits as long as the first download takes, for ever if it never finishes, because nothing depends on it but warming up. */
function waitForController(): Promise<ServiceWorker> {
  const { serviceWorker } = navigator;
  if (serviceWorker.controller) return Promise.resolve(serviceWorker.controller);
  return new Promise((resolve) => {
    serviceWorker.addEventListener('controllerchange', () => resolve(serviceWorker.controller as ServiceWorker), { once: true });
  });
}

let workerReady: Promise<boolean> = Promise.resolve(false);

/** Fetch this role's screens through the worker. Called once the role is known. */
export async function cacheScreensFor(roleKey: string): Promise<void> {
  if (!(await workerReady)) return;
  await Promise.allSettled((BOTTOM_BAR_SCREENS[roleKey] ?? []).map((load) => load()));
}

async function register(): Promise<boolean> {
  await checkForUpdate();
  const controller = await waitForController();

  // Loaded before the worker took control, so it never saw them.
  const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
  controller.postMessage({ type: 'CACHE_ASSETS', urls: urls.filter((url) => new URL(url).origin === location.origin) });

  // Cheap phones evict site data under pressure, and the queue lives there.
  await navigator.storage?.persist?.();
  return true;
}

let updateReady = false;
const updateListeners = new Set<() => void>();

function subscribeToUpdate(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

/** A newer version has taken over: this page is running old code, and a reload brings the new one. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(subscribeToUpdate, () => updateReady);
}

/** Registering again is what brings back a first install that the link cut short. */
async function checkForUpdate(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register('/sw.js');
  await registration.update();
  return registration;
}

function watchForUpdates(): void {
  const { serviceWorker } = navigator;
  let controlled = Boolean(serviceWorker.controller);
  serviceWorker.addEventListener('controllerchange', () => {
    // The first worker of all is this same version.
    if (controlled) {
      updateReady = true;
      updateListeners.forEach((listener) => listener());
    }
    controlled = true;
  });

  const check = () => {
    if (document.visibilityState === 'visible') checkForUpdate().catch(() => undefined);
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);
  setInterval(check, UPDATE_CHECK_MS);
}

function finished(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    worker.addEventListener('statechange', () => {
      if (worker.state === 'redundant') resolve();
    });
  });
}

async function downloadNewVersion(): Promise<void> {
  if (updateReady || !('serviceWorker' in navigator)) return;
  const registration = await checkForUpdate().catch(() => null);
  const incoming = registration?.installing ?? registration?.waiting;
  if (incoming) await finished(incoming);
}

function mayRestart(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(RESTART_KEY)) < RESTART_GAP_MS) return false;
    sessionStorage.setItem(RESTART_KEY, String(Date.now()));
    return true;
  } catch {
    // With no memory of the last restart, a first one cannot be told from the tenth.
    return false;
  }
}

/**
 * For a page whose code would not load, which after a deploy is every page not opened yet: the old files
 * are gone from the server. Restarts on the new version, on a page the person has only just moved to, so
 * nothing is being typed. If this returns, a restart cannot help yet and the page must say so.
 */
export async function restartOnNewVersion(): Promise<void> {
  if (!navigator.onLine) return;
  const arrived = await Promise.race([
    downloadNewVersion().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), UPDATE_WAIT_MS)),
  ]);
  if (!arrived || !mayRestart()) return;
  window.location.reload();
  await new Promise(() => undefined);
}

/** A part of a page failed, not the page: only look, since a restart could cost what is being typed. */
export function lookForNewVersion(): void {
  if ('serviceWorker' in navigator) checkForUpdate().catch(() => undefined);
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  watchForUpdates();
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
