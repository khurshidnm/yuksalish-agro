/** Land and facility calculations (spec 6.1). Same convention as index.ts: no data is null. */
import { diffDays } from '../dates';

/** Share of a barn's capacity in use, percent. */
export function capacityUsePercent(head: number, capacity: number | null | undefined): number | null {
  if (capacity == null || capacity <= 0) return null;
  return (head * 100) / capacity;
}

/** Share of a water limit used, percent. */
export function waterLimitUsePercent(actualM3: number, limitM3: number | null | undefined): number | null {
  if (limitM3 == null || limitM3 <= 0) return null;
  return (actualM3 * 100) / limitM3;
}

/** Land not yet assigned to a contour. Negative means the contours exceed the farm's total. */
export function unassignedAreaHa(totalHa: number | null | undefined, contoursHa: number[]): number | null {
  if (totalHa == null) return null;
  const assigned = contoursHa.reduce((sum, ha) => sum + ha, 0);
  // `|| 0` turns -0 into 0: float noise on an exact match must not show as "-0".
  return Math.round((totalHa - assigned) * 10_000) / 10_000 || 0;
}

export type ExpiryState = 'expired' | 'expiring' | 'valid';

/** Document expiry status as of `today`. No expiry date means it does not expire. */
export function expiryState(expiryDate: string | null | undefined, today: string, warnDays = 30): ExpiryState | null {
  if (!expiryDate) return null;
  const left = diffDays(today, expiryDate);
  if (left < 0) return 'expired';
  return left <= warnDays ? 'expiring' : 'valid';
}
