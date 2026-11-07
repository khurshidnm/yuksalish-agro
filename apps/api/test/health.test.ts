import { afterEach, describe, expect, it, vi } from 'vitest';
import { healthPool, pool } from '../src/db/client';
import {
  assessHealth,
  deepHealth,
  heartbeatTick,
  noteJobsStarted,
  noteTelegramContact,
  noteUndelivered,
  noteWorkerRun,
  setTelegramCheck,
  type HealthFacts,
  type TelegramAnswer,
} from '../src/core/health';
import { checkTelegram } from '../src/modules/notifications/telegram';
import { createFixture, getApp } from './helpers';

/** Redis as the deep check sees it. */
const redis = vi.hoisted(() => ({ answer: 'PONG' as string | Error }));

vi.mock('ioredis', () => ({
  Redis: class {
    on() {}
    async connect() {
      if (redis.answer instanceof Error) throw redis.answer;
    }
    async ping() {
      return redis.answer;
    }
    disconnect() {}
  },
}));

const now = new Date('2026-11-10T04:00:00Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const healthy: HealthFacts = {
  database: true,
  redis: true,
  jobsStartedAt: minutesAgo(60),
  lastWorkerRunAt: minutesAgo(1),
  oldestUndeliveredAt: null,
  telegramContactAt: minutesAgo(1),
  telegramGetMe: 'ok',
  diskUsedPercent: 40,
};

const failingWith = (change: Partial<HealthFacts>) => assessHealth({ ...healthy, ...change }, now).failing;

const passingNow = () => {
  noteJobsStarted();
  noteWorkerRun();
  noteTelegramContact();
  redis.answer = 'PONG';
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setTelegramCheck(null);
  redis.answer = 'PONG';
});

describe('the deep check reads the facts', () => {
  it('passes when everything answers', () => {
    expect(assessHealth(healthy, now)).toMatchObject({ status: 'ok', failing: [] });
  });

  it('fails on each thing the outside world depends on', () => {
    expect(failingWith({ database: false })).toEqual(['database']);
    expect(failingWith({ redis: false })).toEqual(['redis']);
    expect(failingWith({ diskUsedPercent: 90 })).toEqual(['disk']);
    expect(failingWith({ diskUsedPercent: null })).toEqual(['disk']);
  });

  it('a worker that stopped fails after three missed minutes, and a new one has that long to start', () => {
    expect(failingWith({ lastWorkerRunAt: minutesAgo(2.9) })).toEqual([]);
    expect(failingWith({ lastWorkerRunAt: minutesAgo(3) })).toEqual(['worker']);
    expect(failingWith({ lastWorkerRunAt: null, jobsStartedAt: minutesAgo(1) })).toEqual([]);
    expect(failingWith({ lastWorkerRunAt: null, jobsStartedAt: minutesAgo(5) })).toEqual(['worker']);
  });

  it('an API running without jobs is not healthy, whatever else it says', () => {
    expect(failingWith({ lastWorkerRunAt: null, jobsStartedAt: null })).toEqual(['worker']);
  });

  it('an urgent alert stuck for five minutes fails, and a fresh one does not', () => {
    expect(failingWith({ oldestUndeliveredAt: minutesAgo(4.9) })).toEqual([]);
    expect(failingWith({ oldestUndeliveredAt: minutesAgo(5) })).toEqual(['urgentDelivery']);
  });

  it('a bot that lost Telegram fails before any alert has, and no bot at all is the app warning, not a failure', () => {
    expect(failingWith({ telegramContactAt: minutesAgo(5) })).toEqual(['telegram']);
    expect(failingWith({ telegramContactAt: null })).toEqual([]);
  });

  it('a token Telegram turns down, or a road that is closed, fails at once, and no answer yet says nothing', () => {
    expect(failingWith({ telegramGetMe: 'refused' })).toEqual(['telegram']);
    expect(failingWith({ telegramGetMe: 'unreachable' })).toEqual(['telegram']);
    expect(failingWith({ telegramGetMe: null })).toEqual([]);
    expect(assessHealth({ ...healthy, telegramGetMe: 'refused' }, now).checks.telegram).toMatchObject({ status: 'failing', getMe: 'refused' });
  });

  it('says how long, and what is missing is null', () => {
    const report = assessHealth({ ...healthy, lastWorkerRunAt: null, oldestUndeliveredAt: minutesAgo(7), diskUsedPercent: null }, now);
    expect(report.checks.worker).toMatchObject({ lastRunAt: null, ageSeconds: null });
    expect(report.checks.urgentDelivery).toMatchObject({ oldestUndeliveredAt: minutesAgo(7).toISOString(), ageSeconds: 420 });
    expect(report.checks.disk.usedPercent).toBeNull();
  });
});

describe('/api/health', () => {
  it('stays cheap and answers while every connection of the API is taken', async () => {
    const app = await getApp();
    const taken = await Promise.all(Array.from({ length: pool.options.max }, () => pool.connect()));
    try {
      const started = Date.now();
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const client of taken) client.release();
    }
  });

  it('says so when the database is gone, in time for a container check', async () => {
    const app = await getApp();
    vi.spyOn(healthPool, 'query').mockImplementation((() => Promise.reject(new Error('connection refused'))) as never);

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'failing' });
  });

  it('a database that hangs is a failure within seconds, not a wait', async () => {
    const app = await getApp();
    vi.spyOn(healthPool, 'query').mockImplementation((() => new Promise(() => {})) as never);

    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('does not ask about Redis: the API works without it', async () => {
    const app = await getApp();
    redis.answer = new Error('connection refused');

    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});

describe('/api/health/deep', () => {
  it('gives the server itself the whole report', async () => {
    const app = await getApp();
    passingNow();
    await deepHealth({ fresh: true });

    const res = await app.inject({ method: 'GET', url: '/api/health/deep' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'ok' }, redis: { status: 'ok' }, worker: { status: 'ok' }, urgentDelivery: { status: 'ok' }, disk: { status: 'ok' } },
    });
    expect(res.json().checks.disk.usedPercent).toBeGreaterThan(0);
  });

  it('gives anyone else only pass or fail: a stranger must not learn that alerts are not getting out', async () => {
    const app = await getApp();
    passingNow();
    noteUndelivered('farm-1', new Date(Date.now() - 10 * 60_000));
    await deepHealth({ fresh: true });
    noteUndelivered('farm-1', null);

    const res = await app.inject({ method: 'GET', url: '/api/health/deep', remoteAddress: '203.0.113.7', headers: { 'x-forwarded-for': '127.0.0.1' } });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'failing' });
  });

  it('a proxy on the same address cannot be talked into the detail by a header', async () => {
    const app = await getApp();
    passingNow();
    await deepHealth({ fresh: true });

    const res = await app.inject({ method: 'GET', url: '/api/health/deep', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': '::1' } });

    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('Redis refusing fails it, with the rest still reported', async () => {
    passingNow();
    redis.answer = new Error('MISCONF Errors writing to the AOF file');

    const report = await deepHealth({ fresh: true });

    expect(report.failing).toEqual(['redis']);
    expect(report.checks.database.status).toBe('ok');
  });

  it('repeating it does no work for a while', async () => {
    passingNow();
    const first = await deepHealth({ fresh: true });
    const query = vi.spyOn(healthPool, 'query');

    expect(await deepHealth()).toBe(first);

    expect(query).not.toHaveBeenCalled();
  });

  it('the oldest stuck alert of any farm counts', async () => {
    passingNow();
    noteUndelivered('farm-a', new Date(Date.now() - 60_000));
    noteUndelivered('farm-b', new Date(Date.now() - 20 * 60_000));

    const report = await deepHealth({ fresh: true });
    noteUndelivered('farm-a', null);
    noteUndelivered('farm-b', null);

    expect(report.failing).toEqual(['urgentDelivery']);
    expect(report.checks.urgentDelivery.ageSeconds).toBeGreaterThanOrEqual(20 * 60);
  });
});

describe('the live Telegram check', () => {
  /** Stands in for Telegram: says what it is told to, and counts the questions. */
  const fakeTelegram = (first: TelegramAnswer = 'ok') => {
    const check = vi.fn(async (): Promise<TelegramAnswer> => first);
    setTelegramCheck(check);
    return check;
  };

  const report = () => deepHealth({ fresh: true });

  const minutesLater = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000);

  it('reports what getMe says, and nothing without a bot', async () => {
    passingNow();
    expect((await report()).checks.telegram.getMe).toBeNull();

    fakeTelegram('ok');
    expect((await report()).checks.telegram).toMatchObject({ status: 'ok', getMe: 'ok' });
  });

  it('a revoked token fails the check on the first look, without waiting for polling to go quiet', async () => {
    passingNow();
    fakeTelegram('refused');

    const health = await report();

    expect(health.failing).toEqual(['telegram']);
    expect(health.checks.telegram).toMatchObject({ status: 'failing', getMe: 'refused' });
  });

  it('asks every five minutes however often the watch looks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    passingNow();
    const check = fakeTelegram('ok');

    await report();
    minutesLater(4.9);
    noteWorkerRun();
    noteTelegramContact();
    await report();
    expect(check).toHaveBeenCalledTimes(1);

    minutesLater(0.2);
    await report();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('after a bad answer it asks again within the minute, so a moment of trouble is over quickly', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    passingNow();
    const check = fakeTelegram('unreachable');
    expect((await report()).status).toBe('failing');

    check.mockResolvedValue('ok');
    minutesLater(0.5);
    expect((await report()).status).toBe('failing');
    expect(check).toHaveBeenCalledTimes(1);

    minutesLater(0.6);
    noteWorkerRun();
    noteTelegramContact();
    expect((await report()).status).toBe('ok');
  });

  it('a slow Telegram is no answer yet, not a failure, and the answer arrives in a later report', async () => {
    passingNow();
    let answer: (value: TelegramAnswer) => void = () => {};
    const check = vi.fn(() => new Promise<TelegramAnswer>((resolve) => (answer = resolve)));
    setTelegramCheck(check);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const slow = report();
    await vi.advanceTimersByTimeAsync(3_000);
    const health = await slow;
    expect(health.checks.telegram.getMe).toBeNull();
    expect(health.failing).not.toContain('telegram');

    answer('refused');
    vi.useRealTimers();
    expect((await report()).checks.telegram.getMe).toBe('refused');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a check that throws counts as unreachable, and takes nothing down', async () => {
    passingNow();
    setTelegramCheck(async () => {
      throw new Error('boom');
    });
    expect((await report()).checks.telegram.getMe).toBe('unreachable');
  });

  describe('getMe itself', () => {
    const token = '123456789:AAAA-secret-token-of-the-bot';
    const answering = (status: number, body: object) =>
      vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

    it.each([
      ['ok', 200, { ok: true, result: { id: 1, is_bot: true, username: 'yap_bot' } }],
      ['refused', 401, { ok: false, description: 'Unauthorized' }],
      ['refused', 404, { ok: false, description: 'Not Found' }],
      ['unreachable', 502, { ok: false, description: 'Bad Gateway' }],
      ['unreachable', 429, { ok: false, parameters: { retry_after: 30 } }],
    ] as const)('%s for %d', async (word, status, body) => {
      vi.stubEnv('TELEGRAM_BOT_TOKEN', token);
      const fetchMock = answering(status, body);
      vi.stubGlobal('fetch', fetchMock);

      expect(await checkTelegram()).toBe(word);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${token}/getMe`);
    });

    it('unreachable when nothing gets through', async () => {
      vi.stubEnv('TELEGRAM_BOT_TOKEN', token);
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`fetch failed for https://api.telegram.org/bot${token}/getMe`); }));

      expect(await checkTelegram()).toBe('unreachable');
    });

    it.each([
      ['refused', answering(401, { ok: false, description: `Unauthorized ${token}` })],
      ['unreachable', vi.fn(async () => { throw new TypeError(`fetch failed for https://api.telegram.org/bot${token}/getMe`); })],
    ])('the token appears nowhere in the report or the log, whatever Telegram says (%s)', async (_word, fetchMock) => {
      passingNow();
      vi.stubEnv('TELEGRAM_BOT_TOKEN', token);
      setTelegramCheck(checkTelegram);
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const printed = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
      printed.forEach((spy) => spy.mockImplementation(() => {}));
      vi.stubGlobal('fetch', fetchMock);

      await heartbeatTick(log, '')();
      const health = await deepHealth();

      expect(health.failing).toEqual(['telegram']);
      const everything = JSON.stringify([health, log.error.mock.calls, log.warn.mock.calls, log.info.mock.calls, printed.map((spy) => spy.mock.calls)]);
      expect(everything).not.toContain(token);
      expect(everything).not.toContain('secret-token');
    });
  });
});

describe('a farm that stops reporting', () => {
  it('does not fail the server for ever: its workspace may have been suspended with an alert open', async () => {
    passingNow();
    noteUndelivered('farm-gone', new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 4 * 60_000));

    const report = await deepHealth({ fresh: true });
    noteUndelivered('farm-gone', null);

    expect(report.failing).toEqual([]);
  });
});

describe('the heartbeat', () => {
  const url = 'https://hc.example/ping/secret-token';
  const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  const ok = () => vi.fn(async (_url: string, _init?: RequestInit) => new Response('OK', { status: 200 }));

  it('goes out while the deep check passes, and carries nothing', async () => {
    passingNow();
    const fetchMock = ok();
    vi.stubGlobal('fetch', fetchMock);

    await heartbeatTick(log(), url)();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [address, init] = fetchMock.mock.calls[0];
    expect(address).toBe(url);
    expect(init?.body).toBeUndefined();
    expect(init?.method).toBeUndefined();
  });

  it('stays quiet while it fails, so the outside service raises the alarm, and says so once', async () => {
    passingNow();
    redis.answer = new Error('connection refused');
    const fetchMock = ok();
    const logged = log();
    vi.stubGlobal('fetch', fetchMock);
    const tick = heartbeatTick(logged, url);

    await tick();
    await tick();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.error).toHaveBeenCalledTimes(1);
    expect(logged.error.mock.calls[0][0]).toEqual({ failing: ['redis'] });

    redis.answer = 'PONG';
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logged.info).toHaveBeenCalledTimes(1);
  });

  it('stays off while the setting is empty, and the log still hears about failures', async () => {
    passingNow();
    redis.answer = new Error('connection refused');
    const fetchMock = ok();
    const logged = log();
    vi.stubGlobal('fetch', fetchMock);

    await heartbeatTick(logged, '')();
    redis.answer = 'PONG';
    await heartbeatTick(logged, undefined)();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged.error).toHaveBeenCalledTimes(1);
  });

  it('a service that is away is noted once, and its address, which may hold a secret, stays out of the log', async () => {
    passingNow();
    const logged = log();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`fetch failed for ${url}`); }));
    const tick = heartbeatTick(logged, url);

    await tick();
    await tick();

    expect(logged.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.warn.mock.calls)).not.toContain('secret-token');
  });

  it('an answer that is not a success counts as not reaching it', async () => {
    passingNow();
    const logged = log();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));

    await heartbeatTick(logged, url)();

    expect(logged.warn).toHaveBeenCalledTimes(1);
  });
});

describe('nothing waits for ever', () => {
  it('every connection of the API has limits the server enforces', async () => {
    await createFixture();
    const client = await pool.connect();
    try {
      const read = async (setting: string) => (await client.query(`show ${setting}`)).rows[0][setting];
      expect(await read('statement_timeout')).toBe('1min');
      expect(await read('idle_in_transaction_session_timeout')).toBe('5min');
      expect(await read('transaction_timeout')).toBe('15min');
    } finally {
      client.release();
    }
    expect(pool.options.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('a statement over its limit is stopped by the server, and the connection goes back to work', async () => {
    const client = await pool.connect();
    try {
      await client.query(`set statement_timeout = '100ms'`);
      await expect(client.query('select pg_sleep(5)')).rejects.toThrow(/statement timeout/);
      await client.query(`set statement_timeout = '60s'`);
      expect((await client.query('select 1 as one')).rows[0].one).toBe(1);
    } finally {
      client.release();
    }
  });

  it('a transaction left open is ended by the server', async () => {
    const client = await pool.connect();
    client.on('error', () => {});
    try {
      await client.query('begin');
      await client.query(`set local idle_in_transaction_session_timeout = '100ms'`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await expect(client.query('select 1')).rejects.toThrow();
    } finally {
      client.release(true);
    }
  });
});
