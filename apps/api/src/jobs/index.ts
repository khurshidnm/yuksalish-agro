import { setTimeout as sleep } from 'node:timers/promises';
import { Queue, Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { MODULES, DEFAULT_TIMEZONE } from '@yap/shared';
import { config } from '../config';
import { schema } from '../db/client';
import { withPlatform, withTenant } from '../core/context';
import { mergeSettings } from '../core/settings';
import { jobs as aiJobs } from '../modules/ai/jobs';
import { jobs as alertJobs } from '../modules/alerts/jobs';
import { jobs as assetJobs } from '../modules/assets/jobs';
import { jobs as deviceJobs } from '../modules/devices/jobs';
import { jobs as farmJobs } from '../modules/farm/jobs';
import { jobs as notificationJobs } from '../modules/notifications/jobs';
import { jobs as reportJobs } from '../modules/reports/jobs';
import { jobs as settingsJobs } from '../modules/settings/jobs';
import { jobs as taskJobs } from '../modules/tasks/jobs';
import type { FarmJob } from './types';

const { farms, tenants } = schema;

export const ALL_JOBS: FarmJob[] = [
  ...farmJobs,
  ...taskJobs,
  ...alertJobs,
  ...notificationJobs,
  ...assetJobs,
  ...reportJobs,
  ...aiJobs,
  ...deviceJobs,
  ...settingsJobs,
];

/**
 * These reach people about a fire or a sick flock, so they have a worker of their own: jobs that
 * wait on the model can fill every slot of the shared one for minutes.
 */
const URGENT_JOBS = new Set(['alerts.evaluate', 'alerts.repeat-urgent', 'notifications.dispatch']);

/** Two of these run every minute for ever, and a finished job stays in Redis unless it is told not to. */
const RETENTION = { removeOnComplete: { count: 200 }, removeOnFail: { count: 1000 } };

/** Commands wait for Redis by themselves, so this only paces a start Redis refused outright. */
const START_RETRY_MS = 1_000;
/** A connection that keeps failing reports it several times a second. */
const COMPLAINT_INTERVAL_MS = 60_000;

/** Every permission, for code running as the system. */
const SYSTEM_PERMISSIONS = MODULES.flatMap((m) =>
  ['view', 'create', 'update', 'approve', 'delete'].map((a) => `${m}.${a}`),
);

/** Run `fn` once per active farm. One farm failing does not stop the others. */
export async function forEachFarm(fn: () => Promise<void>, onError?: (err: unknown) => void): Promise<void> {
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
  for (const row of rows) {
    try {
      await withTenant(
        {
          userId: null,
          tenantId: row.tenantId,
          farmId: row.farmId,
          source: 'system',
          permissions: SYSTEM_PERMISSIONS,
          settings: mergeSettings(row.settings),
          currency: row.currency,
          timezone: row.timezone,
        },
        fn,
      );
    } catch (err) {
      onError?.(err);
    }
  }
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

  let complainedAt = 0;
  const complain = (err: Error) => {
    if (Date.now() - complainedAt < COMPLAINT_INTERVAL_MS) return;
    complainedAt = Date.now();
    log.error({ err }, 'background jobs cannot reach Redis: alerts wait in the outbox and scheduled work is paused');
  };
  for (const source of [connection, queue, urgentQueue]) source.on('error', complain);

  const run = async (bull: Job) => {
    const job = ALL_JOBS.find((j) => j.name === bull.name);
    if (!job) return;
    await forEachFarm(job.run, (err) => log.error({ err, job: job.name }, 'job failed for farm'));
  };

  const schedule = async () => {
    for (const job of ALL_JOBS) {
      const urgent = URGENT_JOBS.has(job.name);
      await (urgent ? urgentQueue : queue).upsertJobScheduler(job.name, { pattern: job.cron, tz: DEFAULT_TIMEZONE }, { name: job.name, opts: RETENTION });
      // A scheduler stays in Redis until removed, so one from before the split would keep firing on the old queue.
      if (urgent) await queue.removeJobScheduler(job.name);
    }
  };

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
    // With Redis gone a polite close waits for an answer that never comes.
    const force = connection.status !== 'ready';
    await Promise.all(workers.map((worker) => worker.close(force)));
    await Promise.all([queue.close(), urgentQueue.close()]);
    // Not awaiting the start: commands waiting for a Redis that never came would hold this up for good.
    connection.disconnect();
  };
}
