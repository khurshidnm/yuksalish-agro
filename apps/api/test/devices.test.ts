import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { unseal } from '../src/core/crypto';
import { evaluateRules } from '../src/modules/alerts/rules';
import { DEFAULT_OFFLINE_MINUTES, detectOffline } from '../src/modules/devices/devices.service';
import { offlineCheck } from '../src/modules/devices/jobs';
import { createFixture, type Client, type Fixture } from './helpers';
import { renderAlert } from '../src/modules/alerts/alerts.service';

async function ingest(f: Fixture, key: string | undefined, url: string, payload: unknown) {
  const res = await f.app.inject({
    method: 'POST',
    url: `/api/v1/devices${url}`,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    payload: JSON.stringify(payload),
  });
  return { status: res.statusCode, body: res.json() };
}

async function setup() {
  const f = await createFixture();
  const owner = await f.as('owner');
  const key = (await owner.post('/settings/api-keys', { name: 'Edge', scopes: ['events:write'] })).data.key as string;
  const device = (await owner.post('/devices', { type: 'camera', name: 'Molxona 1', zone: 'barn' })).data;
  return { f, owner, key, device };
}

const alertsFor = (f: Fixture) => f.run(() => tx().select().from(schema.alerts));

describe('with Redis down when the API starts', () => {
  it('it still answers, still takes a fire event, and stops at once', async () => {
    const { f, key, device } = await setup();
    const port = 4700 + randomInt(0, 200);
    const api = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      stdio: 'ignore',
      env: { ...process.env, API_PORT: String(port), JOBS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:1', TELEGRAM_BOT_TOKEN: '' },
    });
    try {
      await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200), { timeout: 20_000, interval: 200 });

      const res = await fetch(`http://127.0.0.1:${port}/api/v1/devices/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ deviceId: device.id, type: 'fire', severity: 'urgent' }),
      });

      expect(res.status).toBe(200);
      expect(await alertsFor(f)).toHaveLength(1);
      const stopped = once(api, 'exit');
      api.kill('SIGTERM');
      await vi.waitFor(() => expect(api.exitCode).toBe(0), { timeout: 5_000 });
      await stopped;
    } finally {
      api.kill('SIGKILL');
    }
  }, 40_000);
});

describe('device registry', () => {
  let f: Fixture;
  let owner: Client;
  beforeAll(async () => {
    f = await createFixture();
    owner = await f.as('owner');
  });

  it('creates, lists, filters, updates and removes', async () => {
    const created = await owner.post('/devices', { type: 'sensor', name: 'Harorat datchigi', status: 'planned', notes: 'Ombor' });
    expect(created.status).toBe(201);
    expect(created.data.status).toBe('planned');

    const list = await owner.get('/devices', { type: 'sensor' });
    expect(list.body.data.map((d: any) => d.name)).toContain('Harorat datchigi');

    const updated = await owner.patch(`/devices/${created.data.id}`, { name: 'Namlik datchigi', zone: 'feed_store', liveUrl: 'https://gw.example/hls/x.m3u8' });
    expect(updated.data.name).toBe('Namlik datchigi');
    expect(updated.data.zone).toBe('feed_store');
    expect(updated.data.liveUrl).toBe('https://gw.example/hls/x.m3u8');

    const cleared = await owner.patch(`/devices/${created.data.id}`, { liveUrl: null });
    expect(cleared.data.liveUrl).toBeNull();
    expect(cleared.data.zone).toBe('feed_store');

    expect((await owner.delete(`/devices/${created.data.id}`)).status).toBe(200);
    expect((await owner.get(`/devices/${created.data.id}`)).status).toBe(404);
  });

  it('seals credentials out of the stream URL and the audit log', async () => {
    const created = await owner.post('/devices', {
      type: 'camera',
      name: 'Darvoza',
      streamUrl: 'rtsp://admin:s3cret@192.168.1.20:554/stream1',
    });
    expect(created.status).toBe(201);
    expect(created.data.streamUrl).toBe('rtsp://192.168.1.20:554/stream1');
    expect(created.data.hasStreamCredentials).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain('s3cret');
    expect(created.data.streamCredentials).toBeUndefined();

    const [row] = await f.run(() => tx().select().from(schema.devices).where(eq(schema.devices.id, created.data.id)));
    expect(unseal(row.streamCredentials!)).toBe('admin:s3cret');

    const audit = await f.run(() => tx().select().from(schema.auditLogs).where(sql`entity = 'devices' and entity_id = ${created.data.id}`));
    expect(JSON.stringify(audit)).not.toContain('s3cret');
  });

  it('keeps stored credentials when the URL is saved again without them', async () => {
    const created = await owner.post('/devices', { type: 'camera', name: 'Ombor', streamUrl: 'rtsp://u:p@10.0.0.2/s' });
    const edited = await owner.patch(`/devices/${created.data.id}`, { streamUrl: 'rtsp://10.0.0.3/s' });
    expect(edited.data.streamUrl).toBe('rtsp://10.0.0.3/s');
    expect(edited.data.hasStreamCredentials).toBe(true);

    const removed = await owner.patch(`/devices/${created.data.id}`, { streamUrl: null });
    expect(removed.data.streamUrl).toBeNull();
    expect(removed.data.hasStreamCredentials).toBe(false);
  });

  it('an empty edit changes nothing', async () => {
    const created = await owner.post('/devices', { type: 'scale', name: 'Tarozi' });
    const edited = await owner.patch(`/devices/${created.data.id}`, {});
    expect(edited.status).toBe(200);
    expect(edited.data.name).toBe('Tarozi');
  });

  it('refuses a broken stream URL and credentials in an ONVIF URL', async () => {
    const bad = await owner.post('/devices', { type: 'camera', name: 'Xato', streamUrl: 'not a url' });
    expect(bad.body.error.code).toBe('INVALID_STREAM_URL');
    const onvif = await owner.post('/devices', { type: 'camera', name: 'Xato', onvifUrl: 'http://admin:pw@10.0.0.2/onvif' });
    expect(onvif.body.error.code).toBe('INVALID_STREAM_URL');
    const live = await owner.post('/devices', { type: 'camera', name: 'Xato', liveUrl: 'javascript:alert(1)' });
    expect(live.status).toBe(400);
  });

  it('needs camera permissions', async () => {
    const shepherd = await f.as('shepherd');
    expect((await shepherd.get('/devices')).status).toBe(403);
    expect((await shepherd.get('/devices/events')).status).toBe(403);
    expect((await shepherd.post('/devices', { type: 'camera', name: 'Yashirin' })).status).toBe(403);
    const accountant = await f.as('accountant');
    expect((await accountant.get('/devices')).status).toBe(403);
  });

  it('refuses links to another tenant, which a foreign key alone would allow', async () => {
    const g = await createFixture();
    const stranger = await g.as('owner');
    const foreignKey = (await stranger.post('/settings/api-keys', { name: 'Begona', scopes: ['*'] })).data;
    const facility = await g.run(() =>
      tx().insert(schema.facilities).values({ tenantId: g.tenantId, farmId: g.farmId, type: 'barn', name: 'Begona molxona' }).returning(),
    );
    expect((await owner.post('/devices', { type: 'camera', name: 'Sinov', apiKeyId: foreignKey.id })).status).toBe(404);
    expect((await owner.post('/devices', { type: 'camera', name: 'Sinov', facilityId: facility[0].id })).status).toBe(404);
  });

  it('compares the plan from spec 25.3 with what is registered', async () => {
    const g = await createFixture();
    const o = await g.as('owner');
    await o.post('/devices', { type: 'camera', name: 'M1', zone: 'barn' });
    await o.post('/devices', { type: 'camera', name: 'M2', zone: 'barn', status: 'online' });
    await o.post('/devices', { type: 'sensor', name: 'Datchik', zone: 'barn' });
    const res = await o.get('/devices/plan');
    expect(res.data).toEqual([
      { zone: 'barn', min: 4, max: 6, registered: 2, online: 1 },
      { zone: 'feed_store', min: 2, max: 2, registered: 0, online: 0 },
      { zone: 'gate', min: 2, max: 2, registered: 0, online: 0 },
      { zone: 'pump', min: 1, max: 1, registered: 0, online: 0 },
    ]);
    const totals = res.data.reduce((sum: { min: number; max: number }, z: any) => ({ min: sum.min + z.min, max: sum.max + z.max }), { min: 0, max: 0 });
    expect(totals).toEqual({ min: 9, max: 11 });
  });
});

describe('event ingest', () => {
  it('records a standard event, marks the device online, keeps the snapshot', async () => {
    const { f, owner, key, device } = await setup();
    const res = await ingest(f, key, '/events', {
      deviceId: device.id,
      type: 'trough_empty',
      occurredAt: '2026-11-04T06:15:00+05:00',
      severity: 'attention',
      data: { section: 2 },
      snapshotUrl: 'https://nvr.example/snap/1.jpg',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accepted: true });

    const feed = await owner.get('/devices/events');
    expect(feed.body.meta.total).toBe(1);
    const event = feed.data[0];
    expect(event.type).toBe('camera.trough_empty');
    expect(event.source).toBe('camera');
    expect(event.deviceName).toBe('Molxona 1');
    expect(event.occurredAt).toBe('2026-11-04T01:15:00.000Z');
    expect(event.data).toEqual({ section: 2, snapshotUrl: 'https://nvr.example/snap/1.jpg', deviceName: 'Molxona 1' });

    const after = (await owner.get(`/devices/${device.id}`)).data;
    expect(after.status).toBe('online');
    expect(after.lastSeenAt).toBeTruthy();
  });

  it('labels non-camera events as sensor events and keeps dotted types as sent', async () => {
    const { f, owner, key } = await setup();
    const sensor = (await owner.post('/devices', { type: 'sensor', name: 'Ammiak' })).data;
    await ingest(f, key, '/events', { deviceId: sensor.id, type: 'ammonia', data: { ppm: 12 } });
    await ingest(f, key, '/events', { deviceId: sensor.id, type: 'scale.weighed', data: { kg: 52 } });
    const feed = await owner.get('/devices/events', { source: 'sensor' });
    expect(feed.data.map((e: any) => e.type).sort()).toEqual(['scale.weighed', 'sensor.ammonia']);
  });

  it('needs a key with the right scope', async () => {
    const { f, owner, device } = await setup();
    const event = { deviceId: device.id, type: 'smoke' };
    expect((await ingest(f, undefined, '/events', event)).status).toBe(401);
    expect((await ingest(f, 'yap_wrong', '/events', event)).status).toBe(401);

    await f.run(() => tx().update(schema.apiKeys).set({ scopes: ['other:thing'] }));
    const [row] = await f.run(() => tx().select().from(schema.apiKeys));
    expect(row.scopes).toEqual(['other:thing']);
    const created = await owner.post('/settings/api-keys', { name: 'Hammasi', scopes: ['*'] });
    expect((await ingest(f, created.data.key, '/events', event)).status).toBe(200);
  });

  it('refuses a key without the scope', async () => {
    const { f, owner, key, device } = await setup();
    await f.run(() => tx().update(schema.apiKeys).set({ scopes: ['reports:read'] }));
    const res = await ingest(f, key, '/events', { deviceId: device.id, type: 'smoke' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(owner.userId).toBeTruthy();
  });

  it("a suspended workspace's keys stop working", async () => {
    const { f, key, device } = await setup();
    await f.run(() => tx().update(schema.tenants).set({ status: 'suspended' }).where(eq(schema.tenants.id, f.tenantId)));
    const res = await ingest(f, key, '/events', { deviceId: device.id, type: 'person' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_SUSPENDED');
    expect((await ingest(f, key, '/heartbeat', { deviceId: device.id })).status).toBe(403);
  });

  it('a revoked key stops working at once', async () => {
    const { f, owner, key, device } = await setup();
    const [row] = await f.run(() => tx().select().from(schema.apiKeys));
    await owner.delete(`/settings/api-keys/${row.id}`);
    const res = await ingest(f, key, '/events', { deviceId: device.id, type: 'smoke' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_API_KEY');
  });

  it("a key cannot report for another tenant's device", async () => {
    const a = await setup();
    const b = await setup();
    const res = await ingest(a.f, a.key, '/events', { deviceId: b.device.id, type: 'smoke', severity: 'urgent' });
    expect(res.status).toBe(404);
    expect((await b.owner.get('/devices/events')).body.meta.total).toBe(0);
    expect(await alertsFor(b.f)).toEqual([]);
    expect((await b.owner.get(`/devices/${b.device.id}`)).data.status).toBe('planned');
    expect((await ingest(a.f, a.key, '/heartbeat', { deviceId: b.device.id })).status).toBe(404);
  });

  it('a device bound to a key accepts only that key', async () => {
    const { f, owner, key } = await setup();
    const [bound] = await f.run(() => tx().select().from(schema.apiKeys));
    const device = (await owner.post('/devices', { type: 'camera', name: 'Bog\'langan', apiKeyId: bound.id })).data;
    const other = (await owner.post('/settings/api-keys', { name: 'Boshqa', scopes: ['events:write'] })).data.key;

    const refused = await ingest(f, other, '/events', { deviceId: device.id, type: 'person' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('DEVICE_KEY_MISMATCH');
    expect((await ingest(f, other, '/heartbeat', { deviceId: device.id })).status).toBe(403);
    expect((await ingest(f, key, '/events', { deviceId: device.id, type: 'person' })).status).toBe(200);
  });

  it.each([
    ['no device', { type: 'smoke' }],
    ['bad type', { deviceId: uuidv7(), type: 'BAD TYPE!' }],
    ['bad severity', { deviceId: uuidv7(), type: 'trough_empty', severity: 'catastrophic' }],
    ['bad time', { deviceId: uuidv7(), type: 'smoke', occurredAt: 'yesterday' }],
    ['bad snapshot', { deviceId: uuidv7(), type: 'smoke', snapshotUrl: 'javascript:alert(1)' }],
  ])('rejects an event with %s', async (_label, body) => {
    const { f, key } = await setup();
    const res = await ingest(f, key, '/events', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a timestamp from a device with a wrong clock', async () => {
    const { f, key, device } = await setup();
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const res = await ingest(f, key, '/events', { deviceId: device.id, type: 'smoke', occurredAt: future });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_EVENT_TIME');
  });

  it('one device saying fire three ways is one alert, and a capital letter is not refused', async () => {
    const { f, key, device } = await setup();
    for (const type of ['fire', 'camera.fire', 'FIRE', 'Sensor.Fire']) {
      expect((await ingest(f, key, '/events', { deviceId: device.id, type })).status).toBe(200);
    }

    expect(await alertsFor(f)).toMatchObject([{ severity: 'urgent', ruleKey: 'device_event', dedupKey: `device_event:${device.id}:fire` }]);
  });

  it('smoke from the same device stays its own alert', async () => {
    const { f, key, device } = await setup();
    await ingest(f, key, '/events', { deviceId: device.id, type: 'fire' });
    await ingest(f, key, '/events', { deviceId: device.id, type: 'camera.smoke' });

    expect((await alertsFor(f)).map((alert) => alert.dedupKey).sort()).toEqual([`device_event:${device.id}:fire`, `device_event:${device.id}:smoke`]);
  });

  describe('fire and smoke are urgent whatever the sender says', () => {
    const reportedSeverity = (f: Fixture) =>
      f.run(() => tx().select({ severity: schema.events.severity }).from(schema.events).where(eq(schema.events.source, 'camera')));

    it.each([
      ['no severity at all', { type: 'smoke' }],
      ['info', { type: 'fire', severity: 'info' }],
      ['attention', { type: 'smoke', severity: 'attention' }],
      ['a word the format does not know', { type: 'fire', severity: 'critical' }],
      ['a number', { type: 'smoke', severity: 5 }],
      ['a dotted type', { type: 'sensor.smoke' }],
    ])('%s', async (_label, event) => {
      const { f, key, device } = await setup();
      const res = await ingest(f, key, '/events', { deviceId: device.id, ...event });
      expect(res.status).toBe(200);
      expect(await alertsFor(f)).toMatchObject([{ severity: 'urgent', source: 'device', ruleKey: 'device_event' }]);
      expect(await reportedSeverity(f)).toEqual([{ severity: 'urgent' }]);
    });

    it('in a batch too, and a malformed neighbour changes nothing', async () => {
      const { f, key, device } = await setup();
      const res = await ingest(f, key, '/events/batch', {
        events: [{ deviceId: device.id, type: 'smoke', severity: 'info' }, { deviceId: device.id, type: 'BAD TYPE!' }, { deviceId: device.id, type: 'fire' }],
      });
      expect(res.body.data).toMatchObject({ accepted: 2, rejected: [{ index: 1, code: 'VALIDATION_ERROR' }] });
      expect((await alertsFor(f)).map((alert) => alert.severity)).toEqual(['urgent', 'urgent']);
    });

    it('only these two: other events keep the severity they were sent with, and info stays the default', async () => {
      const { f, key, device } = await setup();
      await ingest(f, key, '/events', { deviceId: device.id, type: 'smoke_cleared' });
      await ingest(f, key, '/events', { deviceId: device.id, type: 'firewall', severity: 'attention' });
      expect(await alertsFor(f)).toEqual([]);
      expect((await reportedSeverity(f)).map((event) => event.severity).sort()).toEqual(['attention', 'info']);
    });
  });

  it('an urgent event raises one alert however many frames arrive, and a lesser one raises none', async () => {
    const { f, key, device } = await setup();
    await ingest(f, key, '/events', { deviceId: device.id, type: 'person', severity: 'attention' });
    expect(await alertsFor(f)).toEqual([]);

    for (let i = 0; i < 3; i++) {
      await ingest(f, key, '/events', { deviceId: device.id, type: 'smoke', severity: 'urgent', snapshotUrl: 'https://nvr.example/s.jpg' });
    }
    const alerts = await alertsFor(f);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].source).toBe('device');
    expect(alerts[0].severity).toBe('urgent');
    expect(alerts[0].title).toBe('Molxona 1: Tutun belgisi aniqlandi');
    expect(renderAlert(alerts[0], 'ru').title).toBe('Molxona 1: Признак дыма');
    expect(renderAlert(alerts[0], 'en').title).toBe('Molxona 1: Signs of smoke');
    expect(alerts[0].entityId).toBe(device.id);

    await ingest(f, key, '/events', { deviceId: device.id, type: 'fire', severity: 'urgent' });
    expect(await alertsFor(f)).toHaveLength(2);
  });

  describe('an urgent event after the last one', () => {
    const fire = (f: Fixture, key: string, deviceId: string) => ingest(f, key, '/events', { deviceId, type: 'fire', severity: 'urgent' });
    const told = (f: Fixture, userId: string) =>
      f.run(() => tx().select().from(schema.notifications).where(eq(schema.notifications.userId, userId)));
    const quietFor = (f: Fixture, ms: number, changes: Partial<typeof schema.alerts.$inferInsert> = {}) =>
      f.run(() => tx().update(schema.alerts).set({ lastSeenAt: new Date(Date.now() - ms), ...changes }));

    it('frames seconds apart stay one message, even just after someone acknowledged', async () => {
      const { f, owner, key, device } = await setup();
      await fire(f, key, device.id);
      const [alert] = await alertsFor(f);
      expect((await owner.post(`/alerts/${alert.id}/acknowledge`)).status).toBe(200);

      await fire(f, key, device.id);
      await quietFor(f, 90_000);
      await fire(f, key, device.id);

      const [after] = await alertsFor(f);
      expect(after.status).toBe('acknowledged');
      expect(after.nextNotifyAt).toBeNull();
      expect(await told(f, owner.userId)).toHaveLength(1);
    });

    it('past the burst, an acknowledged alarm opens again and someone hears now', async () => {
      const { f, owner, key, device } = await setup();
      await fire(f, key, device.id);
      const [alert] = await alertsFor(f);
      await owner.post(`/alerts/${alert.id}/acknowledge`);
      await quietFor(f, 3 * 60_000);

      await fire(f, key, device.id);

      const [after] = await alertsFor(f);
      expect(after).toMatchObject({ id: alert.id, status: 'open', acknowledgedAt: null, acknowledgedBy: null, notifyCount: 1 });
      expect(after.nextNotifyAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
      expect(await told(f, owner.userId)).toHaveLength(2);
      const raised = await f.run(() => tx().select().from(schema.events).where(eq(schema.events.type, 'alert.raised')));
      expect(raised).toHaveLength(2);
    });

    it('past the burst, an alarm nobody answered is told now, and the repeats start over from 15 minutes', async () => {
      const { f, owner, key, device } = await setup();
      await fire(f, key, device.id);
      await quietFor(f, 6 * 3_600_000, { notifyCount: 6, nextNotifyAt: new Date(Date.now() + 3 * 3_600_000) });

      await fire(f, key, device.id);

      const [after] = await alertsFor(f);
      expect(after.notifyCount).toBe(1);
      expect(after.nextNotifyAt!.getTime()).toBeLessThan(Date.now() + 16 * 60_000);
      expect(await told(f, owner.userId)).toHaveLength(2);
    });

    it('two frames at the same instant after a quiet spell are one new event', async () => {
      const { f, owner, key, device } = await setup();
      await fire(f, key, device.id);
      await quietFor(f, 3 * 60_000);

      await Promise.all([fire(f, key, device.id), fire(f, key, device.id)]);

      expect(await told(f, owner.userId)).toHaveLength(2);
    });

    it('a resolved alarm stays closed, and the next event is an alert of its own', async () => {
      const { f, owner, key, device } = await setup();
      await fire(f, key, device.id);
      const [alert] = await alertsFor(f);
      await owner.post(`/alerts/${alert.id}/resolve`);

      await fire(f, key, device.id);

      expect((await alertsFor(f)).map((a) => a.status).sort()).toEqual(['open', 'resolved']);
      expect(await told(f, owner.userId)).toHaveLength(2);
    });
  });

  it('a batch keeps the good events and reports the bad ones', async () => {
    const { f, owner, key, device } = await setup();
    const res = await ingest(f, key, '/events/batch', {
      events: [
        { deviceId: device.id, type: 'person' },
        { deviceId: uuidv7(), type: 'person' },
        { deviceId: device.id, type: 'vehicle', occurredAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        { deviceId: device.id, type: 'gate_open' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      accepted: 2,
      duplicates: 0,
      rejected: [
        { index: 1, code: 'DEVICE_NOT_FOUND' },
        { index: 2, code: 'INVALID_EVENT_TIME' },
      ],
    });
    const feed = await owner.get('/devices/events');
    expect(feed.data.map((e: any) => e.type).sort()).toEqual(['camera.gate_open', 'camera.person']);
    expect((await owner.get(`/devices/${device.id}`)).data.status).toBe('online');
  });

  it('a malformed event in a batch is reported on its own, and cannot hold back the rest', async () => {
    const { f, owner, key, device } = await setup();
    const res = await ingest(f, key, '/events/batch', {
      events: [{ deviceId: device.id, type: 'NOT A TYPE' }, 'not even an object', { deviceId: device.id, type: 'gate_open' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [
        { index: 0, code: 'VALIDATION_ERROR' },
        { index: 1, code: 'VALIDATION_ERROR' },
      ],
    });
    expect((await owner.get('/devices/events')).data.map((e: any) => e.type)).toEqual(['camera.gate_open']);
  });

  it('caps a batch at 100 events', async () => {
    const { f, key, device } = await setup();
    const events = Array.from({ length: 101 }, () => ({ deviceId: device.id, type: 'person' }));
    expect((await ingest(f, key, '/events/batch', { events })).status).toBe(400);
  });

  it('a heartbeat is not an audited change', async () => {
    const { f, key, device } = await setup();
    const count = async () =>
      (await f.run(() => tx().select().from(schema.auditLogs).where(sql`entity = 'devices' and entity_id = ${device.id}`))).length;
    const before = await count();
    await ingest(f, key, '/heartbeat', { deviceId: device.id });
    await ingest(f, key, '/events', { deviceId: device.id, type: 'person' });
    expect(await count()).toBe(before);
  });

  it('filters the feed', async () => {
    const { f, owner, key, device } = await setup();
    const second = (await owner.post('/devices', { type: 'camera', name: 'Darvoza' })).data;
    await ingest(f, key, '/events', { deviceId: device.id, type: 'person', severity: 'attention' });
    await ingest(f, key, '/events', { deviceId: second.id, type: 'vehicle' });

    const byDevice = await owner.get('/devices/events', { deviceId: second.id });
    expect(byDevice.data.map((e: any) => e.type)).toEqual(['camera.vehicle']);
    const bySeverity = await owner.get('/devices/events', { severity: 'attention' });
    expect(bySeverity.data.map((e: any) => e.type)).toEqual(['camera.person']);
    const byType = await owner.get('/devices/events', { type: 'camera.vehicle' });
    expect(byType.body.meta.total).toBe(1);
    expect((await owner.get('/devices/events', { from: '2099-01-01' })).body.meta.total).toBe(0);
  });

  it('the feed shows device events only, not the rest of the journal', async () => {
    const { f, owner, key, device } = await setup();
    await owner.post('/finance/counterparties', { name: 'Journal only', type: 'buyer' });
    await ingest(f, key, '/events', { deviceId: device.id, type: 'person' });
    expect((await owner.get('/devices/events')).body.meta.total).toBe(1);
  });
});

describe('offline detection', () => {
  const minutes = (n: number, from = new Date()) => new Date(from.getTime() + n * 60_000);

  it('warns when a device goes quiet, once, and clears when it returns', async () => {
    const { f, owner, key, device } = await setup();
    await ingest(f, key, '/heartbeat', { deviceId: device.id });

    expect(await f.run(() => detectOffline(minutes(DEFAULT_OFFLINE_MINUTES - 1)))).toBe(0);
    expect((await owner.get(`/devices/${device.id}`)).data.status).toBe('online');

    expect(await f.run(() => detectOffline(minutes(DEFAULT_OFFLINE_MINUTES + 1)))).toBe(1);
    expect((await owner.get(`/devices/${device.id}`)).data.status).toBe('offline');
    const alerts = await alertsFor(f);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].ruleKey).toBe('camera_offline');
    expect(alerts[0].dedupKey).toBe(`camera_offline:${device.id}`);
    expect(alerts[0].data).toEqual({ camera: 'Molxona 1' });
    expect(alerts[0].severity).toBe('attention');
    expect(alerts[0].status).toBe('open');

    expect(await f.run(() => detectOffline(minutes(DEFAULT_OFFLINE_MINUTES + 30)))).toBe(0);
    expect(await alertsFor(f)).toHaveLength(1);

    await ingest(f, key, '/heartbeat', { deviceId: device.id });
    expect((await owner.get(`/devices/${device.id}`)).data.status).toBe('online');
    expect((await alertsFor(f))[0].status).toBe('resolved');

    const journal = await f.run(() => tx().select().from(schema.events).where(sql`type like 'device.o%'`).orderBy(schema.events.createdAt));
    expect(journal.map((e) => e.type)).toEqual(['device.offline', 'device.online']);
  });

  it('a device other than a camera gets its own rule, which the alerts engine leaves alone', async () => {
    const { f, owner, key } = await setup();
    const sensor = (await owner.post('/devices', { type: 'sensor', name: 'Ammiak datchigi' })).data;
    await ingest(f, key, '/heartbeat', { deviceId: sensor.id });
    await f.run(() => detectOffline(minutes(DEFAULT_OFFLINE_MINUTES + 1)));
    await f.run(() => evaluateRules());
    const alerts = await alertsFor(f);
    expect(alerts.map((a) => [a.ruleKey, a.source, a.status])).toEqual([['device_offline', 'device', 'open']]);
    expect(alerts[0].title).toBe('Ammiak datchigi aloqada emas');
    expect(renderAlert(alerts[0], 'ru').title).toBe('Ammiak datchigi: нет связи');
    expect(renderAlert(alerts[0], 'en').body).toMatch(/^No signal for \d+ minutes\.$/);

    await ingest(f, key, '/heartbeat', { deviceId: sensor.id });
    expect((await alertsFor(f))[0].status).toBe('resolved');
  });

  it('one camera outage is one alert when the job finds it first', async () => {
    const { f, key, device } = await setup();
    await ingest(f, key, '/heartbeat', { deviceId: device.id });
    await f.run(() => detectOffline(minutes(DEFAULT_OFFLINE_MINUTES + 1)));
    await f.run(() => evaluateRules());
    expect(await alertsFor(f)).toHaveLength(1);

    await ingest(f, key, '/heartbeat', { deviceId: device.id });
    await f.run(() => evaluateRules());
    const alerts = await alertsFor(f);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe('resolved');
  });

  it('one camera outage is one alert, and only the job decides that a camera is silent', async () => {
    const { f, key, device } = await setup();
    await ingest(f, key, '/heartbeat', { deviceId: device.id });
    await f.run(() =>
      tx().update(schema.devices).set({ lastSeenAt: minutes(-20) }).where(eq(schema.devices.id, device.id)),
    );
    // The engine reads the status, so a per-device threshold cannot be overruled by a fixed one.
    await f.run(() => evaluateRules());
    expect(await alertsFor(f)).toHaveLength(0);

    await f.run(() => detectOffline());
    expect(await alertsFor(f)).toHaveLength(1);

    await f.run(() => evaluateRules());
    const alerts = await alertsFor(f);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe('open');

    await ingest(f, key, '/heartbeat', { deviceId: device.id });
    expect((await alertsFor(f))[0].status).toBe('resolved');
  });

  it('honours a per-device threshold', async () => {
    const { f, owner, key, device } = await setup();
    await owner.patch(`/devices/${device.id}`, { offlineAfterMinutes: 60 });
    await ingest(f, key, '/heartbeat', { deviceId: device.id });
    expect(await f.run(() => detectOffline(minutes(30)))).toBe(0);
    expect(await f.run(() => detectOffline(minutes(61)))).toBe(1);
  });

  it('leaves planned devices alone', async () => {
    const { f } = await setup();
    expect(await f.run(() => detectOffline(minutes(10_000)))).toBe(0);
    expect(await alertsFor(f)).toEqual([]);
  });

  it('removing an offline device closes its alert', async () => {
    const { f, owner, key, device } = await setup();
    await ingest(f, key, '/heartbeat', { deviceId: device.id });
    await f.run(() => detectOffline(minutes(DEFAULT_OFFLINE_MINUTES + 1)));
    await owner.delete(`/devices/${device.id}`);
    expect((await alertsFor(f))[0].status).toBe('resolved');
  });
});

describe('the offline check after an outage', () => {
  async function silentCamera() {
    const { f, owner, device } = await setup();
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    await f.run(() => tx().update(schema.devices).set({ status: 'online', lastSeenAt: longAgo }).where(eq(schema.devices.id, device.id)));
    return { f, owner, device };
  }
  const minutes = (n: number) => new Date(Date.now() + n * 60_000);

  it('does not read the server being away as every camera dying, and says it skipped', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { f, owner, device } = await silentCamera();

    await f.run(() => offlineCheck(minutes(0)));

    expect(await alertsFor(f)).toEqual([]);
    expect((await owner.get(`/devices/${device.id}`)).data.status).toBe('online');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('skipped'));
    info.mockRestore();
  });

  it('a device still silent at the next run is reported', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { f } = await silentCamera();

    await f.run(() => offlineCheck(minutes(0)));
    await f.run(() => offlineCheck(minutes(5)));

    expect((await alertsFor(f)).map((alert) => alert.ruleKey)).toEqual(['camera_offline']);
    info.mockRestore();
  });

  it('a gap in the runs starts the clock again', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { f } = await silentCamera();

    await f.run(() => offlineCheck(minutes(0)));
    await f.run(() => offlineCheck(minutes(30)));

    expect(await alertsFor(f)).toEqual([]);
    info.mockRestore();
  });
});

describe('a device sending the same event again', () => {
  const stored = (f: Fixture) => f.run(() => tx().select().from(schema.events).where(eq(schema.events.farmId, f.farmId)));
  const reported = async (f: Fixture) => (await stored(f)).filter((event) => event.source === 'camera');

  it('is one event and one alert, by its id', async () => {
    const { f, key, device } = await setup();
    const fire = { deviceId: device.id, eventId: 'frame-41', type: 'fire', severity: 'urgent' };

    const first = await ingest(f, key, '/events', fire);
    const again = await ingest(f, key, '/events', fire);

    expect(first.body.data).toEqual({ accepted: true });
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ accepted: true, duplicate: true });
    expect(await reported(f)).toHaveLength(1);
    expect(await alertsFor(f)).toHaveLength(1);
    const told = await f.run(() => tx().select().from(schema.notifications).where(eq(schema.notifications.farmId, f.farmId)));
    expect(told).toHaveLength(1);
  });

  it('is one event by type and time when it has no id, whichever way the time is written', async () => {
    const { f, key, device } = await setup();
    const at = (occurredAt: string) => ({ deviceId: device.id, type: 'person', occurredAt });

    await ingest(f, key, '/events', at('2026-11-04T06:15:00+05:00'));
    const again = await ingest(f, key, '/events', at('2026-11-04T01:15:00Z'));

    expect(again.body.data.duplicate).toBe(true);
    expect(await reported(f)).toHaveLength(1);
  });

  it('tells apart what only looks alike', async () => {
    const { f, owner, key, device } = await setup();
    const other = (await owner.post('/devices', { type: 'camera', name: 'Molxona 2', zone: 'barn' })).data;
    const occurredAt = '2026-11-04T06:15:00+05:00';

    await ingest(f, key, '/events', { deviceId: device.id, type: 'person' });
    await ingest(f, key, '/events', { deviceId: device.id, type: 'person' });
    await ingest(f, key, '/events', { deviceId: device.id, type: 'person', occurredAt });
    await ingest(f, key, '/events', { deviceId: device.id, type: 'vehicle', occurredAt });
    await ingest(f, key, '/events', { deviceId: other.id, type: 'person', occurredAt });
    await ingest(f, key, '/events', { deviceId: device.id, eventId: 'a', type: 'person', occurredAt });
    await ingest(f, key, '/events', { deviceId: other.id, eventId: 'a', type: 'person', occurredAt });

    expect(await reported(f)).toHaveLength(7);
  });

  it('a batch sent twice, or with a repeat inside it, stores each event once and says how many were repeats', async () => {
    const { f, key, device } = await setup();
    const events = ['a', 'b', 'a'].map((eventId) => ({ deviceId: device.id, eventId, type: 'smoke', severity: 'urgent' }));

    const first = await ingest(f, key, '/events/batch', { events });
    const again = await ingest(f, key, '/events/batch', { events });

    expect(first.body.data).toEqual({ accepted: 3, duplicates: 1, rejected: [] });
    expect(again.body.data).toEqual({ accepted: 3, duplicates: 3, rejected: [] });
    expect(await reported(f)).toHaveLength(2);
    expect(await alertsFor(f)).toHaveLength(1);
  });

  it('two attempts at the same moment are still one event', async () => {
    const { f, key, device } = await setup();
    const fire = { deviceId: device.id, eventId: 'race', type: 'fire', severity: 'urgent' };

    const results = await Promise.all([ingest(f, key, '/events', fire), ingest(f, key, '/events', fire)]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await reported(f)).toHaveLength(1);
  });

  it('an urgent event from a buffer still raises the alert, and it says when it happened', async () => {
    const { f, key, device } = await setup();
    const occurredAt = new Date(Date.now() - 3 * 3_600_000).toISOString();

    await ingest(f, key, '/events', { deviceId: device.id, type: 'smoke', severity: 'urgent', occurredAt });

    const [alert] = await alertsFor(f);
    const happenedAt = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Asia/Tashkent',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(occurredAt));
    expect(alert.data.happenedAt).toBe(happenedAt);
    expect(renderAlert(alert, 'en').body).toBe(`It happened at ${happenedAt}. The message reached the server late.`);
  });

  it('a fresh one says nothing of the kind', async () => {
    const { f, key, device } = await setup();

    await ingest(f, key, '/events', { deviceId: device.id, type: 'smoke', severity: 'urgent', occurredAt: new Date().toISOString() });

    expect(renderAlert((await alertsFor(f))[0], 'en').body).toBeNull();
  });
});

describe('the bridge in docs/device-events.md', () => {
  const docs = readFileSync(join(process.cwd(), '..', '..', 'docs', 'device-events.md'), 'utf8');
  const sample = /```js\n(\/\/ outbox\.mjs[\s\S]*?)```/.exec(docs)![1].replace('FIRST_WAIT_MS = 1_000', 'FIRST_WAIT_MS = 5');
  let loaded = 0;

  /** The code as printed, against the real API, with a network that does what the test says. */
  async function bridge(f: Fixture, key: string, network: (forward: () => Promise<Response>, attempt: number, body: string) => Promise<Response>) {
    const folder = mkdtempSync(join(tmpdir(), 'yap-bridge-'));
    const file = join(folder, `outbox-${(loaded += 1)}.mjs`);
    writeFileSync(file, sample);
    vi.stubEnv('YAP_URL', 'http://yap.test');
    vi.stubEnv('YAP_API_KEY', key);
    vi.stubEnv('YAP_OUTBOX', join(folder, 'queue'));
    let attempt = 0;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      attempt += 1;
      const forward = async () => {
        const res = await f.app.inject({
          method: 'POST',
          url: '/api/v1/devices/events/batch',
          headers: init.headers as Record<string, string>,
          payload: init.body as string,
        });
        return new Response(res.body, { status: res.statusCode });
      };
      return network(forward, attempt, init.body as string);
    });
    const outbox = await import(/* @vite-ignore */ file);
    const waiting = () => readdirSync(join(folder, 'queue')).filter((name) => name.endsWith('.json'));
    return { ...outbox, waiting } as { enqueue(event: unknown): Promise<void>; flush(): Promise<void>; waiting(): string[] };
  }

  const reported = (f: Fixture) =>
    f.run(() => tx().select().from(schema.events).where(eq(schema.events.source, 'camera')).then((rows) => rows.filter((row) => row.farmId === f.farmId)));

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps a fire frame through an outage and a lost reply, and the server has it once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { f, key, device } = await setup();
    const held: string[][] = [];
    const out = await bridge(f, key, async (forward, attempt) => {
      held.push(out.waiting());
      if (attempt === 1) throw new TypeError('fetch failed');
      if (attempt === 2) return new Response('{}', { status: 502 });
      if (attempt === 3) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      if (attempt === 4) {
        await forward();
        throw new TypeError('the reply was lost');
      }
      return forward();
    });

    await out.enqueue({ deviceId: device.id, type: 'fire', severity: 'urgent' });
    await vi.waitFor(() => expect(out.waiting()).toEqual([]), { timeout: 5_000 });

    expect(held).toHaveLength(5);
    expect(held.every((names) => names.length === 1)).toBe(true);
    expect(await reported(f)).toHaveLength(1);
    expect(await alertsFor(f)).toHaveLength(1);
  });

  describe('the severity of what Frigate sees', () => {
    const [, printed] = /(const WORK_STARTS_AT[\s\S]*?\n}\n)/.exec(docs)!;
    const severityOf = new Function(`${printed}; return severityOf;`)() as (type: string, startTime: number) => string;
    const atFarm = (time: string) => Date.parse(`2026-11-10T${time}:00+05:00`) / 1000;

    it.each([
      ['06:59', 'urgent'],
      ['07:00', 'info'],
      ['12:30', 'info'],
      ['18:59', 'info'],
      ['19:00', 'urgent'],
      ['23:30', 'urgent'],
      ['03:00', 'urgent'],
    ])('a person at %s by the farm clock is %s (spec 16.3)', (time, severity) => {
      expect(severityOf('person', atFarm(time))).toBe(severity);
    });

    it('a vehicle is never urgent, at any hour', () => {
      expect(severityOf('vehicle', atFarm('03:00'))).toBe('attention');
      expect(severityOf('vehicle', atFarm('12:00'))).toBe('attention');
    });
  });

  describe('the detector section', () => {
    const printed = /## Smoke detectors and relays[\s\S]*?```js\n([\s\S]*?)```/.exec(docs)![1];

    /** The code as printed, with an MQTT broker and an outbox that do what the test says. */
    function detectorBridge() {
      const on: Record<string, (...args: any[]) => unknown> = {};
      const client = { on: (name: string, handler: (...args: any[]) => unknown) => (on[name] = handler), subscribe: vi.fn() };
      const sent: unknown[] = [];
      const body = printed.replace(/^(import|await flush|setInterval).*$/gm, '');
      new Function('mqtt', 'enqueue', body)({ connect: () => client }, async (event: unknown) => sent.push(event));
      on.connect();
      return { client, sent, say: (topic: string, text: string) => on.message(topic, Buffer.from(text)) };
    }

    it('says plainly that the platform detects nothing', () => {
      expect(docs).toContain('**The platform has no fire detection of its own.**');
    });

    it('sends one event when a detector goes off, not one per message, and one more after it stopped', async () => {
      const { client, sent, say } = detectorBridge();
      expect(client.subscribe).toHaveBeenCalledWith(['zigbee2mqtt/barn-smoke', 'relays/store-smoke/input']);

      await say('zigbee2mqtt/barn-smoke', '{"smoke":false}');
      expect(sent).toEqual([]);

      await say('zigbee2mqtt/barn-smoke', '{"smoke":true}');
      await say('zigbee2mqtt/barn-smoke', '{"smoke":true,"battery":80}');
      expect(sent).toEqual([{ deviceId: expect.any(String), type: 'smoke' }]);

      await say('zigbee2mqtt/barn-smoke', '{"smoke":false}');
      await say('zigbee2mqtt/barn-smoke', '{"smoke":true}');
      await say('relays/store-smoke/input', '1');
      expect(sent).toHaveLength(3);
    });

    it('what it sends raises the alert with no severity from the sender', async () => {
      const { f, key, device } = await setup();
      const { sent, say } = detectorBridge();
      await say('relays/store-smoke/input', '1');

      await ingest(f, key, '/events', { ...(sent[0] as object), deviceId: device.id });

      expect(await alertsFor(f)).toMatchObject([{ severity: 'urgent', status: 'open' }]);
    });
  });

  it('what a restart left on disk goes out, the oldest first and in batches', async () => {
    const { f, key, device } = await setup();
    let online = false;
    const out = await bridge(f, key, async (forward) => {
      if (!online) throw new TypeError('fetch failed');
      return forward();
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 120; i += 1) await out.enqueue({ deviceId: device.id, type: 'person', data: { i } });

    online = true;
    await vi.waitFor(() => expect(out.waiting()).toEqual([]), { timeout: 15_000 });

    const seen = (await reported(f)).map((event) => event.data.i as number);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  it('a key that was revoked keeps everything until it is fixed, and one bad event is dropped alone', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { f, key, device } = await setup();
    let revoked = true;
    const out = await bridge(f, key, async (forward) => (revoked ? new Response('{}', { status: 401 }) : forward()));

    await out.enqueue({ deviceId: device.id, type: 'person' });
    await out.enqueue({ deviceId: uuidv7(), type: 'person' });
    await out.enqueue({ deviceId: device.id, type: 'NOT A TYPE' });
    await vi.waitFor(() => expect(out.waiting()).toHaveLength(3));

    revoked = false;
    await vi.waitFor(() => expect(out.waiting()).toEqual([]), { timeout: 5_000 });

    expect(await reported(f)).toHaveLength(1);
    expect(errors.mock.calls.map(([line]) => /: (\w+)$/.exec(line as string)?.[1]).sort()).toEqual(['DEVICE_NOT_FOUND', 'VALIDATION_ERROR']);
  });

  it('a body the server will never take is cut down until only the event at fault is lost', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { f, key, device } = await setup();
    let tooLarge = 0;
    const out = await bridge(f, key, async (forward, _attempt, body) => {
      if (body.length <= 1_000_000) return forward();
      tooLarge += 1;
      return new Response('{}', { status: 413 });
    });

    await out.enqueue({ deviceId: device.id, type: 'person', data: { keep: 1 } });
    await out.enqueue({ deviceId: device.id, type: 'person', data: { blob: 'x'.repeat(1_100_000) } });
    await out.enqueue({ deviceId: device.id, type: 'person', data: { keep: 2 } });
    await vi.waitFor(() => expect(out.waiting()).toEqual([]), { timeout: 5_000 });

    expect((await reported(f)).map((event) => event.data.keep).sort()).toEqual([1, 2]);
    expect(tooLarge).toBeGreaterThan(0);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
