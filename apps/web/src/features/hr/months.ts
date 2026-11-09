/** "YYYY-MM" moved by whole months. */
export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

export interface PayrollMonthChoice {
  /** What the dialog offers, newest first. */
  months: string[];
  /** The newest month that already has a run. */
  latest: string | null;
  /** The month to preselect, or null when the payroll is up to date and the dialog should say so. */
  suggested: string | null;
}

/**
 * The months a new payroll run can be for: the last year, not before the first hire (an empty run helps
 * nobody), leaving out the months that have a run already, since there is one run per month. The
 * suggestion is the newest finished month after the latest run. A month with a run is never suggested.
 */
export function payrollMonths(now: string, taken: readonly string[], firstHireMonth: string | null): PayrollMonthChoice {
  const yearAgo = shiftMonth(now, -11);
  const oldest = firstHireMonth && firstHireMonth > yearAgo ? firstHireMonth : yearAgo;
  const used = new Set(taken);
  const months: string[] = [];
  for (let month = now; month >= oldest; month = shiftMonth(month, -1)) {
    if (!used.has(month)) months.push(month);
  }
  const latest = taken.length > 0 ? taken.reduce((a, b) => (a > b ? a : b)) : null;
  const suggested = months.find((month) => month < now && (latest === null || month > latest)) ?? null;
  return { months, latest, suggested };
}
