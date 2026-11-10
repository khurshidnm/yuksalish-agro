import { describe, expect, it } from 'vitest';
import { fitYieldModel, forecastYield, MIN_YIELD_SEASONS, sameWeekLastSeason } from './yield-forecast';

describe('fitYieldModel', () => {
  it('needs three finished seasons', () => {
    expect(MIN_YIELD_SEASONS).toBe(3);
    expect(fitYieldModel([])).toEqual({ model: null, reason: 'too_few_seasons', seasons: 0 });
    expect(
      fitYieldModel([
        { peakNdvi: 0.5, yieldTHa: 3 },
        { peakNdvi: 0.7, yieldTHa: 4.4 },
      ]),
    ).toEqual({ model: null, reason: 'too_few_seasons', seasons: 2 });
    // A season with no harvest does not count.
    expect(
      fitYieldModel([
        { peakNdvi: 0.5, yieldTHa: 3 },
        { peakNdvi: 0.7, yieldTHa: 4.4 },
        { peakNdvi: 0.6, yieldTHa: 0 },
      ]).seasons,
    ).toBe(2);
  });

  it('fits the least-squares line through three seasons (worked by hand)', () => {
    // Means 0.6 and 3.8. Sxx = 0.01 + 0 + 0.01 = 0.02. Sxy = 0.08 + 0 + 0.06 = 0.14.
    // Syy = 0.64 + 0.04 + 0.36 = 1.04. Slope 0.14 / 0.02 = 7. Intercept 3.8 − 7 × 0.6 = −0.4.
    // Residual sum 1.04 − 7 × 0.14 = 0.06, error √(0.06 / 1) = 0.2449. R² = 0.0196 / 0.0208 = 0.9423.
    const fit = fitYieldModel([
      { peakNdvi: 0.5, yieldTHa: 3 },
      { peakNdvi: 0.6, yieldTHa: 4 },
      { peakNdvi: 0.7, yieldTHa: 4.4 },
    ]);
    expect(fit.reason).toBeNull();
    expect(fit.seasons).toBe(3);
    expect(fit.model!.slope).toBeCloseTo(7, 9);
    expect(fit.model!.intercept).toBeCloseTo(-0.4, 9);
    expect(fit.model!.errorTHa).toBeCloseTo(0.2449, 4);
    expect(fit.model!.r2).toBeCloseTo(0.9423, 4);

    // At a peak of 0.65: −0.4 + 7 × 0.65 = 4.15, give or take 0.2449.
    expect(forecastYield(fit.model, 0.65)).toEqual({ estimateTHa: 4.15, lowTHa: 3.91, highTHa: 4.39, seasons: 3, r2: 0.942, extrapolated: false });
    // Outside the peaks the line has seen: still an estimate, flagged.
    expect(forecastYield(fit.model, 0.8)).toMatchObject({ estimateTHa: 5.2, extrapolated: true });
  });

  it('refuses a line when the seasons show no rising relation', () => {
    const flat = [
      { peakNdvi: 0.6, yieldTHa: 3 },
      { peakNdvi: 0.6, yieldTHa: 4 },
      { peakNdvi: 0.6, yieldTHa: 5 },
    ];
    expect(fitYieldModel(flat)).toEqual({ model: null, reason: 'no_relation', seasons: 3 });
    const falling = [
      { peakNdvi: 0.5, yieldTHa: 5 },
      { peakNdvi: 0.6, yieldTHa: 4 },
      { peakNdvi: 0.7, yieldTHa: 3 },
    ];
    expect(fitYieldModel(falling)).toEqual({ model: null, reason: 'no_relation', seasons: 3 });
  });

  it('gives no forecast without a model or a peak, and never a negative yield', () => {
    expect(forecastYield(null, 0.6)).toBeNull();
    const { model } = fitYieldModel([
      { peakNdvi: 0.5, yieldTHa: 3 },
      { peakNdvi: 0.6, yieldTHa: 4 },
      { peakNdvi: 0.7, yieldTHa: 4.4 },
    ]);
    expect(forecastYield(model, null)).toBeNull();
    expect(forecastYield(model, 0.02)).toMatchObject({ estimateTHa: 0, lowTHa: 0 });
  });
});

describe('sameWeekLastSeason', () => {
  const series = [
    { date: '2025-04-28', mean: 0.4 },
    { date: '2025-05-08', mean: 0.52 },
    { date: '2025-05-13', mean: 0.55 },
    { date: '2025-07-01', mean: 0.3 },
    { date: '2026-05-10', mean: 0.61 },
  ];

  it('takes the reading nearest to a year earlier, within a week', () => {
    // A year before 2026-05-10 is 2025-05-10: 05-08 is two days off, 05-13 three.
    expect(sameWeekLastSeason({ date: '2026-05-10', mean: 0.61 }, series)).toEqual({ date: '2025-05-08', mean: 0.52, change: 0.09 });
  });

  it('is null when last season has no reading that week', () => {
    expect(sameWeekLastSeason({ date: '2026-06-10', mean: 0.5 }, series)).toBeNull();
    expect(sameWeekLastSeason(null, series)).toBeNull();
  });
});
