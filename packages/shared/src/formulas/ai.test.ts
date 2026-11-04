import { describe, expect, it } from 'vitest';
import * as ai from './ai';

describe('basic statistics', () => {
  it('mean and sample standard deviation match a hand calculation', () => {
    expect(ai.mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    // Sum of squared deviations is 32, n − 1 = 7.
    expect(ai.sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 10);
    expect(ai.mean([])).toBeNull();
    expect(ai.sampleStdDev([1])).toBeNull();
  });

  it('movingAverage leaves the first window empty', () => {
    expect(ai.movingAverage([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });

  it('zScore floors the spread so a flat baseline still works', () => {
    // Flat at 100: the spread is the 2% floor, so 120 is (120 − 100) / 2 = 10.
    expect(ai.zScore(120, [100, 100, 100])).toBeCloseTo(10, 8);
    expect(ai.zScore(1, [5])).toBeNull();
    expect(ai.zScore(1, [0, 0, 0])).toBeNull();
  });

  it('confidence rises with effect and sample and stays within bounds', () => {
    expect(ai.findingConfidence(2, 0, 7)).toBe(0.5);
    expect(ai.findingConfidence(50, 100, 7)).toBe(0.95);
    expect(ai.findingConfidence(4, 21, 7)).toBeGreaterThan(ai.findingConfidence(3, 7, 7));
  });
});

describe('detectAnomalies', () => {
  const flat = Array.from({ length: 13 }, () => 100);

  it('flags a 20% spike on the newest day', () => {
    const [found] = ai.detectAnomalies([...flat, 120], { window: 14, minBaseline: 7, lookback: 3 });
    expect(found).toMatchObject({ index: 13, value: 120, baselineSize: 13, deviationPercent: 20, z: 10 });
    expect(found.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('claims nothing below the minimum baseline', () => {
    expect(ai.detectAnomalies([100, 100, 100, 200], { window: 14, minBaseline: 7, lookback: 3 })).toEqual([]);
    expect(ai.hasEnoughBaseline(4, 7)).toBe(false);
    expect(ai.hasEnoughBaseline(8, 7)).toBe(true);
  });

  it('ignores ordinary noise and small relative changes', () => {
    const noisy = [100, 104, 96, 101, 99, 103, 97, 100, 102, 98, 101];
    expect(ai.detectAnomalies([...noisy, 103], { window: 14, minBaseline: 7, lookback: 3 })).toEqual([]);
    // Statistically odd but under 10%: not worth anyone's attention.
    expect(ai.detectAnomalies([...flat, 107], { window: 14, minBaseline: 7, lookback: 1 })).toEqual([]);
  });

  it('respects the direction', () => {
    const series = [...flat, 70];
    expect(ai.detectAnomalies(series, { window: 14, minBaseline: 7, lookback: 1, direction: 'up' })).toEqual([]);
    expect(ai.detectAnomalies(series, { window: 14, minBaseline: 7, lookback: 1, direction: 'down' })).toHaveLength(1);
  });

  it('only judges the lookback window', () => {
    const series = [...flat, 150, ...Array.from({ length: 5 }, () => 100)];
    expect(ai.detectAnomalies(series, { window: 14, minBaseline: 7, lookback: 3 })).toEqual([]);
    expect(ai.detectAnomalies(series, { window: 14, minBaseline: 7, lookback: 6 }).map((a) => a.value)).toEqual([150]);
  });
});

describe('countSpike', () => {
  it('flags a week well above a quiet baseline', () => {
    // Expected 0.5 a week; (6 − 0.5) / sqrt(0.5) = 7.78.
    const spike = ai.countSpike(6, [0, 1, 0, 1, 0, 1], { minBaseline: 6 });
    expect(spike).toMatchObject({ expected: 0.5, z: 7.78 });
  });

  it('stays silent on a single loss, on normal weeks, and with too little history', () => {
    expect(ai.countSpike(1, [0, 0, 0, 0, 0, 0], { minBaseline: 6 })).toBeNull();
    expect(ai.countSpike(3, [3, 2, 3, 4, 3, 3], { minBaseline: 6 })).toBeNull();
    expect(ai.countSpike(6, [0, 1], { minBaseline: 6 })).toBeNull();
  });
});

describe('gainSlowdown', () => {
  it('reports when the latest interval falls below 70% of the earlier mean', () => {
    const r = ai.gainSlowdown([0.2, 0.2, 0.12]);
    expect(r).toMatchObject({ latest: 0.12, previousMean: 0.2, ratio: 0.6 });
  });

  it('needs enough intervals and a real earlier gain', () => {
    expect(ai.gainSlowdown([0.2, 0.1])).toBeNull();
    expect(ai.gainSlowdown([0.2, 0.2, 0.18])).toBeNull();
    expect(ai.gainSlowdown([-0.1, -0.1, -0.2])).toBeNull();
  });
});

describe('forecasts', () => {
  it('weekStartOf returns the Monday', () => {
    expect(ai.weekStartOf('2026-11-04')).toBe('2026-11-02'); // Wednesday
    expect(ai.weekStartOf('2026-11-02')).toBe('2026-11-02'); // Monday
    expect(ai.weekStartOf('2026-11-08')).toBe('2026-11-02'); // Sunday
  });

  it('lambingWorkload matches the hand-computed weeks', () => {
    const rows = ai.lambingWorkload(
      [
        { weekStart: '2027-02-15', ewes: 10 },
        { weekStart: '2027-02-22', ewes: 20 },
        { weekStart: '2027-03-01', ewes: 30 },
      ],
      { lambsPerEwe: 1.2, lactationWeeks: 2, extraKgPerEweDay: 0.5, laborHoursPerLambing: 1, shiftHours: 10 },
    );
    expect(rows).toEqual([
      { weekStart: '2027-02-15', ewes: 10, lambs: 12, lactatingEwes: 10, extraFeedKg: 35, laborHours: 10, workersNeeded: 1 },
      { weekStart: '2027-02-22', ewes: 20, lambs: 24, lactatingEwes: 30, extraFeedKg: 105, laborHours: 20, workersNeeded: 1 },
      { weekStart: '2027-03-01', ewes: 30, lambs: 36, lactatingEwes: 50, extraFeedKg: 175, laborHours: 30, workersNeeded: 1 },
    ]);
  });

  it('lambingWorkload keeps extra feed null when a ration is missing', () => {
    const [row] = ai.lambingWorkload([{ weekStart: '2027-02-15', ewes: 100 }], {
      lambsPerEwe: 1,
      lactationWeeks: 8,
      extraKgPerEweDay: null,
      laborHoursPerLambing: 2,
      shiftHours: 10,
    });
    expect(row.extraFeedKg).toBeNull();
    expect(row.workersNeeded).toBe(3); // 200 h / 70 h a week
  });

  it('seasonForecast matches a hand calculation and skips incomplete lines', () => {
    const forecast = ai.seasonForecast([
      { areaHa: 10, expectedYieldTHa: 4, pricePerT: 1000, plannedCost: 20_000, actualCost: 25_000, harvestedT: null },
      { areaHa: 10, expectedYieldTHa: 4, pricePerT: 2000, plannedCost: 10_000, actualCost: 8000, harvestedT: 30 },
      { areaHa: 5, expectedYieldTHa: 4, pricePerT: null, plannedCost: 1000, actualCost: null, harvestedT: null },
    ]);
    expect(forecast).toEqual({
      revenue: 100_000,
      cost: 35_000,
      profit: 65_000,
      profitabilityPercent: 185.71,
      linesUsed: 2,
      linesSkipped: 1,
      areaCoveredPercent: 80,
    });
  });

  it('seasonForecast with nothing usable reports no profitability', () => {
    expect(ai.seasonForecast([]).profitabilityPercent).toBeNull();
    const none = ai.seasonForecast([
      { areaHa: 5, expectedYieldTHa: null, pricePerT: 10, plannedCost: 1, actualCost: null, harvestedT: null },
    ]);
    expect(none).toMatchObject({ linesUsed: 0, linesSkipped: 1, areaCoveredPercent: 0 });
  });

  it('feedRunOutDate counts whole days', () => {
    expect(ai.feedRunOutDate(3000, 600, '2026-11-04')).toBe('2026-11-09');
    expect(ai.feedRunOutDate(3100, 600, '2026-11-04')).toBe('2026-11-09');
    expect(ai.feedRunOutDate(3000, 0, '2026-11-04')).toBeNull();
  });

  it('costPerKgDryMatter', () => {
    expect(ai.costPerKgDryMatter(900, 90)).toBeCloseTo(1000, 8);
    expect(ai.costPerKgDryMatter(900, 0)).toBeNull();
  });

  it('rationSavingOption moves dry matter from the dearest to the cheapest', () => {
    const saving = ai.rationSavingOption(
      [
        { itemId: 'a', name: 'Arpa', kgPerHeadDay: 1, unitCostPerKg: 3000, dryMatterPct: 90 },
        { itemId: 'b', name: 'Somon', kgPerHeadDay: 1, unitCostPerKg: 1000, dryMatterPct: 88 },
      ],
      500,
    );
    // 0.09 kg DM × (3333.33 − 1136.36) = 197.73 per head per day.
    expect(saving).toEqual({
      fromItemId: 'a',
      fromName: 'Arpa',
      toItemId: 'b',
      toName: 'Somon',
      shiftKgDmPerHeadDay: 0.09,
      savingPerHeadDay: 197.73,
      savingPerDay: 98_863.64,
    });
  });

  it('rationSavingOption needs two priced components', () => {
    const line = { itemId: 'a', name: 'A', kgPerHeadDay: 1, unitCostPerKg: 100, dryMatterPct: 90 };
    expect(ai.rationSavingOption([line], 10)).toBeNull();
    expect(ai.rationSavingOption([line, { ...line, itemId: 'b', unitCostPerKg: null }], 10)).toBeNull();
    expect(ai.rationSavingOption([line, { ...line, itemId: 'b' }], 10)).toBeNull();
    expect(ai.rationSavingOption([line, { ...line, itemId: 'b', unitCostPerKg: 50 }], 0)).toBeNull();
  });

  it('rankCropOptions orders by margin and applies rotation and feed adjustments', () => {
    const base = { isFeed: false, grownLastSeason: false, feedShortage: false };
    const ranked = ai.rankCropOptions([
      { ...base, key: 'wheat', yieldTHa: 5, pricePerT: 3_000_000, costPerHa: 9_000_000, grownLastSeason: true },
      { ...base, key: 'barley', yieldTHa: 4, pricePerT: 2_500_000, costPerHa: 5_000_000, isFeed: true, feedShortage: true },
      { ...base, key: 'rice', yieldTHa: null, pricePerT: 1, costPerHa: 1 },
    ]);
    // wheat margin 6 mln, less 25% = 4.5 mln. barley margin 5 mln, plus 15% = 5.75 mln.
    expect(ranked).toEqual([
      { key: 'barley', marginPerHa: 5_000_000, score: 5_750_000, reasons: ['feed_shortage_bonus'] },
      { key: 'wheat', marginPerHa: 6_000_000, score: 4_500_000, reasons: ['rotation_penalty'] },
    ]);
  });

  it('a perennial crop carries no rotation penalty', () => {
    const [ranked] = ai.rankCropOptions([
      { key: 'alfalfa', yieldTHa: 8, pricePerT: 1, costPerHa: 1, isFeed: true, perennial: true, grownLastSeason: true, feedShortage: false },
    ]);
    expect(ranked.reasons).toEqual([]);
  });
});
