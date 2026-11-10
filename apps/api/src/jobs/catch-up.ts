/**
 * A scheduled run that falls inside an outage. Starting the queue moves a run that came due while the
 * API was away to its next time, and a run that failed is not retried, so job_runs keeps what each
 * farm is owed in Postgres, which outlives both Redis and the API.
 */
import { and, eq } from 'drizzle-orm';
import { ctx, tx } from '../core/context';
import { schema } from '../db/client';
import { nextRun } from './schedule';
import type { ScheduledJob } from './types';

const { jobRuns } = schema;

const HOUR = 3_600_000;

/** Works from current state and takes care of itself if run twice, so late is better than never. */
const ANY_TIME = Number.POSITIVE_INFINITY;

/**
 * How long after its time a missed run may still happen. Past that it is skipped with a log line,
 * because it would say the wrong thing. Jobs left out run at least hourly from current state, so their
 * next run does the same work.
 */
export const CATCH_UP_MS: Record<string, number> = {
  'tasks.generate-recurring': ANY_TIME,
  'farm.weather': ANY_TIME,
  // It reads only scenes it has not read yet, so a late run loses nothing.
  'farm.satellite': ANY_TIME,
  'notifications.forget-answered': ANY_TIME,
  'settings.retention': ANY_TIME,
  // It fills each animal's missing days and frees trackers of animals that left: late loses nothing.
  'tracking.daily': ANY_TIME,
  // It ends every hold whose last day has passed, whenever it runs.
  'sales.expire-reservations': ANY_TIME,
  'ai-statistics': ANY_TIME,
  'assets.monthly-depreciation': ANY_TIME,
  'reports.investor-monthly': ANY_TIME,
  'ai-summary-monthly': ANY_TIME,
  // The morning summary is old news after noon.
  'notifications.daily-summary': 5 * HOUR,
  // A saved report's schedule is read against today, so it must stay the same day.
  'reports.scheduled-delivery': 10 * HOUR,
  // It adds up "today", and past midnight that is the wrong day.
  'ai-evening-recap': 3 * HOUR,
  'ai-summary-weekly': 48 * HOUR,
};

/** The queue gets this long to run a job on time before the run counts as missed. */
export const MISSED_AFTER_MS = 2 * 60_000;

export const tracked = (job: ScheduledJob): boolean => job.name in CATCH_UP_MS;

const ownRow = (job: ScheduledJob) => and(eq(jobRuns.farmId, ctx().farmId), eq(jobRuns.job, job.name));

/**
 * Whether this farm still owes the run that is due now. The row stays locked until the transaction
 * ends, so a second runner waits and then finds it done. A next time beyond the one after next was
 * left by a clock that ran ahead, and must not hold the job back until the clock gets there.
 */
export async function owed(job: ScheduledJob, now: Date): Promise<boolean> {
  const c = ctx();
  await tx().insert(jobRuns).values({ tenantId: c.tenantId, farmId: c.farmId, job: job.name, nextDueAt: now }).onConflictDoNothing();
  const [row] = await tx().select({ nextDueAt: jobRuns.nextDueAt }).from(jobRuns).where(ownRow(job)).for('update');
  return row.nextDueAt <= now || row.nextDueAt > nextRun(job.cron, nextRun(job.cron, now));
}

export async function markDone(job: ScheduledJob, now: Date): Promise<void> {
  await tx().update(jobRuns).set({ nextDueAt: nextRun(job.cron, now), lastRunAt: now }).where(ownRow(job));
}

export async function markSkipped(job: ScheduledJob, now: Date): Promise<void> {
  await tx().update(jobRuns).set({ nextDueAt: nextRun(job.cron, now) }).where(ownRow(job));
}

/** Runs this farm is owed. A job never seen on it owes nothing yet, and starts counting from now. */
export async function missedRuns(jobs: ScheduledJob[], now: Date): Promise<{ job: ScheduledJob; dueAt: Date }[]> {
  const c = ctx();
  const rows = await tx().select({ job: jobRuns.job, nextDueAt: jobRuns.nextDueAt }).from(jobRuns).where(eq(jobRuns.farmId, c.farmId));
  const dueAt = new Map(rows.map((row) => [row.job, row.nextDueAt]));
  const missed: { job: ScheduledJob; dueAt: Date }[] = [];
  for (const job of jobs.filter(tracked)) {
    const due = dueAt.get(job.name);
    if (!due) {
      await tx().insert(jobRuns).values({ tenantId: c.tenantId, farmId: c.farmId, job: job.name, nextDueAt: nextRun(job.cron, now) }).onConflictDoNothing();
    } else if (now.getTime() - due.getTime() >= MISSED_AFTER_MS) {
      missed.push({ job, dueAt: due });
    }
  }
  return missed;
}
