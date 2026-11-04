import { describe, expect, it } from 'vitest';
import {
  allocateLabour,
  attendancePercent,
  basePay,
  hoursBetween,
  kpiBonus,
  payrollGross,
  payrollNet,
  pieceworkPay,
  shepherdSurvival,
} from './payroll';

const month = { daysInMonth: 30, employedDays: 30, expectedDays: 26 };

describe('basePay', () => {
  it('pays a monthly salary in full for a full month', () => {
    expect(basePay({ ...month, payType: 'monthly', baseRate: 5_200_000, presentDays: 26, paidDays: 26 })).toBe(5_200_000);
  });

  it('reduces a monthly salary for unpaid absence: 24 of 26 days', () => {
    expect(basePay({ ...month, payType: 'monthly', baseRate: 5_200_000, presentDays: 24, paidDays: 24 })).toBe(4_800_000);
  });

  it('keeps paid leave whole', () => {
    expect(basePay({ ...month, payType: 'monthly', baseRate: 5_200_000, presentDays: 20, paidDays: 26 })).toBe(5_200_000);
  });

  it('never pays more than the rate for extra days', () => {
    expect(basePay({ ...month, payType: 'monthly', baseRate: 5_200_000, presentDays: 30, paidDays: 30 })).toBe(5_200_000);
  });

  it('prorates a mid-month start: half the month employed earns half the rate', () => {
    const r = basePay({
      payType: 'monthly',
      baseRate: 6_000_000,
      presentDays: 13,
      paidDays: 13,
      expectedDays: 13,
      employedDays: 15,
      daysInMonth: 30,
    });
    expect(r).toBe(3_000_000);
  });

  it('pays nothing for a monthly employee with no expected days', () => {
    expect(basePay({ payType: 'monthly', baseRate: 100, presentDays: 0, paidDays: 0, expectedDays: 0, employedDays: 0, daysInMonth: 30 })).toBe(0);
  });

  it('pays day workers for days present only', () => {
    expect(basePay({ ...month, payType: 'daily', baseRate: 220_000, presentDays: 21, paidDays: 26 })).toBe(4_620_000);
  });

  it('pays piece workers nothing as base', () => {
    expect(basePay({ ...month, payType: 'piece', baseRate: 999, presentDays: 20, paidDays: 20 })).toBe(0);
  });

  it('spreads a seasonal rate over the season', () => {
    const season = { ...month, payType: 'seasonal' as const, baseRate: 18_000_000, seasonDays: 180 };
    expect(basePay({ ...season, presentDays: 30, paidDays: 30 })).toBe(3_000_000);
    expect(basePay({ ...season, seasonDays: null, presentDays: 30, paidDays: 30 })).toBe(0);
  });
});

describe('pieceworkPay', () => {
  it('multiplies each unit by its rate', () => {
    expect(pieceworkPay({ ha: 120.5, head: 40 }, { ha: 45_000, head: 2_000, t: 60_000 })).toBe(5_502_500);
  });

  it('ignores units without a rate and unknown keys', () => {
    expect(pieceworkPay({ ha: 10 }, { t: 60_000, bogus: 5 })).toBe(0);
    expect(pieceworkPay({}, { ha: 45_000 })).toBe(0);
  });
});

describe('kpiBonus', () => {
  const fixed = { threshold: 90, rewardType: 'fixed' as const, amount: 800_000 };
  const perUnit = { threshold: 30, rewardType: 'per_unit' as const, amount: 10_000 };

  it('pays a fixed bonus at or above the threshold', () => {
    expect(kpiBonus(fixed, 90)).toBe(800_000);
    expect(kpiBonus(fixed, 96.5)).toBe(800_000);
    expect(kpiBonus(fixed, 89.9)).toBe(0);
  });

  it('pays per unit above the threshold', () => {
    expect(kpiBonus(perUnit, 72.5)).toBe(425_000);
    expect(kpiBonus(perUnit, 30)).toBe(0);
    expect(kpiBonus(perUnit, 12)).toBe(0);
  });

  it('pays nothing when the metric has no data', () => {
    expect(kpiBonus(fixed, null)).toBe(0);
  });
});

describe('gross and net', () => {
  const amounts = { base: 4_800_000, piecework: 500_000, bonus: 200_000, advance: 1_000_000, deductions: 50_000 };

  it('gross is base + piecework + bonus', () => {
    expect(payrollGross(amounts)).toBe(5_500_000);
  });

  it('net takes off advances and deductions', () => {
    expect(payrollNet(amounts)).toBe(4_450_000);
  });

  it('net can go negative when advances exceed earnings', () => {
    expect(payrollNet({ base: 500, piecework: 0, bonus: 0, advance: 800, deductions: 0 })).toBe(-300);
  });
});

describe('allocateLabour', () => {
  it('splits by days worked on each cost center', () => {
    expect(allocateLabour(5_000_000, { fieldA: 3, fieldB: 1 }, 'general')).toEqual({ fieldA: 3_750_000, fieldB: 1_250_000 });
  });

  it('shares add up exactly to the total', () => {
    const shares = allocateLabour(1_000_000.01, { a: 1, b: 1, c: 1 }, 'general');
    const sum = Object.values(shares).reduce((s, v) => s + v, 0);
    expect(Math.round(sum * 100) / 100).toBe(1_000_000.01);
  });

  it('falls back when no work is recorded', () => {
    expect(allocateLabour(100, {}, 'general')).toEqual({ general: 100 });
  });

  it('allocates nothing for a zero total', () => {
    expect(allocateLabour(0, { a: 1 }, 'general')).toEqual({});
  });
});

describe('timesheet helpers', () => {
  it('hoursBetween', () => {
    expect(hoursBetween('2026-11-04T04:00:00Z', '2026-11-04T13:30:00Z')).toBe(9.5);
    expect(hoursBetween(new Date('2026-11-04T04:00:00Z'), new Date('2026-11-04T04:20:00Z'))).toBe(0.33);
    expect(hoursBetween(null, '2026-11-04T13:30:00Z')).toBeNull();
    expect(hoursBetween('2026-11-04T13:30:00Z', '2026-11-04T04:00:00Z')).toBeNull();
    expect(hoursBetween('nonsense', '2026-11-04T04:00:00Z')).toBeNull();
  });

  it('attendancePercent ignores excused days', () => {
    expect(attendancePercent(24, 2)).toBe(92.3);
    expect(attendancePercent(0, 0)).toBeNull();
    expect(attendancePercent(0, 5)).toBe(0);
  });

  it('shepherdSurvival', () => {
    expect(shepherdSurvival(95, 100)).toBe(95);
    expect(shepherdSurvival(0, 0)).toBeNull();
  });
});
