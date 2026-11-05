/** What grows, and what must not slow down as it does. */
import { and, asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { paged, type Page } from '../src/core/query';
import { raiseAlert } from '../src/modules/alerts/alerts.service';
import { collectEvents } from '../src/modules/settings/webhooks.service';
import { createFixture, type Fixture } from './helpers';

const { apiKeys, auditLogs, events, webhookSubscriptions } = schema;

const auditRows = (f: Fixture, entity: string) =>
  f.run(() => tx().select().from(auditLogs).where(eq(auditLogs.entity, entity)));

async function machine() {
  const f = await createFixture();
  const owner = await f.as('owner');
  const created = await owner.post('/settings/api-keys', { name: 'Edge', scopes: ['events:write'] });
  const device = (await owner.post('/devices', { type: 'camera', name: 'Molxona 1' })).data;
  const call = async (url: string, payload: unknown) => {
    const res = await f.app.inject({
      method: 'POST',
      url: `/api/v1/devices${url}`,
      headers: { 'content-type': 'application/json', 'x-api-key': created.data.key },
      payload: JSON.stringify(payload),
    });
    expect(res.statusCode).toBe(200);
  };
  const lastUsedAt = async () => {
    const [row] = await f.run(() => tx().select().from(apiKeys).where(eq(apiKeys.id, created.data.id)));
    return row.lastUsedAt;
  };
  return { f, owner, keyId: created.data.id as string, device, call, lastUsedAt };
}

describe('machine traffic and the audit log', () => {
  it('a hundred calls from a device add nothing to the audit log and touch the key once', async () => {
    const { f, device, call, lastUsedAt } = await machine();
    const before = (await auditRows(f, 'api_keys')).length;

    await call('/heartbeat', { deviceId: device.id });
    const first = await lastUsedAt();
    expect(first).not.toBeNull();
    for (let i = 0; i < 50; i++) {
      await call('/heartbeat', { deviceId: device.id });
      await call('/events', { deviceId: device.id, type: 'person' });
    }

    expect(await lastUsedAt()).toEqual(first);
    expect((await auditRows(f, 'api_keys')).length).toBe(before);
  });

  it('moves "last used" again after an hour, still without an audit row', async () => {
    const { f, keyId, device, call, lastUsedAt } = await machine();
    await call('/heartbeat', { deviceId: device.id });
    const before = (await auditRows(f, 'api_keys')).length;

    const almost = new Date(Date.now() - 59 * 60_000);
    await f.run(() => tx().update(apiKeys).set({ lastUsedAt: almost }).where(eq(apiKeys.id, keyId)));
    await call('/heartbeat', { deviceId: device.id });
    expect(await lastUsedAt()).toEqual(almost);

    const stale = new Date(Date.now() - 61 * 60_000);
    await f.run(() => tx().update(apiKeys).set({ lastUsedAt: stale }).where(eq(apiKeys.id, keyId)));
    await call('/heartbeat', { deviceId: device.id });
    expect((await lastUsedAt())!.getTime()).toBeGreaterThan(Date.now() - 60_000);

    expect((await auditRows(f, 'api_keys')).length).toBe(before);
  });

  it('a person changing the same row is still audited', async () => {
    const { f, owner, keyId, device, call } = await machine();
    await call('/heartbeat', { deviceId: device.id });
    const before = (await auditRows(f, 'api_keys')).length;

    await owner.delete(`/settings/api-keys/${keyId}`);

    const rows = await auditRows(f, 'api_keys');
    expect(rows.length).toBe(before + 1);
    expect(rows.find((r) => (r.after as { revoked_at: string | null }).revoked_at)).toBeDefined();
  });

  it('an open alert seen again is not a change, but a worse one is', async () => {
    const f = await createFixture();
    const alert = { ruleKey: 'test.rule', dedupKey: 'test:1', title: 'Yong\'in', body: 'Molxona' };
    await f.run(() => raiseAlert({ ...alert, severity: 'attention' }));
    const created = (await auditRows(f, 'alerts')).length;

    for (let i = 0; i < 5; i++) await f.run(() => raiseAlert({ ...alert, severity: 'attention' }));
    expect((await auditRows(f, 'alerts')).length).toBe(created);

    await f.run(() => raiseAlert({ ...alert, severity: 'urgent' }));
    expect((await auditRows(f, 'alerts')).length).toBeGreaterThan(created);
  });

  it('a webhook moving through the journal is not a change', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const hook = await owner.post('/settings/webhooks', { url: 'https://93.184.216.34/hooks/yap', eventTypes: ['*'] });
    const before = (await auditRows(f, 'webhook_subscriptions')).length;
    const cursor = () =>
      f.run(async () => {
        const [row] = await tx().select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, hook.data.id));
        return row.cursor;
      });
    const start = await cursor();

    await f.run(() =>
      tx().insert(events).values({
        tenantId: f.tenantId,
        farmId: f.farmId,
        type: 'test.happened',
        // Old enough to be past the commit lag.
        createdAt: new Date(Date.now() - 60_000),
      }),
    );
    await f.run(() => collectEvents());

    expect(await cursor()).not.toBe(start);
    expect((await auditRows(f, 'webhook_subscriptions')).length).toBe(before);
  });
});

describe('counting a long list', () => {
  /** Past the point where a count stops, and quick to build. */
  const ROWS = 10_300;

  async function journal(rows = ROWS) {
    const f = await createFixture();
    await f.run(() =>
      tx().execute(sql`
        insert into events (id, tenant_id, farm_id, type, occurred_at)
        select gen_random_uuid(), ${f.tenantId}, ${f.farmId}, 'test.happened', now() - make_interval(secs => i)
        from generate_series(1, ${rows}::int) i`),
    );
    return { f, owner: await f.as('owner') };
  }

  const ids = (f: Fixture, q: { page: number; pageSize: number }) =>
    f.run(() => {
      const where = and(eq(events.farmId, f.farmId), eq(events.type, 'test.happened'));
      return paged(q, events, where, (limit, offset) =>
        tx().select({ id: events.id }).from(events).where(where).orderBy(asc(events.id)).limit(limit).offset(offset),
      );
    });

  it('stops at a floor and says so', async () => {
    const { owner } = await journal();
    const { meta } = (await owner.get('/settings/journal', { type: 'test.happened' })).body;
    expect(meta).toEqual({ page: 1, pageSize: 25, total: 10_025, totalCapped: true });
  });

  it('the floor moves with the page, so a person can keep going', async () => {
    const { f } = await journal();
    const { meta } = await ids(f, { page: 3, pageSize: 25 });
    expect(meta.total).toBe(10_075);
    expect(meta.totalCapped).toBe(true);
  });

  it('is exact again on the last page', async () => {
    const { f } = await journal();
    const { data, meta } = await ids(f, { page: 52, pageSize: 200 });
    expect(data).toHaveLength(100);
    expect(meta).toEqual({ page: 52, pageSize: 200, total: ROWS });
  });

  it('a caller reading until it has `total` rows still gets them all', async () => {
    const { f } = await journal();
    const seen = new Set<string>();
    let result: Page<{ id: string }>;
    let page = 1;
    do {
      result = await ids(f, { page, pageSize: 200 });
      for (const row of result.data) seen.add(row.id);
      page += 1;
    } while (seen.size < result.meta.total && result.data.length > 0);
    expect(seen.size).toBe(ROWS);
  });

  it('is exact for any list that fits under the limit', async () => {
    const { f } = await journal(120);
    expect((await ids(f, { page: 1, pageSize: 25 })).meta).toEqual({ page: 1, pageSize: 25, total: 120 });
    expect((await ids(f, { page: 5, pageSize: 25 })).meta).toEqual({ page: 5, pageSize: 25, total: 120 });
  });

  it('a full last page and a page past the end still know the total', async () => {
    const { f } = await journal(50);
    expect((await ids(f, { page: 2, pageSize: 25 })).meta.total).toBe(50);
    const past = await ids(f, { page: 9, pageSize: 25 });
    expect(past.data).toEqual([]);
    expect(past.meta.total).toBe(50);
  });

  it('an empty list is 0, not a missing total', async () => {
    const f = await createFixture();
    expect((await ids(f, { page: 1, pageSize: 25 })).meta).toEqual({ page: 1, pageSize: 25, total: 0 });
  });

  it('counts only this tenant, past the limit too', async () => {
    const { owner } = await journal();
    const other = await createFixture();
    const list = await (await other.as('owner')).get('/settings/journal', { type: 'test.happened' });
    expect(list.body.meta.total).toBe(0);
    expect((await owner.get('/settings/journal', { type: 'test.happened' })).body.meta.totalCapped).toBe(true);
  });
});

describe('the export overview', () => {
  it('counts a long journal only so far, and says so', async () => {
    const f = await createFixture();
    await f.run(() =>
      tx().execute(sql`
        insert into events (id, tenant_id, farm_id, type, occurred_at)
        select gen_random_uuid(), ${f.tenantId}, ${f.farmId}, 'test.happened', now()
        from generate_series(1, 100001)`),
    );
    const overview = (await (await f.as('owner')).get('/settings/export/overview')).data;
    expect(overview.find((table: any) => table.name === 'events').capped).toBe(true);
    expect(overview.find((table: any) => table.name === 'events').rows).toBe(100_000);
    expect(overview.find((table: any) => table.name === 'farms').capped).toBeUndefined();
  });
});

describe('indexes', () => {
  async function asOwner<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
    const db = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
    await db.connect();
    try {
      return await fn(db);
    } finally {
      await db.end();
    }
  }

  // Drizzle's .desc() means DESC NULLS LAST, which ORDER BY x DESC cannot use, in either direction:
  // every newest-first list then reads all its rows and sorts them. A plain index serves it backwards.
  it('none is built in an order the lists cannot use', async () => {
    const { rows } = await asOwner((db) =>
      db.query(`select indexname from pg_indexes where schemaname = 'public' and indexdef like '%DESC NULLS LAST%'`),
    );
    expect(rows).toEqual([]);
  });

  /** Rows the plan really read, as the API role under row-level security. */
  async function rowsRead(f: Fixture, query: string): Promise<number> {
    const [{ 'QUERY PLAN': plan }] = await f.run(async () => (await tx().execute(sql.raw(`explain (analyze, format json) ${query}`))).rows as any[]);
    const walk = (node: any): number =>
      (node['Node Type'].includes('Scan') ? node['Actual Rows'] * node['Actual Loops'] + (node['Rows Removed by Filter'] ?? 0) : 0) +
      (node.Plans ?? []).reduce((sum: number, child: any) => sum + walk(child), 0);
    return walk(plan[0].Plan);
  }

  it('a newest-first page reads a page, however long the journal', async () => {
    const f = await createFixture();
    await f.run(() =>
      tx().execute(sql`
        insert into events (id, tenant_id, farm_id, type, source, severity, occurred_at)
        select gen_random_uuid(), ${f.tenantId}, ${f.farmId}, 'test.happened', 'user', case when i = 5000 then 'urgent' else 'info' end, now() - make_interval(secs => i)
        from generate_series(1, 20000) i`),
    );
    await asOwner((db) => db.query('analyze events'));
    const farm = `farm_id = '${f.farmId}'`;

    expect(await rowsRead(f, `select * from events where ${farm} order by occurred_at desc, id desc limit 25`)).toBeLessThan(100);
    expect(
      await rowsRead(f, `select * from events where ${farm} and source in ('camera', 'sensor') and type <> 'alert.raised' order by occurred_at desc, id desc limit 25`),
      'a farm with no cameras',
    ).toBeLessThan(100);
    expect(await rowsRead(f, `select * from events where ${farm} and severity = 'urgent' order by occurred_at desc, id desc limit 25`), 'a rare severity').toBeLessThan(100);
  });
});
