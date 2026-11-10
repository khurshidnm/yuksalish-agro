/**
 * Payroll and timesheet formulas (spec section 11).
 *
 * This is a management calculation of what the farm owes its people. Statutory tax and social
 * payments are calculated in Keeping (spec 11.5), so nothing here touches them.
 */
import { allocateOverhead, round, survivalPercent, type AllocationTarget } from './index';

/** Units a piece rate can be paid in, matching `employees.pieceRates` keys. */
export const PIECE_UNITS = ['ha', 'head', 'headDay', 't'] as const;
export type PieceUnit = (typeof PIECE_UNITS)[number];

/** `tasks_on_time` is the percent from tasksOnTime() in formulas/kpi.ts. */
export const KPI_METRICS = ['survival_percent', 'hectares', 'tasks_on_time'] as const;
export type KpiMetric = (typeof KPI_METRICS)[number];

export const KPI_REWARD_TYPES = ['fixed', 'per_unit'] as const;
export type KpiRewardType = (typeof KPI_REWARD_TYPES)[number];

export type PayType = 'monthly' | 'daily' | 'piece' | 'seasonal';

export interface BasePayInput {
  payType: PayType;
  /** Per month, per day, or per whole season, depending on payType. */
  baseRate: number;
  /** Timesheet days marked present. */
  presentDays: number;
  /** Present plus paid leave (vacation, sick). */
  paidDays: number;
  /** Days this person was due to work in the month: employed days minus days off. */
  expectedDays: number;
  /** Calendar days of the month this person was employed. */
  employedDays: number;
  /** Calendar days in the month. */
  daysInMonth: number;
  /** Length of a seasonal contract in days. */
  seasonDays?: number | null;
}

/**
 * Base pay for the month.
 *  monthly  rate × share of the month employed × share of expected days paid, capped at the rate
 *  daily    rate × days present (leave is unpaid for day workers)
 *  piece    nothing: all pay comes from piecework
 *  seasonal the season's rate spread over its days, for the days present
 */
export function basePay(i: BasePayInput): number {
  switch (i.payType) {
    case 'monthly': {
      if (i.expectedDays <= 0 || i.daysInMonth <= 0) return 0;
      const attendance = Math.min(1, i.paidDays / i.expectedDays);
      return round(i.baseRate * (i.employedDays / i.daysInMonth) * attendance, 2);
    }
    case 'daily':
      return round(i.baseRate * i.presentDays, 2);
    case 'seasonal':
      return i.seasonDays && i.seasonDays > 0 ? round((i.baseRate * i.presentDays) / i.seasonDays, 2) : 0;
    case 'piece':
      return 0;
  }
}

/** Sum of quantity × rate for every unit that has a rate. */
export function pieceworkPay(
  work: Partial<Record<PieceUnit, number>>,
  rates: Partial<Record<PieceUnit, number>> | Record<string, number>,
): number {
  let total = 0;
  for (const unit of PIECE_UNITS) {
    const rate = (rates as Record<string, number>)[unit];
    if (rate) total += (work[unit] ?? 0) * rate;
  }
  return round(total, 2);
}

export interface KpiRule {
  threshold: number;
  rewardType: KpiRewardType;
  amount: number;
}

/**
 * Bonus for one KPI rule (spec 11.7). A null metric means there is not enough data, which earns
 * nothing rather than being read as a failure or a success.
 */
export function kpiBonus(rule: KpiRule, value: number | null): number {
  if (value === null || value < rule.threshold) return 0;
  if (rule.rewardType === 'fixed') return rule.amount;
  return round((value - rule.threshold) * rule.amount, 2);
}

export interface PayAmounts {
  base: number;
  piecework: number;
  bonus: number;
  advance: number;
  deductions: number;
}

/** Labour cost of the line: what reaches cost centers. */
export function payrollGross(a: Pick<PayAmounts, 'base' | 'piecework' | 'bonus'>): number {
  return round(a.base + a.piecework + a.bonus, 2);
}

/** To pay out. Negative when advances exceed what was earned. */
export function payrollNet(a: PayAmounts): number {
  return round(payrollGross(a) - a.advance - a.deductions, 2);
}

/**
 * Split labour cost across cost centers by days worked on each (spec 11.6).
 * Days are the one unit that compares a mechanic's field work with a shepherd's herd work.
 * Shares add up exactly to `total`; with no recorded work everything goes to `fallbackId`.
 */
export function allocateLabour(
  total: number,
  daysByCostCenter: Record<string, number>,
  fallbackId: string,
): Record<string, number> {
  if (total === 0) return {};
  const targets: AllocationTarget[] = Object.entries(daysByCostCenter).map(([id, weight]) => ({ id, weight }));
  const shares = allocateOverhead(total, targets);
  return Object.keys(shares).length > 0 ? shares : { [fallbackId]: round(total, 2) };
}

/** Hours between two moments, or null when either is missing or the order is wrong. */
export function hoursBetween(from: Date | string | null | undefined, to: Date | string | null | undefined): number | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return round(ms / 3_600_000, 2);
}

/** Tabel intizomi (%): share of working days actually attended. Excused leave does not count. */
export function attendancePercent(presentDays: number, absentDays: number): number | null {
  const due = presentDays + absentDays;
  if (due <= 0) return null;
  return round((presentDays / due) * 100, 1);
}

/** Survival of lambs in a cohort, for the shepherd KPI (spec 11.7, 8.6). */
export const shepherdSurvival = (aliveLambs: number, lambsBorn: number): number | null =>
  survivalPercent(aliveLambs, lambsBorn);
