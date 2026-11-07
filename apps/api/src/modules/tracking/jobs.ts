import { ctx } from '../../core/context';
import type { FarmJob } from '../../jobs/types';
import { evaluateHealth, releaseExited, summarizeDays } from './health.service';

/** Two runs missed, or none yet: the server has been away. */
const GAP_MS = 25 * 60_000;

const lastRunAt = new Map<string, number>();

/**
 * After an outage every tracker looks silent, but the silence was the server's: the network server
 * posted and nobody answered. That run judges health but leaves silence until the next one.
 */
export async function healthCheck(now = new Date()) {
  const { farmId } = ctx();
  const last = lastRunAt.get(farmId);
  lastRunAt.set(farmId, now.getTime());
  return evaluateHealth(now, last !== undefined && now.getTime() - last < GAP_MS);
}

/** Wired in jobs/index.ts next to the other modules' jobs. */
export const jobs: FarmJob[] = [
  { name: 'tracking.health', cron: '*/10 * * * *', run: async () => void (await healthCheck()) },
  {
    name: 'tracking.daily',
    cron: '20 0 * * *',
    run: async () => {
      await releaseExited();
      await summarizeDays();
    },
  },
];
