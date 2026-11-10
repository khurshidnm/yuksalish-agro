import { setTimeout as sleep } from 'node:timers/promises';
import { Queue, Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { MODULES, DEFAULT_TIMEZONE } from '@yap/shared';
import { config } from '../config';
import { schema } from '../db/client';
import { withPlatform, withTenant, type Identity } from '../core/context';
import { noteJobsStarted, noteWorkerRun, watchHealth } from '../core/health';
import { mergeSettings } from '../core/settings';
import { jobs as aiJobs } from '../modules/ai/jobs';
import { jobs as alertJobs } from '../modules/alerts/jobs';
import { jobs as assetJobs } from '../modules/assets/jobs';
import { jobs as deviceJobs } from '../modules/devices/jobs';
import { jobs as farmJobs } from '../modules/farm/jobs';
import { jobs as notificationJobs } from '../modules/notifications/jobs';
import { jobs as reportJobs } from '../modules/reports/jobs';
import { jobs as salesJobs } from '../modules/sales/jobs';
import { jobs as settingsJobs } from '../modules/settings/jobs';
import { jobs as taskJobs } from '../modules/tasks/jobs';
import { jobs as trackingJobs } from '../modules/tracking/jobs';
import { CATCH_UP_MS, markDone, markSkipped, missedRuns, owed, tracked } from './catch-up';
import { periodMs, scheduleProblem } from './schedule';
import type { ScheduledJob } from './types';

const { farms, tenants } = schema;

export const ALL_JOBS: ScheduledJob[] = [
  ...farmJobs,
  ...taskJobs,
  ...alertJobs,
  ...notificationJobs,
  ...assetJobs,
  ...reportJobs,
  ...salesJobs,
  ...aiJobs,
  ...deviceJobs,
  ...trackingJobs,
  ...settingsJobs,
];

/**
 * These reach people about a fire or a sick flock, so they have a worker of their own: jobs that
 * wait on the model can fill every slot of the shared one for minutes.
 */
const URGENT_JOBS = new Set(['alerts.evaluate', 'alerts.repeat-urgent', 'notifications.dispatch']);

/** The one job that shows the queue is alive: it runs every minute, and alerts leave through it. */
const WATCHED_JOB = 'notifications.dispatch';

/**
 * Two of these run every minute for ever, and a finished job stays in Redis unless it is told not to.
 * Kept ones also hold on to their time slot: if the clock steps back over it, the slot is refused and
 * the schedule stops there. Failures reach the log, so nothing reads them here.
 */
const RETENTION = { removeOnComplete: true, removeOnFail: true };

/** Commands wait for Redis by themselves, so this only paces a start Redis refused outright. */
const START_RETRY_MS = 1_000;
/** A connection that keeps failing reports it several times a second. */
const COMPLAINT_INTERVAL_MS = 60_000;
/** How often the schedules are checked, overdue runs looked for, and urgent jobs vouched for. */
const CHECK_INTERVAL_MS = 60_000;
/** An urgent job this far past its period has not been run by the queue, for whatever reason. */
const URGENT_MARGIN_MS = 60_000;
/** Longest wait between attempts at a run that keeps failing, in minutes. */
const MAX_RETRY_MINUTES = 60;

/** Every permission, for code running as the system. */
const SYSTEM_PERMISSIONS = MODULES.flatMap((m) =>
  ['view', 'create', 'update', 'approve', 'delete'].map((a) => `${m}.${a}`),
);

export async function activeFarms(): Promise<Identity[]> {
  const rows = await withPlatform((trx) =>
    trx
      .select({
        tenantId: tenants.id,
        farmId: farms.id,
        settings: tenants.settings,
        currency: tenants.currency,
        timezone: tenants.timezone,
      })
      .from(farms)
      .innerJoin(tenants, eq(tenants.id, farms.tenantId))
      .where(eq(tenants.status, 'active')),
  );
  return rows.map((row) => ({
    userId: null,
    tenantId: row.tenantId,
    farmId: row.farmId,
    source: 'system',
    permissions: SYSTEM_PERMISSIONS,
    settings: mergeSettings(row.settings),
    currency: row.currency,
    timezone: row.timezone,
  }));
}

/** Run `fn` once per active farm. One farm failing does not stop the others, and it fails the run. */
export async function forEachFarm(fn: (farm: Identity) => Promise<void>, onError?: (err: unknown, farm: Identity) => void): Promise<void> {
  const farms = await activeFarms();
  let failed = 0;
  for (const farm of farms) {
    try {
      await fn(farm);
    } catch (err) {
      failed += 1;
      onError?.(err, farm);
    }
  }
  if (failed > 0) throw new Error(`Failed on ${failed} of ${farms.length} farms`);
}

/** A detached run records itself in two short transactions, around the work. */
async function runOnFarm(job: ScheduledJob, farm: Identity, now: Date): Promise<void> {
  if ('runDetached' in job) {
    if (tracked(job) && !(await withTenant(farm, () => owed(job, now)))) return;
    await job.runDetached(farm);
    if (tracked(job)) await withTenant(farm, () => markDone(job, now));
    return;
  }
  await withTenant(farm, async () => {
    if (tracked(job) && !(await owed(job, now))) return;
    await job.run();
    if (tracked(job)) await markDone(job, now);
  });
}

type JobLog = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

/** Everything that runs jobs: the queue, and what makes up for it when it does not. */
export function createRunner(log: JobLog, jobs: ScheduledJob[] = ALL_JOBS) {
  const startedAt = Date.now();
  const running = new Set<string>();
  const lastRun = new Map<string, number>();
  const retries = new Map<string, { count: number; notBefore: number }>();

  /** The same job twice at once gains nothing, and the second would wait on the first one's rows. */
  const exclusively = async (job: ScheduledJob, fn: () => Promise<void>): Promise<boolean> => {
    if (running.has(job.name)) return false;
    running.add(job.name);
    try {
      await fn();
      return true;
    } finally {
      running.delete(job.name);
    }
  };

  /** One run on every farm. It throws if a farm failed, so the queue counts it as failed. */
  const runEverywhere = (job: ScheduledJob, now = new Date()) =>
    exclusively(job, async () => {
      await forEachFarm(
        (farm) => runOnFarm(job, farm, now),
        (err, farm) => log.error({ err, job: job.name, farmId: farm.farmId }, 'job failed for farm'),
      );
      lastRun.set(job.name, now.getTime());
    });

  /** Fire alerts must not depend on anything Redis holds, so these run here when the queue does not. */
  const runStaleUrgent = async (now = new Date()) => {
    for (const job of jobs.filter((candidate) => URGENT_JOBS.has(candidate.name))) {
      const last = lastRun.get(job.name) ?? startedAt;
      if (now.getTime() - last < periodMs(job.cron, now) + URGENT_MARGIN_MS) continue;
      log.warn({ job: job.name }, 'the queue has not run this job on time, so it runs outside the queue');
      await runEverywhere(job, now);
    }
  };

  /** Runs owed from an outage or a failure, each retried with growing waits until it is too late. */
  const runMissed = async (now = new Date()) => {
    for (const farm of await activeFarms()) {
      for (const { job, dueAt } of await withTenant(farm, () => missedRuns(jobs, now))) {
        const key = `${job.name}:${farm.farmId}`;
        const retry = retries.get(key);
        if (retry && retry.notBefore > now.getTime()) continue;
        const context = { job: job.name, farmId: farm.farmId, dueAt };
        if (now.getTime() - dueAt.getTime() > CATCH_UP_MS[job.name]) {
          await withTenant(farm, () => markSkipped(job, now));
          retries.delete(key);
          log.warn(context, 'a run missed in an outage is skipped, because it is too late to be useful');
          continue;
        }
        try {
          if (!(await exclusively(job, () => runOnFarm(job, farm, now)))) continue;
          retries.delete(key);
          log.info(context, 'a run missed in an outage has caught up');
        } catch (err) {
          const count = (retry?.count ?? 0) + 1;
          retries.set(key, { count, notBefore: now.getTime() + Math.min(2 ** count, MAX_RETRY_MINUTES) * 60_000 });
          log.error({ ...context, err }, 'catching up a missed run failed, and it will be tried again');
        }
      }
    }
  };

  return { runEverywhere, runStaleUrgent, runMissed };
}

/**
 * Returns at once and keeps trying in the background: the API and the bot must not wait for Redis.
 * Only what the queues run pauses until it answers, and the returned function stops either way.
 */
export function startJobs(log: FastifyBaseLogger): () => Promise<void> {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue('yap', { connection });
  const urgentQueue = new Queue('yap-urgent', { connection });
  const workers: Worker[] = [];
  const stopping = new AbortController();
  const runner = createRunner(log);
  noteJobsStarted();

  const complaints = new Map<string, number>();
  const complainOf = (problem: string) => (err: Error) => {
    if (Date.now() - (complaints.get(problem) ?? 0) < COMPLAINT_INTERVAL_MS) return;
    complaints.set(problem, Date.now());
    log.error({ err }, problem);
  };
  const complain = complainOf('background jobs cannot reach Redis: alerts wait in the outbox and scheduled work is paused');
  for (const source of [connection, queue, urgentQueue]) source.on('error', complain);

  const run = async (bull: Job) => {
    const job = ALL_JOBS.find((j) => j.name === bull.name);
    if (!job) return;
    await runner.runEverywhere(job);
    if (job.name === WATCHED_JOB) noteWorkerRun();
  };

  const queueFor = (job: ScheduledJob) => (URGENT_JOBS.has(job.name) ? urgentQueue : queue);
  const upsert = (job: ScheduledJob) =>
    queueFor(job).upsertJobScheduler(job.name, { pattern: job.cron, tz: DEFAULT_TIMEZONE }, { name: job.name, opts: RETENTION });
  const urgentFirst = [...ALL_JOBS].sort((a, b) => Number(URGENT_JOBS.has(b.name)) - Number(URGENT_JOBS.has(a.name)));

  const schedule = async () => {
    for (const job of urgentFirst) {
      await upsert(job);
      // A scheduler stays in Redis until removed, so one from before the split would keep firing on the old queue.
      if (URGENT_JOBS.has(job.name)) await queue.removeJobScheduler(job.name);
    }
  };

  let scheduled = false;
  /** Redis can lose all of this with the API still up, and nothing else would ever write it back. */
  const heal = async () => {
    if (!scheduled || connection.status !== 'ready') return;
    const repaired: { job: string; problem: string }[] = [];
    for (const job of urgentFirst) {
      const problem = await scheduleProblem(queueFor(job), job, new Date());
      if (!problem) continue;
      await upsert(job);
      repaired.push({ job: job.name, problem });
    }
    if (repaired.length > 0) log.warn({ repaired }, 'job schedules in Redis were lost or stale, and are repaired');
  };
  connection.on('ready', () => void heal().catch(complain));

  /** Each on its own, so that a long catch-up cannot hold up a fire alert. */
  const every = (fn: () => Promise<void>, problem: string) => {
    let busy = false;
    const onFailure = complainOf(problem);
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void fn()
        .catch(onFailure)
        .finally(() => {
          busy = false;
        });
    }, CHECK_INTERVAL_MS);
    timer.unref();
    return timer;
  };
  const timers = [
    every(heal, 'job schedules could not be checked'),
    every(() => runner.runStaleUrgent(), 'urgent jobs could not run outside the queue'),
    every(() => runner.runMissed(), 'missed runs could not be looked for'),
  ];
  const stopWatching = watchHealth(log);

  const start = async () => {
    for (;;) {
      try {
        await schedule();
        break;
      } catch (err) {
        if (stopping.signal.aborted) return;
        complain(err as Error);
        await sleep(START_RETRY_MS, undefined, { signal: stopping.signal }).catch(() => {});
      }
    }
    if (stopping.signal.aborted) return;
    scheduled = true;
    workers.push(
      new Worker('yap', run, { connection, concurrency: 2 }),
      new Worker('yap-urgent', run, { connection, concurrency: URGENT_JOBS.size }),
    );
    for (const worker of workers) {
      worker.on('failed', (bull, err) => log.error({ err, job: bull?.name }, 'job failed'));
      worker.on('error', complain);
    }
    log.info({ jobs: ALL_JOBS.map((j) => j.name) }, 'background jobs scheduled');
  };
  void start();

  return async () => {
    stopping.abort();
    for (const timer of timers) clearInterval(timer);
    stopWatching();
    // With Redis gone a polite close waits for an answer that never comes.
    const force = connection.status !== 'ready';
    await Promise.all(workers.map((worker) => worker.close(force)));
    await Promise.all([queue.close(), urgentQueue.close()]);
    // Not awaiting the start: commands waiting for a Redis that never came would hold this up for good.
    connection.disconnect();
  };
}
