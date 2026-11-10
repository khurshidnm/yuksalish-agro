/**
 * Sale readiness: when an animal sold by live weight reaches the weight the farm sells at.
 * Pure functions over the animal's own dated weights. The service gathers the weights
 * (modules/livestock/sale-readiness.service.ts); nothing here reads a database.
 *
 * The forecast is a straight line from the animal's own recent growth. It is not a growth curve
 * from a book: growth slows as an animal matures, so the further ahead the date, the less it is worth.
 */
import { addDays, diffDays } from '../dates';
import { SALE_READINESS_STATUSES } from '../enums';
import { averageDailyGain, round } from './index';

export type SaleReadinessStatus = (typeof SALE_READINESS_STATUSES)[number];

export interface DatedWeight {
  /** YYYY-MM-DD */
  date: string;
  weightKg: number;
}

/** Starting values chosen for this product, not figures from a book. A farm should change them to fit how it weighs and sells. */
export const SALE_READINESS = {
  /**
   * How far back from the newest weight a weighing still counts as "recent". Growth is measured from
   * the oldest weighing inside this window, so one odd pair of weighings does not decide the rate.
   */
  recentWindowDays: 90,
  /** An animal that reaches the target within this many days from today is "soon". */
  soonDays: 30,
  /** How far back the farm's own live-weight sales count towards the price per kg behind a value estimate. */
  priceWindowDays: 180,
} as const;

export interface RecentGain {
  /** kg per day. Negative when the animal lost weight. */
  kgPerDay: number;
  /** The weighing growth is measured from. */
  from: DatedWeight;
  /** The newest weighing. */
  to: DatedWeight;
}

/** One weight per day, oldest first. When a day has several, the last one given stands: a second entry corrects the first. */
function byDay(weights: DatedWeight[]): DatedWeight[] {
  const perDay = new Map<string, DatedWeight>();
  for (const w of weights) if (Number.isFinite(w.weightKg) && w.weightKg > 0) perDay.set(w.date, w);
  return [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Average daily gain from the animal's own recent weights: from the oldest weighing inside the
 * window to the newest one. When the window holds only the newest weighing, the one before it is
 * used, because that interval is still measured, not guessed. `null` with fewer than two weighings
 * on different days.
 */
export function recentDailyGain(weights: DatedWeight[], windowDays: number = SALE_READINESS.recentWindowDays): RecentGain | null {
  const days = byDay(weights);
  if (days.length < 2) return null;
  const to = days[days.length - 1];
  const earlier = days.slice(0, -1);
  const from = earlier.find((w) => diffDays(w.date, to.date) <= windowDays) ?? earlier[earlier.length - 1];
  const kgPerDay = averageDailyGain(to.weightKg, from.weightKg, diffDays(from.date, to.date));
  return kgPerDay === null ? null : { kgPerDay, from, to };
}

/** Weight on `onDate`, carried forward from the last weighing at the given gain. `null` without a gain or for a day before the weighing. */
export function projectedWeightKg(last: DatedWeight, kgPerDay: number | null, onDate: string): number | null {
  if (kgPerDay === null) return null;
  const days = diffDays(last.date, onDate);
  if (days < 0) return null;
  return round(last.weightKg + kgPerDay * days, 2);
}

/**
 * The first day the animal is at or above the target. The day of the last weighing when it is there
 * already. `null` without a target, and `null` when it is below the target and not gaining: it never arrives.
 */
export function dateReachingWeight(last: DatedWeight, kgPerDay: number | null, targetKg: number | null | undefined): string | null {
  if (targetKg == null || !(targetKg > 0)) return null;
  if (last.weightKg >= targetKg) return last.date;
  if (kgPerDay === null || kgPerDay <= 0) return null;
  // Rounded before the ceiling, so 14.000000001 days from float division is 14, not 15.
  return addDays(last.date, Math.ceil(round((targetKg - last.weightKg) / kgPerDay, 6)));
}

export interface SaleForecast {
  status: SaleReadinessStatus;
  /** The newest weighing, or null when the animal was never weighed. */
  lastWeight: DatedWeight | null;
  /** kg per day from the animal's own recent weights. */
  dailyGainKg: number | null;
  /** First day of the interval the gain was measured over. */
  gainFrom: string | null;
  /** Weight expected today. The measured weight when it was weighed today. */
  projectedWeightKg: number | null;
  /** First day at or above the target. */
  targetDate: string | null;
  /** Days from today to `targetDate`. Zero or negative: the forecast says it is there, and a weighing will confirm it. */
  daysToTarget: number | null;
  /** Weighed at least twice, below the target, and not gaining. */
  notGaining: boolean;
}

/**
 * - `ready`: the last measured weight is at or above the target. Measured, never forecast.
 * - `soon`: the forecast reaches the target within `soonDays` from today.
 * - `later`: the forecast is further away, or the animal is not gaining.
 * - `unknown`: no target, never weighed, or one weighing only and below the target.
 */
export function saleForecast(
  weights: DatedWeight[],
  targetKg: number | null | undefined,
  today: string,
  rules: { recentWindowDays: number; soonDays: number } = SALE_READINESS,
): SaleForecast {
  const days = byDay(weights);
  const lastWeight = days.at(-1) ?? null;
  const gain = recentDailyGain(days, rules.recentWindowDays);
  const dailyGainKg = gain ? round(gain.kgPerDay, 4) : null;
  const base = {
    lastWeight,
    dailyGainKg,
    gainFrom: gain?.from.date ?? null,
    projectedWeightKg: lastWeight && gain ? projectedWeightKg(lastWeight, gain.kgPerDay, today) : null,
  };
  const none = { targetDate: null, daysToTarget: null, notGaining: false };
  if (!lastWeight || targetKg == null || !(targetKg > 0)) return { ...base, ...none, status: 'unknown' };
  if (lastWeight.weightKg >= targetKg) {
    return { ...base, status: 'ready', targetDate: lastWeight.date, daysToTarget: diffDays(today, lastWeight.date), notGaining: false };
  }
  if (!gain) return { ...base, ...none, status: 'unknown' };
  const targetDate = dateReachingWeight(lastWeight, gain.kgPerDay, targetKg);
  if (!targetDate) return { ...base, ...none, status: 'later', notGaining: true };
  const daysToTarget = diffDays(today, targetDate);
  return { ...base, status: daysToTarget <= rules.soonDays ? 'soon' : 'later', targetDate, daysToTarget, notGaining: false };
}

/**
 * What the farm itself was paid per kg of live weight: money received over kilograms sold, across
 * its own sales. Sales without a weight or an amount are left out. `null` when nothing is left:
 * no price is guessed.
 */
export function ownPricePerKg(sales: { amount: number | null; liveWeightKg: number | null }[]): number | null {
  let money = 0;
  let kg = 0;
  for (const s of sales) {
    if (s.amount == null || s.liveWeightKg == null || !(s.amount > 0) || !(s.liveWeightKg > 0)) continue;
    money += s.amount;
    kg += s.liveWeightKg;
  }
  return kg > 0 ? round(money / kg, 2) : null;
}

/** An estimate, not an offer: the last measured weight at the farm's own recent price per kg. */
export function estimatedSaleValue(weightKg: number | null, pricePerKg: number | null): number | null {
  if (weightKg == null || pricePerKg == null || !(weightKg > 0) || !(pricePerKg > 0)) return null;
  return round(weightKg * pricePerKg, 2);
}
