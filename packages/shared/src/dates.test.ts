import { describe, expect, it } from 'vitest';
import { addDays, diffDays, monthOf, monthRange, todayIso } from './dates';

describe('dates', () => {
  it('todayIso uses Tashkent time, not UTC', () => {
    // 20:30 UTC on Nov 4 is already 01:30 on Nov 5 in Tashkent.
    expect(todayIso('Asia/Tashkent', new Date('2026-11-04T20:30:00Z'))).toBe('2026-11-05');
    expect(todayIso('UTC', new Date('2026-11-04T20:30:00Z'))).toBe('2026-11-04');
  });

  it('addDays and diffDays are inverse', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-12-31', '2027-01-01')).toBe(1);
    expect(diffDays('2027-01-01', '2026-12-31')).toBe(-1);
  });

  it('monthOf and monthRange', () => {
    expect(monthOf('2026-11-04')).toBe('2026-11');
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});
