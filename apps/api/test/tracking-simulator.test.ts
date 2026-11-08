import { herdIsolation, median, type AnimalFixes } from '@yap/shared/formulas/tracking';
import { and, eq, like } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { tx } from '../src/core/context';
import { fromChirpstack, readingFields } from '../src/modules/tracking/decode';
import { evaluateHealth, summarizeDays } from '../src/modules/tracking/health.service';
import { SIM_PREFIX, loadFarm, removeSimulation, setupSimulation } from '../src/modules/tracking/simulator/farm';
import { backfill, chirpstackUp, live, type Transport } from '../src/modules/tracking/simulator/runner';
import { World, inside, type LatLng, type SimFarm } from '../src/modules/tracking/simulator/world';
import { createFixture, type Fixture } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The demo farm's barn and pasture, in metres from its origin (seed/land.ts). */
const ORIGIN = { lat: 39.743439, lng: 64.794201 };
const at = (x: number, y: number): LatLng => ({ lat: ORIGIN.lat + y / 111_000, lng: ORIGIN.lng + x / 85_705 });
const pen = [at(130, -130), at(250, -130), at(250, -185), at(130, -185)];
const pasture = [at(-640, 1890), at(420, 1210), at(660, 1330), at(660, 2000), at(0, 2330), at(-640, 2330)];

function flock(n = 700): SimFarm {
  return {
    seed: 'test-farm',
    tzOffsetMin: 300,
    herds: [{ id: 'herd', name: "Bo'g'oz sovliqlar", pen, pasture, trough: at(420, 1215) }],
    sheep: Array.from({ length: n }, (_, i) => ({
      animalId: `animal-${i}`,
      tag: `YA-${String(i + 1).padStart(4, '0')}`,
      herdId: 'herd',
      collar: `53494D01${i.toString(16).padStart(8, '0')}`.toUpperCase(),
      bolus: `53494D02${i.toString(16).padStart(8, '0')}`.toUpperCase(),
    })),
    gateways: [
      { id: 'gw-barn-roof', at: at(190, -157) },
      { id: 'gw-trough-mast-1', at: at(420, 1215) },
    ],
  };
}

/** A moment on 2026-11-10, farm time (UTC+5). */
const local = (h: number, m = 0) => Date.UTC(2026, 10, 10, h - 5, m);
const xy = (p: LatLng) => ({ x: (p.lng - ORIGIN.lng) * 85_705, y: (p.lat - ORIGIN.lat) * 111_000 });

describe('the simulated flock', () => {
  const world = new World(flock());
  const sheep = world.farm.sheep;

  it('tells the same story every time, however the hours are cut', () => {
    const a = world.uplinks(local(9), local(11));
    const b = [...world.uplinks(local(9), local(10)), ...world.uplinks(local(10), local(11))];
    expect(b).toEqual(a);
    expect(new World(flock()).uplinks(local(9), local(11))).toEqual(a);
  });

  it('sleeps in the barn, grazes on the pasture, rests at the trough', () => {
    const where = (t: number) => sheep.map((s) => world.sheepAt(s, t));
    const night = where(local(3));
    expect(night.every((s) => s.phase === 'night' && inside(pen.map(xy), xy(s.position)))).toBe(true);

    const grazing = where(local(10)).filter((s) => !s.strayed);
    expect(grazing.filter((s) => inside(pasture.map(xy), xy(s.position))).length / grazing.length).toBeGreaterThan(0.98);

    const resting = where(local(12, 50));
    const trough = xy(at(420, 1215));
    expect(median(resting.map((s) => Math.hypot(xy(s.position).x - trough.x, xy(s.position).y - trough.y)))).toBeLessThan(80);
  });

  it('sends a collar message every 15 minutes and a bolus every 30, and the rumen is heard only near a gateway', () => {
    const day = world.uplinks(local(0), local(24));
    const collars = day.filter((u) => u.kind === 'collar');
    expect(collars.length / sheep.length).toBeGreaterThan(90); // of 96, less collisions and failed fixes heard as such
    const bolusesAt = (from: number, to: number) => world.uplinks(from, to).filter((u) => u.kind === 'bolus').length / sheep.length;
    // In the barn, next to the roof gateway, nearly every bolus message arrives; out on the pasture few do.
    expect(bolusesAt(local(2), local(4))).toBeGreaterThan(3.7);
    expect(bolusesAt(local(9), local(11))).toBeLessThan(1.5);
  });

  it('within a week a sheep strays, and the health rule finds exactly that sheep', () => {
    let found = false;
    for (let t = local(9) - 6 * DAY; t < local(16) + DAY && !found; t += 15 * MIN) {
      const states = sheep.map((s) => world.sheepAt(s, t));
      const stray = states.find((s) => s.strayed);
      if (!stray || states.find((s) => s.animalId === stray.animalId)!.phase !== 'graze') continue;
      const before = sheep.map((s) => world.sheepAt(s, t - 15 * MIN));
      const fixes: AnimalFixes[] = sheep.map((s, i) => ({
        animalId: s.animalId,
        fixes: [
          { ...before[i]!.position, at: t - 15 * MIN },
          { ...states[i]!.position, at: t },
        ],
      }));
      const result = herdIsolation(fixes, t);
      if (result?.kind !== 'ok' || result.isolated.length === 0) continue;
      expect(result.isolated.map((x) => x.animalId)).toContain(stray.animalId);
      found = true;
    }
    expect(found).toBe(true);
  });

  it('a sick sheep runs a fever well above the herd, while drinking only dips it', () => {
    let peak = { overHerd: 0, tag: '' };
    for (let t = local(3) - 6 * DAY; t < local(3) + DAY; t += 6 * HOUR) {
      const states = sheep.map((s) => world.sheepAt(s, t));
      const herd = median(states.map((s) => s.temperatureC))!;
      for (const s of states.filter((x) => x.ill)) {
        if (s.temperatureC - herd > peak.overHerd) peak = { overHerd: s.temperatureC - herd, tag: s.tag };
      }
    }
    expect(peak.overHerd).toBeGreaterThan(1.0);
    const healthy = sheep.map((s) => world.sheepAt(s, local(3))).filter((s) => !s.ill).map((s) => s.temperatureC);
    expect(Math.min(...healthy)).toBeGreaterThan(37.5);
    expect(Math.max(...healthy)).toBeLessThan(40.2);
  });

  it('leaves a few collars nearly flat, as some arrive', () => {
    const low = sheep.filter((s) => world.batteryAt(s.collar, 'collar', local(12)) < 20).length;
    expect(low).toBeGreaterThan(2);
    expect(low).toBeLessThan(30);
  });

  it('speaks ChirpStack: its up events decode like a real one', () => {
    const [u] = world.uplinks(local(10), local(10, 20)).filter((x) => x.kind === 'collar');
    const adapted = fromChirpstack('up', chirpstackUp(u!, 'Test flock'));
    if (!('uplink' in adapted)) throw new Error('not decoded');
    expect(adapted.uplink.externalId).toBe(u!.devEui);
    const fields = readingFields(adapted.uplink, 'collar');
    expect(fields.lat).not.toBeNull();
    expect(fields.activity).toBeGreaterThanOrEqual(0);
  });
});

describe('simulating on a farm, end to end', () => {
  async function smallFlock(f: Fixture, n: number) {
    const owner = await f.as('owner');
    const herdId = (await owner.post('/livestock/herds', { name: 'Sovliqlar' })).data.id as string;
    await f.run(async () => {
      const [sp] = await tx().select().from(schema.species).where(eq(schema.species.key, 'sheep'));
      await tx()
        .insert(schema.animals)
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
        );
    });
  }

  const inject = (f: Fixture, key: string): Transport => ({
    async post(path, body) {
      const res = await f.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', 'x-api-key': key }, payload: JSON.stringify(body) });
      return { status: res.statusCode, body: res.body ? res.json() : null };
    },
  });

  it('fits every sheep, fills a day of history, goes live, and leaves nothing behind when removed', async () => {
    const f = await createFixture();
    await smallFlock(f, 12);

    const simFarm = await f.run(loadFarm);
    expect(simFarm.sheep).toHaveLength(12);
    const first = await f.run(() => setupSimulation(simFarm));
    expect({ fitted: first.fitted, registered: first.registered }).toEqual({ fitted: 24, registered: 24 });
    // A second start fits nothing new, and its key replaces the first.
    const { key, fitted } = await f.run(() => setupSimulation(simFarm));
    expect(fitted).toBe(0);
    const one = { readings: [{ externalId: simFarm.sheep[0]!.collar, recordedAt: new Date().toISOString(), batteryPct: 90 }] };
    expect((await inject(f, first.key).post('/api/v1/tracking/readings', one)).status).toBe(401);

    const world = new World(simFarm);
    const now = Date.now();
    const sent = await backfill(world, inject(f, key), now - DAY, now - MIN, () => {});
    expect(sent).toBeGreaterThan(12 * 80);
    expect(await f.run(() => summarizeDays())).toBeGreaterThanOrEqual(0);
    await f.run(() => evaluateHealth(new Date(), true));

    const stop = new AbortController();
    await live(world, inject(f, key), now - 20 * MIN, { tickMs: 5000, applicationName: 'Test', log: () => {}, signal: stop.signal, onTick: () => stop.abort() });

    const owner = await f.as('owner');
    const map = await owner.get('/tracking/live');
    expect(map.data.summary.tracked).toBe(12);
    expect(map.data.summary.located).toBeGreaterThan(9);

    const removed = await f.run(removeSimulation);
    expect(removed.trackers).toBe(24);
    const left = await f.run(async () => [
      await tx().select().from(schema.devices).where(and(eq(schema.devices.farmId, f.farmId), like(schema.devices.externalId, `${SIM_PREFIX}%`))),
      await tx().select().from(schema.trackerReadings),
      await tx().select().from(schema.animalTracking),
    ]);
    expect(left.map((rows) => rows.length)).toEqual([0, 0, 0]);
    expect((await owner.get('/tracking/live')).data.summary.tracked).toBe(0);
  });
});
