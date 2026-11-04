import { describe, expect, it } from 'vitest';
import { monthGrid, shiftDateByMonth, shiftMonth, startOfWeek, weekDays, weekdayIndex } from './calendarDates';

describe('calendar dates', () => {
  it('treats Monday as the first day of the week', () => {
    expect(weekdayIndex('2026-11-02')).toBe(0); // Monday
    expect(weekdayIndex('2026-11-08')).toBe(6); // Sunday
    expect(startOfWeek('2026-11-08')).toBe('2026-11-02');
    expect(startOfWeek('2026-11-02')).toBe('2026-11-02');
  });

  it('builds a week across a month boundary', () => {
    expect(weekDays('2026-12-01')).toEqual([
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
      '2026-12-03',
      '2026-12-04',
      '2026-12-05',
      '2026-12-06',
    ]);
  });

  it('moves between months and years', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2027-01', -1)).toBe('2026-12');
  });

  it('keeps a valid day when months have different lengths', () => {
    expect(shiftDateByMonth('2027-01-31', 1)).toBe('2027-02-28');
    expect(shiftDateByMonth('2027-03-15', -1)).toBe('2027-02-15');
  });

  it('covers the whole month in full weeks', () => {
    const november = monthGrid('2026-11');
    expect(november[0]).toBe('2026-10-26');
    expect(november.at(-1)).toBe('2026-12-06');
    expect(november).toHaveLength(42);
    expect(november.length % 7).toBe(0);

    // February 2027 starts on a Monday and ends on a Sunday: exactly four weeks.
    const february = monthGrid('2027-02');
    expect(february).toHaveLength(28);
    expect(february[0]).toBe('2027-02-01');
  });
});
