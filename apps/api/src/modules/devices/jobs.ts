import { ctx } from '../../core/context';
import type { FarmJob } from '../../jobs/types';
import { detectOffline } from './devices.service';

/** Two runs missed, or none yet: the server has been away. */
const GAP_MS = 12 * 60_000;

const lastCheckAt = new Map<string, number>();

/**
 * After an outage every device looks silent, but the silence was the server's: their signals were
 * refused. This run only starts the clock, so that one outage is not an alert for every camera.
 */
export async function offlineCheck(now = new Date()): Promise<void> {
  const { farmId } = ctx();
  const last = lastCheckAt.get(farmId);
  lastCheckAt.set(farmId, now.getTime());
  if (last !== undefined && now.getTime() - last < GAP_MS) await detectOffline(now);
  else console.info(`[devices] offline check skipped on farm ${farmId}: devices get time to report after the server was away`);
}

/** Wired in jobs/index.ts next to the other modules' jobs. */
export const jobs: FarmJob[] = [{ name: 'devices.offline-check', cron: '*/5 * * * *', run: () => offlineCheck() }];
