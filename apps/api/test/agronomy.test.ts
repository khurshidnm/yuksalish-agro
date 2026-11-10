/**
 * The agronomy pack end to end: fertiliser rate on the field card, rotation warnings on a plan,
 * leaching water, groundwater observations, the moisture index and the yield forecast. Each formula
 * has its own hand-worked test in packages/shared; these check the figures reach the API unchanged.
 */
import { addDays, todayIso } from '@yap/shared';
import { and, eq } from 'drizzle-orm';
import proj4 from 'proj4';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ctx, tx } from '../src/core/context';
import { schema } from '../src/db/client';
import { readField, satelliteSources, type BandWindow, type SceneRef } from '../src/modules/farm/satellite.service';
import { createFixture, type Fixture } from './helpers';

const { cropPlans, crops, fields, fieldVegetation, harvests, items, satelliteScenes, seasons } = schema;

const today = todayIso();
const day = (offset: number) => addDays(today, offset);

// Nothing here may depend on the network.
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const base = () => ({ tenantId: ctx().tenantId, farmId: ctx().farmId });

async function field(f: Fixture, number: string, extra: object = {}) {
  return f.run(async () => {
    const [row] = await tx().insert(fields).values({ ...base(), number, areaHa: 10, landUse: 'arable', ...extra }).returning();
    return row.id;
  });
}

async function season(f: Fixture, name: string, startOffset: number, isCurrent = false) {
  return f.run(async () => {
    const [row] = await tx()
      .insert(seasons)
      .values({ ...base(), name, kind: 'spring', startDate: day(startOffset), endDate: day(startOffset + 200), isCurrent })
      .returning();
    return row.id;
  });
}

async function cropId(f: Fixture, key: string) {
  return f.run(async () => {
    const [row] = await tx().select().from(crops).where(and(eq(crops.tenantId, f.tenantId), eq(crops.key, key)));
    return row.id;
  });
}

async function plan(f: Fixture, values: { seasonId: string; fieldId: string; cropId: string; status?: string; expectedYieldTHa?: number; sowingDateFact?: string }) {
  return f.run(async () => {
    const [row] = await tx().insert(cropPlans).values({ ...base(), areaHa: 10, ...values }).returning();
    return row.id;
  });
}

/** A clear reading stored as the nightly refresh would store it. */
async function reading(f: Fixture, fieldId: string, date: string, mean: number, ndmiMean: number | null = null) {
  await f.run(async () => {
    const [scene] = await tx()
      .insert(satelliteScenes)
      .values({ ...base(), sceneId: `S2_${fieldId}_${date}`, date, clearPct: 100 })
      .returning();
    await tx()
      .insert(fieldVegetation)
      .values({ ...base(), fieldId, sceneId: scene.id, date, clearPct: 100, cellCount: 600, ndviMean: mean, ndviP10: mean, ndviP50: mean, ndviP90: mean, ndmiMean });
  });
}

describe('fertiliser rate on the field card', () => {
  it('gives the hand-worked rate for wheat, the inputs it used, and kilograms of the stocked products', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const fieldId = await field(f, '1');
    const seasonId = await season(f, '2027', -30, true);
    const wheat = await cropId(f, 'wheat');
    expect((await owner.get(`/farm/fields/${fieldId}`)).data.fertiliser).toBeNull();

    await plan(f, { seasonId, fieldId, cropId: wheat, expectedYieldTHa: 5 });
    await owner.post(`/farm/fields/${fieldId}/soil`, { date: day(-900), n: 21, p: 10, k: 100 });
    await owner.post(`/farm/fields/${fieldId}/soil`, { date: day(-100), n: 21, p: 28, k: 230 });
    await f.run(() =>
      tx()
        .insert(items)
        .values([
          { ...base(), name: 'Ammofos', category: 'fertilizer', unit: 'kg', nPct: 12, p2o5Pct: 52 },
          { ...base(), name: 'Kaliy xlorid', category: 'fertilizer', unit: 'kg', k2oPct: 60 },
          { ...base(), name: "Go'ng", category: 'fertilizer', unit: 't' },
        ]),
    );

    const card = (await owner.get(`/farm/fields/${fieldId}`)).data.fertiliser;
    expect(card).toMatchObject({ cropKey: 'wheat', family: 'cereal', targetYieldTHa: 5, removalSource: 'typical' });
    // The latest analysis is used, and it is fresh.
    expect(card.analysis).toMatchObject({ date: day(-100), stale: false });
    // P2O5: (5 × 10.4 − 28 × 3 × 0.15) / 0.2 = 197. K2O: (5 × 21.7 − 230 × 3 × 0.05) / 0.7 = 105.7.
    expect(card.nutrients.p2o5).toMatchObject({ uptakeKgHa: 52, soilMgKg: 28, soilSupplyKgHa: 12.6, rateKgHa: 197, reason: null });
    expect(card.nutrients.k2o).toMatchObject({ uptakeKgHa: 108.5, soilSupplyKgHa: 34.5, rateKgHa: 105.7, reason: null });
    // Nitrogen is not guessed from a nitrate figure.
    expect(card.nutrients.n).toMatchObject({ uptakeKgHa: 165, rateKgHa: null, reason: 'nitrate_not_supported' });
    // 197 / 0.52 = 378.8 kg ammophos; 105.7 / 0.60 = 176.2 kg potassium chloride.
    const byName = Object.fromEntries(card.products.products.map((p: any) => [p.name, p.kgHa]));
    expect(byName).toEqual({ Ammofos: 378.8, 'Kaliy xlorid': 176.2 });
    expect(card.productsWithoutContent.map((p: any) => p.name)).toEqual(["Go'ng"]);
  });

  it("uses the farm's own removal figures once set, and flags an analysis older than three years", async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const fieldId = await field(f, '1');
    const wheat = await cropId(f, 'wheat');
    await plan(f, { seasonId: await season(f, '2027', -30, true), fieldId, cropId: wheat, expectedYieldTHa: 4 });
    await owner.post(`/farm/fields/${fieldId}/soil`, { date: day(-1200), p: 20, k: 200 });

    const patched = await owner.patch(`/crops/crops/${wheat}`, { removalP2o5KgT: 12 });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ removalP2o5KgT: 12, typical: { family: 'cereal', removal: { n: 33, p2o5: 10.4, k2o: 21.7 } } });

    const card = (await owner.get(`/farm/fields/${fieldId}`)).data.fertiliser;
    expect(card.removalSource).toBe('farm');
    expect(card.analysis.stale).toBe(true);
    // (4 × 12 − 20 × 3 × 0.15) / 0.2 = 195.
    expect(card.nutrients.p2o5.rateKgHa).toBe(195);
    // The farm set phosphorus only: potassium has no removal figure of its own, so no rate.
    expect(card.nutrients.k2o).toMatchObject({ rateKgHa: null, reason: 'no_removal' });

    // A storekeeper may look at crops but not change the reference.
    expect((await (await f.as('storekeeper')).patch(`/crops/crops/${wheat}`, { removalP2o5KgT: 1 })).status).toBe(403);
  });

  it('stores nutrient percentages on a fertiliser item', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const created = await owner.post('/inventory/items', { name: 'Karbamid', category: 'fertilizer', unit: 'kg', nPct: 46 });
    expect(created.status).toBe(201);
    const listed = (await owner.get('/inventory/items', { search: 'Karbamid' })).data[0];
    expect(listed).toMatchObject({ nPct: 46, p2o5Pct: null, k2oPct: null });
    expect((await owner.post('/inventory/items', { name: 'Xato', category: 'fertilizer', unit: 'kg', nPct: 146 })).status).toBe(400);
  });
});

describe('rotation warnings', () => {
  async function rotationWorld() {
    const f = await createFixture();
    const fieldId = await field(f, '1');
    const last = await season(f, '2026', -400);
    const next = await season(f, '2027', -30, true);
    return { f, fieldId, last, next, wheat: await cropId(f, 'wheat'), barley: await cropId(f, 'barley'), alfalfa: await cropId(f, 'alfalfa'), cotton: await cropId(f, 'cotton') };
  }

  it('warns about wheat after wheat on create and on edit, and saves the plan all the same', async () => {
    const w = await rotationWorld();
    const owner = await w.f.as('owner');
    await plan(w.f, { seasonId: w.last, fieldId: w.fieldId, cropId: w.wheat, status: 'harvested' });

    const preview = await owner.get('/crops/plans/rotation-check', { fieldId: w.fieldId, seasonId: w.next, cropId: w.wheat });
    expect(preview.status).toBe(200);
    expect(preview.data.notes.map((n: any) => [n.rule, n.level])).toEqual([['same_crop', 'warning']]);
    expect(preview.data.notes[0].source).toContain('Земледелие');
    expect(preview.data.history).toMatchObject([{ key: 'wheat', family: 'cereal', seasonName: '2026' }]);

    const created = await owner.post('/crops/plans', { seasonId: w.next, fieldId: w.fieldId, cropId: w.wheat });
    expect(created.status).toBe(201);
    expect(created.data.rotation.notes.map((n: any) => n.rule)).toEqual(['same_crop']);
    expect((await owner.get(`/crops/plans/${created.data.id}`)).status).toBe(200);

    // Barley after wheat is a cereal after a cereal; the edit answers with the new warning and is saved.
    const edited = await owner.patch(`/crops/plans/${created.data.id}`, { cropId: w.barley });
    expect(edited.status).toBe(200);
    expect(edited.data.cropKey).toBe('barley');
    expect(edited.data.rotation.notes.map((n: any) => n.rule)).toEqual(['cereal_after_cereal']);

    // Cotton after wheat breaks no rule.
    const cotton = await owner.patch(`/crops/plans/${created.data.id}`, { cropId: w.cotton });
    expect(cotton.data.rotation.notes).toEqual([]);
  });

  it('does not warn about lucerne kept for another year, and calls it a good predecessor', async () => {
    const w = await rotationWorld();
    const owner = await w.f.as('owner');
    const before = await season(w.f, '2025', -800);
    await plan(w.f, { seasonId: before, fieldId: w.fieldId, cropId: w.alfalfa, status: 'harvested' });
    await plan(w.f, { seasonId: w.last, fieldId: w.fieldId, cropId: w.alfalfa, status: 'harvested' });

    const third = await owner.post('/crops/plans', { seasonId: w.next, fieldId: w.fieldId, cropId: w.alfalfa });
    expect(third.status).toBe(201);
    expect(third.data.rotation.notes).toEqual([]);
    expect(third.data.rotation.history).toHaveLength(2);

    const afterGrass = (await owner.get('/crops/plans/rotation-check', { fieldId: w.fieldId, seasonId: w.next, cropId: w.wheat, planId: third.data.id })).data;
    expect(afterGrass.notes.map((n: any) => [n.rule, n.level])).toEqual([['after_perennial_grass', 'good']]);
  });

  it('reads the family the farm set on the crop, and keeps other farms out', async () => {
    const w = await rotationWorld();
    const owner = await w.f.as('owner');
    // Mung bean is not among the starting crops: the farm adds it as a grain legume.
    const mung = await owner.post('/crops/crops', { key: 'mung_bean', name: { uz: 'Mosh', ru: 'Маш', en: 'Mung bean' }, family: 'legume' });
    expect(mung.status).toBe(201);
    await plan(w.f, { seasonId: w.last, fieldId: w.fieldId, cropId: mung.data.id, status: 'harvested' });
    const check = (await owner.get('/crops/plans/rotation-check', { fieldId: w.fieldId, seasonId: w.next, cropId: w.wheat })).data;
    expect(check.notes.map((n: any) => [n.rule, n.level])).toEqual([['after_legume', 'good']]);

    const other = await createFixture();
    const stranger = await (await other.as('owner')).get('/crops/plans/rotation-check', { fieldId: w.fieldId, seasonId: w.next, cropId: w.wheat });
    expect(stranger.status).toBe(404);
  });
});

describe('leaching', () => {
  it('needs an amount of water and counts it in the water drawn from the network', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const fieldId = await field(f, '1', { salinityLevel: 'medium', soilTexture: 'loam' });
    const node = await owner.post('/farm/irrigation', { type: 'canal', name: 'K-1', limitM3: 50_000, fieldIds: [fieldId] });
    expect(node.status).toBe(201);

    const dry = await owner.post('/crops/operations', { type: 'leaching', date: today, fieldId });
    expect(dry.status).toBe(400);
    expect(dry.body.error.code).toBe('WATER_REQUIRED');

    expect((await owner.post('/crops/operations', { type: 'irrigation', date: today, fieldId, waterM3: 8000 })).status).toBe(201);
    const wash = await owner.post('/crops/operations', { type: 'leaching', date: today, fieldId, waterM3: 30_000 });
    expect(wash.status).toBe(201);
    expect(wash.data).toMatchObject({ type: 'leaching', waterM3: 30_000 });

    const [listed] = (await owner.get('/farm/irrigation')).data;
    // 8 000 m³ of irrigation and 30 000 m³ of leaching against a limit of 50 000 m³.
    expect(listed.actualM3).toBe(38_000);
    expect(listed.usedPercent).toBe(76);

    // The field's salinity and texture travel with the lookup, for the suggested norm.
    const lookup = (await owner.get('/farm/fields/lookup')).data.find((row: any) => row.id === fieldId);
    expect(lookup).toMatchObject({ salinityLevel: 'medium', soilTexture: 'loam' });
  });

  it('accepts only the shared salinity levels on a field', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    expect((await owner.post('/farm/fields', { number: 'A', landUse: 'arable', areaHa: 5, salinityLevel: 'high' })).status).toBe(201);
    expect((await owner.post('/farm/fields', { number: 'B', landUse: 'arable', areaHa: 5, salinityLevel: 'extreme' })).status).toBe(400);
  });
});

describe('groundwater observations', () => {
  it('records, corrects and deletes observations, judging depth against the published range only', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const fieldId = await field(f, '1');

    const first = await owner.post(`/farm/fields/${fieldId}/groundwater`, { date: day(-60), depthM: 3.4, mineralisationGl: 2.1 });
    expect(first.status).toBe(201);
    // Deeper than 3.0 m: no judgement, and none on mineralisation either.
    expect(first.data).toMatchObject({ depthM: 3.4, mineralisationGl: 2.1, risk: null });
    const second = await owner.post(`/farm/fields/${fieldId}/groundwater`, { date: day(-5), depthM: 1.2, notes: 'Quduq 3' });
    expect(second.data).toMatchObject({ risk: 'shallow', mineralisationGl: null });

    const list = (await owner.get(`/farm/fields/${fieldId}/groundwater`)).data;
    expect(list.map((o: any) => o.date)).toEqual([day(-60), day(-5)]);
    expect((await owner.get(`/farm/fields/${fieldId}`)).data.groundwater).toHaveLength(2);

    // The field list carries the latest observation.
    const row = (await owner.get('/farm/fields')).data.find((r: any) => r.id === fieldId);
    expect(row.groundwater).toEqual({ date: day(-5), depthM: 1.2, mineralisationGl: null, risk: 'shallow' });

    const corrected = await owner.patch(`/farm/groundwater/${second.data.id}`, { depthM: 2.2 });
    expect(corrected.data).toMatchObject({ depthM: 2.2, risk: 'within_critical_range', notes: 'Quduq 3' });

    expect((await owner.delete(`/farm/groundwater/${second.data.id}`)).status).toBe(200);
    expect((await owner.get('/farm/fields')).data.find((r: any) => r.id === fieldId).groundwater).toMatchObject({ date: day(-60), risk: null });

    expect((await owner.post(`/farm/fields/${fieldId}/groundwater`, { date: today, depthM: -1 })).status).toBe(400);
    expect((await owner.post(`/farm/fields/${fieldId}/groundwater`, { date: today })).status).toBe(400);
  });

  it('lets farm staff record, viewers only read, and keeps other roles and other farms out', async () => {
    const f = await createFixture();
    const fieldId = await field(f, '1');
    const body = { date: today, depthM: 2.5 };

    const agronomist = await f.as('agronomist');
    const made = await agronomist.post(`/farm/fields/${fieldId}/groundwater`, body);
    expect(made.status).toBe(201);
    // Farm staff write and correct; only a full farm role deletes.
    expect((await agronomist.patch(`/farm/groundwater/${made.data.id}`, { depthM: 2.6 })).status).toBe(200);
    expect((await agronomist.delete(`/farm/groundwater/${made.data.id}`)).status).toBe(403);

    const storekeeper = await f.as('storekeeper');
    expect((await storekeeper.get(`/farm/fields/${fieldId}/groundwater`)).status).toBe(200);
    expect((await storekeeper.post(`/farm/fields/${fieldId}/groundwater`, body)).status).toBe(403);
    expect((await storekeeper.patch(`/farm/groundwater/${made.data.id}`, { depthM: 9 })).status).toBe(403);

    const shepherd = await f.as('shepherd');
    expect((await shepherd.get(`/farm/fields/${fieldId}/groundwater`)).status).toBe(403);
    expect((await shepherd.post(`/farm/fields/${fieldId}/groundwater`, body)).status).toBe(403);

    const other = await createFixture();
    const stranger = await other.as('owner');
    expect((await stranger.get(`/farm/fields/${fieldId}/groundwater`)).status).toBe(404);
    expect((await stranger.post(`/farm/fields/${fieldId}/groundwater`, body)).status).toBe(404);
    expect((await stranger.patch(`/farm/groundwater/${made.data.id}`, { depthM: 9 })).status).toBe(404);
    expect((await stranger.delete(`/farm/groundwater/${made.data.id}`)).status).toBe(404);
    expect((await (await f.as('owner')).get(`/farm/fields/${fieldId}/groundwater`)).data[0].depthM).toBe(2.6);
  });
});

describe('moisture index', () => {
  const UTM = '+proj=utm +zone=41 +datum=WGS84 +units=m +no_defs';
  const M_LNG = 86_013;
  const M_LAT = 111_025;
  const LNG = 64.8;
  const LAT = 39.5;
  const FIELD = {
    type: 'Polygon',
    coordinates: [[[LNG, LAT], [LNG + 300 / M_LNG, LAT], [LNG + 300 / M_LNG, LAT + 200 / M_LAT], [LNG, LAT + 200 / M_LAT], [LNG, LAT]]],
  };
  const [CX, CY] = proj4('EPSG:4326', UTM).forward([LNG + 150 / M_LNG, LAT + 100 / M_LAT]);
  const dn = (reflectance: number) => Math.round((reflectance + 0.1) * 10_000);
  // NDVI (0.20 − 0.05) / 0.25 = 0.6; NDMI (0.30 − 0.15) / 0.45 = 0.333.
  const PIXEL: Record<string, number> = { red: dn(0.05), nir: dn(0.2), scl: 4, nir08: dn(0.3), swir16: dn(0.15) };
  const TEN_METRE = new Set(['red', 'nir']);

  const reader = vi.fn(async (href: string, bounds: [number, number, number, number]): Promise<BandWindow> => {
    const band = href.split('/').pop()!;
    const resolution = TEN_METRE.has(band) ? 10 : 20;
    const originX = Math.floor(bounds[0] / resolution) * resolution;
    const originY = Math.ceil(bounds[3] / resolution) * resolution;
    const width = Math.ceil((bounds[2] - originX) / resolution);
    const height = Math.ceil((originY - bounds[1]) / resolution);
    return { values: new Uint16Array(width * height).fill(PIXEL[band]), width, height, originX, originY, resolution };
  });

  const ref = (band: string) => ({ href: `mem://scene/${band}`, scale: 0.0001, offset: -0.1 });
  const scene = (id: string, date: string, moisture: boolean): SceneRef => ({
    id,
    date,
    tileCloudPct: 2,
    epsg: 32641,
    bbox: [60, 39, 66, 41],
    red: ref('red'),
    nir: ref('nir'),
    scl: { href: 'mem://scene/scl' },
    ...(moisture ? { nir08: ref('nir08'), swir16: ref('swir16') } : {}),
  });

  it('takes NDMI from the 20 m bands over the clear cells, and leaves it null without them', async () => {
    const bounds: [number, number, number, number] = [CX - 400, CY - 300, CX + 400, CY + 300];
    const shape = { id: 'f', rings: FIELD.coordinates as [number, number][][] };
    const bands = { red: await reader('x/red', bounds), nir: await reader('x/nir', bounds), scl: await reader('x/scl', bounds) };
    const moisture = { nir08: await reader('x/nir08', bounds), swir16: await reader('x/swir16', bounds) };

    const withBands = readField(shape, { ...bands, ...moisture }, scene('s', day(0), true))!;
    expect(withBands.stats!.mean).toBeCloseTo(0.6, 3);
    expect(withBands.ndmiMean).toBeCloseTo(0.333, 3);
    // The 20 m windows hold about a quarter of the pixels of the 10 m ones: memory stays bounded.
    expect(moisture.nir08.values.length).toBeLessThan(bands.nir.values.length / 3);

    expect(readField(shape, bands, scene('s', day(0), false))!.ndmiMean).toBeNull();
    // Under cloud nothing is counted, so there is no moisture figure either.
    const cloud = { ...bands, scl: { ...bands.scl, values: new Uint16Array(bands.scl.values.length).fill(9) } };
    expect(readField(shape, { ...cloud, ...moisture }, scene('s', day(0), true))!.ndmiMean).toBeNull();
  });

  it('stores it for new scenes, keeps old readings null, and reads no scene twice', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const created = await owner.post('/farm/fields', { number: 'N1', landUse: 'arable', boundary: FIELD });
    const fieldId = created.data.id as string;
    // A reading stored before the index existed.
    await reading(f, fieldId, day(-20), 0.5);

    vi.spyOn(satelliteSources, 'search').mockResolvedValue([scene('S2B_NEW', day(-3), true), scene('S2B_BARE', day(-8), false)]);
    const read = vi.spyOn(satelliteSources, 'read').mockImplementation(reader);
    expect((await owner.post('/farm/satellite/refresh')).data).toEqual({ scenes: 2, readings: 2, pending: 0, unavailable: false });
    // Five windows for the scene with the 20 m bands, three for the one without.
    expect(read).toHaveBeenCalledTimes(8);

    const health = (await owner.get(`/farm/satellite/fields/${fieldId}`)).data;
    expect(health.series.map((p: any) => [p.date, p.ndmi])).toEqual([
      [day(-20), null],
      [day(-8), null],
      [day(-3), 0.333],
    ]);
    expect(health.latest).toMatchObject({ date: day(-3), ndmiMean: 0.333 });

    // History is not fetched again to fill the gaps.
    read.mockClear();
    expect((await owner.post('/farm/satellite/refresh')).data).toMatchObject({ scenes: 0, pending: 0 });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('yield forecast', () => {
  /** A finished wheat field-season: 10 ha, a peak NDVI and the tonnes cut. */
  async function finished(f: Fixture, seasonId: string, wheat: string, number: string, peak: number, grossT: number) {
    const fieldId = await field(f, number);
    const planId = await plan(f, { seasonId, fieldId, cropId: wheat, status: 'harvested' });
    await reading(f, fieldId, day(-330), peak - 0.2);
    await reading(f, fieldId, day(-300), peak);
    // Greener after the harvest (weeds, a catch crop) is outside the season's window.
    await reading(f, fieldId, day(-200), 0.9);
    await f.run(() => tx().insert(harvests).values({ ...base(), fieldId, cropPlanId: planId, date: day(-250), grossT }));
    return fieldId;
  }

  it('is null below three finished seasons, and matches the hand-worked line above', async () => {
    const f = await createFixture();
    const owner = await f.as('owner');
    const wheat = await cropId(f, 'wheat');
    const past = await season(f, '2026', -400);
    const current = await season(f, '2027', -60, true);

    const fieldId = await field(f, 'NOW');
    await plan(f, { seasonId: current, fieldId, cropId: wheat, status: 'growing', sowingDateFact: day(-50) });
    await reading(f, fieldId, day(-373), 0.5);
    await reading(f, fieldId, day(-30), 0.4);
    await reading(f, fieldId, day(-20), 0.65);
    await reading(f, fieldId, day(-8), 0.6);

    await finished(f, past, wheat, 'A', 0.5, 30);
    await finished(f, past, wheat, 'B', 0.6, 40);

    const few = (await owner.get(`/farm/satellite/fields/${fieldId}`)).data;
    expect(few.yieldOutlook).toEqual({ cropKey: 'wheat', seasons: 2, seasonsNeeded: 3, peakNdvi: 0.65, forecast: null, reason: 'too_few_seasons' });

    await finished(f, past, wheat, 'C', 0.7, 44);
    // Another crop's season does not count towards wheat.
    const barley = await cropId(f, 'barley');
    const barleyField = await field(f, 'D');
    const barleyPlan = await plan(f, { seasonId: past, fieldId: barleyField, cropId: barley, status: 'harvested' });
    await reading(f, barleyField, day(-300), 0.8);
    await f.run(() => tx().insert(harvests).values({ ...base(), fieldId: barleyField, cropPlanId: barleyPlan, date: day(-250), grossT: 10 }));

    const enough = (await owner.get(`/farm/satellite/fields/${fieldId}`)).data;
    // Seasons (0.5, 3.0), (0.6, 4.0), (0.7, 4.4) t/ha: slope 7, intercept −0.4, miss 0.245 t/ha.
    // At this season's peak of 0.65: 7 × 0.65 − 0.4 = 4.15, range 3.91 to 4.39.
    expect(enough.yieldOutlook).toMatchObject({ seasons: 3, seasonsNeeded: 3, peakNdvi: 0.65, reason: null });
    expect(enough.yieldOutlook.forecast).toMatchObject({ estimateTHa: 4.15, lowTHa: 3.91, highTHa: 4.39, seasons: 3, extrapolated: false });

    // NDVI now (0.60 on day −8) against the same week a year earlier (0.50 on day −373).
    expect(enough.lastSeason).toEqual({ date: day(-373), mean: 0.5, change: 0.1 });

    // A field without a crop has no outlook; a reading with no counterpart a year back has no comparison.
    const empty = await field(f, 'E');
    await reading(f, empty, day(-8), 0.3);
    const bare = (await owner.get(`/farm/satellite/fields/${empty}`)).data;
    expect(bare.yieldOutlook).toBeNull();
    expect(bare.lastSeason).toBeNull();
  });
});
