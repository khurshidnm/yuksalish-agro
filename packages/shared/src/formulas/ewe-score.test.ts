import { describe, expect, it } from 'vitest';
import { CULLING, EWE_SCORE, cullReasons, emptySeasonsRunning, eweScore, lambingIntervalDays, lowScoreCutoff, scalePoints, type CullInput, type EweScoreInput } from './ewe-score';

const full: EweScoreInput = {
  lambings: 3,
  lambsBorn: 5,
  lambsDueAtWeaning: 4,
  lambsReared: 3,
  lambWeight100Kg: 33,
  farmWeight100Kg: 30,
  lambingIntervalDays: 400,
  ageYears: 5,
  bodyCondition: 2.5,
  bodyConditionAgeDays: 30,
};

describe('ewe score', () => {
  it('rests on the starting values this test was worked with', () => {
    expect(EWE_SCORE.weights).toEqual({ prolificacy: 25, rearing: 25, lamb_growth: 20, lambing_interval: 10, age: 10, condition: 10 });
    expect(EWE_SCORE.scales.lamb_growth).toEqual({ zeroAt: 80, fullAt: 120 });
    expect(EWE_SCORE.scales.lambing_interval).toEqual({ zeroAt: 730, fullAt: 365 });
    expect(EWE_SCORE.scales.age).toEqual({ zeroAt: 10, fullAt: 6 });
    expect(EWE_SCORE.scales.condition).toEqual({ zeroAt: 1, fullAt: 3 });
  });

  it('turns a value into 0 to 100 points, in either direction', () => {
    expect(scalePoints(1, { zeroAt: 0, fullAt: 2 })).toBe(50);
    expect(scalePoints(3, { zeroAt: 0, fullAt: 2 })).toBe(100);
    expect(scalePoints(-1, { zeroAt: 0, fullAt: 2 })).toBe(0);
    // Downwards: 8 years between "full at 6" and "zero at 10" is half way.
    expect(scalePoints(8, { zeroAt: 10, fullAt: 6 })).toBe(50);
    expect(scalePoints(4, { zeroAt: 10, fullAt: 6 })).toBe(100);
    expect(scalePoints(12, { zeroAt: 10, fullAt: 6 })).toBe(0);
  });

  it('scores a ewe with every part, by hand', () => {
    // prolificacy       5 lambs / 3 lambings = 1.6667 -> 1.6667 / 2          = 83.333 points x 0.25 = 20.8333
    // rearing           3 reared / 4 due = 0.75                              = 75     points x 0.25 = 18.75
    // lamb_growth       33 / 30 = index 110 -> (110 - 80) / 40               = 75     points x 0.20 = 15
    // lambing_interval  400 days -> (730 - 400) / 365                        = 90.411 points x 0.10 =  9.0411
    // age               5 years, full until 6                                = 100    points x 0.10 = 10
    // condition         2.5 -> (2.5 - 1) / 2                                 = 75     points x 0.10 =  7.5
    //                                                                                         total = 81.1244
    const result = eweScore(full);
    expect(result.missing).toEqual([]);
    expect(result.score).toBeCloseTo(81.1244, 3);
    const points = Object.fromEntries(result.parts.map((p) => [p.key, p.points]));
    expect(points.prolificacy).toBeCloseTo(83.333, 2);
    expect(points.rearing).toBe(75);
    expect(points.lamb_growth).toBeCloseTo(75, 6);
    expect(points.lambing_interval).toBeCloseTo(90.411, 2);
    expect(points.age).toBe(100);
    expect(points.condition).toBe(75);
    expect(result.parts.map((p) => p.weight)).toEqual([0.25, 0.25, 0.2, 0.1, 0.1, 0.1]);
    expect(result.parts.find((p) => p.key === 'lamb_growth')?.value).toBeCloseTo(110, 6);
  });

  it('leaves out a part with no data and shares its weight among the rest', () => {
    // A two-year-old with one single lamb born last month: only prolificacy (1 / 2 = 50 points,
    // weight 25) and age (100 points, weight 10) are known. (50 x 25 + 100 x 10) / 35 = 64.2857.
    const result = eweScore({
      lambings: 1,
      lambsBorn: 1,
      lambsDueAtWeaning: 0,
      lambsReared: 0,
      lambWeight100Kg: null,
      farmWeight100Kg: 30,
      lambingIntervalDays: null,
      ageYears: 2,
      bodyCondition: null,
      bodyConditionAgeDays: null,
    });
    expect(result.score).toBeCloseTo(64.2857, 3);
    expect(result.missing).toEqual(['rearing', 'lamb_growth', 'lambing_interval', 'condition']);
    expect(result.parts.map((p) => [p.key, p.weight])).toEqual([
      ['prolificacy', 25 / 35],
      ['age', 10 / 35],
    ]);
  });

  it('treats an old body condition score as missing', () => {
    const stale = eweScore({ ...full, bodyConditionAgeDays: EWE_SCORE.conditionMaxAgeDays + 1 });
    expect(stale.missing).toEqual(['condition']);
    // The other five parts over a weight of 90: (20.8333 + 18.75 + 15 + 9.0411 + 10) / 0.9 = 81.8049.
    expect(stale.score).toBeCloseTo(81.8049, 3);
  });

  it('counts a fostered or bottle lamb as born to her but not reared by her', () => {
    // Twins, one given to a foster ewe: 2 born, 2 due at weaning, 1 reared -> rearing 0.5 = 50 points.
    const result = eweScore({ ...full, lambings: 1, lambsBorn: 2, lambsDueAtWeaning: 2, lambsReared: 1, lambingIntervalDays: null });
    expect(result.parts.find((p) => p.key === 'prolificacy')?.points).toBe(100);
    expect(result.parts.find((p) => p.key === 'rearing')?.points).toBe(50);
  });

  it('has no score for a ewe with no lambing on record', () => {
    const result = eweScore({ ...full, lambings: 0, lambsBorn: 0, lambsDueAtWeaning: 0, lambsReared: 0 });
    expect(result.score).toBeNull();
    expect(result.parts).toEqual([]);
    expect(result.missing).toHaveLength(6);
  });

  it('averages the days between lambings', () => {
    // 2024-03-01 -> 2025-03-11 is 375 days, -> 2026-03-01 another 355: 730 / 2 = 365.
    expect(lambingIntervalDays(['2025-03-11', '2024-03-01', '2026-03-01'])).toBe(365);
    expect(lambingIntervalDays(['2026-03-01'])).toBeNull();
    expect(lambingIntervalDays([])).toBeNull();
  });
});

describe('culling reasons', () => {
  const none: CullInput = {
    ageYears: 4,
    emptySeasons: 0,
    rearedByLambing: [1, 2],
    score: 70,
    lowScoreCutoff: 40,
    conditionScores: [3, 2],
    complicatedLambings: 0,
  };

  it('rests on the starting values this test was worked with', () => {
    expect(CULLING).toMatchObject({ oldAgeYears: 7, emptySeasons: 2, seasonGapDays: 200, lambingsWithoutRearing: 2, lowScoreShare: 0.1, lowScoreMinFlock: 20, thinScorings: 2, complicatedLambings: 2 });
  });

  it('finds nothing against a sound ewe', () => {
    expect(cullReasons(none)).toEqual([]);
  });

  it('names each reason from its own fact', () => {
    expect(cullReasons({ ...none, ageYears: 7 })).toEqual(['old_age']);
    expect(cullReasons({ ...none, ageYears: 6.9 })).toEqual([]);
    expect(cullReasons({ ...none, ageYears: null })).toEqual([]);
    expect(cullReasons({ ...none, emptySeasons: 2 })).toEqual(['empty_twice']);
    expect(cullReasons({ ...none, emptySeasons: 1 })).toEqual([]);
    expect(cullReasons({ ...none, rearedByLambing: [0, 0, 2] })).toEqual(['no_lamb_reared']);
    expect(cullReasons({ ...none, score: 40 })).toEqual(['low_score']);
    expect(cullReasons({ ...none, score: 40, lowScoreCutoff: null })).toEqual([]);
    expect(cullReasons({ ...none, score: null })).toEqual([]);
    expect(cullReasons({ ...none, conditionScores: [2, 1.5, 4] })).toEqual(['thin_twice']);
    expect(cullReasons({ ...none, complicatedLambings: 2 })).toEqual(['lambing_complications']);
    expect(cullReasons({ ...none, complicatedLambings: 1 })).toEqual([]);
  });

  it('does not judge rearing while the outcome is unknown or with one lambing only', () => {
    // Her newest lambs are still with her and not yet weaned.
    expect(cullReasons({ ...none, rearedByLambing: [null, 0] })).toEqual([]);
    expect(cullReasons({ ...none, rearedByLambing: [0] })).toEqual([]);
    // Only the last two lambings count: an old failure followed by a reared lamb is behind her.
    expect(cullReasons({ ...none, rearedByLambing: [1, 0, 0] })).toEqual([]);
  });

  it('needs two scorings, both thin', () => {
    expect(cullReasons({ ...none, conditionScores: [2] })).toEqual([]);
    expect(cullReasons({ ...none, conditionScores: [2, 2.5] })).toEqual([]);
    expect(cullReasons({ ...none, conditionScores: [2.5, 1, 1] })).toEqual([]);
  });

  it('lists several reasons in a fixed order', () => {
    expect(cullReasons({ ageYears: 9, emptySeasons: 2, rearedByLambing: [0, 0], score: 12, lowScoreCutoff: 30, conditionScores: [1.5, 2], complicatedLambings: 3 })).toEqual([
      'old_age',
      'empty_twice',
      'no_lamb_reared',
      'low_score',
      'thin_twice',
      'lambing_complications',
    ]);
  });

  it('counts empty seasons running back from today', () => {
    // Empty in autumn 2025 and in autumn 2024, lambed from the 2023 mating: two seasons running.
    expect(
      emptySeasonsRunning([
        { date: '2023-10-10', outcome: 'lambed' },
        { date: '2024-10-12', outcome: 'empty' },
        { date: '2025-10-15', outcome: 'empty' },
      ]),
    ).toBe(2);
    // Mated twice in one autumn and empty both times: one season (the matings are 40 days apart).
    expect(
      emptySeasonsRunning([
        { date: '2025-10-01', outcome: 'empty' },
        { date: '2025-11-10', outcome: 'empty' },
      ]),
    ).toBe(1);
    // She is carrying now, or lambed since: the run is broken.
    expect(
      emptySeasonsRunning([
        { date: '2024-10-12', outcome: 'empty' },
        { date: '2025-10-15', outcome: 'empty' },
        { date: '2026-05-01', outcome: 'pregnant' },
      ]),
    ).toBe(0);
    expect(
      emptySeasonsRunning([
        { date: '2024-10-12', outcome: 'empty' },
        { date: '2025-03-20', outcome: 'aborted' },
        { date: '2025-10-15', outcome: 'empty' },
      ]),
    ).toBe(1);
    expect(emptySeasonsRunning([])).toBe(0);
  });

  it('draws the low-score line at the lowest tenth of a flock of twenty or more', () => {
    // Scores 1..20: a tenth of 20 is 2 ewes, so the line is the second lowest score.
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(lowScoreCutoff(twenty)).toBe(2);
    // 35 ewes: floor(3.5) = 3, the third lowest.
    expect(lowScoreCutoff(Array.from({ length: 35 }, (_, i) => 100 - i))).toBe(68);
    // Nulls are ewes with no score: they do not count towards the flock.
    expect(lowScoreCutoff([...twenty.slice(1), null])).toBeNull();
    expect(lowScoreCutoff(Array.from({ length: 19 }, (_, i) => i))).toBeNull();
    // Every ewe the same: nobody is "lowest".
    expect(lowScoreCutoff(Array.from({ length: 30 }, () => 55))).toBeNull();
  });
});
