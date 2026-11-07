import { addDays, todayIso } from '@yap/shared';
import { and, eq, sql } from 'drizzle-orm';
import proj4 from 'proj4';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ctx, tx } from '../src/core/context';
import { schema } from '../src/db/client';
import {
  CELL_M,
  pickScenes,
  readField,
  satelliteSources,
  type BandWindow,
  type SceneRef,
} from '../src/modules/farm/satellite.service';
import { createFixture, type Fixture } from './helpers';

const UTM = '+proj=utm +zone=41 +datum=WGS84 +units=m +no_defs';
const today = () => todayIso();
const day = (offset: number) => addDays(today(), offset);

/** Metres per degree at latitude 39.5 on WGS84. */
const M_LNG = 86_013;
const M_LAT = 111_025;
const LNG = 64.8;
const LAT = 39.5;

function rect(lng: number, lat: number, widthM: number, heightM: number) {
  const dx = widthM / M_LNG;
  const dy = heightM / M_LAT;
  return { type: 'Polygon', coordinates: [[[lng, lat], [lng + dx, lat], [lng + dx, lat + dy], [lng, lat + dy], [lng, lat]]] };
}

/** DN for a reflectance, with the −0.1 offset of processing baseline 04.00 and later. */
const dn = (reflectance: number) => Math.round((reflectance + 0.1) * 10_000);
/** NDVI 0.6 and 0.2. */
const HEALTHY = { red: dn(0.05), nir: dn(0.2) };
const WEAK = { red: dn(0.1), nir: dn(0.15) };

type Pixel = { red: number; nir: number; scl: number };

/** A fake image reader: each band is a north-up window at its own resolution, valued by a function of UTM position. */
function fakeReader(pixel: (x: number, y: number) => Pixel) {
  return vi.fn(async (href: string, bounds: [number, number, number, number]): Promise<BandWindow> => {
    const band = href.split('/').pop() as 'red' | 'nir' | 'scl';
    const resolution = band === 'scl' ? 20 : 10;
    const originX = Math.floor(bounds[0] / resolution) * resolution;
    const originY = Math.ceil(bounds[3] / resolution) * resolution;
    const width = Math.ceil((bounds[2] - originX) / resolution);
    const height = Math.ceil((originY - bounds[1]) / resolution);
    const values = new Uint16Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        values[row * width + col] = pixel(originX + (col + 0.5) * resolution, originY - (row + 0.5) * resolution)[band];
      }
    }
    return { values, width, height, originX, originY, resolution };
  });
}

function scene(id: string, date: string, tileCloudPct = 2): SceneRef {
  return {
    id,
    date,
    tileCloudPct,
    epsg: 32641,
    bbox: [60, 39, 66, 41],
    red: { href: 'mem://scene/red', scale: 0.0001, offset: -0.1 },
    nir: { href: 'mem://scene/nir', scale: 0.0001, offset: -0.1 },
    scl: { href: 'mem://scene/scl' },
  };
}

/** A 300 × 200 m field with a 60 m square weak patch in the middle. */
const FIELD = rect(LNG, LAT, 300, 200);
const [CX, CY] = proj4('EPSG:4326', UTM).forward([LNG + 150 / M_LNG, LAT + 100 / M_LAT]);
const withPatch = (x: number, y: number): Pixel => ({
  ...(Math.abs(x - CX) < 30 && Math.abs(y - CY) < 30 ? WEAK : HEALTHY),
  scl: 4,
});

async function bandsFor(pixel: (x: number, y: number) => Pixel) {
  const read = fakeReader(pixel);
  const bounds: [number, number, number, number] = [CX - 400, CY - 300, CX + 400, CY + 300];
  return {
    red: await read('mem://red', bounds),
    nir: await read('mem://nir', bounds),
    scl: await read('mem://scl', bounds),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('scene choice', () => {
  const farm: [number, number, number, number] = [64.79, 39.74, 64.81, 39.75];
  const item = (id: string, datetime: string, bbox: number[], extra: Record<string, unknown> = {}) => ({
    id,
    bbox,
    properties: { datetime, 'eo:cloud_cover': 5, 'proj:epsg': 32641, ...extra },
    assets: {
      red: { href: `https://x/${id}/B04.tif`, 'raster:bands': [{ scale: 0.0001, offset: -0.1 }] },
      nir: { href: `https://x/${id}/B08.tif` },
      scl: { href: `https://x/${id}/SCL.tif` },
    },
  });
  const whole = [63.5, 39.0, 65.5, 40.5];

  it('keeps the latest processing, skips tiles that miss part of the farm, and sorts newest first', () => {
    const picked = pickScenes(
      [
        item('S2B_41TPE_20261013_0_L2A', '2026-10-13T06:38:11Z', whole),
        item('S2B_41TPE_20261013_1_L2A', '2026-10-13T06:38:11Z', whole),
        item('S2B_41TQE_20261013_0_L2A', '2026-10-13T06:38:11Z', [64.8, 39.0, 66.0, 40.5]),
        item('S2C_41TPE_20261018_0_L2A', '2026-10-18T06:38:13Z', whole, { 'proj:epsg': undefined, 'proj:code': 'EPSG:32641' }),
        item('S2A_41TPE_20261020_0_L2A', '2026-10-20T06:38:22Z', whole, { 'proj:epsg': undefined }),
        { id: 'broken' },
      ],
      farm,
      'Asia/Tashkent',
    );
    expect(picked.map((s) => s.id)).toEqual(['S2C_41TPE_20261018_0_L2A', 'S2B_41TPE_20261013_1_L2A']);
    expect(picked[1]).toMatchObject({ date: '2026-10-13', epsg: 32641, red: { scale: 0.0001, offset: -0.1 }, nir: { scale: 0.0001, offset: -0.1 } });
  });

  it('uses the farm date, and of two tiles on one date the clearer', () => {
    const picked = pickScenes(
      [
        item('S2B_41TPE_20261101_0_L2A', '2026-11-01T20:30:00Z', whole, { 'eo:cloud_cover': 40 }),
        item('S2B_41SPD_20261101_0_L2A', '2026-11-01T20:30:00Z', whole, { 'eo:cloud_cover': 10 }),
      ],
      farm,
      'Asia/Tashkent',
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ id: 'S2B_41SPD_20261101_0_L2A', date: '2026-11-02' });
  });
});

describe('field reading', () => {
  const shape = { id: 'f', rings: FIELD.coordinates as [number, number][][] };

  it('maps NDVI at 10 m and finds the weak patch to walk to', async () => {
    const reading = readField(shape, await bandsFor(withPatch), scene('s', day(0)))!;
    expect(reading.clearPct).toBe(100);
    // 300 × 200 m in 10 m cells.
    expect(reading.cellCount).toBeGreaterThanOrEqual(570);
    expect(reading.cellCount).toBeLessThanOrEqual(630);
    expect(reading.stats!.p50).toBeCloseTo(0.6, 3);
    expect(reading.stats!.p10).toBeCloseTo(0.6, 3);
    expect(reading.stats!.mean).toBeGreaterThan(0.55);
    expect(reading.stats!.mean).toBeLessThan(0.6);

    expect(reading.weakZones).toHaveLength(1);
    const [zone] = reading.weakZones;
    // 60 × 60 m is 0.36 ha; cell edges and pixel edges do not line up exactly.
    expect(zone.areaHa).toBeGreaterThanOrEqual(0.25);
    expect(zone.areaHa).toBeLessThanOrEqual(0.49);
    expect(zone.meanNdvi).toBeCloseTo(0.2, 3);
    const [zx, zy] = proj4('EPSG:4326', UTM).forward([zone.lng, zone.lat]);
    expect(Math.hypot(zx - CX, zy - CY)).toBeLessThan(15);

    // The grid covers the field north-up, in degrees, with unknown cells marked 255.
    const { grid } = reading;
    expect(grid.width).toBe(Math.ceil(300 / CELL_M));
    expect(grid.west).toBe(LNG);
    expect(grid.north).toBeCloseTo(LAT + 200 / M_LAT, 6);
    const bytes = Buffer.from(grid.data, 'base64');
    expect(bytes).toHaveLength(grid.width * grid.height);
    expect(bytes[grid.width + 1]).toBe(160);
    expect([...bytes].filter((b) => b === 120).length).toBe(Math.round(zone.areaHa * 100));
  });

  it('counts cloud and shadow as not clear', async () => {
    const [westEdge] = proj4('EPSG:4326', UTM).forward([LNG, LAT]);
    const cloudy = (x: number, y: number): Pixel => ({ ...HEALTHY, scl: x < westEdge + 120 ? 9 : y < CY - 60 ? 3 : 4 });
    const reading = readField(shape, await bandsFor(cloudy), scene('s', day(0)))!;
    expect(reading.clearPct).toBeGreaterThan(30);
    expect(reading.clearPct).toBeLessThan(55);
  });

  it('finds no weak zones on a bare field', async () => {
    const bare = (): Pixel => ({ red: dn(0.2), nir: dn(0.25), scl: 5 });
    const reading = readField(shape, await bandsFor(bare), scene('s', day(0)))!;
    expect(reading.stats!.p50).toBeLessThan(0.3);
    expect(reading.weakZones).toEqual([]);
  });
});

describe('satellite refresh and field health', () => {
  async function fieldOf(f: Fixture, body: Record<string, unknown> = {}) {
    const owner = await f.as('owner');
    const res = await owner.post('/farm/fields', { number: `S${Math.random().toString(36).slice(2, 6)}`, landUse: 'arable', boundary: FIELD, ...body });
    expect(res.status).toBe(201);
    return res.data.id as string;
  }

  it('reads new scenes once, stores clear fields, and serves the map and the curve', async () => {
    const f = await createFixture();
    const fieldId = await fieldOf(f);
    const search = vi.spyOn(satelliteSources, 'search').mockResolvedValue([scene('S2B_A', day(-3)), scene('S2B_B', day(-8))]);
    const read = vi.spyOn(satelliteSources, 'read').mockImplementation(fakeReader(withPatch));

    const owner = await f.as('owner');
    const res = await owner.post('/farm/satellite/refresh');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ scenes: 2, readings: 2, pending: 0, unavailable: false });
    // One window for the whole farm per band.
    expect(read).toHaveBeenCalledTimes(6);
    const [bbox, from, to] = search.mock.calls[0];
    expect(bbox[0]).toBeCloseTo(LNG, 6);
    expect(from).toBe(day(-120));
    expect(to).toBe(day(0));

    const health = (await owner.get(`/farm/satellite/fields/${fieldId}`)).data;
    expect(health.latest).toMatchObject({ date: day(-3), clearPct: 100 });
    expect(health.latest.grid.width).toBe(30);
    expect(health.latest.weakZones).toHaveLength(1);
    expect(health.series.map((p: any) => p.date)).toEqual([day(-8), day(-3)]);
    expect(health.previousMean).toBeCloseTo(health.latest.ndviMean, 3);
    expect(health.lastSceneDate).toBe(day(-3));
    expect(health.pasture).toBeNull();

    const latest = (await owner.get('/farm/satellite/latest')).data;
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ fieldId, date: day(-3) });
    expect((await owner.get(`/farm/satellite/fields/${fieldId}/reading`, { date: day(-8) })).data.date).toBe(day(-8));

    // Scenes already read are not read again.
    read.mockClear();
    expect((await owner.post('/farm/satellite/refresh')).data).toEqual({ scenes: 0, readings: 0, pending: 0, unavailable: false });
    expect(read).not.toHaveBeenCalled();
  });

  it('records a cloudy scene without readings, and retries a scene that failed to read', async () => {
    const f = await createFixture();
    const fieldId = await fieldOf(f);
    vi.spyOn(satelliteSources, 'search').mockResolvedValue([scene('S2B_CLOUDY', day(-2), 70), scene('S2B_FAILS', day(-6))]);
    const read = vi.spyOn(satelliteSources, 'read').mockImplementation(async (href, bounds) => {
      if (href === 'mem://scene/red' && read.mock.calls.length > 3) throw new Error('timeout');
      return fakeReader(() => ({ ...HEALTHY, scl: 9 }))(href, bounds);
    });
    const owner = await f.as('owner');
    expect((await owner.post('/farm/satellite/refresh')).data).toEqual({ scenes: 1, readings: 0, pending: 1, unavailable: false });
    const stored = await f.run(() => tx().select().from(schema.satelliteScenes).where(eq(schema.satelliteScenes.farmId, f.farmId)));
    expect(stored.map((s) => [s.sceneId, s.clearPct])).toEqual([['S2B_CLOUDY', 0]]);
    expect((await owner.get(`/farm/satellite/fields/${fieldId}`)).data.latest).toBeNull();

    read.mockImplementation(fakeReader(withPatch));
    expect((await owner.post('/farm/satellite/refresh')).data).toEqual({ scenes: 1, readings: 1, pending: 0, unavailable: false });
  });

  it('reports an unavailable catalogue as a result, not an error', async () => {
    const f = await createFixture();
    await fieldOf(f);
    vi.spyOn(satelliteSources, 'search').mockRejectedValue(new Error('ECONNRESET'));
    const res = await (await f.as('owner')).post('/farm/satellite/refresh');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ scenes: 0, readings: 0, pending: 0, unavailable: true });
  });

  it('does nothing for a farm without drawn fields', async () => {
    const f = await createFixture();
    const search = vi.spyOn(satelliteSources, 'search');
    expect((await (await f.as('owner')).post('/farm/satellite/refresh')).data).toMatchObject({ scenes: 0, unavailable: false });
    expect(search).not.toHaveBeenCalled();
  });

  it('shows crop health to farm and crop staff only, within the tenant', async () => {
    const f = await createFixture();
    const fieldId = await fieldOf(f);
    for (const role of ['agronomist', 'mechanic', 'storekeeper', 'director'] as const) {
      expect((await (await f.as(role)).get(`/farm/satellite/fields/${fieldId}`)).status).toBe(200);
    }
    for (const role of ['shepherd', 'investor'] as const) {
      expect((await (await f.as(role)).get(`/farm/satellite/fields/${fieldId}`)).status).toBe(403);
    }
    vi.spyOn(satelliteSources, 'search').mockResolvedValue([]);
    expect((await (await f.as('agronomist')).post('/farm/satellite/refresh')).status).toBe(200);
    expect((await (await f.as('storekeeper')).post('/farm/satellite/refresh')).status).toBe(403);

    const other = await createFixture();
    expect((await (await other.as('owner')).get(`/farm/satellite/fields/${fieldId}`)).status).toBe(404);
    expect((await (await other.as('owner')).post(`/farm/satellite/fields/${fieldId}/pasture-samples`, { date: day(0), biomassKgHa: 900 })).status).toBe(404);
  });
});

describe('satellite checks of recorded work', () => {
  /** Store a clear reading of a field directly, as the refresh would. */
  async function reading(fieldId: string, date: string, mean: number) {
    const c = ctx();
    const [s] = await tx()
      .insert(schema.satelliteScenes)
      .values({ tenantId: c.tenantId, farmId: c.farmId, sceneId: `S2_${fieldId}_${date}`, date, clearPct: 100 })
      .onConflictDoNothing()
      .returning();
    const sceneId = s?.id ?? (await tx().select().from(schema.satelliteScenes).where(eq(schema.satelliteScenes.sceneId, `S2_${fieldId}_${date}`)))[0].id;
    await tx().insert(schema.fieldVegetation).values({
      tenantId: c.tenantId,
      farmId: c.farmId,
      fieldId,
      sceneId,
      date,
      clearPct: 100,
      cellCount: 600,
      ndviMean: mean,
      ndviP10: mean - 0.05,
      ndviP50: mean,
      ndviP90: mean + 0.05,
    });
  }

  async function planted(f: Fixture, cropKey: string, sowingDateFact: string, opts: { landUse?: string; status?: string } = {}) {
    return f.run(async () => {
      const c = ctx();
      const base = { tenantId: c.tenantId, farmId: c.farmId };
      const [field] = await tx()
        .insert(schema.fields)
        .values({ ...base, number: `W${Math.random().toString(36).slice(2, 6)}`, landUse: opts.landUse ?? 'arable', areaHa: 20, boundary: FIELD })
        .returning();
      const [season] = await tx()
        .insert(schema.seasons)
        .values({ ...base, name: 'S', kind: 'spring', startDate: addDays(sowingDateFact, -30), endDate: addDays(sowingDateFact, 300), isCurrent: true })
        .returning();
      const [crop] = await tx().select().from(schema.crops).where(and(eq(schema.crops.key, cropKey), sql`tenant_id = ${c.tenantId}`));
      const [plan] = await tx()
        .insert(schema.cropPlans)
        .values({ ...base, seasonId: season.id, fieldId: field.id, cropId: crop.id, areaHa: 20, sowingDateFact, status: opts.status ?? 'growing' })
        .returning();
      return { fieldId: field.id, planId: plan.id };
    });
  }

  it('flags a recorded harvest the satellite did not see, and a harvest nobody recorded', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');

    const standing = await planted(f, 'cotton', day(-150));
    await f.run(async () => {
      for (const [offset, mean] of [[-140, 0.15], [-100, 0.4], [-60, 0.75], [-30, 0.8], [-12, 0.78], [-6, 0.77]] as const) {
        await reading(standing.fieldId, day(offset), mean);
      }
      const c = ctx();
      await tx().insert(schema.harvests).values({ tenantId: c.tenantId, farmId: c.farmId, fieldId: standing.fieldId, cropPlanId: standing.planId, date: day(-20), grossT: 50 });
    });
    const checks = (await owner.get(`/farm/satellite/fields/${standing.fieldId}`)).data.checks;
    expect(checks).toEqual([{ kind: 'harvest_not_seen', date: day(-20) }]);

    const cut = await planted(f, 'corn', day(-140));
    await f.run(async () => {
      for (const [offset, mean] of [[-130, 0.15], [-90, 0.5], [-40, 0.82], [-28, 0.8], [-22, 0.25], [-12, 0.15], [-6, 0.12]] as const) {
        await reading(cut.fieldId, day(offset), mean);
      }
    });
    const health = (await owner.get(`/farm/satellite/fields/${cut.fieldId}`)).data;
    expect(health.checks).toEqual([{ kind: 'unrecorded_harvest', date: day(-22) }]);
    expect(health.events).toEqual([
      { type: 'green_up', date: day(-90) },
      { type: 'harvest', date: day(-22) },
      { type: 'bare', date: day(-12) },
    ]);
    expect(health.crop).toMatchObject({ cropKey: 'corn', status: 'growing', sowingDate: day(-140) });
  });

  it('flags a crop that never greened up, but gives autumn wheat until April', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    // 75 days of bare-soil readings after sowing.
    const sowing = day(-75);
    const wheat = await planted(f, 'wheat', sowing);
    const corn = await planted(f, 'corn', sowing);
    await f.run(async () => {
      for (const field of [wheat.fieldId, corn.fieldId]) {
        for (const offset of [25, 40, 55, 70]) await reading(field, addDays(sowing, offset), 0.18);
      }
    });
    const flagged = [{ kind: 'no_green_up', date: sowing }];
    expect((await owner.get(`/farm/satellite/fields/${corn.fieldId}`)).data.checks).toEqual(flagged);
    // Sown from August on, wheat is a winter crop: short until spring, and that is no fault.
    const autumnSown = Number(sowing.slice(5, 7)) >= 8;
    expect((await owner.get(`/farm/satellite/fields/${wheat.fieldId}`)).data.checks).toEqual(autumnSown ? [] : flagged);
  });
});

describe('pasture estimate', () => {
  it('estimates grazing days for the flock, and calibrates on cut-and-weigh samples', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const res = await owner.post('/farm/fields', { number: 'Y1', landUse: 'pasture', areaHa: 20 });
    const fieldId = res.data.id as string;
    await f.run(async () => {
      const c = ctx();
      const base = { tenantId: c.tenantId, farmId: c.farmId };
      const [sheep] = await tx().select().from(schema.species).where(and(eq(schema.species.key, 'sheep'), sql`tenant_id = ${c.tenantId}`));
      await tx()
        .insert(schema.animals)
        .values(
          Array.from({ length: 140 }, (_, i) => ({ ...base, tag: `P-${i}`, speciesId: sheep.id, sex: 'female', category: 'ewe', origin: 'purchased', status: i === 0 ? 'sold' : 'active' })),
        );
      for (const [offset, mean] of [[-40, 0.3], [-20, 0.6], [-5, 0.45]] as const) {
        const [s] = await tx().insert(schema.satelliteScenes).values({ ...base, sceneId: `P_${offset}`, date: day(offset), clearPct: 100 }).returning();
        await tx().insert(schema.fieldVegetation).values({ ...base, fieldId, sceneId: s.id, date: day(offset), clearPct: 100, cellCount: 2000, ndviMean: mean });
      }
    });

    const before = (await owner.get(`/farm/satellite/fields/${fieldId}`)).data.pasture;
    // Default model: 5000 × 0.45 − 750 = 1500 kg DM/ha; 1500 × 20 ha × 0.5 / (139 head × 1.8 kg) = 59.95 days.
    expect(before).toMatchObject({ ndvi: 0.45, biomassKgHa: 1500, head: 139, grazingDays: 60, model: { calibrated: false, samples: 0 } });

    // Samples pick up the NDVI of the nearest clear reading within a week.
    for (const [offset, kg] of [[-38, 900], [-21, 2400], [-4, 1650]] as const) {
      const sample = await owner.post(`/farm/satellite/fields/${fieldId}/pasture-samples`, { date: day(offset), biomassKgHa: kg });
      expect(sample.status).toBe(201);
    }
    const lonely = await owner.post(`/farm/satellite/fields/${fieldId}/pasture-samples`, { date: day(-90), biomassKgHa: 100 });
    expect(lonely.data.ndvi).toBeNull();

    const after = (await owner.get(`/farm/satellite/fields/${fieldId}`)).data.pasture;
    // A perfect line through (0.3, 900), (0.45, 1650), (0.6, 2400): 5000·NDVI − 600.
    expect(after.model).toMatchObject({ calibrated: true, samples: 3, r2: 1 });
    expect(after.model.slope).toBeCloseTo(5000, 6);
    expect(after.model.intercept).toBeCloseTo(-600, 6);
    expect(after.biomassKgHa).toBe(1650);
    expect(after.samples).toHaveLength(4);

    const removed = await owner.delete(`/farm/satellite/fields/${fieldId}/pasture-samples/${lonely.data.id}`);
    expect(removed.status).toBe(200);
    expect((await (await f.as('shepherd')).post(`/farm/satellite/fields/${fieldId}/pasture-samples`, { date: day(0), biomassKgHa: 1 })).status).toBe(403);
    const events = await f.run(() => tx().select().from(schema.events).where(sql`type like 'pasture.%'`));
    expect(events).toHaveLength(5);
  });
});
