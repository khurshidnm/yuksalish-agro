import { describe, expect, it } from 'vitest';
import {
  CROP_WATER_PRESETS,
  SOIL_TEXTURES,
  cropCoefficient,
  effectiveRainfallMm,
  growthStage,
  irrigationDepthMm,
  projectDueDate,
  readilyAvailableWaterMm,
  refillVolumeM3,
  seasonLength,
  soilWaterBalance,
  totalAvailableWaterMm,
  waterStressCoefficient,
  type KcCurve,
  type SoilTexture,
  type WaterBalanceDay,
  seasonStart,
} from './water-balance';

// Winter wheat: Kc 0.4 / 1.15 / 0.25 over 30 / 140 / 40 / 30 days.
const wheat: KcCurve = { kcIni: 0.4, kcMid: 1.15, kcEnd: 0.25, lIni: 30, lDev: 140, lMid: 40, lLate: 30 };

describe('crop coefficient curve', () => {
  it('seasonLength', () => {
    expect(seasonLength(wheat)).toBe(240);
  });

  it('cropCoefficient follows FAO-56 Fig. 25', () => {
    expect(cropCoefficient(wheat, 0)).toBe(0.4);
    expect(cropCoefficient(wheat, 30)).toBe(0.4);
    // Development: 0.4 + (70 / 140) × 0.75
    expect(cropCoefficient(wheat, 100)).toBeCloseTo(0.775, 10);
    expect(cropCoefficient(wheat, 170)).toBe(1.15);
    expect(cropCoefficient(wheat, 210)).toBe(1.15);
    // Late season: 1.15 + (15 / 30) × (0.25 − 1.15)
    expect(cropCoefficient(wheat, 225)).toBeCloseTo(0.7, 10);
    expect(cropCoefficient(wheat, 240)).toBeCloseTo(0.25, 10);
    expect(cropCoefficient(wheat, -1)).toBeNull();
    expect(cropCoefficient(wheat, 241)).toBeNull();
  });

  it('cropCoefficient with a zero-length stage does not divide by zero', () => {
    const curve: KcCurve = { kcIni: 0.5, kcMid: 1, kcEnd: 0.6, lIni: 10, lDev: 0, lMid: 10, lLate: 0 };
    expect(cropCoefficient(curve, 10)).toBe(0.5);
    expect(cropCoefficient(curve, 10.5)).toBe(1);
    expect(cropCoefficient(curve, 20)).toBe(1);
    expect(cropCoefficient({ ...wheat, lDev: -5 }, 50)).toBeNull();
  });

  it('growthStage: a day belongs to the stage it starts in', () => {
    expect(growthStage(wheat, 0)).toBe('initial');
    expect(growthStage(wheat, 29)).toBe('initial');
    expect(growthStage(wheat, 30)).toBe('development');
    expect(growthStage(wheat, 169)).toBe('development');
    expect(growthStage(wheat, 170)).toBe('mid');
    expect(growthStage(wheat, 209)).toBe('mid');
    expect(growthStage(wheat, 210)).toBe('late');
    expect(growthStage(wheat, 240)).toBe('late');
    expect(growthStage(wheat, 241)).toBeNull();
    expect(growthStage(wheat, -1)).toBeNull();
  });

  it('CROP_WATER_PRESETS: season lengths calibrated to the Uzbek calendar', () => {
    const lengths = Object.fromEntries(Object.entries(CROP_WATER_PRESETS).map(([k, c]) => [k, seasonLength(c)]));
    expect(lengths).toEqual({ wheat: 240, barley: 220, rice: 150, alfalfa: 220, corn: 150, cotton: 195 });
    expect(CROP_WATER_PRESETS.wheat).toMatchObject(wheat);
    expect(CROP_WATER_PRESETS.cotton).toMatchObject({ kcIni: 0.35, kcMid: 1.15, kcEnd: 0.6, depletionFraction: 0.65 });
    expect(CROP_WATER_PRESETS.rice.flooded).toBe(true);
    for (const [key, preset] of Object.entries(CROP_WATER_PRESETS)) {
      if (key !== 'rice') expect(preset.flooded).toBeUndefined();
      expect(preset.rootDepthM).toBeGreaterThan(0);
      expect(preset.depletionFraction).toBeGreaterThan(0);
      expect(preset.depletionFraction).toBeLessThan(1);
    }
  });
});

describe('soil water', () => {
  it('totalAvailableWaterMm (FAO-56 eq. 82, Table 19 midpoints)', () => {
    // 1000 × (0.23 − 0.11) × 1.0
    expect(totalAvailableWaterMm('sandy_loam', 1)).toBeCloseTo(120, 8);
    // 1000 × (0.25 − 0.12) × 0.5
    expect(totalAvailableWaterMm('loam', 0.5)).toBeCloseTo(65, 8);
    expect(totalAvailableWaterMm('clay', 1)).toBeCloseTo(140, 8);
    expect(totalAvailableWaterMm('sandy_loam', 0)).toBeNull();
    expect(totalAvailableWaterMm('sandy_loam', null)).toBeNull();
    expect(totalAvailableWaterMm('peat' as SoilTexture, 1)).toBeNull();
    expect(totalAvailableWaterMm('toString' as SoilTexture, 1)).toBeNull();
    for (const soil of Object.values(SOIL_TEXTURES)) expect(soil.fieldCapacity).toBeGreaterThan(soil.wiltingPoint);
  });

  it('readilyAvailableWaterMm (eq. 83)', () => {
    expect(readilyAvailableWaterMm(120, 0.55)).toBeCloseTo(66, 10);
    expect(readilyAvailableWaterMm(null, 0.55)).toBeNull();
    expect(readilyAvailableWaterMm(120, 1.2)).toBeNull();
  });

  it('waterStressCoefficient (eq. 84)', () => {
    expect(waterStressCoefficient(60, 120, 60)).toBe(1);
    expect(waterStressCoefficient(61, 120, 60)).toBeCloseTo(59 / 60, 10);
    expect(waterStressCoefficient(90, 120, 60)).toBeCloseTo(0.5, 10);
    expect(waterStressCoefficient(120, 120, 60)).toBe(0);
    expect(waterStressCoefficient(10, 0, 0)).toBeNull();
    expect(waterStressCoefficient(10, 100, 120)).toBeNull();
  });

  it('effectiveRainfallMm: rain below 0.2·ET0 evaporates', () => {
    // 0.2 × 6 = 1.2 mm
    expect(effectiveRainfallMm(1.19, 6)).toBe(0);
    expect(effectiveRainfallMm(1.2, 6)).toBe(1.2);
    expect(effectiveRainfallMm(10, 6)).toBe(10);
    expect(effectiveRainfallMm(null, 6)).toBe(0);
    expect(effectiveRainfallMm(0, null)).toBe(0);
    expect(effectiveRainfallMm(5, null)).toBeNull();
  });
});

describe('soilWaterBalance', () => {
  const day = (date: string, over: Partial<WaterBalanceDay>): WaterBalanceDay => ({
    date,
    et0Mm: 5,
    kc: 1,
    rainMm: 0,
    irrigationMm: 0,
    ...over,
  });

  it('three days by hand: ETc, a rain that evaporates, then stress and a rain that counts', () => {
    const rows = soilWaterBalance({
      tawMm: 120,
      rawMm: 60,
      initialDepletionMm: 50,
      days: [
        day('2026-06-01', { et0Mm: 5, kc: 1.2 }), // ETc 6, Dr 50 + 6 = 56
        day('2026-06-02', { et0Mm: 6, rainMm: 0.8 }), // 0.8 < 1.2 evaporates; Dr 56 + 6 = 62
        day('2026-06-03', { et0Mm: 6, rainMm: 10 }), // Ks (120 − 62) / 60; ETc 5.8; Dr 62 − 10 + 5.8 = 57.8
      ],
    });
    expect(rows.map((r) => r.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(rows[0]).toMatchObject({ ks: 1, effectiveRainMm: 0, deepPercolationMm: 0 });
    expect(rows[0].etcMm).toBeCloseTo(6, 10);
    expect(rows[0].depletionMm).toBeCloseTo(56, 10);
    expect(rows[1].effectiveRainMm).toBe(0);
    expect(rows[1].etcMm).toBeCloseTo(6, 10);
    expect(rows[1].depletionMm).toBeCloseTo(62, 10);
    expect(rows[2].ks).toBeCloseTo(58 / 60, 10);
    expect(rows[2].etcMm).toBeCloseTo(5.8, 10);
    expect(rows[2].effectiveRainMm).toBe(10);
    expect(rows[2].depletionMm).toBeCloseTo(57.8, 10);
  });

  it('irrigation efficiency and deep percolation', () => {
    // 80 mm at 75 % puts 60 mm in the root zone: 50 − 60 + 5 = −5, so Dr 0 and 5 mm drain away.
    const rows = soilWaterBalance({
      tawMm: 120,
      rawMm: 60,
      initialDepletionMm: 50,
      irrigationEfficiency: 0.75,
      days: [day('2026-06-01', { irrigationMm: 80 }), day('2026-06-02', { et0Mm: 4 })],
    });
    expect(rows[0].depletionMm).toBe(0);
    expect(rows[0].deepPercolationMm).toBeCloseTo(5, 10);
    expect(rows[1].depletionMm).toBeCloseTo(4, 10);

    // Default efficiency 1: 50 − 40 + 5 = 15.
    const full = soilWaterBalance({
      tawMm: 120,
      rawMm: 60,
      initialDepletionMm: 50,
      days: [day('2026-06-01', { irrigationMm: 40 })],
    });
    expect(full[0].depletionMm).toBeCloseTo(15, 10);

    // A heavy rain on a nearly full profile: 10 − 20 + 4 = −6.
    const rain = soilWaterBalance({
      tawMm: 120,
      rawMm: 60,
      initialDepletionMm: 10,
      days: [day('2026-06-01', { et0Mm: 4, rainMm: 20 })],
    });
    expect(rain[0]).toMatchObject({ depletionMm: 0, effectiveRainMm: 20 });
    expect(rain[0].deepPercolationMm).toBeCloseTo(6, 10);
  });

  it('Ks slows the drying near TAW, and depletion never passes TAW', () => {
    // Ks = (120 − 110) / 60; ETc = 6 / 6 = 1; Dr 111.
    const stressed = soilWaterBalance({
      tawMm: 120,
      rawMm: 60,
      initialDepletionMm: 110,
      days: [day('2026-07-01', { et0Mm: 6 })],
    });
    expect(stressed[0].ks).toBeCloseTo(1 / 6, 10);
    expect(stressed[0].etcMm).toBeCloseTo(1, 10);
    expect(stressed[0].depletionMm).toBeCloseTo(111, 10);

    // A starting depletion beyond TAW is held at TAW, where Ks is 0.
    const dry = soilWaterBalance({
      tawMm: 120,
      rawMm: 60,
      initialDepletionMm: 200,
      days: [day('2026-07-01', { et0Mm: 8 })],
    });
    expect(dry[0]).toMatchObject({ ks: 0, etcMm: 0, depletionMm: 120 });
  });

  it('an unknown ET0 or Kc makes that day and every later day unknown', () => {
    const rows = soilWaterBalance({
      tawMm: 120,
      rawMm: 60,
      initialDepletionMm: 50,
      days: [day('2026-06-01', {}), day('2026-06-02', { et0Mm: null }), day('2026-06-03', { rainMm: 5 })],
    });
    expect(rows[0].depletionMm).toBeCloseTo(55, 10);
    expect(rows[1]).toMatchObject({ etcMm: null, ks: null, depletionMm: null });
    expect(rows[2]).toMatchObject({ etcMm: null, depletionMm: null, effectiveRainMm: 5 });

    const noKc = soilWaterBalance({
      tawMm: 120,
      rawMm: 60,
      initialDepletionMm: 50,
      days: [day('2026-06-01', { kc: null }), day('2026-06-02', {})],
    });
    expect(noKc.map((r) => r.depletionMm)).toEqual([null, null]);
  });

  it('missing rain is no rain; invalid TAW, RAW or efficiency gives no balance', () => {
    const rows = soilWaterBalance({
      tawMm: 120,
      rawMm: 60,
      initialDepletionMm: 50,
      days: [day('2026-06-01', { rainMm: null })],
    });
    expect(rows[0]).toMatchObject({ effectiveRainMm: 0 });
    expect(rows[0].depletionMm).toBeCloseTo(55, 10);

    const days = [day('2026-06-01', {})];
    expect(soilWaterBalance({ tawMm: 120, rawMm: 60, initialDepletionMm: 50, irrigationEfficiency: 0, days })[0].depletionMm).toBeNull();
    expect(soilWaterBalance({ tawMm: 120, rawMm: 60, initialDepletionMm: 50, irrigationEfficiency: 1.5, days })[0].depletionMm).toBeNull();
    expect(soilWaterBalance({ tawMm: 120, rawMm: 130, initialDepletionMm: 50, days })[0].depletionMm).toBeNull();
    expect(soilWaterBalance({ tawMm: 0, rawMm: 0, initialDepletionMm: 0, days })[0].depletionMm).toBeNull();
  });
});

describe('irrigation volumes', () => {
  it('irrigationDepthMm: 1 mm on 1 ha is 10 m³', () => {
    expect(irrigationDepthMm(10, 1)).toBe(1);
    expect(irrigationDepthMm(1600, 2)).toBe(80);
    expect(irrigationDepthMm(1600, 0)).toBeNull();
    expect(irrigationDepthMm(1600, null)).toBeNull();
  });

  it('refillVolumeM3: depletion × 10 × ha / efficiency', () => {
    // 60 × 10 × 2 / 0.75
    expect(refillVolumeM3(60, 2, 0.75)).toBeCloseTo(1600, 8);
    expect(refillVolumeM3(1, 1, 1)).toBe(10);
    expect(refillVolumeM3(60, 2, 0)).toBeNull();
    expect(refillVolumeM3(60, 2, 1.2)).toBeNull();
    expect(refillVolumeM3(60, 0, 0.75)).toBeNull();
    expect(refillVolumeM3(null, 2, 0.75)).toBeNull();
  });
});

describe('projectDueDate', () => {
  const forecast = (...etc: (number | null)[]) =>
    etc.map((etcMm, n) => ({ date: `2026-07-0${n + 1}`, etcMm }));

  it('finds the first day depletion reaches RAW', () => {
    // 50 + 5 = 55, + 6 = 61 ≥ 60
    expect(projectDueDate({ depletionMm: 50, rawMm: 60, forecast: forecast(5, 6, 6) })).toBe('2026-07-02');
    // Reaching RAW exactly counts: 50 + 5 + 5 = 60.
    expect(projectDueDate({ depletionMm: 50, rawMm: 60, forecast: forecast(5, 5, 5) })).toBe('2026-07-02');
    // Already there: due on the first forecast day.
    expect(projectDueDate({ depletionMm: 60, rawMm: 60, forecast: forecast(5) })).toBe('2026-07-01');
    // An unknown day after the due date does not matter.
    expect(projectDueDate({ depletionMm: 50, rawMm: 60, forecast: forecast(5, 6, null) })).toBe('2026-07-02');
  });

  it('null when RAW is not reached or a needed day is unknown', () => {
    expect(projectDueDate({ depletionMm: 50, rawMm: 60, forecast: forecast(1, 1, 1) })).toBeNull();
    expect(projectDueDate({ depletionMm: 50, rawMm: 60, forecast: forecast(5, null, 6) })).toBeNull();
    expect(projectDueDate({ depletionMm: 70, rawMm: 60, forecast: [] })).toBeNull();
  });
});

describe('seasonStart', () => {
  const alfalfa = CROP_WATER_PRESETS.alfalfa;
  it('restarts a perennial each spring, never before its sowing', () => {
    expect(seasonStart(alfalfa, '2025-10-05', '2026-11-07')).toBe('2026-03-01');
    expect(seasonStart(alfalfa, '2025-10-05', '2026-03-01')).toBe('2026-03-01');
    expect(seasonStart(alfalfa, '2025-10-05', '2026-02-10')).toBe('2025-10-05');
    expect(seasonStart(alfalfa, '2026-04-01', '2026-07-01')).toBe('2026-04-01');
    expect(seasonStart(alfalfa, '2024-09-20', '2026-01-15')).toBe('2025-03-01');
  });
  it('keeps the sowing date of an annual crop', () => {
    expect(seasonStart(CROP_WATER_PRESETS.wheat, '2025-10-05', '2026-11-07')).toBe('2025-10-05');
  });
});
