/**
 * Yield forecast from the farm's own past: an ordinary least-squares line of harvested yield on the
 * season's peak NDVI, for one crop, over finished field-seasons that have both numbers.
 *
 * There is no universal NDVI-to-yield coefficient here on purpose. A line fitted on another farm's
 * variety, water and soil would be a guess; below MIN_SEASONS finished seasons the answer is null
 * and the screen says how many more are needed.
 */

/** Three points are the fewest that leave a line anything to be wrong about. */
export const MIN_YIELD_SEASONS = 3;

export interface YieldSeason {
  peakNdvi: number;
  yieldTHa: number;
}

export interface YieldModel {
  slope: number;
  intercept: number;
  /** Squared correlation of the past seasons. */
  r2: number;
  /** Finished field-seasons used. */
  seasons: number;
  /** Root mean square miss of the line on the past seasons, t/ha, with n − 2 degrees of freedom. */
  errorTHa: number;
  /** Smallest and largest peak NDVI the line was fitted on. */
  ndviMin: number;
  ndviMax: number;
}

export type YieldModelResult =
  | { model: YieldModel; reason: null; seasons: number }
  | { model: null; reason: 'too_few_seasons' | 'no_relation'; seasons: number };

/**
 * Fit the line. Null with fewer than MIN_YIELD_SEASONS usable seasons, and null when the seasons
 * show no rising relation (all peaks equal, all yields equal, or more green meant less yield): a
 * line that says "greener is worse" is noise at this sample size, not a finding.
 */
export function fitYieldModel(history: readonly YieldSeason[]): YieldModelResult {
  const usable = history.filter((s) => Number.isFinite(s.peakNdvi) && Number.isFinite(s.yieldTHa) && s.yieldTHa > 0);
  const n = usable.length;
  if (n < MIN_YIELD_SEASONS) return { model: null, reason: 'too_few_seasons', seasons: n };
  const meanX = usable.reduce((sum, s) => sum + s.peakNdvi, 0) / n;
  const meanY = usable.reduce((sum, s) => sum + s.yieldTHa, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const s of usable) {
    const dx = s.peakNdvi - meanX;
    const dy = s.yieldTHa - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // Tolerances absorb float noise, as in fitBiomassModel.
  if (sxx <= 1e-12 || syy <= 1e-9 || sxy <= 0) return { model: null, reason: 'no_relation', seasons: n };
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const ssRes = Math.max(0, syy - slope * sxy);
  return {
    model: {
      slope,
      intercept,
      r2: Math.min(1, (sxy * sxy) / (sxx * syy)),
      seasons: n,
      errorTHa: Math.sqrt(ssRes / (n - 2)),
      ndviMin: Math.min(...usable.map((s) => s.peakNdvi)),
      ndviMax: Math.max(...usable.map((s) => s.peakNdvi)),
    },
    reason: null,
    seasons: n,
  };
}

export interface YieldForecast {
  estimateTHa: number;
  /** Estimate less and plus the line's past miss; not a confidence interval. Never below 0. */
  lowTHa: number;
  highTHa: number;
  seasons: number;
  r2: number;
  /** This season's peak lies outside the peaks the line was fitted on. */
  extrapolated: boolean;
}

const r2dp = (value: number) => Math.round(value * 100) / 100;

/** The forecast for a season whose peak NDVI so far is `peakNdvi`. Null without a model or a peak. */
export function forecastYield(model: YieldModel | null, peakNdvi: number | null | undefined): YieldForecast | null {
  if (!model || peakNdvi == null || !Number.isFinite(peakNdvi)) return null;
  const estimate = Math.max(0, model.intercept + model.slope * peakNdvi);
  return {
    estimateTHa: r2dp(estimate),
    lowTHa: r2dp(Math.max(0, estimate - model.errorTHa)),
    highTHa: r2dp(estimate + model.errorTHa),
    seasons: model.seasons,
    r2: Math.round(model.r2 * 1000) / 1000,
    extrapolated: peakNdvi < model.ndviMin - 1e-9 || peakNdvi > model.ndviMax + 1e-9,
  };
}

/** A reading counts as "the same week" when it lies this close to the date a year earlier. */
export const SAME_WEEK_DAYS = 7;

export interface DatedValue {
  date: string;
  mean: number;
}

const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/**
 * The reading nearest to one year before `latest`, within SAME_WEEK_DAYS, and the change since.
 * Null when there is no such reading: a comparison with another time of year would mislead.
 */
export function sameWeekLastSeason(
  latest: DatedValue | null | undefined,
  series: readonly DatedValue[],
): { date: string; mean: number; change: number } | null {
  if (!latest) return null;
  const target = dayNumber(latest.date) - 365;
  let best: DatedValue | null = null;
  for (const point of series) {
    const gap = Math.abs(dayNumber(point.date) - target);
    if (gap > SAME_WEEK_DAYS) continue;
    if (!best || gap < Math.abs(dayNumber(best.date) - target)) best = point;
  }
  return best ? { date: best.date, mean: best.mean, change: Math.round((latest.mean - best.mean) * 1000) / 1000 } : null;
}
