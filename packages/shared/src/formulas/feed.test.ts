import { describe, expect, it } from 'vitest';
import { averageDailyConsumption, dryMatterKg, dryMatterPercentOfWeight, hectaresForCropShortages, kgPerUnit, rationDryMatterKg } from './feed';

const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}`;
const TODAY = day(20);

describe('averageDailyConsumption', () => {
  it('averages seven full days of daily issues', () => {
    const issues = [13, 14, 15, 16, 17, 18, 19].map((d) => ({ date: day(d), qty: 600 }));
    expect(averageDailyConsumption(issues, TODAY)).toEqual({ avgDaily: 600, total: 4200, days: 7 });
  });

  it('counts today once something was issued today', () => {
    const issues = [14, 15, 16, 17, 18, 19, 20].map((d) => ({ date: day(d), qty: 100 }));
    expect(averageDailyConsumption(issues, TODAY)).toEqual({ avgDaily: 100, total: 700, days: 7 });
  });

  it('ignores anything older than the window', () => {
    const issues = [
      { date: day(1), qty: 99_999 },
      { date: day(12), qty: 99_999 },
      ...[13, 14, 15, 16, 17, 18, 19].map((d) => ({ date: day(d), qty: 10 })),
    ];
    expect(averageDailyConsumption(issues, TODAY)?.avgDaily).toBe(10);
  });

  it('does not understate in the first days of records', () => {
    const issues = [17, 18, 19].map((d) => ({ date: day(d), qty: 600 }));
    expect(averageDailyConsumption(issues, TODAY)).toEqual({ avgDaily: 600, total: 1800, days: 3 });
  });

  it('counts unlogged days in the span as zero consumption', () => {
    const issues = [
      { date: day(13), qty: 700 },
      { date: day(19), qty: 700 },
    ];
    expect(averageDailyConsumption(issues, TODAY)).toEqual({ avgDaily: 200, total: 1400, days: 7 });
  });

  it('sums several issues on one day', () => {
    const issues = [
      { date: day(19), qty: 200 },
      { date: day(19), qty: 300 },
    ];
    expect(averageDailyConsumption(issues, TODAY)).toEqual({ avgDaily: 500, total: 500, days: 1 });
  });

  it('is null when nothing was issued', () => {
    expect(averageDailyConsumption([], TODAY)).toBeNull();
    expect(averageDailyConsumption([{ date: day(1), qty: 5 }], TODAY)).toBeNull();
    expect(averageDailyConsumption([{ date: day(19), qty: 0 }], TODAY)).toBeNull();
  });

  it('respects a custom window', () => {
    const issues = [
      { date: day(16), qty: 9999 },
      { date: day(18), qty: 100 },
      { date: day(19), qty: 300 },
    ];
    expect(averageDailyConsumption(issues, TODAY, 2)).toEqual({ avgDaily: 200, total: 400, days: 2 });
  });
});

describe('kgPerUnit', () => {
  it('knows kg and tonnes', () => {
    expect(kgPerUnit('kg')).toBe(1);
    expect(kgPerUnit('t')).toBe(1000);
  });

  it('needs an explicit weight for anything else', () => {
    expect(kgPerUnit('bale', 22)).toBe(22);
    expect(kgPerUnit('bale')).toBeNull();
    expect(kgPerUnit('bale', 0)).toBeNull();
    expect(kgPerUnit('l')).toBeNull();
  });
});

describe('hectaresForCropShortages', () => {
  it('sows one wheat field for grain and straw, not two (control numbers)', () => {
    // Grain 38.3 t at 5.5 t/ha = 6.96 ha; straw 43.92 t at 5.5 t/ha = 7.99 ha. One field gives both: 7.99 ha, not 14.95.
    const ha = hectaresForCropShortages([
      { shortageKg: 38_300, yieldTHa: 5.5 },
      { shortageKg: 43_920, yieldTHa: 5.5 },
    ]);
    expect(ha).toBeCloseTo(7.985, 3);
  });

  it('uses each product its own yield', () => {
    // Straw at 6.6 t/ha (1.2 × grain): 43.92 / 6.6 = 6.65 ha; grain 38.3 / 5.5 = 6.96 ha sets the land.
    expect(hectaresForCropShortages([
      { shortageKg: 38_300, yieldTHa: 5.5 },
      { shortageKg: 43_920, yieldTHa: 6.6 },
    ])).toBeCloseTo(6.9636, 3);
  });

  it('is null while a short product has no yield, and 0 when nothing is short', () => {
    expect(hectaresForCropShortages([{ shortageKg: 1000, yieldTHa: 5 }, { shortageKg: 1000, yieldTHa: null }])).toBeNull();
    expect(hectaresForCropShortages([{ shortageKg: 1000, yieldTHa: 0 }])).toBeNull();
    expect(hectaresForCropShortages([{ shortageKg: 0, yieldTHa: null }])).toBe(0);
    expect(hectaresForCropShortages([])).toBe(0);
  });
});

describe('dry matter', () => {
  it('converts an as-fed amount', () => {
    expect(dryMatterKg(1.1, 86)).toBeCloseTo(0.946, 6);
    expect(dryMatterKg(1, 30)).toBeCloseTo(0.3, 6);
  });

  it('is null without a sensible percent', () => {
    expect(dryMatterKg(1, null)).toBeNull();
    expect(dryMatterKg(1, undefined)).toBeNull();
    expect(dryMatterKg(1, 0)).toBeNull();
    expect(dryMatterKg(1, 120)).toBeNull();
  });

  it('sums a ration on dry matter, not as fed (control numbers)', () => {
    // Hay 1.1 kg at 86 % = 0.946, silage 1 kg at 30 % = 0.3, barley 0.4 kg at 87 % = 0.348,
    // bran 0.2 kg at 88 % = 0.176, salt 0.012 kg at 98 % = 0.01176, premix 0.012 kg at 95 % = 0.0114.
    // As fed that is 2.724 kg; as dry matter 1.79316 kg.
    const lines = [
      { kgPerHeadDay: 1.1, dryMatterPct: 86 },
      { kgPerHeadDay: 1, dryMatterPct: 30 },
      { kgPerHeadDay: 0.4, dryMatterPct: 87 },
      { kgPerHeadDay: 0.2, dryMatterPct: 88 },
      { kgPerHeadDay: 0.012, dryMatterPct: 98 },
      { kgPerHeadDay: 0.012, dryMatterPct: 95 },
    ];
    expect(rationDryMatterKg(lines)).toBeCloseTo(1.79316, 6);
  });

  it('gives no total when one feed has no dry matter', () => {
    expect(rationDryMatterKg([{ kgPerHeadDay: 1, dryMatterPct: 86 }, { kgPerHeadDay: 1, dryMatterPct: null }])).toBeNull();
    expect(rationDryMatterKg([])).toBeNull();
  });

  it('states intake as a percent of live weight', () => {
    // 2.06 kg DM for a 71 kg ewe is 2.9 %.
    expect(dryMatterPercentOfWeight(2.06, 71)).toBeCloseTo(2.9014, 3);
    expect(dryMatterPercentOfWeight(null, 71)).toBeNull();
    expect(dryMatterPercentOfWeight(2, null)).toBeNull();
    expect(dryMatterPercentOfWeight(2, 0)).toBeNull();
  });
});
