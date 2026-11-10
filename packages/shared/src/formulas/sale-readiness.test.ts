import { describe, expect, it } from 'vitest';
import {
  dateReachingWeight,
  estimatedSaleValue,
  ownPricePerKg,
  projectedWeightKg,
  recentDailyGain,
  saleForecast,
  SALE_READINESS,
} from './sale-readiness';

/**
 * Control animal, worked by hand:
 *   1 Aug 30.0 kg, 1 Sep 36.2 kg, 1 Oct 42.2 kg.
 *   1 Aug to 1 Oct is 31 + 30 = 61 days, inside the 90-day window, so growth is measured over all of it:
 *   (42.2 - 30.0) / 61 = 12.2 / 61 = 0.2 kg a day.
 *   Target 45 kg: (45 - 42.2) / 0.2 = 14 days after 1 Oct = 15 Oct.
 *   On 11 Oct, 10 days after the weighing: 42.2 + 0.2 x 10 = 44.2 kg, and 4 days to go.
 */
const lamb = [
  { date: '2026-08-01', weightKg: 30 },
  { date: '2026-09-01', weightKg: 36.2 },
  { date: '2026-10-01', weightKg: 42.2 },
];

describe('recentDailyGain', () => {
  it('measures from the oldest weighing inside the window to the newest', () => {
    const gain = recentDailyGain(lamb);
    expect(gain?.kgPerDay).toBeCloseTo(0.2, 10);
    expect(gain?.from.date).toBe('2026-08-01');
    expect(gain?.to.date).toBe('2026-10-01');
  });

  it('leaves out weighings older than the window', () => {
    // 1 May is 153 days before 1 Oct, outside 90 days, so it changes nothing.
    const gain = recentDailyGain([{ date: '2026-05-01', weightKg: 5 }, ...lamb]);
    expect(gain?.from.date).toBe('2026-08-01');
    expect(gain?.kgPerDay).toBeCloseTo(0.2, 10);
  });

  it('with a narrower window measures from a later weighing', () => {
    // 30 days back from 1 Oct reaches 1 Sep: (42.2 - 36.2) / 30 = 0.2.
    const gain = recentDailyGain(lamb, 30);
    expect(gain?.from.date).toBe('2026-09-01');
    expect(gain?.kgPerDay).toBeCloseTo(0.2, 10);
  });

  it('uses the weighing before the newest when the window holds only the newest', () => {
    // 1 Jan to 1 Oct 2026 is 273 days: 27.3 / 273 = 0.1 kg a day. Measured, though old.
    const gain = recentDailyGain([
      { date: '2026-01-01', weightKg: 20 },
      { date: '2026-10-01', weightKg: 47.3 },
    ]);
    expect(gain?.kgPerDay).toBeCloseTo(0.1, 10);
    expect(gain?.from.date).toBe('2026-01-01');
  });

  it('is null with fewer than two weighings on different days', () => {
    expect(recentDailyGain([])).toBeNull();
    expect(recentDailyGain([{ date: '2026-10-01', weightKg: 42 }])).toBeNull();
    expect(
      recentDailyGain([
        { date: '2026-10-01', weightKg: 42 },
        { date: '2026-10-01', weightKg: 43 },
      ]),
    ).toBeNull();
  });

  it('takes the last weight given for a day, and the order of the list does not matter', () => {
    const gain = recentDailyGain([
      { date: '2026-10-01', weightKg: 99 },
      { date: '2026-08-01', weightKg: 30 },
      { date: '2026-10-01', weightKg: 42.2 },
    ]);
    expect(gain?.kgPerDay).toBeCloseTo(0.2, 10);
  });

  it('is negative when the animal lost weight', () => {
    // 40 to 38.5 over 30 days: -1.5 / 30 = -0.05.
    const gain = recentDailyGain([
      { date: '2026-09-01', weightKg: 40 },
      { date: '2026-10-01', weightKg: 38.5 },
    ]);
    expect(gain?.kgPerDay).toBeCloseTo(-0.05, 10);
  });
});

describe('projectedWeightKg', () => {
  const last = lamb[2];
  it('carries the last weight forward at the measured gain', () => {
    expect(projectedWeightKg(last, 0.2, '2026-10-11')).toBe(44.2);
    expect(projectedWeightKg(last, 0.2, '2026-10-01')).toBe(42.2);
  });
  it('is null without a gain, or for a day before the weighing', () => {
    expect(projectedWeightKg(last, null, '2026-10-11')).toBeNull();
    expect(projectedWeightKg(last, 0.2, '2026-09-30')).toBeNull();
  });
});

describe('dateReachingWeight', () => {
  const last = lamb[2];
  it('gives the first day at or above the target', () => {
    expect(dateReachingWeight(last, 0.2, 45)).toBe('2026-10-15');
    // 2.9 / 0.2 = 14.5 days: it is there on the 15th day, 16 Oct.
    expect(dateReachingWeight(last, 0.2, 45.1)).toBe('2026-10-16');
  });
  it('is the day of the weighing when the animal is there already', () => {
    expect(dateReachingWeight(last, 0.2, 42.2)).toBe('2026-10-01');
    expect(dateReachingWeight(last, null, 40)).toBe('2026-10-01');
  });
  it('is null when the animal never arrives, and without a target', () => {
    expect(dateReachingWeight(last, 0, 45)).toBeNull();
    expect(dateReachingWeight(last, -0.05, 45)).toBeNull();
    expect(dateReachingWeight(last, null, 45)).toBeNull();
    expect(dateReachingWeight(last, 0.2, null)).toBeNull();
    expect(dateReachingWeight(last, 0.2, 0)).toBeNull();
  });
});

describe('saleForecast', () => {
  it('soon: the control animal reaches 45 kg in 4 days', () => {
    expect(saleForecast(lamb, 45, '2026-10-11')).toEqual({
      status: 'soon',
      lastWeight: { date: '2026-10-01', weightKg: 42.2 },
      dailyGainKg: 0.2,
      gainFrom: '2026-08-01',
      projectedWeightKg: 44.2,
      targetDate: '2026-10-15',
      daysToTarget: 4,
      notGaining: false,
    });
  });

  it('later: 60 kg is 89 days after the weighing', () => {
    // (60 - 42.2) / 0.2 = 89 days after 1 Oct = 29 Dec, 79 days after 11 Oct.
    const f = saleForecast(lamb, 60, '2026-10-11');
    expect(f.status).toBe('later');
    expect(f.targetDate).toBe('2026-12-29');
    expect(f.daysToTarget).toBe(79);
  });

  it('the edge of "soon" is the named number of days', () => {
    // 15 Oct is 30 days after 15 Sep and 31 days after 14 Sep.
    expect(SALE_READINESS.soonDays).toBe(30);
    const twoWeighings = lamb.slice(0, 2);
    // From 1 Sep at 36.2 kg and 0.2 kg a day, 45 kg takes 44 days: 15 Oct.
    expect(saleForecast(twoWeighings, 45, '2026-09-15').status).toBe('soon');
    expect(saleForecast(twoWeighings, 45, '2026-09-14').status).toBe('later');
  });

  it('ready only on a measured weight, never on the forecast alone', () => {
    const ready = saleForecast(lamb, 42, '2026-10-11');
    expect(ready.status).toBe('ready');
    expect(ready.targetDate).toBe('2026-10-01');
    expect(ready.daysToTarget).toBe(-10);
    // The forecast passed 45 kg on 15 Oct, but nobody has weighed it since: still "soon".
    const overdue = saleForecast(lamb, 45, '2026-11-01');
    expect(overdue.status).toBe('soon');
    expect(overdue.daysToTarget).toBe(-17);
    expect(overdue.projectedWeightKg).toBe(48.4);
  });

  it('one weighing at or above the target is ready, with no gain to show', () => {
    const f = saleForecast([{ date: '2026-10-01', weightKg: 50 }], 45, '2026-10-11');
    expect(f.status).toBe('ready');
    expect(f.dailyGainKg).toBeNull();
    expect(f.projectedWeightKg).toBeNull();
  });

  it('not gaining: below the target and losing or holding weight never arrives', () => {
    const f = saleForecast(
      [
        { date: '2026-09-01', weightKg: 40 },
        { date: '2026-10-01', weightKg: 38.5 },
      ],
      45,
      '2026-10-11',
    );
    expect(f).toMatchObject({ status: 'later', targetDate: null, daysToTarget: null, notGaining: true, dailyGainKg: -0.05 });
    const flat = saleForecast(
      [
        { date: '2026-09-01', weightKg: 40 },
        { date: '2026-10-01', weightKg: 40 },
      ],
      45,
      '2026-10-11',
    );
    expect(flat).toMatchObject({ status: 'later', targetDate: null, notGaining: true, dailyGainKg: 0 });
  });

  it('unknown without a target, without a weight, or with one weighing below the target', () => {
    expect(saleForecast(lamb, null, '2026-10-11')).toMatchObject({ status: 'unknown', targetDate: null, dailyGainKg: 0.2 });
    expect(saleForecast([], 45, '2026-10-11')).toMatchObject({ status: 'unknown', lastWeight: null, dailyGainKg: null, projectedWeightKg: null });
    expect(saleForecast([{ date: '2026-10-01', weightKg: 30 }], 45, '2026-10-11')).toMatchObject({
      status: 'unknown',
      targetDate: null,
      daysToTarget: null,
      notGaining: false,
    });
  });
});

describe('ownPricePerKg and estimatedSaleValue', () => {
  it('is money received over kilograms sold, not the average of the prices', () => {
    // 40 kg for 2 000 000 and 60 kg for 3 300 000: 5 300 000 / 100 = 53 000 a kg.
    expect(
      ownPricePerKg([
        { amount: 2_000_000, liveWeightKg: 40 },
        { amount: 3_300_000, liveWeightKg: 60 },
        { amount: 900_000, liveWeightKg: null },
        { amount: null, liveWeightKg: 50 },
      ]),
    ).toBe(53_000);
  });
  it('is null with no sale that has both a weight and an amount', () => {
    expect(ownPricePerKg([])).toBeNull();
    expect(ownPricePerKg([{ amount: 900_000, liveWeightKg: null }])).toBeNull();
  });
  it('values the measured weight at that price, and guesses nothing', () => {
    // 42.2 kg x 53 000 = 2 236 600.
    expect(estimatedSaleValue(42.2, 53_000)).toBe(2_236_600);
    expect(estimatedSaleValue(null, 53_000)).toBeNull();
    expect(estimatedSaleValue(42.2, null)).toBeNull();
  });
});
