/** Feed calculations that need more than the spec formulas in index.ts. */
import { addDays, diffDays } from '../dates';

export const ACTUAL_CONSUMPTION_WINDOW_DAYS = 7;

export interface DailyQty {
  /** YYYY-MM-DD */
  date: string;
  qty: number;
}

export interface ActualConsumption {
  avgDaily: number;
  total: number;
  /** Calendar days the average covers. */
  days: number;
}

/**
 * Average daily consumption over the last `windowDays` (spec 24.1: "haqiqiy sarf asosida").
 *
 * The divisor is the span actually covered, not always the full window. In the first week of
 * records, dividing by 7 would understate consumption and overstate how long stock lasts.
 * Today counts only once something was issued today: mornings are normally not logged yet.
 * Returns null when nothing was issued in the window.
 */
export function averageDailyConsumption(
  issues: DailyQty[],
  today: string,
  windowDays = ACTUAL_CONSUMPTION_WINDOW_DAYS,
): ActualConsumption | null {
  const issuedToday = issues.some((i) => i.date === today && i.qty > 0);
  const end = issuedToday ? today : addDays(today, -1);
  const windowStart = addDays(end, 1 - windowDays);

  const inWindow = issues.filter((i) => i.qty > 0 && i.date >= windowStart && i.date <= end);
  if (inWindow.length === 0) return null;

  const first = inWindow.reduce((min, i) => (i.date < min ? i.date : min), inWindow[0].date);
  const days = diffDays(first, end) + 1;
  const total = inWindow.reduce((sum, i) => sum + i.qty, 0);
  return { avgDaily: total / days, total, days };
}

/**
 * Kilograms in one unit of an item, or null when that cannot be known.
 * Bales and other counted units need an explicit weight.
 */
export function kgPerUnit(unit: string, explicit?: number | null): number | null {
  if (unit === 'kg') return 1;
  if (unit === 't') return 1000;
  return explicit && explicit > 0 ? explicit : null;
}

/**
 * Hectares of one crop that cover the shortages of every feed it gives. A wheat field yields grain
 * and straw at once, so the land is set by the product that needs the most of it, never the sum.
 * Null while any product lacks a yield: the largest known figure could understate the land.
 */
export function hectaresForCropShortages(products: { shortageKg: number; yieldTHa: number | null | undefined }[]): number | null {
  let most = 0;
  for (const product of products) {
    if (product.shortageKg <= 0) continue;
    if (!product.yieldTHa || product.yieldTHa <= 0) return null;
    most = Math.max(most, product.shortageKg / 1000 / product.yieldTHa);
  }
  return most;
}

/** Dry matter in an as-fed amount, or null when the feed's dry matter percent is not known. */
export function dryMatterKg(asFedKg: number, dryMatterPct: number | null | undefined): number | null {
  if (dryMatterPct === null || dryMatterPct === undefined || !(dryMatterPct > 0) || dryMatterPct > 100) return null;
  return (asFedKg * dryMatterPct) / 100;
}

/**
 * Dry matter of a whole ration per head per day. Silage at 30 % and hay at 86 % cannot be added as
 * fed, so a ration is judged on dry matter. Null when any line lacks its dry matter: a partial sum
 * would read as the whole ration (rule 5).
 */
export function rationDryMatterKg(lines: { kgPerHeadDay: number; dryMatterPct: number | null | undefined }[]): number | null {
  if (lines.length === 0) return null;
  let total = 0;
  for (const line of lines) {
    const dm = dryMatterKg(line.kgPerHeadDay, line.dryMatterPct);
    if (dm === null) return null;
    total += dm;
  }
  return total;
}

/** Dry matter intake as a percent of live weight, the figure ewe norms are written in. Null without a weight. */
export function dryMatterPercentOfWeight(dryMatterKgPerDay: number | null, liveWeightKg: number | null | undefined): number | null {
  if (dryMatterKgPerDay === null || !liveWeightKg || liveWeightKg <= 0) return null;
  return (dryMatterKgPerDay / liveWeightKg) * 100;
}
