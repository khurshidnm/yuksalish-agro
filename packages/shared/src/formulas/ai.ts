/**
 * Statistics behind the AI layer (spec 15.2: simple moving averages and z-scores first, ML only
 * once data has accumulated). Pure functions, one implementation for API and UI.
 *
 * Every detector takes a minimum sample size and returns null below it. Too little data is
 * reported as such, never as "no problem found" (spec 15.2).
 */
import { addDays } from '../dates';
import { round } from './index';

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample standard deviation (n − 1). */
export function sampleStdDev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

/** Trailing moving average; null until the window is full. */
export function movingAverage(values: readonly number[], window: number): (number | null)[] {
  return values.map((_, i) => (i + 1 < window ? null : mean(values.slice(i + 1 - window, i + 1))));
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A perfectly flat baseline has std 0. Treat 2% of the mean as the smallest meaningful spread. */
const STD_FLOOR_RATIO = 0.02;

export function zScore(value: number, baseline: readonly number[]): number | null {
  const m = mean(baseline);
  const s = sampleStdDev(baseline);
  if (m === null || s === null) return null;
  const spread = Math.max(s, Math.abs(m) * STD_FLOOR_RATIO);
  if (spread === 0) return null;
  return (value - m) / spread;
}

/** Confidence in a statistical finding: 0.5 to 0.95, rising with effect size and sample size. */
export function findingConfidence(z: number, sampleSize: number, minSample: number): number {
  const strength = clamp((Math.abs(z) - 2) / 3, 0, 1);
  const sample = clamp(sampleSize / (minSample * 3), 0, 1);
  return round(0.5 + 0.3 * strength + 0.15 * sample, 2);
}

export interface AnomalyOptions {
  /** Trailing points forming each point's baseline. */
  window: number;
  /** Fewest baseline points that allow a claim. */
  minBaseline: number;
  /** Only the last `lookback` points are judged. */
  lookback: number;
  zThreshold?: number;
  minDeviationPercent?: number;
  direction?: 'both' | 'up' | 'down';
}

export interface Anomaly {
  index: number;
  value: number;
  baselineMean: number;
  baselineStd: number;
  baselineSize: number;
  z: number;
  deviationPercent: number;
  confidence: number;
}

/** Whether the series is long enough for at least its newest point to be judged. */
export function hasEnoughBaseline(length: number, minBaseline: number): boolean {
  return length >= minBaseline + 1;
}

/** Points that stand out from their trailing baseline by both z-score and relative size. */
export function detectAnomalies(series: readonly number[], o: AnomalyOptions): Anomaly[] {
  const zThreshold = o.zThreshold ?? 2.5;
  const minDeviation = o.minDeviationPercent ?? 10;
  const direction = o.direction ?? 'both';
  const found: Anomaly[] = [];

  for (let i = Math.max(0, series.length - o.lookback); i < series.length; i++) {
    const baseline = series.slice(Math.max(0, i - o.window), i);
    if (baseline.length < o.minBaseline) continue;
    const z = zScore(series[i], baseline);
    const baselineMean = mean(baseline)!;
    if (z === null || baselineMean === 0) continue;
    const deviationPercent = ((series[i] - baselineMean) / Math.abs(baselineMean)) * 100;
    const outside = Math.abs(z) >= zThreshold && Math.abs(deviationPercent) >= minDeviation;
    const wanted = direction === 'both' || (direction === 'up' ? z > 0 : z < 0);
    if (outside && wanted) {
      found.push({
        index: i,
        value: series[i],
        baselineMean,
        baselineStd: sampleStdDev(baseline)!,
        baselineSize: baseline.length,
        z: round(z, 2),
        deviationPercent: round(deviationPercent, 1),
        confidence: findingConfidence(z, baseline.length, o.minBaseline),
      });
    }
  }
  return found;
}

export interface CountSpike {
  expected: number;
  z: number;
  confidence: number;
}

/**
 * Rare events per period, such as deaths per week. Counts are close to Poisson, so the spread
 * comes from the expected count itself rather than from a noisy sample of near-zero weeks.
 */
export function countSpike(
  recent: number,
  baseline: readonly number[],
  o: { minBaseline: number; zThreshold?: number; minCount?: number },
): CountSpike | null {
  if (baseline.length < o.minBaseline) return null;
  const expected = mean(baseline)!;
  const z = (recent - expected) / Math.sqrt(Math.max(expected, 0.5));
  if (recent < (o.minCount ?? 2) || z < (o.zThreshold ?? 2.5)) return null;
  return {
    expected: round(expected, 2),
    z: round(z, 2),
    confidence: findingConfidence(z, baseline.length, o.minBaseline),
  };
}

export interface GainSlowdown {
  latest: number;
  previousMean: number;
  ratio: number;
  confidence: number;
}

/**
 * Compare the newest weight-gain interval with the ones before it. `series` is mean daily gain
 * per interval, oldest first. `dropRatio` 0.7 means "fell below 70% of the earlier average".
 */
export function gainSlowdown(
  series: readonly number[],
  o: { minIntervals?: number; dropRatio?: number } = {},
): GainSlowdown | null {
  const minIntervals = o.minIntervals ?? 3;
  if (series.length < minIntervals) return null;
  const latest = series[series.length - 1];
  const previous = series.slice(0, -1);
  const previousMean = mean(previous)!;
  if (previousMean <= 0) return null;
  const ratio = latest / previousMean;
  if (ratio >= (o.dropRatio ?? 0.7)) return null;
  const spread = sampleStdDev(previous) ?? 0;
  const z = (previousMean - latest) / Math.max(spread, previousMean * 0.1);
  return {
    latest: round(latest, 3),
    previousMean: round(previousMean, 3),
    ratio: round(ratio, 2),
    confidence: findingConfidence(z, previous.length, minIntervals - 1),
  };
}

// ─── Forecasts ──────────────────────────────────────────────────────────────

/** Monday of the week containing a date. */
export function weekStartOf(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return addDays(isoDate, day === 0 ? -6 : 1 - day);
}

export interface LambingWeek {
  weekStart: string;
  ewes: number;
}

export interface LambingWorkloadOptions {
  lambsPerEwe: number;
  /** How long a ewe stays on the lactating ration, in whole weeks. */
  lactationWeeks: number;
  /** Lactating ration minus current ration, kg per head per day. Null when a ration is missing. */
  extraKgPerEweDay: number | null;
  laborHoursPerLambing: number;
  shiftHours: number;
}

export interface LambingWorkloadRow extends LambingWeek {
  lambs: number;
  lactatingEwes: number;
  extraFeedKg: number | null;
  laborHours: number;
  workersNeeded: number;
}

/** Spring feed and labour load per week (spec 15.3 scenario 1). `weeks` is oldest first. */
export function lambingWorkload(weeks: readonly LambingWeek[], o: LambingWorkloadOptions): LambingWorkloadRow[] {
  return weeks.map((week, i) => {
    const lactatingEwes = weeks
      .slice(Math.max(0, i + 1 - o.lactationWeeks), i + 1)
      .reduce((sum, w) => sum + w.ewes, 0);
    const laborHours = round(week.ewes * o.laborHoursPerLambing, 1);
    return {
      ...week,
      lambs: round(week.ewes * o.lambsPerEwe, 1),
      lactatingEwes,
      extraFeedKg: o.extraKgPerEweDay === null ? null : round(lactatingEwes * o.extraKgPerEweDay * 7, 1),
      laborHours,
      workersNeeded: Math.ceil(laborHours / (o.shiftHours * 7)),
    };
  });
}

export interface SeasonLine {
  areaHa: number;
  expectedYieldTHa: number | null;
  pricePerT: number | null;
  plannedCost: number | null;
  actualCost: number | null;
  harvestedT: number | null;
}

export interface SeasonForecast {
  revenue: number;
  cost: number;
  profit: number;
  profitabilityPercent: number | null;
  linesUsed: number;
  linesSkipped: number;
  /** Share of the planned area the forecast covers. */
  areaCoveredPercent: number | null;
}

/**
 * Season profit from plan, actual and expected yield (spec 15.3 scenario 3). Lines missing a
 * price, a yield or any cost are left out and counted, rather than filled in with a guess.
 * A harvest overrides expected yield. Cost is the larger of planned and actual: spending below
 * plan mid-season usually means the work has not happened yet.
 */
export function seasonForecast(lines: readonly SeasonLine[]): SeasonForecast {
  let revenue = 0;
  let cost = 0;
  let linesUsed = 0;
  let usedArea = 0;
  let totalArea = 0;

  for (const line of lines) {
    totalArea += line.areaHa;
    const tons =
      line.harvestedT ?? (line.expectedYieldTHa === null ? null : line.areaHa * line.expectedYieldTHa);
    const hasCost = line.plannedCost !== null || line.actualCost !== null;
    if (tons === null || line.pricePerT === null || !hasCost) continue;
    revenue += tons * line.pricePerT;
    cost += Math.max(line.plannedCost ?? 0, line.actualCost ?? 0);
    linesUsed += 1;
    usedArea += line.areaHa;
  }

  return {
    revenue: round(revenue, 2),
    cost: round(cost, 2),
    profit: round(revenue - cost, 2),
    profitabilityPercent: cost > 0 ? round(((revenue - cost) / cost) * 100, 2) : null,
    linesUsed,
    linesSkipped: lines.length - linesUsed,
    areaCoveredPercent: totalArea > 0 ? round((usedArea / totalArea) * 100, 1) : null,
  };
}

/** The date stock runs out at a daily rate, counting whole days covered from `today`. */
export function feedRunOutDate(stockKg: number, dailyKg: number, today: string): string | null {
  if (dailyKg <= 0) return null;
  return addDays(today, Math.floor(stockKg / dailyKg));
}

export function costPerKgDryMatter(unitCostPerKg: number, dryMatterPct: number): number | null {
  if (dryMatterPct <= 0) return null;
  return unitCostPerKg / (dryMatterPct / 100);
}

export interface RationCostLine {
  itemId: string;
  name: string;
  kgPerHeadDay: number;
  unitCostPerKg: number | null;
  dryMatterPct: number | null;
}

export interface RationSaving {
  fromItemId: string;
  fromName: string;
  toItemId: string;
  toName: string;
  shiftKgDmPerHeadDay: number;
  savingPerHeadDay: number;
  savingPerDay: number;
}

/**
 * Cheapening option for a ration (spec 15.1.5): move a share of the dry matter from the most
 * expensive component to the cheapest. A cost figure only. Whether the swap suits the animals
 * nutritionally is the zootechnician's decision, which is why it stays a recommendation.
 */
export function rationSavingOption(
  lines: readonly RationCostLine[],
  head: number,
  shiftShare = 0.1,
): RationSaving | null {
  const priced = lines
    .filter((l) => l.unitCostPerKg !== null && l.dryMatterPct !== null && l.kgPerHeadDay > 0)
    .map((l) => ({ ...l, costDm: costPerKgDryMatter(l.unitCostPerKg!, l.dryMatterPct!) }))
    .filter((l): l is typeof l & { costDm: number } => l.costDm !== null);
  if (priced.length < 2 || head <= 0) return null;

  const dearest = priced.reduce((a, b) => (b.costDm > a.costDm ? b : a));
  const cheapest = priced.reduce((a, b) => (b.costDm < a.costDm ? b : a));
  if (dearest.costDm <= cheapest.costDm) return null;

  const shiftKgDm = dearest.kgPerHeadDay * (dearest.dryMatterPct! / 100) * shiftShare;
  const savingPerHeadDay = shiftKgDm * (dearest.costDm - cheapest.costDm);
  return {
    fromItemId: dearest.itemId,
    fromName: dearest.name,
    toItemId: cheapest.itemId,
    toName: cheapest.name,
    shiftKgDmPerHeadDay: round(shiftKgDm, 3),
    savingPerHeadDay: round(savingPerHeadDay, 2),
    savingPerDay: round(savingPerHeadDay * head, 2),
  };
}

export interface CropOption {
  key: string;
  yieldTHa: number | null;
  pricePerT: number | null;
  costPerHa: number | null;
  isFeed: boolean;
  perennial?: boolean;
  grownLastSeason: boolean;
  /** Own feed is short, so this crop saves a purchase (spec 15.1.6). */
  feedShortage: boolean;
}

export interface RankedCrop {
  key: string;
  marginPerHa: number;
  score: number;
  reasons: ('rotation_penalty' | 'feed_shortage_bonus')[];
}

const ROTATION_PENALTY = 0.25;
const FEED_BONUS = 0.15;

/** Rank next-season crops by expected margin, adjusted for rotation and feed need. */
export function rankCropOptions(options: readonly CropOption[]): RankedCrop[] {
  return options
    .filter((o) => o.yieldTHa !== null && o.pricePerT !== null && o.costPerHa !== null)
    .map((o) => {
      const margin = o.yieldTHa! * o.pricePerT! - o.costPerHa!;
      const reasons: RankedCrop['reasons'] = [];
      let score = margin;
      if (o.grownLastSeason && !o.perennial) {
        score -= Math.abs(margin) * ROTATION_PENALTY;
        reasons.push('rotation_penalty');
      }
      if (o.isFeed && o.feedShortage) {
        score += Math.abs(margin) * FEED_BONUS;
        reasons.push('feed_shortage_bonus');
      }
      return { key: o.key, marginPerHa: round(margin, 2), score: round(score, 2), reasons };
    })
    .sort((a, b) => b.score - a.score);
}
