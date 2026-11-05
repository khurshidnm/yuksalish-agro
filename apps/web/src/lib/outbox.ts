/**
 * Offline outbox. Everything a field worker saves lands here first, online or not, so there is only
 * one path to get right. Records wait in IndexedDB and are replayed in order when the server answers.
 *
 * Why a repeat delivery is safe: each record keeps one client-generated `id` and one Idempotency-Key
 * for its whole life. If the response is lost, the retry gets the stored response and feed is issued
 * once. A record leaves the queue only after the server has confirmed it.
 *
 * Failure handling:
 *   no network, 5xx, 429   keep the record, back off, stop: order is preserved
 *   401                    keep the record, stop: it goes out after sign-in, as the same user
 *   same herd and date     move to the conflict list, where a person decides
 *   any other 4xx          move to the failed list with the reason; later records carry on
 *
 * The engine takes its storage and transport as arguments, so its rules are unit-tested without a
 * browser. The IndexedDB store and the real transport are at the bottom of this file.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, api } from './api';

export type OutboxKind = 'daily_log' | 'sick_report' | 'death' | 'weight' | 'lambing' | 'task_complete';

export interface OutboxPhoto {
  id: string;
  name: string;
  type: string;
  /** Set once uploaded, so a retry of the record does not upload the photo again. */
  fileId?: string;
}

export interface OutboxError {
  code: string;
  status: number;
  message: string;
  details?: unknown;
}

export interface OutboxOwner {
  userId: string;
  farmId: string;
}

export interface OutboxRecord {
  /** Also the record's id on the server. */
  id: string;
  kind: OutboxKind;
  method: 'POST' | 'PATCH';
  path: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
  photos: OutboxPhoto[];
  /** Where uploaded photo ids go in the body. */
  photoField?: 'photoFileIds' | 'photoFileId';
  /** What the queue shows for this record. */
  title: string;
  /** Free-form data for screens, e.g. the herd and date. */
  meta: Record<string, unknown>;
  status: 'pending' | 'failed' | 'conflict';
  attempts: number;
  nextAttemptAt: number;
  error: OutboxError | null;
  /** The server's own record that this one clashes with. */
  serverId: string | null;
  createdAt: number;
  userId: string;
  farmId: string;
}

export interface SentRecord {
  id: string;
  kind: OutboxKind;
  title: string;
  meta: Record<string, unknown>;
  sentAt: number;
  userId: string;
  farmId: string;
}

export interface OutboxStore {
  list(): Promise<OutboxRecord[]>;
  put(record: OutboxRecord): Promise<void>;
  remove(id: string): Promise<void>;
  putPhoto(id: string, blob: Blob): Promise<void>;
  getPhoto(id: string): Promise<Blob | null>;
  removePhoto(id: string): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

export interface ConflictReport {
  /** The server already holds exactly this: nothing to resolve. */
  applied: boolean;
  serverId: string | null;
}

export interface OutboxTransport {
  send(record: OutboxRecord, body: Record<string, unknown>): Promise<unknown>;
  upload(photo: OutboxPhoto, blob: Blob): Promise<string>;
  inspectConflict(record: OutboxRecord, error: ApiError): Promise<ConflictReport>;
}

export interface OutboxDeps {
  store: OutboxStore;
  transport: OutboxTransport;
  now?: () => number;
  random?: () => number;
  isOnline?: () => boolean;
  /** Schedules a wake-up. Returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Runs `fn` if no other tab is delivering. */
  lock?: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  /** Tell other tabs that the queue changed. */
  announce?: () => void;
}

export interface OutboxState {
  ready: boolean;
  /** The current user's records on the current farm, oldest first. */
  records: OutboxRecord[];
  /** Records waiting for another user or farm: they go out when that person signs in. */
  others: number;
  syncing: boolean;
  /** The record on its way to the server this moment. It must not change under the delivery. */
  sendingId: string | null;
  /** The last attempt could not reach the server. */
  unreachable: boolean;
  /** Counts up with each delivery, so screens know to refresh. */
  delivered: number;
  lastSyncAt: number | null;
  sent: SentRecord[];
}

export type NewRecord = Pick<OutboxRecord, 'kind' | 'path' | 'body' | 'title'> &
  Partial<Pick<OutboxRecord, 'id' | 'method' | 'meta' | 'photoField'>> & {
    photos?: { name: string; blob: Blob }[];
  };

export type RecordPatch = Partial<Pick<OutboxRecord, 'body' | 'title' | 'meta' | 'path' | 'method'>> & {
  /** New photos to add to the ones already queued. */
  addPhotos?: { name: string; blob: Blob }[];
  removePhotoIds?: string[];
};

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 5 * 60_000;
const SENT_KEEP = 30;
const SENT_KEY = 'outbox:sent';
/** A duplicate answer is expected to clear on the next try, once the first delivery has committed. */
const MAX_DUPLICATE_RETRIES = 3;

/** Time-ordered id. crypto.randomUUID does not exist on plain http, e.g. a server on the farm LAN. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Exponential, capped, with ±20 % jitter so several phones do not retry in step. */
export function backoffMs(attempts: number, random: number = Math.random()): number {
  const delay = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS);
  return Math.round(delay * (0.8 + random * 0.4));
}

export type FailureClass = 'network' | 'transient' | 'auth' | 'conflict' | 'duplicate' | 'closed' | 'permanent';

export function classifyFailure(record: Pick<OutboxRecord, 'kind'>, error: unknown): FailureClass {
  if (!(error instanceof ApiError)) return 'transient';
  if (error.status === 0) return 'network';
  if (error.status === 401) return 'auth';
  if (error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500) return 'transient';
  if (error.code === 'RETRY') return 'transient';
  if (error.code === 'DAILY_LOG_EXISTS' || error.code === 'STALE_UPDATE') return 'conflict';
  if (error.code === 'ALREADY_EXISTS') return 'duplicate';
  // Someone finished this task first. The outcome is what the person wanted.
  if (record.kind === 'task_complete' && error.code === 'TASK_NOT_ACTIVE') return 'closed';
  return 'permanent';
}

/**
 * Only a record the server can never have seen may change. After an attempt with no clear answer the
 * first version may already be saved, and an edit would be silently dropped by the idempotent replay.
 */
export function canEdit(record: OutboxRecord): boolean {
  return record.status === 'failed' || record.status === 'conflict' || (record.status === 'pending' && record.attempts === 0);
}

export function bodyWithPhotos(record: OutboxRecord): Record<string, unknown> {
  if (!record.photoField) return record.body;
  const ids = record.photos.flatMap((p) => (p.fileId ? [p.fileId] : []));
  return {
    ...record.body,
    [record.photoField]: record.photoField === 'photoFileId' ? (ids[0] ?? null) : ids,
  };
}

function toOutboxError(error: unknown): OutboxError {
  if (error instanceof ApiError) {
    return { code: error.code, status: error.status, message: error.message, details: error.details };
  }
  return { code: 'CLIENT_ERROR', status: 0, message: error instanceof Error ? error.message : String(error) };
}

const INITIAL_STATE: OutboxState = {
  ready: false,
  records: [],
  others: 0,
  syncing: false,
  sendingId: null,
  unreachable: false,
  delivered: 0,
  lastSyncAt: null,
  sent: [],
};

export function createOutbox(deps: OutboxDeps) {
  const { store, transport } = deps;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const isOnline = deps.isOnline ?? (() => true);
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });
  const lock = deps.lock ?? (<T,>(fn: () => Promise<T>) => fn());

  let state = INITIAL_STATE;
  let owner: OutboxOwner | null = null;
  let running: Promise<void> | null = null;
  let flushAgain = false;
  let forceAgain = false;
  let cancelTimer: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<OutboxState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const owned = (record: Pick<OutboxRecord, 'userId' | 'farmId'>) =>
    owner !== null && record.userId === owner.userId && record.farmId === owner.farmId;

  /** Re-read the queue. Always from storage: another tab may have changed it. */
  async function load(): Promise<void> {
    try {
      const all = (await store.list()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const sent = (await store.getMeta<SentRecord[]>(SENT_KEY)) ?? [];
      const records = all.filter(owned);
      set({ ready: true, records, others: all.length - records.length, sent: sent.filter(owned) });
    } catch {
      // Storage refused, e.g. a full disk. Screens still work online, and saving reports the failure.
      set({ ready: true });
    }
  }

  async function changed(): Promise<void> {
    await load();
    deps.announce?.();
  }

  function schedule(ms: number): void {
    cancelTimer?.();
    cancelTimer = setTimer(() => {
      cancelTimer = null;
      void flush();
    }, Math.max(ms, 1_000));
  }

  async function addPhotos(photos: { name: string; blob: Blob }[]): Promise<OutboxPhoto[]> {
    const queued: OutboxPhoto[] = [];
    for (const photo of photos) {
      const id = uuidv7(now());
      await store.putPhoto(id, photo.blob);
      queued.push({ id, name: photo.name, type: photo.blob.type });
    }
    return queued;
  }

  async function dropPhotos(photos: OutboxPhoto[]): Promise<void> {
    for (const photo of photos) await store.removePhoto(photo.id);
  }

  /** Save a record. Durable once this resolves, then delivery starts in the background. */
  async function enqueue(input: NewRecord): Promise<OutboxRecord> {
    if (!owner) throw new Error('Outbox has no signed-in user');
    const id = input.id ?? uuidv7(now());
    const record: OutboxRecord = {
      id,
      kind: input.kind,
      method: input.method ?? 'POST',
      path: input.path,
      body: input.body,
      idempotencyKey: id,
      photos: await addPhotos(input.photos ?? []),
      photoField: input.photoField,
      title: input.title,
      meta: input.meta ?? {},
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      error: null,
      serverId: null,
      createdAt: now(),
      userId: owner.userId,
      farmId: owner.farmId,
    };
    await store.put(record);
    await changed();
    void flush();
    return record;
  }

  async function find(id: string): Promise<OutboxRecord | undefined> {
    return (await store.list()).find((r) => r.id === id);
  }

  /** Change a record that has not reached the server, then try again. */
  async function revise(id: string, patch: RecordPatch): Promise<OutboxRecord> {
    const record = await find(id);
    if (!record) throw new Error('Record is no longer in the queue');
    if (!canEdit(record) || state.sendingId === id) throw new Error('Record may already be on the server');
    const removed = record.photos.filter((p) => patch.removePhotoIds?.includes(p.id));
    await dropPhotos(removed);
    const { addPhotos: added, removePhotoIds: _removed, ...fields } = patch;
    const next: OutboxRecord = {
      ...record,
      ...fields,
      photos: [...record.photos.filter((p) => !removed.includes(p)), ...(await addPhotos(added ?? []))],
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      error: null,
      serverId: null,
    };
    await store.put(next);
    await changed();
    void flush();
    return next;
  }

  async function removeRecord(record: OutboxRecord): Promise<void> {
    await dropPhotos(record.photos);
    await store.remove(record.id);
  }

  async function remember(record: OutboxRecord): Promise<void> {
    const sent = (await store.getMeta<SentRecord[]>(SENT_KEY)) ?? [];
    const entry: SentRecord = {
      id: record.id,
      kind: record.kind,
      title: record.title,
      meta: record.meta,
      sentAt: now(),
      userId: record.userId,
      farmId: record.farmId,
    };
    await store.setMeta(SENT_KEY, [entry, ...sent.filter((s) => s.id !== record.id)].slice(0, SENT_KEEP));
  }

  async function delivered(record: OutboxRecord): Promise<void> {
    await remember(record);
    await removeRecord(record);
    await load();
    set({ delivered: state.delivered + 1, lastSyncAt: now(), unreachable: false });
    deps.announce?.();
  }

  async function backOff(record: OutboxRecord, error: unknown): Promise<void> {
    const attempts = record.attempts + 1;
    const delay = backoffMs(attempts, random());
    await store.put({ ...record, attempts, nextAttemptAt: now() + delay, error: toOutboxError(error) });
    await load();
    schedule(delay);
  }

  /** Returns false when delivery must stop, leaving later records in order behind this one. */
  async function deliver(start: OutboxRecord): Promise<boolean> {
    let record = start;
    set({ sendingId: record.id });
    try {
      for (const photo of record.photos) {
        if (photo.fileId) continue;
        const blob = await store.getPhoto(photo.id);
        // A photo lost from storage must not hold back the feed record that carries the stock change.
        if (!blob) continue;
        if (!owned(record)) return false;
        const fileId = await transport.upload(photo, blob);
        record = { ...record, photos: record.photos.map((p) => (p.id === photo.id ? { ...p, fileId } : p)) };
        await store.put(record);
      }
      // The token is whoever signed in last, and a slow photo may have outlasted this record's person.
      if (!owned(record)) return false;
      await transport.send(record, bodyWithPhotos(record));
      await delivered(record);
      return true;
    } catch (error) {
      const failure = classifyFailure(record, error);
      switch (failure) {
        case 'network':
          set({ unreachable: true });
          await backOff(record, error);
          return false;
        case 'transient':
          await backOff(record, error);
          return false;
        case 'auth':
          // No attempt is counted: the record did nothing wrong. Sign-in restarts delivery.
          schedule(30_000);
          return false;
        case 'closed':
          await delivered(record);
          return true;
        case 'duplicate':
          if (record.attempts + 1 < MAX_DUPLICATE_RETRIES) {
            await backOff(record, error);
            return false;
          }
          return moveToConflict(record, error as ApiError);
        case 'conflict':
          return moveToConflict(record, error as ApiError);
        default:
          await store.put({ ...record, status: 'failed', attempts: record.attempts + 1, error: toOutboxError(error) });
          await changed();
          return true;
      }
    } finally {
      set({ sendingId: null });
    }
  }

  async function moveToConflict(record: OutboxRecord, error: ApiError): Promise<boolean> {
    let report: ConflictReport = { applied: false, serverId: null };
    try {
      report = await transport.inspectConflict(record, error);
    } catch {
      // Without the comparison a person decides, which is the safe default.
    }
    if (report.applied) {
      await delivered(record);
      return true;
    }
    const details = error.details as { id?: unknown } | null | undefined;
    const serverId = report.serverId ?? (typeof details?.id === 'string' ? details.id : null);
    await store.put({ ...record, status: 'conflict', attempts: record.attempts + 1, error: toOutboxError(error), serverId });
    await changed();
    return true;
  }

  async function deliverQueue(force: boolean): Promise<void> {
    const queue = (await store.list())
      .filter((r) => owned(r) && r.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const record of queue) {
      const wait = record.nextAttemptAt - now();
      if (!force && wait > 0) {
        schedule(wait);
        return;
      }
      if (!(await deliver(record))) return;
    }
  }

  /** Deliver what is due. Safe to call at any time and from anywhere. */
  async function flush(options: { force?: boolean } = {}): Promise<void> {
    if (running) {
      flushAgain = true;
      forceAgain ||= Boolean(options.force);
      return running;
    }
    if (!owner) return;
    if (!options.force && !isOnline()) return;

    set({ syncing: true });
    running = (async () => {
      try {
        let force = Boolean(options.force);
        do {
          flushAgain = false;
          forceAgain = false;
          await lock(() => deliverQueue(force));
          force = forceAgain;
        } while (flushAgain);
      } finally {
        running = null;
        await load();
        set({ syncing: false });
      }
    })();
    return running;
  }

  /** Send again now. Without an id, every failed record of this user. */
  async function retry(id?: string): Promise<void> {
    for (const record of await store.list()) {
      if (!owned(record)) continue;
      if (id ? record.id !== id : record.status !== 'failed') continue;
      if (record.status === 'conflict') continue;
      await store.put({ ...record, status: 'pending', nextAttemptAt: 0, error: null });
    }
    await changed();
    await flush({ force: true });
  }

  /** Throw a record away. Only ever on a person's explicit choice. */
  async function discard(id: string): Promise<void> {
    const record = await find(id);
    if (!record) return;
    await removeRecord(record);
    await changed();
  }

  /** A conflict was settled on the server: the record's work is done. */
  async function settled(id: string): Promise<void> {
    const record = await find(id);
    if (record) await delivered(record);
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    /** Records stay in the queue across sign-out, and resume only for the person who made them. */
    async setOwner(next: OutboxOwner | null) {
      owner = next;
      await load();
      if (next) await flush();
    },
    load,
    enqueue,
    revise,
    flush,
    retry,
    discard,
    settled,
  };
}

export type Outbox = ReturnType<typeof createOutbox>;

// ─── Browser storage ────────────────────────────────────────────────────────

const DB_NAME = 'yap-offline';
const RECORDS = 'records';
const PHOTOS = 'photos';
const META = 'meta';

let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore(RECORDS, { keyPath: 'id' });
      db.createObjectStore(PHOTOS, { keyPath: 'id' });
      db.createObjectStore(META, { keyPath: 'key' });
    };
    open.onsuccess = () => {
      // Another tab upgrading the schema must be able to take over.
      open.result.onversionchange = () => {
        open.result.close();
        database = null;
      };
      resolve(open.result);
    };
    open.onerror = () => {
      database = null;
      reject(open.error ?? new Error('Could not open offline storage'));
    };
  });
  return database;
}

async function transaction<T>(
  name: string,
  mode: IDBTransactionMode,
  run: (objects: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const request = run(tx.objectStore(name));
    // Resolve on commit, not on request success: a saved record must survive the app closing.
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error ?? new Error('Offline storage failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Offline storage failed'));
  });
}

/** Bytes rather than a Blob: older Safari loses Blobs stored in IndexedDB. */
interface StoredPhoto {
  id: string;
  type: string;
  bytes: ArrayBuffer;
}

export const idbStore: OutboxStore = {
  async list() {
    return (await transaction<OutboxRecord[]>(RECORDS, 'readonly', (s) => s.getAll())) ?? [];
  },
  async put(record) {
    await transaction(RECORDS, 'readwrite', (s) => void s.put(record));
  },
  async remove(id) {
    await transaction(RECORDS, 'readwrite', (s) => void s.delete(id));
  },
  async putPhoto(id, blob) {
    const stored: StoredPhoto = { id, type: blob.type, bytes: await blob.arrayBuffer() };
    await transaction(PHOTOS, 'readwrite', (s) => void s.put(stored));
  },
  async getPhoto(id) {
    const stored = await transaction<StoredPhoto | undefined>(PHOTOS, 'readonly', (s) => s.get(id));
    return stored ? new Blob([stored.bytes], { type: stored.type }) : null;
  },
  async removePhoto(id) {
    await transaction(PHOTOS, 'readwrite', (s) => void s.delete(id));
  },
  async getMeta<T>(key: string) {
    const row = await transaction<{ key: string; value: T } | undefined>(META, 'readonly', (s) => s.get(key));
    return row?.value;
  },
  async setMeta(key, value) {
    await transaction(META, 'readwrite', (s) => void s.put({ key, value }));
  },
};

/** Delete stored values whose key starts with this. */
export async function clearMeta(prefix: string): Promise<void> {
  await transaction(META, 'readwrite', (s) => {
    s.delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
  });
}

// ─── Delivery through the API ───────────────────────────────────────────────

interface ServerDailyLog {
  id: string;
  waterL: number | null;
  condition: string;
  notes: string | null;
  lines: { itemId: string; actualQty: number }[];
}

/** The same feed given, ignoring ration lines recorded as zero. */
function sameDailyLog(server: ServerDailyLog, body: Record<string, unknown>): boolean {
  const given = (lines: { itemId: string; actualQty: number }[]) =>
    lines
      .filter((l) => l.actualQty > 0)
      .map((l) => `${l.itemId}:${l.actualQty}`)
      .sort()
      .join();
  const mine = (body.lines as { itemId: string; actualQty: number }[] | undefined) ?? [];
  return (
    given(server.lines) === given(mine) &&
    (server.waterL ?? null) === ((body.waterL as number | null | undefined) ?? null) &&
    server.condition === ((body.condition as string | undefined) ?? 'normal') &&
    (server.notes ?? '') === ((body.notes as string | null | undefined) ?? '') &&
    ((body.photoFileIds as string[] | undefined) ?? []).length === 0
  );
}

const apiTransport: OutboxTransport = {
  send(record, body) {
    if (record.method === 'PATCH') return api.patch(record.path, body);
    return api.post(record.path, body, { idempotencyKey: record.idempotencyKey });
  },
  async upload(photo, blob) {
    // The key makes a retried upload return the same file rather than store a second copy.
    const file = await api.upload(blob, photo.name, { idempotencyKey: `photo-${photo.id}` });
    return file.id;
  },
  async inspectConflict(record, error) {
    if (record.kind !== 'daily_log') return { applied: false, serverId: null };
    const details = error.details as { id?: string } | null | undefined;
    let serverId = details?.id ?? (record.method === 'PATCH' ? (record.path.split('/').pop() ?? null) : null);
    if (!serverId) {
      const { herdId, date } = record.meta;
      const found = await api.list<{ id: string }>('/livestock/daily-logs', { herdId, from: date, to: date, pageSize: 1 });
      serverId = found.data[0]?.id ?? null;
    }
    if (!serverId) return { applied: false, serverId: null };
    if (serverId === record.id) return { applied: true, serverId };
    const server = await api.get<ServerDailyLog>(`/livestock/daily-logs/${serverId}`);
    return { applied: sameDailyLog(server, bodyWithPhotos(record)), serverId };
  },
};

const channel = typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('yap.outbox');

export const outbox = createOutbox({
  store: idbStore,
  transport: apiTransport,
  isOnline: () => navigator.onLine,
  lock: async (fn) => {
    // Idempotency keeps two tabs safe anyway; the lock stops them wasting a poor connection.
    if (!navigator.locks) return fn();
    return navigator.locks.request('yap.outbox', { ifAvailable: true }, (held) => (held ? fn() : undefined));
  },
  announce: () => channel?.postMessage('changed'),
});

let started = false;

/** Wire delivery to the browser. Call once at app start. */
export function startOutbox(): void {
  if (started) return;
  started = true;
  if (channel) channel.onmessage = () => void outbox.load();
  window.addEventListener('online', () => void outbox.flush({ force: true }));
  window.addEventListener('offline', () => void outbox.load());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void outbox.flush();
  });
  // navigator.onLine can stay true on Wi-Fi with no internet, so keep trying what is due.
  setInterval(() => void outbox.flush(), 30_000);
}

export function useOutbox(): OutboxState {
  return useSyncExternalStore(outbox.subscribe, outbox.getState);
}
