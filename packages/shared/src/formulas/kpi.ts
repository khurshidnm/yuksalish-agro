/** KPI formulas of spec 14.3 that are not already in index.ts. Null means "not enough data". */

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/** Operatsion xarajat / daromad: below 1 means operations pay for themselves. */
export function operatingRatio(operatingExpense: number, income: number): number | null {
  return ratio(operatingExpense, income);
}

/** 1 bosh sovliqqa foyda. Null before any income: a season without sales has no profit yet. */
export function profitPerHead(income: number, cost: number, head: number): number | null {
  if (income <= 0) return null;
  return ratio(income - cost, head);
}

/** Mehnat unumdorligi: head or hectares per employee. */
export function perEmployee(volume: number, employees: number): number | null {
  if (volume <= 0) return null;
  return ratio(volume, employees);
}

/**
 * Tabel intizomi: share of due days actually worked. Sick days, vacation and days off were not
 * due, so they count on neither side.
 */
export function attendancePercent(presentDays: number, absentDays: number): number | null {
  const r = ratio(presentDays, presentDays + absentDays);
  return r === null ? null : r * 100;
}

export const MACHINE_HOURS_PER_DAY = 8;

/** Texnika yuklanishi: motor-hours worked against a working day for every machine. */
export function machineryUtilizationPercent(
  usedHours: number,
  machines: number,
  days: number,
  hoursPerDay = MACHINE_HOURS_PER_DAY,
): number | null {
  const r = ratio(usedHours, machines * days * hoursPerDay);
  return r === null ? null : r * 100;
}

/** Ozuqa yo'qotishlari: value written off at stock counts against value fed plus written off. */
export function feedLossPercent(writtenOff: number, issued: number): number | null {
  const r = ratio(writtenOff, issued + writtenOff);
  return r === null ? null : r * 100;
}

/** 1 bosh kunlik ozuqa xarajati. */
export function feedCostPerHeadDay(costPerDay: number, head: number): number | null {
  return ratio(costPerDay, head);
}
