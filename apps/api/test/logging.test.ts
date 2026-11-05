import type { FastifyInstance } from 'fastify';
import { DrizzleQueryError } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
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

  it('a route that fails keeps the cause and drops what it was sent', async () => {
    const res = await post('/finance/counterparties', { name: 'Akmal aka\u0000', type: 'supplier', phone: PHONE, contactPerson: 'Akmal Qodirov' });
    expect(res.statusCode).toBe(500);
    expect(written()).toContain('unhandled error');
    expect(written()).toContain('invalid byte sequence');
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
