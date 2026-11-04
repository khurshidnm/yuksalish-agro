import { describe, expect, it } from 'vitest';
import { averageDailyConsumption, kgPerUnit } from './feed';

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
