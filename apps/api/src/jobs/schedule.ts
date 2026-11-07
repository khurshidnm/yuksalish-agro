import { getNextMillis, type Queue } from 'bullmq';
import { DEFAULT_TIMEZONE } from '@yap/shared';
import type { ScheduledJob } from './types';

export const nextRun = (cron: string, after: Date): Date =>
  new Date(getNextMillis(after.getTime(), { pattern: cron, tz: DEFAULT_TIMEZONE })!);

/** The time between the next two runs, which is all a cron says about how often it fires. */
export function periodMs(cron: string, at: Date): number {
  const next = nextRun(cron, at);
  return nextRun(cron, next).getTime() - next.getTime();
}

/** Its run should have started by now, unless a job says otherwise. */
const OVERDUE_MS = 30_000;

/** A run still on its way. A finished one, or none, means no worker will ever make the next. */
const ON_ITS_WAY = new Set(['delayed', 'waiting', 'prioritized', 'active']);

export type ScheduleProblem = 'missing' | 'changed' | 'clock' | 'stopped';

/**
 * What Redis holds against what the job says. The schedule lives only there and every run makes the
 * next one, so a lost run, or a next run left in the future by a clock that stepped back, stops the
 * job for good with no sign anywhere. Nothing is rewritten while it is healthy: that would move a run
 * that is due right now to its next time.
 */
export async function scheduleProblem(
  queue: Pick<Queue, 'getJobScheduler' | 'getJobState'>,
  job: ScheduledJob,
  now: Date,
): Promise<ScheduleProblem | null> {
  const stored = await queue.getJobScheduler(job.name);
  if (!stored?.next) return 'missing';
  if (stored.pattern !== job.cron) return 'changed';
  if (stored.next > nextRun(job.cron, now).getTime()) return 'clock';
  if (stored.next < now.getTime() - OVERDUE_MS) {
    const state = await queue.getJobState(`repeat:${job.name}:${stored.next}`);
    if (!ON_ITS_WAY.has(state)) return 'stopped';
  }
  return null;
}
