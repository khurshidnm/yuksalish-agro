import { addDays, todayIso } from '@yap/shared';
import { et0PenmanMonteith } from '@yap/shared/formulas/agro-weather';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ctx, tx } from '../src/core/context';
import { schema } from '../src/db/client';
import { evaluateRules } from '../src/modules/alerts/rules';
import { refreshWeather, resetWeatherBackoff } from '../src/modules/farm/weather.service';
import { createFixture, type Fixture } from './helpers';

const today = () => todayIso();
const day = (offset: number) => addDays(today(), offset);
const at = (date: string, hour: number) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+05:00`);
const HOUR = 3_600_000;

/** The same dry, hot weather every day: ET0 is then the same every day. */
const WEATHER = { tempMin: 20, tempMax: 34, rhMeanPct: 30, dewPointC: 10, windMeanMs: 2, solarMj: 25, precipitationMm: 0 };
const ELEVATION = 230;
const E = et0PenmanMonteith({
  date: today(),
  latitudeDeg: 39.5,
  elevationM: ELEVATION,
  tMinC: WEATHER.tempMin,
  tMaxC: WEATHER.tempMax,
  dewPointC: WEATHER.dewPointC,
  windSpeed2mMs: WEATHER.windMeanMs,
  solarRadiationMj: WEATHER.solarMj,
})!;

const base = () => ({ tenantId: ctx().tenantId, farmId: ctx().farmId });

async function setupFarm(f: Fixture, from = -60, to = 7) {
  await f.run(async () => {
    await tx().update(schema.farms).set({ elevationM: ELEVATION }).where(eq(schema.farms.id, f.farmId));
    const days = [];
    for (let o = from; o <= to; o++) days.push({ ...base(), ...WEATHER, date: day(o), isForecast: o > 0 });
    await tx().insert(schema.weatherDaily).values(days);
  });
}

async function plant(f: Fixture, cropKey: string, sowingOffset: number, field: { soilTexture?: string | null; areaHa?: number; status?: string } = {}) {
  return f.run(async () => {
    const [crop] = await tx().select().from(schema.crops).where(and(eq(schema.crops.key, cropKey), sql`tenant_id = ${ctx().tenantId}`));
    const [row] = await tx()
      .insert(schema.fields)
      .values({ ...base(), number: `${cropKey}-${Math.random().toString(36).slice(2, 5)}`, areaHa: field.areaHa ?? 10, soilTexture: field.soilTexture === undefined ? 'sandy_loam' : field.soilTexture })
      .returning();
    const [season] = await tx()
      .insert(schema.seasons)
      .values({ ...base(), name: 'S', kind: 'spring', startDate: day(-200), endDate: day(200), isCurrent: true })
      .returning();
    const [plan] = await tx()
      .insert(schema.cropPlans)
      .values({ ...base(), seasonId: season.id, fieldId: row.id, cropId: crop.id, areaHa: field.areaHa ?? 10, sowingDateFact: day(sowingOffset), status: field.status ?? 'growing' })
      .returning();
    return { fieldId: row.id, number: row.number, planId: plan.id };
  });
}

async function alertsOf(f: Fixture, ruleKey: string) {
  return f.run(() => tx().select().from(schema.alerts).where(and(eq(schema.alerts.ruleKey, ruleKey), sql`status <> 'resolved'`)));
}

beforeEach(() => {
  resetWeatherBackoff();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('irrigation advice', () => {
  it('counts the water a young crop used, net of irrigation, and the volume that refills the root zone', async () => {
    const f = await createFixture();
    await setupFarm(f);
    // Cotton in its first 30 days: Kc 0.35. Sown 5 days ago, so six days of use up to tonight.
    const cotton = await plant(f, 'cotton', -5);
    await f.run(() =>
      tx().insert(schema.fieldOperations).values({ ...base(), type: 'irrigation', status: 'done', date: day(-2), fieldId: cotton.fieldId, waterM3: 100 }),
    );

    const owner = await f.as('owner');
    const [advice] = (await owner.get('/farm/water/advice', { fieldId: cotton.fieldId })).data;
    // 100 m³ on 10 ha is 1 mm gross, 0.6 mm in the root zone at furrow efficiency.
    const depletion = 6 * 0.35 * E - 0.6;
    expect(advice).toMatchObject({ cropKey: 'cotton', stage: 'initial', kc: 0.35, soilTexture: 'sandy_loam', tawMm: 120, rawMm: 78, efficiency: 0.6, gap: null });
    expect(advice.depletionMm).toBeCloseTo(depletion, 1);
    expect(advice.rawUsedPct).toBe(Math.round((depletion * 100) / 78));
    // Six days since sowing in the last seven, then seven forecast days.
    expect(advice.etcLast7Mm).toBeCloseTo(6 * 0.35 * E, 0);
    expect(advice.etcNext7Mm).toBeCloseTo(7 * 0.35 * E, 0);
    expect(advice.refillM3).toBe(Math.round((depletion * 10 * 10) / 0.6));
    expect(advice.lastIrrigation).toEqual({ date: day(-2), m3: 100 });
    // RAW is not reached within the 7-day forecast.
    expect(advice.dueDate).toBeNull();
  });

  it('says watering is due, and raises the alert', async () => {
    const f = await createFixture();
    await setupFarm(f);
    // Corn on sand: TAW 75 mm, RAW 41.25 mm, used up within the 40 days since sowing.
    const corn = await plant(f, 'corn', -40, { soilTexture: 'sand' });
    const cotton = await plant(f, 'cotton', -5);

    const advice = (await (await f.as('agronomist')).get('/farm/water/advice')).data;
    const cornAdvice = advice.find((a: any) => a.fieldId === corn.fieldId);
    expect(cornAdvice).toMatchObject({ tawMm: 75, rawMm: 41, dueDate: day(0) });
    expect(cornAdvice.rawUsedPct).toBeGreaterThanOrEqual(100);

    await f.run(() => evaluateRules());
    const alerts = await alertsOf(f, 'irrigation_due');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ entityId: corn.fieldId, link: `/farm/fields/${corn.fieldId}?tab=water` });
    expect(alerts[0].data).toMatchObject({ field: corn.number, date: day(0), textKey: 'irrigation_due_now' });
    expect(alerts.some((a) => a.entityId === cotton.fieldId)).toBe(false);
  });

  it('names what is missing instead of guessing', async () => {
    const f = await createFixture();
    await setupFarm(f);
    const noSoil = await plant(f, 'cotton', -5, { soilTexture: null });
    const rice = await plant(f, 'rice', -5);
    const planned = await plant(f, 'corn', 3, { status: 'sown' });
    const owner = await f.as('owner');
    const advice = (await owner.get('/farm/water/advice')).data;
    const of = (id: string) => advice.find((a: any) => a.fieldId === id);
    // Crop water use is still known; the soil store is not.
    expect(of(noSoil.fieldId)).toMatchObject({ gap: 'no_soil_texture', depletionMm: null, dueDate: null, refillM3: null });
    expect(of(noSoil.fieldId).etcLast7Mm).toBeCloseTo(6 * 0.35 * E, 0);
    expect(of(rice.fieldId)).toMatchObject({ gap: 'flooded', depletionMm: null });
    expect(of(planned.fieldId)).toMatchObject({ gap: 'not_sown_yet' });

    // Without the farm's altitude there is no water use at all.
    await f.run(() => tx().update(schema.farms).set({ elevationM: null }).where(eq(schema.farms.id, f.farmId)));
    expect((await owner.get('/farm/water/advice', { fieldId: noSoil.fieldId })).data[0]).toMatchObject({ gap: 'no_weather', etcLast7Mm: null });
  });

  it('stops at a missing day of weather rather than skipping it', async () => {
    const f = await createFixture();
    await setupFarm(f);
    const cotton = await plant(f, 'cotton', -10);
    await f.run(() => tx().delete(schema.weatherDaily).where(and(eq(schema.weatherDaily.farmId, f.farmId), eq(schema.weatherDaily.date, day(-7)))));
    const [advice] = (await (await f.as('owner')).get('/farm/water/advice', { fieldId: cotton.fieldId })).data;
    expect(advice).toMatchObject({ gap: 'no_weather', depletionMm: null });
  });

  it('is for farm and crop staff', async () => {
    const f = await createFixture();
    expect((await (await f.as('mechanic')).get('/farm/water/advice')).status).toBe(200);
    expect((await (await f.as('shepherd')).get('/farm/water/advice')).status).toBe(403);
    expect((await (await f.as('investor')).get('/farm/water/advice')).status).toBe(403);
  });

  it('refills days kept from the old weather source, which cannot give crop water use', async () => {
    const f = await createFixture();
    await plant(f, 'cotton', -40);
    // Every day since sowing is stored, but as Open-Meteo wrote it: no humidity, no mean wind.
    await f.run(async () => {
      const days = [];
      for (let o = -45; o <= -1; o++) days.push({ ...base(), date: day(o), tempMin: 10, tempMax: 25, precipitationMm: 0, source: 'open-meteo' });
      await tx().insert(schema.weatherDaily).values(days);
    });
    const fetchMock = vi.fn(async (url: URL | string) => {
      const host = new URL(String(url)).hostname;
      if (host === 'power.larc.nasa.gov') return new Response(JSON.stringify({ properties: { parameter: {} } }));
      return new Response('{}', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await f.run(() => refreshWeather());
    const power = fetchMock.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.hostname === 'power.larc.nasa.gov')!;
    expect(power.searchParams.get('start')).toBe(day(-40).replaceAll('-', ''));
  });

  it('fills past weather back to the sowing of a crop still in the field', async () => {
    const f = await createFixture();
    await plant(f, 'cotton', -40);
    const fetchMock = vi.fn(async (url: URL | string) => {
      const host = new URL(String(url)).hostname;
      if (host === 'power.larc.nasa.gov') return new Response(JSON.stringify({ properties: { parameter: {} } }));
      return new Response('{}', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await f.run(() => refreshWeather());
    const power = fetchMock.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.hostname === 'power.larc.nasa.gov')!;
    expect(power.searchParams.get('start')).toBe(day(-40).replaceAll('-', ''));
  });
});

describe('weather alerts', () => {
  async function hourly(f: Fixture, from: Date, hours: number, weather: (at: Date) => { tempC: number; rhPct: number; windMs: number; precipMm?: number }) {
    await f.run(async () => {
      const rows = [];
      for (let i = 0; i < hours; i++) {
        const time = new Date(from.getTime() + i * HOUR);
        const w = weather(time);
        rows.push({ ...base(), time, periodHours: 1, tempC: w.tempC, rhPct: w.rhPct, windMs: w.windMs, precipMm: w.precipMm ?? 0 });
      }
      await tx().insert(schema.weatherHourly).values(rows);
    });
  }
  const localHour = (time: Date) => (time.getUTCHours() + 5) % 24;
  const localDate = (time: Date) => todayIso('Asia/Tashkent', time);
  const thisHour = () => new Date(Math.floor(Date.now() / HOUR) * HOUR);

  it('warns of frost only where a frost-sensitive crop is up', async () => {
    const f = await createFixture();
    const wheat = await plant(f, 'wheat', -20);
    await hourly(f, thisHour(), 60, (time) => ({ tempC: localDate(time) === day(1) && localHour(time) >= 3 && localHour(time) < 7 ? -3 : 5, rhPct: 60, windMs: 2 }));
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'frost_risk')).toEqual([]);
    void wheat;

    const cotton = await plant(f, 'cotton', -10);
    await f.run(() => evaluateRules());
    const [alert] = await alertsOf(f, 'frost_risk');
    expect(alert).toMatchObject({ dedupKey: `frost_risk:${day(1)}`, severity: 'urgent' });
    expect(alert.data).toMatchObject({ date: day(1), temp: -3, fields: cotton.number });
  });

  it('warns of extreme heat for the flock, with the hours', async () => {
    const f = await createFixture();
    const hot = (time: Date) =>
      localDate(time) === day(1) && localHour(time) >= 13 && localHour(time) < 17 ? { tempC: 38, rhPct: 20, windMs: 1 } : { tempC: 25, rhPct: 30, windMs: 1 };
    await hourly(f, thisHour(), 48, hot);
    await f.run(() => evaluateRules());
    // No sheep, no alert.
    expect(await alertsOf(f, 'heat_stress')).toEqual([]);

    await f.run(async () => {
      const [sheep] = await tx().select().from(schema.species).where(and(eq(schema.species.key, 'sheep'), sql`tenant_id = ${ctx().tenantId}`));
      await tx().insert(schema.animals).values({ ...base(), tag: 'H-1', speciesId: sheep.id, sex: 'female', category: 'ewe', origin: 'purchased' });
    });
    await f.run(() => evaluateRules());
    const [alert] = await alertsOf(f, 'heat_stress');
    // THI = 38 − (0.31 − 0.31·0.2)(38 − 14.4) = 32.15.
    expect(alert.data).toMatchObject({ date: day(1), from: '13:00', to: '17:00', thi: 32.1 });
    expect(alert.notifyRoles).toEqual(expect.arrayContaining(['zootechnician', 'shepherd']));
  });

  it('moves a spraying planned for a windy day to the next calm hours', async () => {
    const f = await createFixture();
    const field = await plant(f, 'cotton', -30);
    const calm = { tempC: 18, rhPct: 55, windMs: 2 };
    const windy = { tempC: 18, rhPct: 55, windMs: 8 };
    // Calm 05:00 to 08:00 and 10:00 to 14:00. The early hours are before or just after sunrise at the
    // fixture farm (39.5°N, 64.8°E) in any season, at most one hour of them lies in the spraying day,
    // so the advice is 10:00 to 14:00 all year. Clock hours from 05:00 advised the dawn.
    const calmAt = (time: Date) => localDate(time) === day(2) && ((localHour(time) >= 5 && localHour(time) < 8) || (localHour(time) >= 10 && localHour(time) < 14));
    await hourly(f, thisHour(), 64, (time) => (calmAt(time) ? calm : windy));
    const [op] = await f.run(() =>
      tx().insert(schema.fieldOperations).values({ ...base(), type: 'protection', status: 'planned', date: day(1), fieldId: field.fieldId }).returning(),
    );
    await f.run(() => evaluateRules());
    const [alert] = await alertsOf(f, 'spray_window');
    expect(alert).toMatchObject({ dedupKey: `spray_window:${op.id}`, entityId: op.id });
    expect(alert.data).toMatchObject({ field: field.number, date: day(1), bestDate: day(2), bestFrom: '10:00', bestTo: '14:00' });
  });

  it('stays quiet when the planned day has good hours', async () => {
    const f = await createFixture();
    const field = await plant(f, 'cotton', -30);
    await hourly(f, thisHour(), 64, () => ({ tempC: 18, rhPct: 55, windMs: 2 }));
    await f.run(() => tx().insert(schema.fieldOperations).values({ ...base(), type: 'protection', status: 'planned', date: day(1), fieldId: field.fieldId }));
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'spray_window')).toEqual([]);
  });
});

describe('satellite alerts', () => {
  async function reading(fieldId: string, date: string, mean: number, zones: { areaHa: number; meanNdvi: number; lat: number; lng: number }[] = []) {
    const [scene] = await tx()
      .insert(schema.satelliteScenes)
      .values({ ...base(), sceneId: `S_${fieldId}_${date}`, date, clearPct: 100 })
      .returning();
    await tx().insert(schema.fieldVegetation).values({ ...base(), fieldId, sceneId: scene.id, date, clearPct: 100, cellCount: 900, ndviMean: mean, weakZones: zones });
  }
  const zone = (areaHa: number) => ({ areaHa, meanNdvi: 0.3, lat: 39.5, lng: 64.8 });

  it('raises weak zones on a growing crop, and resolves them when the next look is healthy', async () => {
    const f = await createFixture();
    const growing = await plant(f, 'cotton', -60);
    const small = await plant(f, 'corn', -60);
    await f.run(async () => {
      await reading(growing.fieldId, day(-4), 0.6, [zone(0.4), zone(0.3)]);
      await reading(small.fieldId, day(-4), 0.6, [zone(0.3)]);
    });
    await f.run(() => evaluateRules());
    const [alert] = await alertsOf(f, 'crop_weak_zone');
    expect(alert).toMatchObject({ entityId: growing.fieldId, link: `/farm/fields/${growing.fieldId}?tab=satellite` });
    expect(alert.data).toMatchObject({ field: growing.number, areaHa: 0.7, count: 2, date: day(-4) });
    expect(await alertsOf(f, 'crop_weak_zone')).toHaveLength(1);

    await f.run(() => reading(growing.fieldId, day(-1), 0.62));
    await f.run(() => evaluateRules());
    expect(await alertsOf(f, 'crop_weak_zone')).toEqual([]);
  });

  it('raises a harvest the satellite saw but nobody recorded', async () => {
    const f = await createFixture();
    const corn = await plant(f, 'corn', -140);
    await f.run(async () => {
      for (const [o, mean] of [[-130, 0.15], [-90, 0.5], [-40, 0.82], [-28, 0.8], [-22, 0.25], [-12, 0.15]] as const) await reading(corn.fieldId, day(o), mean);
    });
    await f.run(() => evaluateRules());
    const [alert] = await alertsOf(f, 'satellite_check');
    expect(alert).toMatchObject({ dedupKey: `satellite_check:${corn.fieldId}:unrecorded_harvest:${day(-22)}`, severity: 'info' });
    expect(alert.data).toMatchObject({ field: corn.number, date: day(-22), textKey: 'satellite_unrecorded_harvest' });
  });
});
