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
