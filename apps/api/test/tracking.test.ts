import { addDays, todayIso } from '@yap/shared';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { renderAlert } from '../src/modules/alerts/alerts.service';
import { detectOffline } from '../src/modules/devices/devices.service';
import { applyRetention } from '../src/modules/settings/retention';
import { decodeObject, fromChirpstack, fromTheThingsStack, normalizeExternalId } from '../src/modules/tracking/decode';
import { evaluateHealth, releaseExited, summarizeDays } from '../src/modules/tracking/health.service';
import { createFixture, type Client, type Fixture } from './helpers';

const { alerts, animals, animalTrackDays, animalTracking, devices, species, trackerAssignments, trackerReadings, trackerState } = schema;

/** Near the farm; 0.001° of latitude is 111.2 m. */
const LAT = 39.5;
const LNG = 64.8;
const MIN = 60_000;

const eui = (i: number, prefix = 'A840410000') => `${prefix}${i.toString(16).padStart(6, '0')}`.toUpperCase();
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();

interface Farm {
  f: Fixture;
  owner: Client;
  key: string;
  herdId: string;
  sheep: { id: string; tag: string }[];
}

async function farm(n = 6, kind: 'collar' | 'bolus' = 'collar'): Promise<Farm> {
  const f = await createFixture();
  const owner = await f.as('owner');
  const key = (await owner.post('/settings/api-keys', { name: 'ChirpStack', scopes: ['events:write'] })).data.key as string;
  const herdId = (await owner.post('/livestock/herds', { name: 'Sovliqlar' })).data.id as string;
  const sheep = await f.run(async () => {
    const [sp] = await tx().select().from(species).where(eq(species.key, 'sheep'));
    return tx()
      .insert(animals)
      .values(
        Array.from({ length: n }, (_, i) => ({
          tenantId: f.tenantId,
          farmId: f.farmId,
          tag: `YA-${String(i + 1).padStart(4, '0')}`,
          speciesId: sp!.id,
          sex: 'female',
          category: 'ewe',
          origin: 'purchased',
          herdId,
        })),
      )
      .returning({ id: animals.id, tag: animals.tag });
  });
  const res = await owner.post('/tracking/trackers/import', { rows: sheep.map((s, i) => ({ externalId: eui(i), kind, animal: s.tag })) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.data.applied).toBe(true);
  return { f, owner, key, herdId, sheep };
}

async function send(f: Fixture, key: string | undefined, url: string, payload: unknown) {
  const res = await f.app.inject({
    method: 'POST',
    url: `/api/v1/tracking${url}`,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    payload: JSON.stringify(payload),
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

/** Readings in our own format: one per sheep, `place(i)` gives its latitude offset in degrees. */
const positions = (farmData: Farm, minutesAgo: number, place: (i: number) => number, extra: Record<string, unknown> = {}) =>
  send(farmData.f, farmData.key, '/readings', {
    readings: farmData.sheep.map((_, i) => ({ externalId: eui(i), recordedAt: ago(minutesAgo), lat: LAT + place(i), lng: LNG, ...extra })),
  });

const openAlerts = (f: Fixture, ruleKey: string) =>
  f.run(() =>
    tx()
      .select()
      .from(alerts)
      .where(and(eq(alerts.ruleKey, ruleKey), eq(alerts.status, 'open'))),
  );

describe('decoding what network servers send', () => {
  it('normalizes a DevEUI in any spelling', () => {
    expect(normalizeExternalId('a8-40-41-00-00-00-00-01')).toBe('A840410000000001');
    expect(normalizeExternalId('a8:40:41:00:00:00:00:01')).toBe('A840410000000001');
    expect(normalizeExternalId('SN-77812')).toBe('SN-77812');
    expect(normalizeExternalId('x')).toBeNull();
  });

  it('reads nested positions and drops what cannot be right', () => {
    expect(decodeObject({ gps: { latitude: 39.5, longitude: 64.8 }, steps: 40, battery: 81 }, 'collar')).toEqual({
      lat: 39.5,
      lng: 64.8,
      activity: 40,
      temperatureC: null,
      batteryPct: 81,
    });
    // No fix: 0,0 or a codec that says so. A collar's "temperature" is the air.
    expect(decodeObject({ latitude: 0, longitude: 0, temperature: 36 }, 'collar')).toMatchObject({ lat: null, lng: null, temperatureC: null });
    expect(decodeObject({ latitude: 39.5, longitude: 64.8, gnssFix: false }, 'collar')).toMatchObject({ lat: null, lng: null });
    // A bolus's temperature is the sheep's; out of 30-45 °C it is out of the sheep.
    expect(decodeObject({ temperature: 39.4 }, 'bolus').temperatureC).toBe(39.4);
    expect(decodeObject({ temperature: 12 }, 'bolus').temperatureC).toBeNull();
    // 3.6 is volts, not percent.
    expect(decodeObject({ battery: 3.6 }, 'collar').batteryPct).toBeNull();
    // A field map reaches anything.
    expect(decodeObject({ s: { t: 39.9 } }, 'ear_tag', { temperatureC: 's.t' }).temperatureC).toBe(39.9);
  });

  it('ChirpStack: up, status and location count; any other event is ignored', () => {
    const device = { deviceInfo: { devEui: 'a840410000000001' }, time: '2026-11-08T05:00:00Z' };
    expect(fromChirpstack('join', device)).toEqual({ ignored: 'join' });
    expect(fromChirpstack('up', { time: 'x' })).toEqual({ invalid: 'deviceInfo.devEui' });
    const up = fromChirpstack('up', { ...device, object: { lat: 39.5 }, rxInfo: [{ gatewayId: 'gw-far', rssi: -118 }, { gatewayId: 'gw-barn', rssi: -90, snr: 7 }] });
    expect(up).toMatchObject({ uplink: { externalId: 'A840410000000001', gatewayId: 'gw-barn', rssi: -90, snr: 7 } });
    expect(fromChirpstack('status', { ...device, batteryLevel: 55.5 })).toMatchObject({ uplink: { fields: { batteryPct: 55.5 } } });
  });

  it('The Things Stack: uplinks and solved locations', () => {
    const ids = { end_device_ids: { dev_eui: 'A840410000000002' }, received_at: '2026-11-08T05:00:00Z' };
    expect(fromTheThingsStack({ ...ids, join_accept: {} })).toEqual({ ignored: 'not an uplink' });
    expect(fromTheThingsStack({ ...ids, location_solved: { location: { latitude: 39.5, longitude: 64.8 } } })).toMatchObject({
      uplink: { fields: { lat: 39.5, lng: 64.8 } },
    });
  });
});

describe('ingest', () => {
  it('stores a ChirpStack uplink and updates the sheep, the tracker and the device', async () => {
    const x = await farm(1);
    const res = await send(x.f, x.key, '/ingest/chirpstack?event=up', {
      deviceInfo: { devEui: eui(0).toLowerCase() },
      time: ago(1),
      object: { latitude: LAT, longitude: LNG, battery: 87, activity: 12 },
      rxInfo: [{ gatewayId: 'gw-barn', rssi: -97, snr: 6.5 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ accepted: 1, empty: 0, unknown: [], rejected: [] });

    const [state] = await x.f.run(() => tx().select().from(animalTracking).where(eq(animalTracking.animalId, x.sheep[0]!.id)));
    expect(state).toMatchObject({ lat: LAT, lng: LNG, activity: 12 });
    const [tracker] = await x.f.run(() => tx().select().from(trackerState));
    expect(tracker).toMatchObject({ batteryPct: 87, gatewayId: 'gw-barn', rssi: -97 });
    const [device] = await x.f.run(() => tx().select().from(devices));
    expect(device!.status).toBe('online');
  });

  it('stores a repeat once, and a status event at the same time adds its battery to that row', async () => {
    const x = await farm(1);
    const time = ago(2);
    const up = { deviceInfo: { devEui: eui(0) }, time, object: { latitude: LAT, longitude: LNG } };
    await send(x.f, x.key, '/ingest/chirpstack?event=up', up);
    await send(x.f, x.key, '/ingest/chirpstack?event=up', up);
    await send(x.f, x.key, '/ingest/chirpstack?event=status', { deviceInfo: { devEui: eui(0) }, time, batteryLevel: 55 });
    const rows = await x.f.run(() => tx().select().from(trackerReadings));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lat: LAT, batteryPct: 55 });
  });

  it('a later reading wins even when an older one arrives after it', async () => {
    const x = await farm(1);
    await send(x.f, x.key, '/readings', { readings: [{ externalId: eui(0), recordedAt: ago(1), lat: LAT + 0.001, lng: LNG }] });
    await send(x.f, x.key, '/readings', { readings: [{ externalId: eui(0), recordedAt: ago(30), lat: LAT, lng: LNG }] });
    const [state] = await x.f.run(() => tx().select().from(animalTracking));
    expect(state!.lat).toBeCloseTo(LAT + 0.001, 6);
  });

  it('takes The Things Stack webhooks', async () => {
    const x = await farm(1);
    const res = await send(x.f, x.key, '/ingest/tts', {
      end_device_ids: { dev_eui: eui(0) },
      uplink_message: {
        received_at: ago(1),
        decoded_payload: { latitude: LAT, longitude: LNG },
        rx_metadata: [{ gateway_ids: { gateway_id: 'gw-1' }, rssi: -100, snr: 3 }],
        last_battery_percentage: { value: 64 },
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await x.f.run(() => tx().select().from(trackerReadings));
    expect(row).toMatchObject({ lat: LAT, gatewayId: 'gw-1', batteryPct: 64 });
  });

  it('counts an uplink with nothing decoded as empty: the codec is missing', async () => {
    const x = await farm(1);
    const res = await send(x.f, x.key, '/ingest/chirpstack?event=up', { deviceInfo: { devEui: eui(0) }, time: ago(1), object: { latitude: 0, longitude: 0 } });
    expect(res.body.data).toMatchObject({ accepted: 1, empty: 1 });
    expect(await x.f.run(() => tx().select().from(trackerReadings))).toHaveLength(0);
    expect(await x.f.run(() => tx().select().from(trackerState))).toHaveLength(1);
  });

  it('answers 204 to other ChirpStack events and 400 to a message without a DevEUI', async () => {
    const x = await farm(1);
    expect((await send(x.f, x.key, '/ingest/chirpstack?event=join', { deviceInfo: { devEui: eui(0) } })).status).toBe(204);
    const bad = await send(x.f, x.key, '/ingest/chirpstack?event=up', { time: ago(1) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_UPLINK');
  });

  it('lists unknown trackers without failing, and refuses a missing or wrong key', async () => {
    const x = await farm(1);
    const res = await send(x.f, x.key, '/readings', { readings: [{ externalId: 'FFFF000000000001', recordedAt: ago(1), lat: LAT, lng: LNG }] });
    expect(res.status).toBe(200);
    expect(res.body.data.unknown).toEqual(['FFFF000000000001']);

    const reading = { readings: [{ externalId: eui(0), recordedAt: ago(1), lat: LAT, lng: LNG }] };
    expect((await send(x.f, undefined, '/readings', reading)).status).toBe(401);
    expect((await send(x.f, 'yap_wrong_key_0000000000000000', '/readings', reading)).status).toBe(401);
    expect(await x.f.run(() => tx().select().from(trackerReadings))).toHaveLength(0);
  });

  it("another workspace's key cannot write to this farm's tracker", async () => {
    const mine = await farm(1);
    const stranger = await createFixture();
    const owner = await stranger.as('owner');
    const theirKey = (await owner.post('/settings/api-keys', { name: 'Edge', scopes: ['events:write'] })).data.key as string;
    const res = await send(stranger, theirKey, '/readings', { readings: [{ externalId: eui(0), recordedAt: ago(1), lat: LAT + 1, lng: LNG }] });
    expect(res.status).toBe(200);
    expect(res.body.data.unknown).toEqual([eui(0)]);
    expect(await mine.f.run(() => tx().select().from(trackerReadings))).toHaveLength(0);
  });
});

describe('fitting trackers', () => {
  it('a dry run changes nothing; any bad row stops the whole import', async () => {
    const x = await farm(2);
    const dry = await x.owner.post('/tracking/trackers/import', {
      dryRun: true,
      rows: [{ externalId: eui(9), kind: 'collar', animal: 'YA-0001' }],
    });
    expect(dry.data).toMatchObject({ applied: false, summary: { register: 1, fit: 1, move: 0, errors: 0 } });

    const bad = await x.owner.post('/tracking/trackers/import', {
      rows: [
        { externalId: eui(10), kind: 'bolus', animal: 'YA-0001' },
        { externalId: 'not-hex!', kind: 'bolus', animal: 'YA-0002' },
        { externalId: eui(11), kind: 'bolus', animal: 'YA-9999' },
        { externalId: eui(10), kind: 'bolus', animal: 'YA-0002' },
      ],
    });
    expect(bad.data.applied).toBe(false);
    expect(bad.data.rows.map((r: { error: string | null }) => r.error)).toEqual([null, 'INVALID_EXTERNAL_ID', 'ANIMAL_NOT_FOUND', 'DUPLICATE_IN_IMPORT']);
    const devicesNow = await x.f.run(() => tx().select().from(devices));
    expect(devicesNow).toHaveLength(2); // only the two collars from setup
  });

  it('moving a collar takes it off the first sheep, and a second collar replaces the first', async () => {
    const x = await farm(2);
    const moved = await x.owner.post('/tracking/trackers/import', { rows: [{ externalId: eui(0), kind: 'collar', animal: 'YA-0002' }] });
    expect(moved.data.summary).toMatchObject({ move: 1, fit: 1 });
    const open = await x.f.run(() => tx().select().from(trackerAssignments).where(eq(trackerAssignments.animalId, x.sheep[1]!.id)));
    // YA-0002 wore collar 1; collar 0 replaced it.
    expect(open.filter((a) => a.removedOn === null)).toHaveLength(1);
    const onFirst = await x.f.run(() => tx().select().from(trackerAssignments).where(eq(trackerAssignments.animalId, x.sheep[0]!.id)));
    expect(onFirst.every((a) => a.removedOn !== null)).toBe(true);

    const list = await x.owner.get('/tracking/trackers', { fitted: 'no' });
    expect(list.data.map((t: { externalId: string }) => t.externalId)).toEqual([eui(1)]);
  });

  it('fits and removes one tracker; a shepherd sees the map but may not fit', async () => {
    const x = await farm(1);
    const [assignment] = await x.f.run(() => tx().select().from(trackerAssignments));
    const removed = await x.owner.post(`/tracking/assignments/${assignment!.id}/remove`, {});
    expect(removed.status).toBe(200);
    expect((await x.owner.post(`/tracking/assignments/${assignment!.id}/remove`, {})).body.error.code).toBe('TRACKER_ALREADY_REMOVED');

    const shepherd = await x.f.as('shepherd');
    expect((await shepherd.get('/tracking/live')).status).toBe(200);
    expect((await shepherd.post('/tracking/assignments', { deviceId: assignment!.deviceId, animalId: x.sheep[0]!.id })).status).toBe(403);
    expect((await shepherd.post('/tracking/trackers/import', { rows: [{ externalId: eui(5), kind: 'collar' }] })).status).toBe(403);

    const fitted = await x.owner.post('/tracking/assignments', { deviceId: assignment!.deviceId, animalId: x.sheep[0]!.id });
    expect(fitted.status, JSON.stringify(fitted.body)).toBe(201);
  });

  it('a tracker comes off an animal that left the farm, on the day it left', async () => {
    const x = await farm(1);
    const exitDate = addDays(todayIso(), -2);
    await x.f.run(() => tx().update(animals).set({ status: 'sold', exitDate }).where(eq(animals.id, x.sheep[0]!.id)));
    expect(await x.f.run(() => releaseExited())).toBe(1);
    const [a] = await x.f.run(() => tx().select().from(trackerAssignments));
    // It was fitted today, after the exit date, so it comes off the day it went on.
    expect(a!.removedOn).toBe(todayIso());
  });
});

describe('health rules', () => {
  it('a sheep 800 m from its flock raises an alert for the shepherd and the vet, and it clears when she is back', async () => {
    const x = await farm(6);
    const stray = (i: number) => (i === 5 ? 0.0072 : i * 0.0001);
    await positions(x, 10, stray);
    await positions(x, 1, stray);
    await x.f.run(() => evaluateHealth(new Date(), false));

    const raised = await openAlerts(x.f, 'animal_isolated');
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ entityId: x.sheep[5]!.id, severity: 'attention' });
    expect(raised[0]!.notifyRoles).toContain('shepherd');
    expect(renderAlert(raised[0]!, 'en').title).toBe('YA-0006 is apart from its herd');
    const [state] = await x.f.run(() => tx().select().from(animalTracking).where(eq(animalTracking.animalId, x.sheep[5]!.id)));
    expect(state!.flags.isolated).toBeTruthy();

    await positions(x, 0, (i) => i * 0.0001);
    await x.f.run(() => evaluateHealth(new Date(), false));
    expect(await openAlerts(x.f, 'animal_isolated')).toHaveLength(0);
  });

  it('a split flock is one herd alert, not one per sheep', async () => {
    const x = await farm(10);
    const place = (i: number) => (i >= 7 ? 0.02 + i * 0.0001 : i * 0.0001);
    await positions(x, 10, place);
    await positions(x, 1, place);
    await x.f.run(() => evaluateHealth(new Date(), false));
    expect(await openAlerts(x.f, 'animal_isolated')).toHaveLength(0);
    const split = await openAlerts(x.f, 'tracking_herd_split');
    expect(split).toHaveLength(1);
    expect(split[0]!.data).toMatchObject({ apart: 3, tracked: 10 });
  });

  it('a fever is above the herd and above her own normal; 2 °C over the herd is urgent', async () => {
    const x = await farm(6, 'bolus');
    // Three earlier days at 39.1 °C for every sheep.
    await x.f.run(() =>
      tx()
        .insert(animalTrackDays)
        .values(
          x.sheep.flatMap((s) =>
            [1, 2, 3].map((back) => ({
              tenantId: x.f.tenantId,
              farmId: x.f.farmId,
              animalId: s.id,
              date: addDays(todayIso(), -back),
              readings: 48,
              fixes: 0,
              temperatureMedianC: 39.1,
            })),
          ),
        ),
    );
    const temps = (minutesAgo: number, hot: number) =>
      send(x.f, x.key, '/readings', {
        readings: x.sheep.map((_, i) => ({ externalId: eui(i), recordedAt: ago(minutesAgo), temperatureC: i === 5 ? hot : 39.1 })),
      });
    await temps(40, 40.5);
    await temps(10, 40.5);
    await x.f.run(() => evaluateHealth(new Date(), false));
    const [fever] = await openAlerts(x.f, 'animal_fever');
    expect(fever).toMatchObject({ entityId: x.sheep[5]!.id, severity: 'attention' });
    expect(fever!.data).toMatchObject({ temperature: 40.5, overHerd: 1.4 });

    // The hour's median now: 40.5, 40.5, 41.6, 41.6, 41.6 gives 41.6, which is 2.5 °C over the herd.
    await temps(5, 41.6);
    await temps(3, 41.6);
    await temps(1, 41.6);
    await x.f.run(() => evaluateHealth(new Date(), false));
    const [urgent] = await openAlerts(x.f, 'animal_fever');
    expect(urgent!.severity).toBe('urgent');
  });

  it('silent trackers and low batteries are one alert each for the farm', async () => {
    const x = await farm(6);
    await positions(x, 180, (i) => i * 0.0001, { batteryPct: 15 });
    await x.f.run(() => evaluateHealth(new Date(), true));
    const [silent] = await openAlerts(x.f, 'tracking_silent');
    expect(silent!.data).toMatchObject({ count: 6, total: 6, textKey: 'tracking_silent_all' });
    expect(renderAlert(silent!, 'en').title).toBe('No tracker is reporting');
    const [battery] = await openAlerts(x.f, 'tracking_battery');
    expect(battery!.data).toMatchObject({ count: 6 });

    // The first run after the server was away does not judge silence.
    await x.f.run(() => tx().update(alerts).set({ status: 'resolved' }));
    await x.f.run(() => evaluateHealth(new Date(), false));
    expect(await openAlerts(x.f, 'tracking_silent')).toHaveLength(0);
  });

  it('a bolus out on the pasture is quiet for hours without counting as silent; a whole night is too long', async () => {
    const x = await farm(6, 'bolus');
    const temps = (minutesAgo: number) =>
      send(x.f, x.key, '/readings', { readings: x.sheep.map((_, i) => ({ externalId: eui(i), recordedAt: ago(minutesAgo), temperatureC: 39.1 })) });
    await temps(180);
    await x.f.run(() => evaluateHealth(new Date(), true));
    expect(await openAlerts(x.f, 'tracking_silent')).toHaveLength(0);

    await x.f.run(() => tx().update(trackerState).set({ lastReadingAt: new Date(Date.now() - 15 * 60 * MIN) }));
    await x.f.run(() => evaluateHealth(new Date(), true));
    const [silent] = await openAlerts(x.f, 'tracking_silent');
    expect(silent!.data).toMatchObject({ count: 6, hours: 2, bolusHours: 14 });
  });

  it('the per-device offline check leaves trackers alone', async () => {
    const x = await farm(1);
    await x.f.run(() => tx().update(devices).set({ status: 'online', lastSeenAt: new Date(Date.now() - 60 * MIN) }));
    expect(await x.f.run(() => detectOffline())).toBe(0);
  });
});

describe('history', () => {
  it("summarises yesterday, and retention keeps the summary when the raw readings go", async () => {
    const x = await farm(1);
    const yesterdayNoon = new Date(`${addDays(todayIso(), -1)}T07:00:00Z`); // 12:00 in Tashkent
    const [device] = await x.f.run(() => tx().select().from(devices));
    await x.f.run(() =>
      tx()
        .insert(trackerReadings)
        .values(
          [0, 0.001].map((d, i) => ({
            tenantId: x.f.tenantId,
            farmId: x.f.farmId,
            deviceId: device!.id,
            animalId: x.sheep[0]!.id,
            recordedAt: new Date(yesterdayNoon.getTime() + i * 10 * MIN),
            lat: LAT + d,
            lng: LNG,
            temperatureC: 39 + i,
          })),
        ),
    );
    await x.f.run(() => summarizeDays());
    const [day] = await x.f.run(() => tx().select().from(animalTrackDays));
    expect(day).toMatchObject({ date: addDays(todayIso(), -1), readings: 2, fixes: 2, temperatureMedianC: 39.5, temperatureMaxC: 40 });
    expect(day!.distanceM).toBeCloseTo(111.2, 1);

    await x.f.run(() => applyRetention(new Date(Date.now() + 40 * 86_400_000)));
    expect(await x.f.run(() => tx().select().from(trackerReadings))).toHaveLength(0);
    expect(await x.f.run(() => tx().select().from(animalTrackDays))).toHaveLength(1);
  });

  it('the map, the passport and the track read back what came in; another workspace sees nothing', async () => {
    const x = await farm(6);
    await positions(x, 20, (i) => i * 0.0001, { temperatureC: 39.2 });
    await positions(x, 5, (i) => i * 0.0001 + 0.0005);

    const live = await x.owner.get('/tracking/live');
    expect(live.data.summary).toMatchObject({ tracked: 6, located: 6, silent: 0 });
    expect(live.data.herds[0]).toMatchObject({ id: x.herdId, tracked: 6, located: 6 });
    expect(live.data.herds[0].centre.lat).toBeCloseTo(LAT + 0.0005 + 0.00025, 6);

    const id = x.sheep[0]!.id;
    const passport = await x.owner.get(`/tracking/animals/${id}`);
    expect(passport.data.trackers).toHaveLength(1);
    expect(passport.data.state.lat).toBeCloseTo(LAT + 0.0005, 6);
    const trackRes = await x.owner.get(`/tracking/animals/${id}/track`);
    expect(trackRes.data.points).toHaveLength(2);
    const series = await x.owner.get(`/tracking/animals/${id}/series`, { days: 1 });
    expect(series.data.hourly.length).toBeGreaterThan(0);

    const stranger = await (await createFixture()).as('owner');
    expect((await stranger.get(`/tracking/animals/${id}`)).status).toBe(404);
  });
});
