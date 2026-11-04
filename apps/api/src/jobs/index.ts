import { Queue, Worker } from 'bullmq';
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

export async function startJobs(log: FastifyBaseLogger): Promise<() => Promise<void>> {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue('yap', { connection });
  for (const job of ALL_JOBS) {
    await queue.upsertJobScheduler(job.name, { pattern: job.cron, tz: DEFAULT_TIMEZONE }, { name: job.name });
  }
  const worker = new Worker(
    'yap',
    async (bull) => {
      const job = ALL_JOBS.find((j) => j.name === bull.name);
      if (!job) return;
      await forEachFarm(job.run, (err) => log.error({ err, job: job.name }, 'job failed for farm'));
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (bull, err) => log.error({ err, job: bull?.name }, 'job failed'));
  log.info({ jobs: ALL_JOBS.map((j) => j.name) }, 'background jobs scheduled');
  return async () => {
    await worker.close();
    await queue.close();
    connection.disconnect();
  };
}
