import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db/client';
import { ctx, tx } from '../src/core/context';
import { ALL_JOBS, createRunner, forEachFarm, startJobs } from '../src/jobs';
import { CATCH_UP_MS, MISSED_AFTER_MS } from '../src/jobs/catch-up';
import { nextRun, periodMs, scheduleProblem } from '../src/jobs/schedule';
import type { ScheduledJob } from '../src/jobs/types';
import { setProvider } from '../src/modules/ai/provider';
import { createFixture, type Fixture } from './helpers';

/** Redis as far as the scheduler needs one: it can be emptied, and it can hold a stale time. */
const redis = vi.hoisted(() => ({
  schedulers: new Map<string, { next: number; pattern: string }>(),
  states: new Map<string, string>(),
  upserts: [] as string[],
  status: 'ready',
  handlers: new Map<string, () => void>(),
  reset() {
    this.schedulers.clear();
    this.states.clear();
    this.upserts = [];
    this.status = 'ready';
    this.handlers.clear();
  },
}));

vi.mock('ioredis', () => ({
  Redis: class {
    on(event: string, handler: () => void) {
      redis.handlers.set(event, handler);
    }
    disconnect() {}
    get status() {
      return redis.status;
    }
  },
}));
vi.mock('bullmq', async (importOriginal) => {
  const real = await importOriginal<typeof import('bullmq')>();
  return {
    ...real,
    Queue: class {
      constructor(readonly name: string) {}
      on() {}
      async close() {}
      async upsertJobScheduler(job: string, repeat: { pattern: string; tz: string }) {
        redis.upserts.push(job);
        redis.schedulers.set(`${this.name}:${job}`, { next: real.getNextMillis(Date.now(), repeat)!, pattern: repeat.pattern });
      }
      async removeJobScheduler() {}
      async getJobScheduler(job: string) {
        return redis.schedulers.get(`${this.name}:${job}`);
      }
      async getJobState(id: string) {
        return redis.states.get(id) ?? 'unknown';
      }
    },
    Worker: class {
      on() {}
      async close() {}
    },
  };
});

const { jobRuns, notifications } = schema;

const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A stand-in for a real job, counting its runs on one farm only. */
function fake(name: string, cron: string, run: () => Promise<void> = async () => {}, farmId?: string) {
  const runs: string[] = [];
  const job: ScheduledJob = {
    name,
    cron,
    run: async () => {
      if (farmId && ctx().farmId !== farmId) return;
      runs.push(ctx().farmId);
      await run();
    },
  };
  return { job, runs };
}

const setDue = (f: Fixture, job: string, nextDueAt: Date) =>
  f.run(() =>
    tx()
      .insert(jobRuns)
      .values({ tenantId: f.tenantId, farmId: f.farmId, job, nextDueAt })
      .onConflictDoUpdate({ target: [jobRuns.farmId, jobRuns.job], set: { nextDueAt } }),
  );

const dueOn = async (f: Fixture, job: string) => {
  const [row] = await f.run(() =>
    tx().select().from(jobRuns).where(and(eq(jobRuns.farmId, f.farmId), eq(jobRuns.job, job))),
  );
  return row;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  redis.reset();
});

describe('what a job schedule in Redis can look like', () => {
  const job: ScheduledJob = { name: 'notifications.dispatch', cron: '* * * * *', run: async () => {} };
  const now = new Date('2026-11-10T04:00:30Z');
  const next = nextRun(job.cron, now).getTime();
  const queue = (stored: { next?: number; pattern?: string } | undefined, state = 'unknown') => ({
    getJobScheduler: async () => stored as never,
    getJobState: async () => state as never,
  });

  it('is left alone while it is healthy, because rewriting it would move a run that is due now', async () => {
    expect(await scheduleProblem(queue({ next, pattern: job.cron }), job, now)).toBeNull();
  });

  it('is gone after Redis lost its data', async () => {
    expect(await scheduleProblem(queue(undefined), job, now)).toBe('missing');
  });

  it('holds an old cron after a new version changed it', async () => {
    expect(await scheduleProblem(queue({ next, pattern: '*/5 * * * *' }), job, now)).toBe('changed');
  });

  it('points past the next run after the clock stepped back, which would stop it for that long', async () => {
    expect(await scheduleProblem(queue({ next: next + 2 * 3_600_000, pattern: job.cron }), job, now)).toBe('clock');
  });

  it('is overdue with no run on its way, so no worker can ever make the next one', async () => {
    const overdue = now.getTime() - 5 * 60_000;
    expect(await scheduleProblem(queue({ next: overdue, pattern: job.cron }), job, now)).toBe('stopped');
    expect(await scheduleProblem(queue({ next: overdue, pattern: job.cron }, 'completed'), job, now)).toBe('stopped');
  });

  it('a run still waiting for a free worker is not a problem, or replacing it would lose it', async () => {
    const overdue = now.getTime() - 5 * 60_000;
    for (const state of ['waiting', 'delayed', 'active', 'prioritized']) {
      expect(await scheduleProblem(queue({ next: overdue, pattern: job.cron }, state), job, now)).toBeNull();
    }
  });

  it('reads a cron in the farm time zone', () => {
    expect(nextRun('0 7 * * *', new Date('2026-11-10T02:30:00Z')).toISOString()).toBe('2026-11-11T02:00:00.000Z');
    expect(periodMs('*/5 * * * *', now)).toBe(5 * 60_000);
    expect(periodMs('0 7 * * *', now)).toBe(86_400_000);
  });
});

describe('schedules heal themselves', () => {
  const start = async (log = quietLog()) => {
    const stop = startJobs(log as unknown as FastifyBaseLogger);
    await vi.waitFor(() => expect(redis.upserts).toHaveLength(ALL_JOBS.length));
    redis.upserts = [];
    return { stop, log };
  };

  it('Redis coming back empty is repaired on its own, fire alerts first, and it is logged', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { stop, log } = await start();

    redis.schedulers.clear();
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(redis.upserts).toHaveLength(ALL_JOBS.length));

    expect(redis.upserts.slice(0, 3).sort()).toEqual(['alerts.evaluate', 'alerts.repeat-urgent', 'notifications.dispatch']);
    const [fields] = log.warn.mock.calls.find(([, line]) => /repaired/.test(line))!;
    expect(fields.repaired).toHaveLength(ALL_JOBS.length);
    expect(fields.repaired[0].problem).toBe('missing');
    await stop();
  });

  it('a reconnect does not wait for the next check', async () => {
    const { stop } = await start();

    redis.schedulers.clear();
    redis.handlers.get('ready')!();

    await vi.waitFor(() => expect(redis.upserts).toHaveLength(ALL_JOBS.length));
    await stop();
  });

  it('a clock that stepped back is noticed, and only what it broke is rewritten', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { stop, log } = await start();

    redis.schedulers.get('yap-urgent:notifications.dispatch')!.next += 2 * 3_600_000;
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(redis.upserts).toEqual(['notifications.dispatch']));

    const [fields] = log.warn.mock.calls.find(([, line]) => /repaired/.test(line))!;
    expect(fields.repaired).toEqual([{ job: 'notifications.dispatch', problem: 'clock' }]);
    await stop();
  });

  it('a healthy schedule is not touched, and Redis being away is not a repair', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { stop, log } = await start();

    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);
    redis.status = 'reconnecting';
    redis.schedulers.clear();
    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(redis.upserts).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
    await stop();
  });
});

describe('urgent jobs do not depend on the queue', () => {
  const dispatch = () => fake('notifications.dispatch', '* * * * *');

  it('run here once the queue has been silent past their period, on every farm', async () => {
    const f = await createFixture();
    const { job, runs } = dispatch();
    const log = quietLog();
    const runner = createRunner(log, [job]);

    await runner.runStaleUrgent(new Date(Date.now() + 90_000));
    expect(runs).toEqual([]);

    await runner.runStaleUrgent(new Date(Date.now() + 121_000));
    expect(runs).toContain(f.farmId);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('are left to the queue while it keeps running them', async () => {
    await createFixture();
    const { job, runs } = dispatch();
    const runner = createRunner(quietLog(), [job]);

    await runner.runEverywhere(job, new Date(Date.now() + 100_000));
    const before = runs.length;
    await runner.runStaleUrgent(new Date(Date.now() + 130_000));

    expect(runs).toHaveLength(before);
  });

  it('one that is still running is not started again', async () => {
    await createFixture();
    // Runs hold until released; once released, later farms' runs finish at once. Releasing them one
    // by one would take longer with every farm the other tests add to the shared database.
    let released = false;
    const waiting: (() => void)[] = [];
    const hold = () => (released ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve)));
    const { job, runs } = fake('notifications.dispatch', '* * * * *', hold);
    const runner = createRunner(quietLog(), [job]);

    const first = runner.runEverywhere(job);
    await vi.waitFor(() => expect(runs.length).toBeGreaterThan(0));
    const started = runs.length;
    expect(await runner.runEverywhere(job)).toBe(false);
    await runner.runStaleUrgent(new Date(Date.now() + 200_000));
    expect(runs).toHaveLength(started);

    released = true;
    for (const resolve of waiting.splice(0)) resolve();
    await first;
    // The first run still visits every farm in the database, and in a full run that can pass 30 seconds.
  }, 120_000);

  it('other jobs wait for the queue', async () => {
    await createFixture();
    const { job, runs } = fake('webhooks.dispatch', '* * * * *');
    const runner = createRunner(quietLog(), [job]);

    await runner.runStaleUrgent(new Date(Date.now() + 3_600_000));

    expect(runs).toEqual([]);
  });
});

describe('one farm failing', () => {
  it('does not stop the others, and the run still counts as failed', async () => {
    const f = await createFixture();
    const g = await createFixture();
    const reached: string[] = [];
    const log = quietLog();
    const { job } = fake('webhooks.dispatch', '* * * * *', async () => {
      reached.push(ctx().farmId);
      if (ctx().farmId === f.farmId) throw new Error('no such table');
    });

    await expect(createRunner(log, [job]).runEverywhere(job)).rejects.toThrow(/Failed on 1 of/);

    expect(reached).toContain(g.farmId);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0].farmId).toBe(f.farmId);
  });

  it('forEachFarm says how many failed', async () => {
    const f = await createFixture();
    await expect(
      forEachFarm(async (farm) => {
        if (farm.farmId === f.farmId) throw new Error('boom');
      }),
    ).rejects.toThrow(/Failed on 1 of \d+ farms/);
  });
});

describe('runs missed in an outage', () => {
  const summaryName = 'notifications.daily-summary';
  const at = (iso: string) => new Date(iso);

  it('every job slower than hourly says what happens to a missed run', () => {
    const now = new Date();
    const slow = ALL_JOBS.filter((job) => periodMs(job.cron, now) > 3_600_000).map((job) => job.name);
    expect(slow.sort()).toEqual(Object.keys(CATCH_UP_MS).sort());
  });

  it('a run that came due while the API was away happens after it comes back, once', async () => {
    const f = await createFixture();
    const { job, runs } = fake(summaryName, '0 7 * * *', undefined, f.farmId);
    await setDue(f, summaryName, at('2026-11-10T02:00:00Z'));
    const log = quietLog();
    const runner = createRunner(log, [job]);

    await runner.runMissed(at('2026-11-10T02:40:00Z'));
    await runner.runMissed(at('2026-11-10T02:41:00Z'));

    expect(runs).toEqual([f.farmId]);
    expect((await dueOn(f, summaryName)).nextDueAt).toEqual(at('2026-11-11T02:00:00Z'));
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ job: summaryName, farmId: f.farmId }), expect.stringMatching(/caught up/));
  });

  it('the queue gets the first chance at a run that has only just come due', async () => {
    const f = await createFixture();
    const { job, runs } = fake(summaryName, '0 7 * * *', undefined, f.farmId);
    await setDue(f, summaryName, at('2026-11-10T02:00:00Z'));

    await createRunner(quietLog(), [job]).runMissed(new Date(at('2026-11-10T02:00:00Z').getTime() + MISSED_AFTER_MS - 1_000));

    expect(runs).toEqual([]);
  });

  it('past its limit a run is skipped with a log line, and the next one stands', async () => {
    const f = await createFixture();
    const { job, runs } = fake(summaryName, '0 7 * * *', undefined, f.farmId);
    await setDue(f, summaryName, at('2026-11-10T02:00:00Z'));
    const log = quietLog();

    await createRunner(log, [job]).runMissed(at('2026-11-10T07:30:00Z'));

    expect(runs).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ job: summaryName, farmId: f.farmId }), expect.stringMatching(/skipped/));
    const row = await dueOn(f, summaryName);
    expect(row.nextDueAt).toEqual(at('2026-11-11T02:00:00Z'));
    expect(row.lastRunAt).toBeNull();
  });

  it('a job that works from current state catches up however late it is', async () => {
    const f = await createFixture();
    const { job, runs } = fake('reports.investor-monthly', '0 9 1 * *', undefined, f.farmId);
    await setDue(f, job.name, at('2026-11-01T04:00:00Z'));

    await createRunner(quietLog(), [job]).runMissed(at('2026-11-20T10:00:00Z'));

    expect(runs).toEqual([f.farmId]);
  });

  it('the evening recap never reaches the next day, because it adds up "today"', async () => {
    const f = await createFixture();
    const { job, runs } = fake('ai-evening-recap', '0 20 * * *', undefined, f.farmId);
    await setDue(f, job.name, at('2026-11-10T15:00:00Z'));

    await createRunner(quietLog(), [job]).runMissed(at('2026-11-10T19:30:00Z'));

    expect(runs).toEqual([]);
  });

  it('a run that fails is tried again with growing waits, and its work does not stay half done', async () => {
    const f = await createFixture();
    let attempts = 0;
    const { job, runs } = fake(
      summaryName,
      '0 7 * * *',
      async () => {
        attempts += 1;
        await tx().insert(notifications).values({ tenantId: f.tenantId, userId: (await f.as('owner')).userId, title: 'half done' });
        if (attempts < 3) throw new Error('getaddrinfo ENOTFOUND db');
      },
      f.farmId,
    );
    const due = at('2026-11-10T02:00:00Z');
    await setDue(f, summaryName, due);
    const log = quietLog();
    const runner = createRunner(log, [job]);
    const minutes = (n: number) => new Date(due.getTime() + n * 60_000);

    await runner.runMissed(minutes(3));
    expect(attempts).toBe(1);
    await runner.runMissed(minutes(4));
    expect(attempts).toBe(1);
    await runner.runMissed(minutes(5));
    expect(attempts).toBe(2);
    await runner.runMissed(minutes(8));
    expect(attempts).toBe(2);
    await runner.runMissed(minutes(9));
    expect(attempts).toBe(3);
    await runner.runMissed(minutes(30));
    expect(attempts).toBe(3);

    expect(runs).toHaveLength(3);
    expect(log.error).toHaveBeenCalledTimes(2);
    const written = await f.run(() => tx().select().from(notifications).where(eq(notifications.title, 'half done')));
    expect(written).toHaveLength(1);
  });

  it('the queue turning up late after a catch-up does not run it twice', async () => {
    const f = await createFixture();
    const { job, runs } = fake(summaryName, '0 7 * * *', undefined, f.farmId);
    await setDue(f, summaryName, at('2026-11-10T02:00:00Z'));
    const runner = createRunner(quietLog(), [job]);

    await runner.runMissed(at('2026-11-10T02:03:00Z'));
    await runner.runEverywhere(job, at('2026-11-10T02:05:00Z'));

    expect(runs).toEqual([f.farmId]);
  });

  it('a regular run counts, so nothing is owed afterwards', async () => {
    const f = await createFixture();
    const { job, runs } = fake(summaryName, '0 7 * * *', undefined, f.farmId);
    await setDue(f, summaryName, at('2026-11-10T02:00:00Z'));
    const runner = createRunner(quietLog(), [job]);

    await runner.runEverywhere(job, at('2026-11-10T02:00:01Z'));
    await runner.runMissed(at('2026-11-10T02:10:00Z'));

    expect(runs).toEqual([f.farmId]);
    expect((await dueOn(f, summaryName)).lastRunAt).toEqual(at('2026-11-10T02:00:01Z'));
  });

  it('a clock that stepped back over a run does not run it twice', async () => {
    const f = await createFixture();
    const { job, runs } = fake(summaryName, '0 7 * * *', undefined, f.farmId);
    await setDue(f, summaryName, at('2026-11-11T02:00:00Z'));

    await createRunner(quietLog(), [job]).runEverywhere(job, at('2026-11-10T02:00:01Z'));

    expect(runs).toEqual([]);
  });

  it('a clock that ran days ahead does not hold the job back until it gets there', async () => {
    const f = await createFixture();
    const { job, runs } = fake(summaryName, '0 7 * * *', undefined, f.farmId);
    await setDue(f, summaryName, at('2026-11-14T02:00:00Z'));

    await createRunner(quietLog(), [job]).runEverywhere(job, at('2026-11-10T02:00:01Z'));

    expect(runs).toEqual([f.farmId]);
    expect((await dueOn(f, summaryName)).nextDueAt).toEqual(at('2026-11-11T02:00:00Z'));
  });

  it('a farm the server has not seen yet owes nothing, and starts counting from now', async () => {
    const f = await createFixture();
    const { job, runs } = fake('reports.investor-monthly', '0 9 1 * *', undefined, f.farmId);

    await createRunner(quietLog(), [job]).runMissed(at('2026-11-20T10:00:00Z'));

    expect(runs).toEqual([]);
    expect((await dueOn(f, job.name)).nextDueAt).toEqual(at('2026-12-01T04:00:00Z'));
  });

  it('frequent jobs are not tracked: their next run does the same work', async () => {
    const f = await createFixture();
    const { job } = fake('alerts.repeat-urgent', '*/5 * * * *', undefined, f.farmId);

    await createRunner(quietLog(), [job]).runEverywhere(job);

    expect(await dueOn(f, job.name)).toBeUndefined();
  });

  it('the real summary, missed at 07:00, reaches the owner at 07:40', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const job = ALL_JOBS.find((candidate) => candidate.name === summaryName)!;
    const now = new Date();
    const due = new Date(now.getTime() - 40 * 60_000);
    await setDue(f, summaryName, due);

    await createRunner(quietLog(), [job]).runMissed(now);

    const told = await f.run(() => tx().select().from(notifications).where(eq(notifications.userId, owner.userId)));
    expect(told.map((row) => row.eventType)).toEqual(['daily_summary']);
  });
});

describe('work that waits on the model', () => {
  it('holds no transaction while the model answers, so a timeout cannot cut it', async () => {
    const f = await createFixture();
    await f.as('owner');
    const job = ALL_JOBS.find((candidate) => candidate.name === 'ai-summary-weekly')!;
    let inTransaction: boolean | undefined;
    setProvider({
      name: 'stub',
      model: 'stub',
      configured: true,
      complete: async () => {
        inTransaction = (() => {
          try {
            return Boolean(ctx());
          } catch {
            return false;
          }
        })();
        throw new Error('stubbed');
      },
    } as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const due = new Date(Date.now() - 3_600_000);
    await setDue(f, job.name, due);

    await createRunner(quietLog(), [job]).runMissed();

    setProvider(undefined);
    expect(inTransaction).toBe(false);
    const row = await dueOn(f, job.name);
    expect(row.lastRunAt).not.toBeNull();
    const [{ summaries }] = await f.run(async () =>
      (await tx().execute(sql`select count(*)::int as summaries from ai_insights where farm_id = ${f.farmId}`)).rows as { summaries: number }[],
    );
    expect(summaries).toBe(1);
  });
});
