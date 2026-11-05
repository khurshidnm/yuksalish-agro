import type { FastifyInstance } from 'fastify';
import { DrizzleQueryError } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { safeError } from '../src/core/errors';
import { signAccessToken } from '../src/core/tokens';
import { setProvider } from '../src/modules/ai/provider';
import { Scripted, say, world, type World } from './ai-world';

const PHONE = '+998901234567';

/** The app with its real logger, so these read the lines that would reach the production log. */
describe('what reaches the log', () => {
  const lines: string[] = [];
  const written = () => lines.join('');
  let app: FastifyInstance;
  let w: World;
  let bearer: string;

  const post = (url: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  beforeAll(async () => {
    app = await buildApp({ write: (line) => lines.push(line) });
    w = await world();
    bearer = await signAccessToken({ userId: w.owner.userId, membershipId: w.owner.membershipId, tenantId: w.f.tenantId, farmId: w.f.farmId });
  });
  afterAll(() => app.close());
  afterEach(() => {
    setProvider(undefined);
    lines.length = 0;
  });

  /** A failure Postgres really raises on this insert, and that no input check or known code answers. */
  async function withFailingInsert(run: () => Promise<void>) {
    const owner = new pg.Client({ connectionString: config.DATABASE_OWNER_URL });
    await owner.connect();
    await owner.query(`
      create function log_test_fail() returns trigger language plpgsql as $$ begin raise exception 'the disk said no'; end $$;
      create trigger log_test_fail before insert on counterparties for each row
        when (new.tenant_id = '${w.f.tenantId}') execute function log_test_fail();
    `);
    try {
      await run();
    } finally {
      await owner.query('drop trigger log_test_fail on counterparties; drop function log_test_fail()');
      await owner.end();
    }
  }

  it('a route that fails keeps the cause and drops what it was sent', async () => {
    await withFailingInsert(async () => {
      const res = await post('/finance/counterparties', { name: 'Akmal aka', type: 'supplier', phone: PHONE, contactPerson: 'Akmal Qodirov' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong on the server' });
    });
    expect(written()).toContain('unhandled error');
    expect(written()).toContain('the disk said no');
    expect(written()).not.toContain(PHONE);
    expect(written()).not.toContain('Akmal');
  });

  it('a chat turn that fails does not write what the person said', async () => {
    setProvider(new Scripted([say('.')]));
    const res = await post('/ai/chat/stream', { message: `Akmal aka uchun maxfiy ${PHONE} \u0000` });
    expect(res.body).toContain('event: failure');
    expect(written()).toContain('AI chat failed');
    expect(written()).toContain('invalid byte sequence');
    expect(written()).not.toContain(PHONE);
    expect(written()).not.toContain('maxfiy');
  });

  it('a job logging through the app logger gets the same treatment', () => {
    const cause = new Error('connection terminated');
    app.log.error({ err: new DrizzleQueryError('insert into notifications', [`Akmal ${PHONE}`], cause), job: 'notifications.dispatch' }, 'job failed');
    expect(written()).toContain('connection terminated');
    expect(written()).toContain('notifications.dispatch');
    expect(written()).not.toContain(PHONE);
  });

  it('an error the caller already made safe is written as it is', () => {
    app.log.error({ err: safeError(new Error('telegram refused')) }, 'telegram reply failed');
    expect(written()).toContain('telegram refused');
  });

  it('the query string stays out: a searched phone, a file link token', async () => {
    const headers = { authorization: `Bearer ${bearer}` };
    const search = await app.inject({ method: 'GET', url: `/api/v1/finance/counterparties?search=${encodeURIComponent(PHONE)}`, headers });
    expect(search.statusCode).toBe(200);
    await app.inject({ method: 'GET', url: '/api/v1/files/00000000-0000-7000-8000-000000000000/content?token=signed-link-token' });
    expect(written()).toContain('"url":"/api/v1/finance/counterparties"');
    expect(written()).toContain('"url":"/api/v1/files/00000000-0000-7000-8000-000000000000/content"');
    expect(written()).not.toContain(encodeURIComponent(PHONE));
    expect(written()).not.toContain('signed-link-token');
  });
});
