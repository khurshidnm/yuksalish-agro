import type { Identity } from '../core/context';

interface Scheduled {
  name: string;
  /** Cron in the farm's business time zone (Asia/Tashkent). */
  cron: string;
}

/** Runs once per farm, inside withTenant() with a system identity. */
export interface FarmJob extends Scheduled {
  run: () => Promise<void>;
}

/** The same outside any transaction, for work that waits on something slow: each database step goes in withTenant(farm). */
export interface DetachedJob extends Scheduled {
  runDetached: (farm: Identity) => Promise<void>;
}

export type ScheduledJob = FarmJob | DetachedJob;
