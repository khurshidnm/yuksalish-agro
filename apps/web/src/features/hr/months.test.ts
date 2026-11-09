import { describe, expect, it } from 'vitest';
import { payrollMonths, shiftMonth } from './months';

describe('shiftMonth', () => {
  it('crosses year ends both ways', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2027-01', -1)).toBe('2026-12');
    expect(shiftMonth('2026-11', -11)).toBe('2025-12');
  });
});

describe('payrollMonths', () => {
  it('never offers or suggests a month that has a run, and says the payroll is up to date (the demo on 9 November)', () => {
    const choice = payrollMonths('2026-11', ['2026-10'], '2026-08');
    expect(choice.months).toEqual(['2026-11', '2026-09', '2026-08']);
    expect(choice.latest).toBe('2026-10');
    expect(choice.suggested).toBeNull();
  });

  it('suggests the newest finished month after the latest run', () => {
    expect(payrollMonths('2026-12', ['2026-10'], '2026-08').suggested).toBe('2026-11');
    expect(payrollMonths('2027-01', ['2026-10'], '2026-08').suggested).toBe('2026-12');
  });

  it('suggests last month when there is no run yet', () => {
    const choice = payrollMonths('2026-11', [], '2026-08');
    expect(choice.suggested).toBe('2026-10');
    expect(choice.latest).toBeNull();
  });

  it('starts at the first hire, or a year back when staff are older or unknown', () => {
    expect(payrollMonths('2026-11', [], '2026-10').months).toEqual(['2026-11', '2026-10']);
    expect(payrollMonths('2026-11', [], '2020-01').months).toHaveLength(12);
    expect(payrollMonths('2026-11', [], null).months.at(-1)).toBe('2025-12');
  });

  it('has nothing to suggest when everyone was hired this month', () => {
    const choice = payrollMonths('2026-11', [], '2026-11');
    expect(choice.months).toEqual(['2026-11']);
    expect(choice.suggested).toBeNull();
  });
});
