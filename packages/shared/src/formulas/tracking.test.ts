import { describe, expect, it } from 'vitest';
import {
  daySummary,
  haversineM,
  herdFever,
  herdInactivity,
  herdIsolation,
  isDaytime,
  median,
  medianPoint,
  rangeM,
  trackDistanceM,
  type AnimalFixes,
  type AnimalWindow,
  type Fix,
} from './tracking';

/**
 * Control numbers by hand: along a meridian the distance is R · Δφ, so with R = 6 371 008.8 m one
 * degree of latitude is 6 371 008.8 · π / 180 = 111 195.08 m, and 0.001° is 111.195 m.
 */
const PER_DEGREE = 111_195.08;
const LAT = 39.0; // Qorovulbozor is near 39.5 N; any latitude works for steps along a meridian
const LNG = 64.8;
const MIN = 60_000;
const NOW = Date.UTC(2026, 5, 1, 9, 0); // 14:00 in Tashkent

const at = (dLat: number, minutesAgo: number, dLng = 0): Fix => ({ lat: LAT + dLat, lng: LNG + dLng, at: NOW - minutesAgo * MIN });

describe('distances', () => {
  it('haversineM along a meridian is R · Δφ', () => {
    expect(haversineM({ lat: 39, lng: 64 }, { lat: 39.01, lng: 64 })).toBeCloseTo(0.01 * PER_DEGREE, 1); // 1111.95 m
  });

  it('haversineM along the equator is R · Δλ', () => {
    expect(haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(PER_DEGREE, 0);
  });

  it('median: odd, even, none', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('medianPoint ignores one far point, where a mean would not', () => {
    const centre = medianPoint([at(0, 0), at(0.0001, 0), at(0.0002, 0), at(0.05, 0)])!;
    expect(centre.lat).toBeCloseTo(LAT + 0.00015, 6);
    expect(medianPoint([])).toBeNull();
  });

  it('trackDistanceM adds the steps and drops a jump faster than 10 km/h', () => {
    // Three steps of 0.001° (111.195 m each) ten minutes apart, then a 0.05° jump (5.56 km in 10 min).
    const walk = [at(0, 40), at(0.001, 30), at(0.002, 20), at(0.052, 10), at(0.003, 0)];
    expect(trackDistanceM(walk)).toBeCloseTo(3 * 111.195, 1); // 333.59 m: the jump is not walked
    expect(trackDistanceM([at(0, 0)])).toBeNull();
  });

  it('trackDistanceM ignores jitter of a sheep standing still but counts a slow walk', () => {
    const still = [at(0, 30), at(0.00002, 20), at(0, 10), at(0.00002, 0)]; // 2.2 m back and forth
    expect(trackDistanceM(still)).toBe(0);
    // 3.34 m per step: counted every second step, once the sheep is 6.67 m on (past 5 m), so the
    // last unfinished step is not: 2 × 0.00006° = 13.34 m of the 16.68 m walked.
    const slow = [0, 1, 2, 3, 4, 5].map((i) => at(i * 0.00003, 60 - i * 10));
    expect(trackDistanceM(slow)).toBeCloseTo(0.00012 * PER_DEGREE, 1);
  });

  it('rangeM is how far the fixes reach from their own centre', () => {
    expect(rangeM([at(0, 20), at(0.001, 10), at(0.002, 0)])).toBeCloseTo(111.195, 1);
    expect(rangeM([])).toBeNull();
  });

  it('isDaytime is 07:00 to before 20:00', () => {
    expect([6, 7, 19, 20].map(isDaytime)).toEqual([false, true, true, false]);
  });
});

describe('herdIsolation', () => {
  /** Five sheep 0.0001° (11.12 m) apart on a line, and one more wherever the test puts it. */
  const flock = (stray: Fix[]): AnimalFixes[] => [
    ...[0, 0.0001, 0.0002, 0.0003, 0.0004].map((d, i) => ({ animalId: `s${i}`, fixes: [at(d, 10), at(d, 0)] })),
    { animalId: 'stray', fixes: stray },
  ];

  it('finds the sheep 800 m away on both of its last fixes', () => {
    const result = herdIsolation(flock([at(0.0072, 10), at(0.0072, 0)]), NOW)!;
    // Centre: median of the six latitudes (0.0002 and 0.0003) = +0.00025°.
    // Distances from it: 27.80, 16.68, 5.56, 5.56, 16.68, 772.81 m; median 16.68; 4 × 16.68 < 300.
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.thresholdM).toBe(300);
    expect(result.isolated).toHaveLength(1);
    expect(result.isolated[0]!.animalId).toBe('stray');
    expect(result.isolated[0]!.distanceM).toBeCloseTo(0.00695 * PER_DEGREE, 1); // 772.81 m
  });

  it('does not trust one far fix', () => {
    const result = herdIsolation(flock([at(0.0004, 10), at(0.0072, 0)]), NOW)!;
    expect(result.kind === 'ok' && result.isolated).toEqual([]);
  });

  it('calls it a split flock when more than 10% are apart', () => {
    const herd: AnimalFixes[] = [
      ...Array.from({ length: 7 }, (_, i) => ({ animalId: `n${i}`, fixes: [at(i * 0.0001, 10), at(i * 0.0001, 0)] })),
      ...Array.from({ length: 3 }, (_, i) => ({ animalId: `f${i}`, fixes: [at(0.02, 10, i * 0.0001), at(0.02, 0, i * 0.0001)] })),
    ];
    const result = herdIsolation(herd, NOW)!;
    // 3 apart of 10 is more than max(1, floor(10% of 10)) = 1.
    expect(result).toMatchObject({ kind: 'split', tracked: 10, apart: 3 });
  });

  it('has no answer when fewer than 5 sheep have a fresh fix', () => {
    const herd = flock([at(0.0072, 50), at(0.0072, 40)]).slice(1); // 4 fresh, the stray is 40 min old
    expect(herdIsolation(herd, NOW)).toBeNull();
  });
});

describe('herdInactivity', () => {
  /** A sheep grazing along the meridian: fixes 0.001° apart reach 111.2 m from their centre. */
  const grazing = (id: string, activity: number[] = []): AnimalWindow => ({
    animalId: id,
    fixes: [at(0, 120), at(0.001, 60), at(0.002, 0)],
    activity,
  });
  const standing = (activity: number[] = []): AnimalWindow => ({
    animalId: 'still',
    fixes: [at(0, 120), at(0.00005, 60), at(0, 0)], // 5.56 m apart: range 5.56 m from the median
    activity,
  });

  it('flags the sheep that stood still while its herd grazed', () => {
    const result = herdInactivity([...['a', 'b', 'c', 'd', 'e'].map((id) => grazing(id)), standing()])!;
    expect(result.herdRangeM).toBeCloseTo(111.195, 1);
    expect(result.inactive.map((x) => x.animalId)).toEqual(['still']);
  });

  it('does not flag it when its activity counter says it is moving', () => {
    const busy = [10, 12, 11];
    const result = herdInactivity([...['a', 'b', 'c', 'd', 'e'].map((id) => grazing(id, busy)), standing(busy)])!;
    expect(result.inactive).toEqual([]);
  });

  it('uses the counter alone when there are no fixes', () => {
    const counter = (id: string, mean: number): AnimalWindow => ({ animalId: id, fixes: [], activity: [mean, mean, mean] });
    const result = herdInactivity([counter('a', 10), counter('b', 11), counter('c', 9), counter('d', 10), counter('e', 12), counter('idle', 2)])!;
    // Herd median of 2, 9, 10, 10, 11, 12 is 10; 2 is below 25% of 10.
    expect(result.herdActivity).toBe(10);
    expect(result.inactive.map((x) => x.animalId)).toEqual(['idle']);
  });

  it('flags nobody while the whole herd rests', () => {
    const resting = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ ...standing(), animalId: id }));
    expect(herdInactivity(resting)!.inactive).toEqual([]);
  });

  it('has no answer for a herd with too little data', () => {
    expect(herdInactivity([grazing('a'), standing()])).toBeNull();
  });
});

describe('herdFever', () => {
  const normal = [39.1, 39.0, 39.2];
  const herd = (feverRecent: number[], feverBaseline = normal) => [
    { animalId: 'a', recent: [39.0, 39.1], baselineDays: normal },
    { animalId: 'b', recent: [39.2, 39.1], baselineDays: normal },
    { animalId: 'c', recent: [39.0, 39.0], baselineDays: normal },
    { animalId: 'd', recent: [39.1, 39.2], baselineDays: normal },
    { animalId: 'e', recent: [39.0, 39.1], baselineDays: normal },
    { animalId: 'hot', recent: feverRecent, baselineDays: feverBaseline },
  ];

  it('finds the sheep above both its herd and its own normal', () => {
    const result = herdFever(herd([40.4, 40.6]))!;
    // Medians: 39.05, 39.15, 39.0, 39.15, 39.05, 40.5; herd median (39.05 + 39.15) / 2 = 39.1.
    // Own normal: median of 39.1, 39.0, 39.2 = 39.1. 40.5 is 1.4 above both, below the 2.0 for urgent.
    expect(result.herdMedianC).toBeCloseTo(39.1, 6);
    expect(result.fever).toHaveLength(1);
    expect(result.fever[0]).toMatchObject({ animalId: 'hot', urgent: false });
    expect(result.fever[0]!.overHerdC).toBeCloseTo(1.4, 6);
    expect(result.fever[0]!.overBaselineC).toBeCloseTo(1.4, 6);
  });

  it('is urgent 2 °C above the herd', () => {
    expect(herdFever(herd([41.2, 41.2]))!.fever[0]!.urgent).toBe(true);
  });

  it('waits until the sheep has three days of its own normal', () => {
    expect(herdFever(herd([40.4, 40.6], [39.1, 39.0]))!.fever).toEqual([]);
  });

  it('raises nothing when the whole herd is warm', () => {
    const hot = herd([40.4, 40.6]).map((a) => ({ ...a, recent: [40.5, 40.6] }));
    expect(herdFever(hot)!.fever).toEqual([]);
  });

  it('needs two readings from the sheep and five sheep in the herd', () => {
    expect(herdFever(herd([40.5]))!.fever).toEqual([]);
    expect(herdFever(herd([40.5, 40.5]).slice(0, 4))).toBeNull();
  });
});

describe('daySummary', () => {
  it('keeps distance, activity and temperature for the day, null where nothing was read', () => {
    const summary = daySummary([
      { at: NOW - 20 * MIN, lat: LAT, lng: LNG, activity: 4, temperatureC: null },
      { at: NOW - 10 * MIN, lat: LAT + 0.001, lng: LNG, activity: 6, temperatureC: 39.2 },
      { at: NOW, lat: null, lng: null, activity: null, temperatureC: 39.6 },
    ]);
    expect(summary).toMatchObject({ fixes: 2, activityMean: 5, temperatureMaxC: 39.6 });
    expect(summary.distanceM).toBeCloseTo(111.195, 1);
    expect(summary.temperatureMedianC).toBeCloseTo(39.4, 6);
    expect(daySummary([])).toEqual({ fixes: 0, distanceM: null, activityMean: null, temperatureMedianC: null, temperatureMaxC: null });
  });
});
