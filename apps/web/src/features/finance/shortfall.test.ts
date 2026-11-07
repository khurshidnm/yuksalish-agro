import { describe, expect, it } from 'vitest';
import { shortfallPeriod } from './shortfall';

const months = (flags: boolean[]) => flags.map((negative, i) => ({ month: `2027-0${i + 1}`, negative }));

describe('shortfallPeriod', () => {
  it('finds nothing when the balance stays positive', () => {
    expect(shortfallPeriod(months([false, false, false]))).toBeUndefined();
    expect(shortfallPeriod([])).toBeUndefined();
  });

  it('stops at the month the balance recovers, not at the end of the forecast', () => {
    expect(shortfallPeriod(months([false, true, true, false, false, false]))).toEqual({ from: '2027-02', to: '2027-04' });
  });

  it('gives a one-month dip a width', () => {
    expect(shortfallPeriod(months([false, true, false, false]))).toEqual({ from: '2027-02', to: '2027-03' });
  });

  it('reaches back when the dip is the last month', () => {
    expect(shortfallPeriod(months([false, false, true]))).toEqual({ from: '2027-02', to: '2027-03' });
  });

  it('runs to the end when the balance never recovers', () => {
    expect(shortfallPeriod(months([false, true, true]))).toEqual({ from: '2027-02', to: '2027-03' });
  });

  it('shades only the first shortfall', () => {
    expect(shortfallPeriod(months([true, false, true, false]))).toEqual({ from: '2027-01', to: '2027-02' });
  });

  it('has nothing to draw for a single month', () => {
    expect(shortfallPeriod(months([true]))).toBeUndefined();
  });
});
