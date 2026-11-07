/**
 * What the server can say about itself. /api/health stays one query, for the container check and for
 * deploys. The deep check adds what people depend on and /api/health cannot see: Redis, the worker,
 * urgent alerts getting out, and the disk. None of it waits on the API's own connection pool, so a
 * busy server does not read as a dead one.
 */
import { statfs } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { config } from '../config';
import { healthPool } from '../db/client';

/** Three missed runs of a job that runs every minute. */
const WORKER_STALE_MS = 3 * 60_000;
/** Past the first two attempts, so a slow Telegram does not count and an outage does. */
const UNDELIVERED_LIMIT_MS = 5 * 60_000;
const DISK_LIMIT_PERCENT = 90;
const PROBE_TIMEOUT_MS = 3_000;
/** Anyone can call the deep check, so repeating it costs nothing. */
const CACHE_MS = 15_000;
/** The watch runs every minute, and Telegram is someone else's server. */
const TELEGRAM_CHECK_MS = 5 * 60_000;
/** After a bad answer, soon enough that a moment's trouble does not hold the check down for minutes. */
const TELEGRAM_RECHECK_MS = 60_000;
const WATCH_INTERVAL_MS = 60_000;
const PING_TIMEOUT_MS = 10_000;
/** A monitoring service that is away for a day should not fill the log. */
const PING_COMPLAINT_INTERVAL_MS = 15 * 60_000;

type Status = 'ok' | 'failing';

/** What Telegram says to getMe: the token is good, it is turned down, or nothing got through. */
export type TelegramAnswer = 'ok' | 'refused' | 'unreachable';

export interface HealthFacts {
  database: boolean;
  redis: boolean;
  jobsStartedAt: Date | null;
  lastWorkerRunAt: Date | null;
  oldestUndeliveredAt: Date | null;
  /** Null with no bot running, which the app warns about but says nothing about the server. */
  telegramContactAt: Date | null;
  /** Null with no bot running, or with no answer yet. */
  telegramGetMe: TelegramAnswer | null;
  diskUsedPercent: number | null;
}

const isTelegramLost = (contactAt: Date | null, now: Date) => contactAt !== null && now.getTime() - contactAt.getTime() >= UNDELIVERED_LIMIT_MS;

const ageSeconds = (from: Date | null, now: Date) => (from ? Math.round((now.getTime() - from.getTime()) / 1000) : null);

export function assessHealth(facts: HealthFacts, now: Date) {
  const workerSince = facts.lastWorkerRunAt ?? facts.jobsStartedAt;
  const undeliveredAge = ageSeconds(facts.oldestUndeliveredAt, now);
  const checks = {
    database: { status: (facts.database ? 'ok' : 'failing') as Status },
    redis: { status: (facts.redis ? 'ok' : 'failing') as Status },
    worker: {
      status: (workerSince && now.getTime() - workerSince.getTime() < WORKER_STALE_MS ? 'ok' : 'failing') as Status,
      lastRunAt: facts.lastWorkerRunAt?.toISOString() ?? null,
      ageSeconds: ageSeconds(facts.lastWorkerRunAt, now),
    },
    urgentDelivery: {
      status: (undeliveredAge !== null && undeliveredAge * 1000 >= UNDELIVERED_LIMIT_MS ? 'failing' : 'ok') as Status,
      oldestUndeliveredAt: facts.oldestUndeliveredAt?.toISOString() ?? null,
      ageSeconds: undeliveredAge,
    },
    telegram: {
      status: (isTelegramLost(facts.telegramContactAt, now) || (facts.telegramGetMe ?? 'ok') !== 'ok' ? 'failing' : 'ok') as Status,
      lastContactAt: facts.telegramContactAt?.toISOString() ?? null,
      getMe: facts.telegramGetMe,
    },
    disk: {
      status: (facts.diskUsedPercent !== null && facts.diskUsedPercent < DISK_LIMIT_PERCENT ? 'ok' : 'failing') as Status,
      usedPercent: facts.diskUsedPercent,
    },
  };
  const failing = Object.entries(checks).flatMap(([name, check]) => (check.status === 'ok' ? [] : [name]));
  return { status: (failing.length === 0 ? 'ok' : 'failing') as Status, failing, checkedAt: now.toISOString(), checks };
}

export type HealthReport = ReturnType<typeof assessHealth>;

// What the jobs in this process report. There is one API process, as the Telegram bot requires.
let jobsStartedAt: Date | null = null;
let lastWorkerRunAt: Date | null = null;
let telegramContactAt: Date | null = null;
const undelivered = new Map<string, { since: Date; reportedAt: Date }>();

export function noteJobsStarted(at = new Date()): void {
  jobsStartedAt = at;
  lastWorkerRunAt = null;
}

/** Only a run the queue made counts: the fallback in jobs/index.ts proves nothing about the queue. */
export function noteWorkerRun(at = new Date()): void {
  lastWorkerRunAt = at;
}

/** The oldest urgent alert on a farm that reached nobody, from each dispatch. */
export function noteUndelivered(farmId: string, since: Date | null, reportedAt = new Date()): void {
  if (since) undelivered.set(farmId, { since, reportedAt });
  else undelivered.delete(farmId);
}

/** A farm that stops reporting has left: its workspace was suspended. If dispatch has died, the worker check says so. */
function oldestUndelivered(now: Date): Date | null {
  const current = [...undelivered.values()].filter(({ reportedAt }) => now.getTime() - reportedAt.getTime() < WORKER_STALE_MS);
  return current.map(({ since }) => since).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

/** From the bot's polling, which talks to Telegram all day, so a dead channel shows before a fire does. */
export function noteTelegramContact(at = new Date()): void {
  telegramContactAt = at;
}

export const telegramLost = (now = new Date()): boolean => isTelegramLost(telegramContactAt, now);

let telegramCheck: (() => Promise<TelegramAnswer>) | null = null;
let lastAnswer: { at: number; bad: boolean; answer: Promise<TelegramAnswer> } | undefined;

/** Set by the bot, which owns the token: core imports no module. Polling alone needs five minutes to notice a dead token. */
export function setTelegramCheck(check: (() => Promise<TelegramAnswer>) | null): void {
  telegramCheck = check;
  lastAnswer = undefined;
}

function askTelegram(): Promise<TelegramAnswer | null> {
  if (!telegramCheck) return Promise.resolve(null);
  const now = Date.now();
  if (!lastAnswer || now - lastAnswer.at >= (lastAnswer.bad ? TELEGRAM_RECHECK_MS : TELEGRAM_CHECK_MS)) {
    const asked = { at: now, bad: false, answer: telegramCheck().catch(() => 'unreachable' as const) };
    void asked.answer.then((answer) => {
      asked.bad = answer !== 'ok';
    });
    lastAnswer = asked;
  }
  return lastAnswer.answer;
}

function within<T>(probe: Promise<T>, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS);
  });
  return Promise.race([probe.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

export const databaseAnswers = (): Promise<boolean> =>
  within(
    healthPool.query('select 1').then(() => true),
    false,
  );

/** A connection of its own: the queue's waits for ever when Redis is away. Redis also refuses PING when it cannot write to disk. */
async function redisPing(): Promise<boolean> {
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: PROBE_TIMEOUT_MS,
    commandTimeout: PROBE_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    enableReadyCheck: false,
    retryStrategy: () => null,
  });
  redis.on('error', () => {});
  try {
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } finally {
    redis.disconnect();
  }
}

/** Measured where the files go. On one server that is the same disk as the database and Redis. */
async function diskUsedPercent(): Promise<number> {
  const directory = config.STORAGE_DRIVER === 'local' ? config.STORAGE_DIR : '.';
  const { blocks, bfree, bavail } = await statfs(directory).catch(() => statfs('.'));
  const used = blocks - bfree;
  return Math.round((used / (used + bavail)) * 100);
}

async function collectFacts(): Promise<HealthFacts> {
  const [database, redis, disk, telegramGetMe] = await Promise.all([
    databaseAnswers(),
    within(redisPing(), false),
    within<number | null>(diskUsedPercent(), null),
    // A slow answer is no answer yet: the question stays open, and the next report has it.
    within<TelegramAnswer | null>(askTelegram(), null),
  ]);
  return {
    database,
    redis,
    jobsStartedAt,
    lastWorkerRunAt,
    oldestUndeliveredAt: oldestUndelivered(new Date()),
    telegramContactAt,
    telegramGetMe,
    diskUsedPercent: disk,
  };
}

let latest: { at: number; report: Promise<HealthReport> } | undefined;

export function deepHealth(options: { fresh?: boolean } = {}): Promise<HealthReport> {
  if (latest && !options.fresh && Date.now() - latest.at < CACHE_MS) return latest.report;
  const report = collectFacts().then((facts) => assessHealth(facts, new Date()));
  latest = { at: Date.now(), report };
  return report;
}

async function pingOutside(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`The heartbeat service answered ${response.status}`);
}

type HealthLog = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

/**
 * One tick of the watch. A change in the deep check goes to the log, and that is all without a
 * HEARTBEAT_URL. With one, the ping goes out only while the check passes, so an outside service raises
 * the alarm when the server, a worker or delivery dies: nothing here can report its own death. It
 * carries no farm data, and its address may hold a secret, so that stays out of the log.
 */
export function heartbeatTick(log: HealthLog, url = config.HEARTBEAT_URL) {
  let failing: string[] = [];
  let complainedAt = 0;
  return async (): Promise<void> => {
    const report = await deepHealth({ fresh: true });
    if (report.failing.join() !== failing.join()) {
      if (report.status === 'ok') log.info('deep health check passes again');
      else log.error({ failing: report.failing }, 'deep health check is failing');
      failing = report.failing;
    }
    if (report.status !== 'ok' || !url) return;
    try {
      await pingOutside(url);
    } catch {
      if (Date.now() - complainedAt < PING_COMPLAINT_INTERVAL_MS) return;
      complainedAt = Date.now();
      log.warn('the heartbeat did not reach its monitoring service');
    }
  };
}

export function watchHealth(log: HealthLog): () => void {
  const tick = heartbeatTick(log);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tick()
      .catch((err) => log.error({ err }, 'the deep health check could not run'))
      .finally(() => {
        busy = false;
      });
  }, WATCH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
