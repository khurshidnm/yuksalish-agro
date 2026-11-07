import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  backoffMs,
  bodyWithPhotos,
  canEdit,
  classifyFailure,
  createOutbox,
  uuidv7,
  waitsFor,
  type ConflictReport,
  type NewRecord,
  type Outbox,
  type OutboxPhoto,
  type OutboxRecord,
  type OutboxStore,
} from './outbox';

function memoryStore(): OutboxStore & { records: Map<string, OutboxRecord>; photos: Map<string, Blob> } {
  const records = new Map<string, OutboxRecord>();
  const photos = new Map<string, Blob>();
  const meta = new Map<string, unknown>();
  return {
    records,
    photos,
    list: async () => [...records.values()].map((r) => structuredClone(r)),
    put: async (r) => void records.set(r.id, structuredClone(r)),
    remove: async (id) => void records.delete(id),
    putPhoto: async (id, blob) => void photos.set(id, blob),
    getPhoto: async (id) => photos.get(id) ?? null,
    removePhoto: async (id) => void photos.delete(id),
    getMeta: async <T,>(key: string) => meta.get(key) as T | undefined,
    setMeta: async (key, value) => void meta.set(key, value),
  };
}

const OFFLINE = new ApiError(0, 'NETWORK_ERROR', 'Network error');
const conflict = (code: string, details?: unknown) => new ApiError(409, code, code, details);

interface Call {
  id: string;
  key: string;
  body: Record<string, unknown>;
}

/** A scripted server: each delivery takes the next outcome, then everything succeeds. */
function fakeServer() {
  const script: (Error | 'ok')[] = [];
  const calls: Call[] = [];
  const uploads: string[] = [];
  const uploadFailures: Error[] = [];
  let report: ConflictReport = { applied: false, serverId: null };
  const health = { up: true };
  return {
    script,
    calls,
    uploads,
    uploadFailures,
    health,
    setReport: (r: ConflictReport) => (report = r),
    transport: {
      send: async (record: OutboxRecord, body: Record<string, unknown>) => {
        calls.push({ id: record.id, key: record.idempotencyKey, body });
        const next = script.shift();
        if (next && next !== 'ok') throw next;
        return { id: record.id };
      },
      upload: async (photo: OutboxPhoto) => {
        const failure = uploadFailures.shift();
        if (failure) throw failure;
        uploads.push(photo.id);
        return `file-of-${photo.id}`;
      },
      inspectConflict: async () => report,
      serverIsUp: async () => health.up,
    },
  };
}

const ME = { userId: 'user-1', farmId: 'farm-1' };

const log = (title: string, over: Partial<NewRecord> = {}): NewRecord => ({
  kind: 'daily_log',
  path: '/livestock/daily-logs',
  body: { herdId: 'herd-1', title },
  title,
  ...over,
});

interface Rig {
  outbox: Outbox;
  store: ReturnType<typeof memoryStore>;
  server: ReturnType<typeof fakeServer>;
  online: { value: boolean };
  clock: { value: number };
  timers: number[];
  settle(): Promise<void>;
}

async function rig(): Promise<Rig> {
  const store = memoryStore();
  const server = fakeServer();
  const online = { value: true };
  const clock = { value: 1_000_000 };
  const timers: number[] = [];
  const outbox = createOutbox({
    store,
    transport: server.transport,
    now: () => clock.value,
    random: () => 0.5,
    isOnline: () => online.value,
    setTimer: (_fn, ms) => {
      timers.push(ms);
      return () => undefined;
    },
  });
  await outbox.setOwner(ME);
  return { outbox, store, server, online, clock, timers, settle: () => outbox.flush() };
}

async function queueWhileOffline(r: Rig, ...records: NewRecord[]) {
  r.online.value = false;
  const saved = [];
  for (const record of records) {
    r.clock.value += 1;
    saved.push(await r.outbox.enqueue(record));
  }
  await r.settle();
  r.online.value = true;
  return saved;
}

describe('saving', () => {
  it('is durable before any delivery, and stays queued while offline', async () => {
    const r = await rig();
    const [record] = await queueWhileOffline(r, log('A'));
    expect(r.server.calls).toEqual([]);
    expect(r.store.records.get(record.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(r.outbox.getState().records.map((x) => x.title)).toEqual(['A']);
  });

  it('uses one id as both the record id and the Idempotency-Key', async () => {
    const r = await rig();
    const record = await r.outbox.enqueue(log('A'));
    expect(record.idempotencyKey).toBe(record.id);
    await r.settle();
    expect(r.server.calls[0]).toMatchObject({ id: record.id, key: record.id });
  });

  it('removes a record only after the server confirms it, and remembers it as sent', async () => {
    const r = await rig();
    await r.outbox.enqueue(log('A'));
    await r.settle();
    expect(r.store.records.size).toBe(0);
    const state = r.outbox.getState();
    expect(state.records).toEqual([]);
    expect(state.sent.map((s) => s.title)).toEqual(['A']);
    expect(state.delivered).toBe(1);
    expect(state.lastSyncAt).toBe(r.clock.value);
  });
});

describe('a lost connection', () => {
  it('keeps the record, stops, and retries with the same id and key after a backoff', async () => {
    const r = await rig();
    const [record] = await queueWhileOffline(r, log('A'));
    r.server.script.push(OFFLINE);
    await r.outbox.flush();

    expect(r.store.records.get(record.id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(r.outbox.getState().unreachable).toBe(true);
    expect(r.timers.at(-1)).toBe(5_000);

    await r.outbox.flush();
    expect(r.server.calls).toHaveLength(1);

    r.clock.value += 6_000;
    await r.outbox.flush();
    expect(r.server.calls).toHaveLength(2);
    expect(r.server.calls[1]).toEqual(r.server.calls[0]);
    expect(r.store.records.size).toBe(0);
    expect(r.outbox.getState().unreachable).toBe(false);
  });

  it('a response lost after the server saved it still ends with one delivered record', async () => {
    const r = await rig();
    const [record] = await queueWhileOffline(r, log('A'));
    // The server applied this delivery; only its answer was lost.
    r.server.script.push(OFFLINE);
    await r.outbox.flush();
    r.clock.value += 6_000;
    await r.outbox.flush();
    const keys = r.server.calls.map((c) => c.key);
    expect(new Set(keys)).toEqual(new Set([record.idempotencyKey]));
    expect(r.outbox.getState().sent).toHaveLength(1);
  });

  it('never overtakes: later records wait behind one that cannot get through', async () => {
    const r = await rig();
    const [a, b, c] = await queueWhileOffline(r, log('A'), log('B'), log('C'));
    r.server.script.push(OFFLINE);
    await r.outbox.flush();
    expect(r.server.calls.map((x) => x.id)).toEqual([a.id]);

    r.clock.value += 6_000;
    await r.outbox.flush();
    expect(r.server.calls.map((x) => x.id)).toEqual([a.id, a.id, b.id, c.id]);
  });

  it('backs off on server errors too, and a forced send ignores the wait', async () => {
    const r = await rig();
    await queueWhileOffline(r, log('A'));
    r.server.script.push(new ApiError(503, 'HTTP_ERROR', 'Unavailable'));
    await r.outbox.flush();
    expect(r.store.records.size).toBe(1);
    await r.outbox.flush({ force: true });
    expect(r.store.records.size).toBe(0);
  });

  it('caps the delay at five minutes', () => {
    expect(backoffMs(1, 0.5)).toBe(5_000);
    expect(backoffMs(3, 0.5)).toBe(20_000);
    expect(backoffMs(30, 0.5)).toBe(300_000);
    expect(backoffMs(30, 1)).toBe(360_000);
    expect(backoffMs(1, 0)).toBe(4_000);
  });
});

describe('sign-in', () => {
  it('an expired session keeps the queue, counts no attempt, and resumes after sign-in', async () => {
    const r = await rig();
    const [record] = await queueWhileOffline(r, log('A'));
    r.server.script.push(new ApiError(401, 'SESSION_EXPIRED', 'Sign in'));
    await r.outbox.flush();
    expect(r.store.records.get(record.id)).toMatchObject({ status: 'pending', attempts: 0 });

    await r.outbox.setOwner(null);
    expect(r.outbox.getState().others).toBe(1);
    expect(r.store.records.size).toBe(1);

    await r.outbox.setOwner(ME);
    expect(r.store.records.size).toBe(0);
    expect(r.outbox.getState().sent).toHaveLength(1);
  });

  it("does not send one person's records with another person's session", async () => {
    const r = await rig();
    await queueWhileOffline(r, log('A'));
    r.server.calls.length = 0;

    await r.outbox.setOwner({ userId: 'user-2', farmId: 'farm-1' });
    await r.outbox.flush({ force: true });
    expect(r.server.calls).toEqual([]);
    expect(r.outbox.getState()).toMatchObject({ records: [], others: 1 });

    await r.outbox.setOwner({ userId: 'user-1', farmId: 'farm-2' });
    await r.outbox.flush({ force: true });
    expect(r.server.calls).toEqual([]);

    await r.outbox.setOwner(ME);
    expect(r.server.calls).toHaveLength(1);
  });

  it('refuses to queue with nobody signed in', async () => {
    const r = await rig();
    await r.outbox.setOwner(null);
    await expect(r.outbox.enqueue(log('A'))).rejects.toThrow();
  });
});

describe('conflicts', () => {
  it('moves a clash to the conflict list with the server record, and later records continue', async () => {
    const r = await rig();
    const [a, b] = await queueWhileOffline(r, log('A'), log('B'));
    r.server.script.push(conflict('DAILY_LOG_EXISTS', { id: 'server-log', date: '2026-11-04' }));
    await r.outbox.flush();

    expect(r.store.records.get(a.id)).toMatchObject({ status: 'conflict', serverId: 'server-log' });
    expect(r.store.records.has(b.id)).toBe(false);
    expect(r.outbox.getState().sent.map((s) => s.title)).toEqual(['B']);
  });

  it('never replays a conflict by itself', async () => {
    const r = await rig();
    await queueWhileOffline(r, log('A'));
    r.server.script.push(conflict('DAILY_LOG_EXISTS', { id: 'server-log' }));
    await r.outbox.flush();
    r.clock.value += 1_000_000;
    await r.outbox.flush({ force: true });
    await r.outbox.retry();
    expect(r.server.calls).toHaveLength(1);
    expect(r.store.records.size).toBe(1);
  });

  it('treats a clash as delivered when the server already holds the same content', async () => {
    const r = await rig();
    await queueWhileOffline(r, log('A'));
    r.server.setReport({ applied: true, serverId: 'server-log' });
    r.server.script.push(conflict('STALE_UPDATE'));
    await r.outbox.flush();
    expect(r.store.records.size).toBe(0);
    expect(r.outbox.getState().sent).toHaveLength(1);
  });

  it('a stale correction is a conflict too', async () => {
    const r = await rig();
    await queueWhileOffline(r, log('A', { method: 'PATCH', path: '/livestock/daily-logs/x' }));
    r.server.setReport({ applied: false, serverId: 'x' });
    r.server.script.push(conflict('STALE_UPDATE'));
    await r.outbox.flush();
    expect([...r.store.records.values()][0]).toMatchObject({ status: 'conflict', serverId: 'x' });
  });

  it('retries a duplicate answer, which clears once the first delivery commits', async () => {
    const r = await rig();
    await queueWhileOffline(r, log('A'));
    r.server.script.push(conflict('ALREADY_EXISTS'));
    await r.outbox.flush();
    expect([...r.store.records.values()][0]).toMatchObject({ status: 'pending', attempts: 1 });
    r.clock.value += 6_000;
    await r.outbox.flush();
    expect(r.store.records.size).toBe(0);
  });

  it('a duplicate that does not clear goes to a person rather than looping', async () => {
    const r = await rig();
    await queueWhileOffline(r, log('A'));
    r.server.script.push(conflict('ALREADY_EXISTS'), conflict('ALREADY_EXISTS'), conflict('ALREADY_EXISTS'));
    for (let i = 0; i < 3; i++) {
      await r.outbox.flush();
      r.clock.value += 60_000;
    }
    expect([...r.store.records.values()][0].status).toBe('conflict');
  });

  it('a correction that arrives after its day closed goes to a person, with the saved record', async () => {
    const tooLate = new ApiError(403, 'EDIT_WINDOW_CLOSED', 'Too late', { id: 'server-log' });
    const { outbox, server, store } = await rig();
    server.script.push(tooLate);
    server.setReport({ applied: false, serverId: 'server-log' });
    const record = await outbox.enqueue(log('Correction', { method: 'PATCH', path: '/livestock/daily-logs/server-log' }));
    await outbox.flush();
    expect(store.records.get(record.id)).toMatchObject({ status: 'conflict', serverId: 'server-log', error: { code: 'EDIT_WINDOW_CLOSED' } });
  });

  it('settling a conflict removes the record and counts it as sent', async () => {
    const r = await rig();
    const [a] = await queueWhileOffline(r, log('A'));
    r.server.script.push(conflict('DAILY_LOG_EXISTS', { id: 's' }));
    await r.outbox.flush();
    await r.outbox.settled(a.id);
    expect(r.store.records.size).toBe(0);
    expect(r.outbox.getState().sent.map((s) => s.id)).toEqual([a.id]);
  });
});

describe('rejected records', () => {
  const noStock = conflict('INSUFFICIENT_STOCK', { available: 3, requested: 9 });

  it('keeps a rejected record with its reason, and later records continue', async () => {
    const r = await rig();
    const [a, b] = await queueWhileOffline(r, log('A'), log('B'));
    r.server.script.push(noStock);
    await r.outbox.flush();
    expect(r.store.records.get(a.id)).toMatchObject({
      status: 'failed',
      error: { code: 'INSUFFICIENT_STOCK', details: { available: 3 } },
    });
    expect(r.store.records.has(b.id)).toBe(false);
  });

  it('does not retry a rejected record by itself', async () => {
    const r = await rig();
    await queueWhileOffline(r, log('A'));
    r.server.script.push(noStock);
    await r.outbox.flush();
    r.clock.value += 1_000_000;
    await r.outbox.flush();
    expect(r.server.calls).toHaveLength(1);
  });

  it('a corrected record goes out with the same id and key', async () => {
    const r = await rig();
    const [a] = await queueWhileOffline(r, log('A'));
    r.server.script.push(noStock);
    await r.outbox.flush();
    await r.outbox.revise(a.id, { body: { herdId: 'herd-1', fixed: true } });
    await r.settle();
    expect(r.server.calls[1]).toMatchObject({ id: a.id, key: a.id, body: { fixed: true } });
    expect(r.store.records.size).toBe(0);
  });

  it('retry sends failed records again', async () => {
    const r = await rig();
    await queueWhileOffline(r, log('A'));
    r.server.script.push(noStock);
    await r.outbox.flush();
    await r.outbox.retry();
    expect(r.store.records.size).toBe(0);
  });

  it('discard removes the record and its photos, only when asked', async () => {
    const r = await rig();
    const [a] = await queueWhileOffline(r, log('A', { photos: [{ name: 'a.jpg', blob: new Blob(['x']) }] }));
    expect(r.store.photos.size).toBe(1);
    await r.outbox.discard(a.id);
    expect(r.store.records.size).toBe(0);
    expect(r.store.photos.size).toBe(0);
    expect(r.outbox.getState().sent).toEqual([]);
  });

  it('a task someone else closed first counts as done', () => {
    const closed = conflict('TASK_NOT_ACTIVE');
    expect(classifyFailure({ kind: 'task_complete' }, closed)).toBe('closed');
    expect(classifyFailure({ kind: 'daily_log' }, closed)).toBe('permanent');
  });

  it('an unexpected client error is retried, not dropped', () => {
    expect(classifyFailure({ kind: 'daily_log' }, new TypeError('boom'))).toBe('server');
    // A step left at sign-in holds the record back, and must not fail it.
    for (const code of ['PASSWORD_CHANGE_REQUIRED', 'TWO_FACTOR_ENROLLMENT_REQUIRED']) {
      expect(classifyFailure({ kind: 'daily_log' }, new ApiError(403, code, 'x'))).toBe('auth');
    }
  });
});

describe('a record the server keeps failing on', () => {
  const crash = () => new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong');
  const animal = (tag: string, title = tag): NewRecord => ({ kind: 'weight', path: '/livestock/weights', body: { title }, title, meta: { tag } });

  /** One forced delivery per failure, as if each backoff had passed. */
  async function refuse(r: Rig, times: number, failure: () => Error = crash): Promise<void> {
    for (let i = 0; i < times; i++) {
      r.server.script.unshift(failure());
      await r.outbox.flush({ force: true });
    }
  }

  it('holds the queue through the tries, then shows as stuck with what the server said, and the rest go', async () => {
    const r = await rig();
    const [bad, next] = await queueWhileOffline(r, animal('A'), animal('B'));
    await refuse(r, 4);
    expect(r.store.records.get(bad.id)).toMatchObject({ status: 'pending', serverErrors: 4 });
    expect(r.server.calls.every((c) => c.id === bad.id)).toBe(true);

    await refuse(r, 1);
    expect(r.store.records.get(bad.id)).toMatchObject({ status: 'stuck', error: { code: 'INTERNAL_ERROR', status: 500, message: 'Something went wrong' } });
    expect(r.server.calls.map((c) => c.id).at(-1)).toBe(next.id);
    expect(r.store.records.has(next.id)).toBe(false);
  });

  it('is not sent again by itself, and cannot be changed, because the first version may be saved', async () => {
    const r = await rig();
    const [bad] = await queueWhileOffline(r, animal('A'));
    await refuse(r, 5);
    const calls = r.server.calls.length;
    r.clock.value += 3_600_000;
    await r.outbox.flush({ force: true });
    expect(r.server.calls.length).toBe(calls);
    expect(canEdit(r.store.records.get(bad.id) as OutboxRecord)).toBe(false);
    await expect(r.outbox.revise(bad.id, { title: 'New' })).rejects.toThrow();
  });

  it('a server down for everyone gets no record blamed, however long it lasts', async () => {
    const r = await rig();
    const [first, second] = await queueWhileOffline(r, animal('A'), animal('B'));
    r.server.health.up = false;
    await refuse(r, 20, () => new ApiError(502, 'HTTP_ERROR', 'Bad gateway'));
    expect(r.store.records.get(first.id)?.status).toBe('pending');
    expect(r.store.records.get(second.id)).toMatchObject({ status: 'pending', attempts: 0 });

    r.server.health.up = true;
    await r.outbox.flush({ force: true });
    expect(r.store.records.size).toBe(0);
  });

  it('lost connections do not count, so a long day offline does not use up the tries', async () => {
    const r = await rig();
    const [bad] = await queueWhileOffline(r, animal('A'));
    await refuse(r, 30, () => OFFLINE);
    await refuse(r, 1);
    expect(r.store.records.get(bad.id)).toMatchObject({ status: 'pending', serverErrors: 1 });
  });

  it('a record saved by an older version, with no count yet, starts from zero', async () => {
    const r = await rig();
    const [bad] = await queueWhileOffline(r, animal('A'));
    const stored = r.store.records.get(bad.id) as OutboxRecord;
    delete stored.serverErrors;
    await refuse(r, 1);
    expect(r.store.records.get(bad.id)?.serverErrors).toBe(1);
  });

  it('a crash on this phone counts the same way, so it cannot block the queue either', async () => {
    const r = await rig();
    const [bad, next] = await queueWhileOffline(r, animal('A'), animal('B'));
    await refuse(r, 5, () => new TypeError('boom'));
    expect(r.store.records.get(bad.id)).toMatchObject({ status: 'stuck', error: { code: 'CLIENT_ERROR', message: 'boom' } });
    expect(r.store.records.has(next.id)).toBe(false);
  });

  it('records about the same thing wait, and say what for, while the others go out', async () => {
    const r = await rig();
    const [bad, sameDay, animalRecord, otherDay] = await queueWhileOffline(
      r,
      log('Log', { meta: { herdId: 'h', date: '2026-11-05' } }),
      log('Same log corrected', { meta: { herdId: 'h', date: '2026-11-05' } }),
      animal('B'),
      log('Next day', { meta: { herdId: 'h', date: '2026-11-06' } }),
    );
    await refuse(r, 5);
    expect(r.store.records.get(bad.id)?.status).toBe('stuck');
    expect(r.store.records.get(sameDay.id)?.status).toBe('pending');
    expect([...r.store.records.keys()].sort()).toEqual([bad.id, sameDay.id].sort());
    expect(r.server.calls.map((c) => c.id)).toEqual(expect.arrayContaining([animalRecord.id, otherDay.id]));

    const records = [...r.store.records.values()];
    expect(waitsFor(records.find((x) => x.id === sameDay.id) as OutboxRecord, records)?.id).toBe(bad.id);
    expect(waitsFor(records.find((x) => x.id === bad.id) as OutboxRecord, records)).toBeUndefined();
  });

  it('a record newer than the stuck one is the only kind that waits', async () => {
    const r = await rig();
    const [first, second] = await queueWhileOffline(r, animal('A', 'first'), animal('A', 'second'));
    await refuse(r, 5);
    r.store.records.set(first.id, { ...(r.store.records.get(first.id) as OutboxRecord), createdAt: 9_000_000 });
    const records = [...r.store.records.values()];
    expect(waitsFor(records.find((x) => x.id === second.id) as OutboxRecord, records)).toBeUndefined();
  });

  it('deleting the stuck record lets the ones behind it go', async () => {
    const r = await rig();
    const [bad, behind] = await queueWhileOffline(r, animal('A'), animal('A', 'after'));
    await refuse(r, 5);
    expect(r.store.records.get(behind.id)?.status).toBe('pending');
    await r.outbox.discard(bad.id);
    await r.settle();
    expect(r.store.records.size).toBe(0);
  });

  it('a retry that works delivers it, with the same id and key, and then the ones behind it', async () => {
    const r = await rig();
    const [bad, behind] = await queueWhileOffline(r, animal('A'), animal('A', 'after'));
    await refuse(r, 5);
    await r.outbox.retry(bad.id);
    expect(r.store.records.size).toBe(0);
    expect(r.server.calls.slice(-2).map((c) => c.id)).toEqual([bad.id, behind.id]);
    expect(new Set(r.server.calls.filter((c) => c.id === bad.id).map((c) => c.key)).size).toBe(1);
  });

  it('a retry that fails goes straight back, so the queue does not wait through the tries again', async () => {
    const r = await rig();
    const [bad, other] = await queueWhileOffline(r, animal('A'), animal('B'));
    await refuse(r, 5);
    expect(r.store.records.has(other.id)).toBe(false);
    const [later] = await queueWhileOffline(r, animal('C'));
    r.server.script.unshift(crash());
    await r.outbox.retry(bad.id);
    expect(r.store.records.get(bad.id)?.status).toBe('stuck');
    expect(r.store.records.has(later.id)).toBe(false);
  });

  it('retrying everything includes stuck records', async () => {
    const r = await rig();
    const [bad] = await queueWhileOffline(r, animal('A'));
    await refuse(r, 5);
    await r.outbox.retry();
    expect(r.store.records.size).toBe(0);
  });
});

describe('editing a queued record', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it('is allowed before any attempt', async () => {
    const [a] = await queueWhileOffline(r, log('A'));
    expect(canEdit(r.store.records.get(a.id)!)).toBe(true);
    await r.outbox.revise(a.id, { body: { changed: 1 }, title: 'A2' });
    await r.settle();
    expect(r.store.records.get(a.id)).toBeUndefined();
    expect(r.server.calls[0].body).toEqual({ changed: 1 });
  });

  it('is refused after an attempt with no clear answer: the first version may be saved', async () => {
    const [a] = await queueWhileOffline(r, log('A'));
    r.server.script.push(OFFLINE);
    await r.outbox.flush();
    expect(canEdit(r.store.records.get(a.id)!)).toBe(false);
    await expect(r.outbox.revise(a.id, { body: {} })).rejects.toThrow();
    expect(r.store.records.get(a.id)!.body).toEqual({ herdId: 'herd-1', title: 'A' });
  });
});

describe('a record on its way to the server', () => {
  it('cannot be changed, because the change would vanish when the delivery succeeds', async () => {
    const store = memoryStore();
    let release: () => void = () => undefined;
    const outbox = createOutbox({
      store,
      transport: {
        ...fakeServer().transport,
        send: () => new Promise<unknown>((resolve) => (release = () => resolve({}))),
      },
    });
    await outbox.setOwner(ME);
    const record = await outbox.enqueue(log('A'));
    await expect.poll(() => outbox.getState().sendingId).toBe(record.id);
    await expect(outbox.revise(record.id, { body: { late: true } })).rejects.toThrow();
    release();
    await outbox.flush();
    expect(outbox.getState().sendingId).toBeNull();
    expect(outbox.getState().sent).toHaveLength(1);
  });
});

describe('storage trouble', () => {
  it('marks the queue ready, so screens do not wait forever, and saving reports the failure', async () => {
    const store = memoryStore();
    store.list = async () => {
      throw new Error('quota');
    };
    const outbox = createOutbox({ store, transport: fakeServer().transport });
    await outbox.setOwner(null);
    expect(outbox.getState().ready).toBe(true);
    store.put = async () => {
      throw new Error('quota');
    };
    await outbox.setOwner(ME).catch(() => undefined);
    await expect(outbox.enqueue(log('A'))).rejects.toThrow('quota');
  });
});

describe('photos', () => {
  const withPhoto = () =>
    log('A', { photoField: 'photoFileIds', photos: [{ name: 'a.jpg', blob: new Blob(['x'], { type: 'image/jpeg' }) }] });

  it('uploads first, and puts the file ids in the body', async () => {
    const r = await rig();
    const [record] = await queueWhileOffline(r, withPhoto());
    await r.outbox.flush();
    expect(r.server.uploads).toHaveLength(1);
    expect(r.server.calls[0].body.photoFileIds).toEqual([`file-of-${record.photos[0].id}`]);
    expect(r.store.photos.size).toBe(0);
  });

  it('does not upload again when only the record failed', async () => {
    const r = await rig();
    await queueWhileOffline(r, withPhoto());
    r.server.script.push(OFFLINE);
    await r.outbox.flush();
    r.clock.value += 6_000;
    await r.outbox.flush();
    expect(r.server.uploads).toHaveLength(1);
    expect(r.server.calls).toHaveLength(2);
  });

  it('a failed upload holds the record and sends nothing', async () => {
    const r = await rig();
    await queueWhileOffline(r, withPhoto());
    r.server.uploadFailures.push(OFFLINE);
    await r.outbox.flush();
    expect(r.server.calls).toEqual([]);
    expect(r.store.records.size).toBe(1);
    expect(r.store.photos.size).toBe(1);
  });

  it('a task takes a single file id', () => {
    const record = {
      body: { note: null },
      photoField: 'photoFileId',
      photos: [{ id: 'p', name: 'a', type: 'image/jpeg', fileId: 'f1' }],
    } as unknown as OutboxRecord;
    expect(bodyWithPhotos(record)).toEqual({ note: null, photoFileId: 'f1' });
  });
});

describe('uuidv7', () => {
  it('is a valid, time-ordered version 7 id', () => {
    const id = uuidv7(1_800_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7(1_800_000_000_001) > id).toBe(true);
    expect(id.startsWith((1_800_000_000_000).toString(16).padStart(12, '0').slice(0, 8))).toBe(true);
  });
});

describe('one phone, two people', () => {
  const A = { userId: 'A', farmId: 'F' };
  const B = { userId: 'B', farmId: 'F' };

  function phoneWithRecords(photos: OutboxPhoto[] = []) {
    const store = memoryStore();
    const record = (id: string, createdAt: number): OutboxRecord => ({
      id, kind: 'daily_log', method: 'POST', path: '/x', body: {}, idempotencyKey: id, photos, photoField: 'photoFileIds', title: id, meta: {},
      status: 'pending', attempts: 0, nextAttemptAt: 0, error: null, serverId: null, createdAt, userId: 'A', farmId: 'F',
    });
    store.records.set('one', record('one', 1));
    store.records.set('two', record('two', 2));
    /** api.ts sends whichever token is signed in at that moment. */
    const phone = { signedIn: 'A' };
    const sent: [string, string][] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    return { store, phone, sent, held, release: () => release() };
  }

  async function signOutAndIn(outbox: Outbox, phone: { signedIn: string }) {
    await outbox.setOwner(null);
    phone.signedIn = 'B';
    void outbox.setOwner(B);
  }

  it('the next record of a running delivery waits for its own person', async () => {
    const { store, phone, sent, held, release } = phoneWithRecords();
    const transport = {
      send: async (record: OutboxRecord) => {
        sent.push([record.id, phone.signedIn]);
        if (record.id === 'one') await held;
      },
      upload: async () => 'file',
      inspectConflict: async () => ({ applied: false, serverId: null }),
          serverIsUp: async () => true,
    };
    const outbox = createOutbox({ store, transport, setTimer: () => () => undefined });
    const delivering = outbox.setOwner(A);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    await signOutAndIn(outbox, phone);
    release();
    await delivering;
    expect(sent).toEqual([['one', 'A']]);
    expect(store.records.has('two'), 'it waits on the phone, as the file header promises').toBe(true);
  });

  it('a record whose photo outlasted its person is not sent by the next one', async () => {
    const { store, phone, sent, held, release } = phoneWithRecords([{ id: 'p', name: 'p.jpg', type: 'image/jpeg' }]);
    store.photos.set('p', new Blob(['x']));
    let uploading = false;
    const transport = {
      send: async (record: OutboxRecord) => void sent.push([record.id, phone.signedIn]),
      upload: async () => {
        uploading = true;
        await held;
        return 'file';
      },
      inspectConflict: async () => ({ applied: false, serverId: null }),
          serverIsUp: async () => true,
    };
    const outbox = createOutbox({ store, transport, setTimer: () => () => undefined });
    const delivering = outbox.setOwner(A);
    await vi.waitFor(() => expect(uploading).toBe(true));

    await signOutAndIn(outbox, phone);
    release();
    await delivering;
    expect(sent).toEqual([]);
    expect(store.records.get('one')?.photos[0].fileId, 'the upload is kept, so it is not repeated').toBe('file');
  });

  it('the records go out when their person signs in again', async () => {
    const { store, phone, sent } = phoneWithRecords();
    const transport = {
      send: async (record: OutboxRecord) => void sent.push([record.id, phone.signedIn]),
      upload: async () => 'file',
      inspectConflict: async () => ({ applied: false, serverId: null }),
          serverIsUp: async () => true,
    };
    const outbox = createOutbox({ store, transport, setTimer: () => () => undefined });
    phone.signedIn = 'B';
    await outbox.setOwner(B);
    expect(sent).toEqual([]);
    expect(outbox.getState().records).toEqual([]);
    expect(outbox.getState().others).toBe(2);
    await outbox.setOwner(null);
    phone.signedIn = 'A';
    await outbox.setOwner(A);
    expect(sent).toEqual([['one', 'A'], ['two', 'A']]);
  });
});
