import { describe, expect, it } from 'vitest';
import { groundwaterRisk, leachingNorm } from './salinity';

describe('leachingNorm', () => {
  it('reads the published table by salinity and soil group', () => {
    expect(leachingNorm('low', 'sandy_loam')).toEqual({ norm: { minM3Ha: 1500, maxM3Ha: 2000, group: 'light' }, reason: null });
    expect(leachingNorm('medium', 'loam')).toEqual({ norm: { minM3Ha: 3000, maxM3Ha: 4000, group: 'medium' }, reason: null });
    expect(leachingNorm('medium', 'clay')).toEqual({ norm: { minM3Ha: 3500, maxM3Ha: 4500, group: 'heavy' }, reason: null });
    expect(leachingNorm('high', 'silt_loam')).toEqual({ norm: { minM3Ha: 5000, maxM3Ha: 6000, group: 'medium' }, reason: null });
  });

  it('gives the whole span of the table when the texture is unknown', () => {
    expect(leachingNorm('low', null)).toEqual({ norm: { minM3Ha: 1500, maxM3Ha: 2500, group: null }, reason: null });
    expect(leachingNorm('medium', undefined)).toEqual({ norm: { minM3Ha: 2500, maxM3Ha: 4500, group: null }, reason: null });
    // Heavy soil has no operational norm at this level, so the span covers light and medium only.
    expect(leachingNorm('high', 'something else')).toEqual({ norm: { minM3Ha: 4000, maxM3Ha: 6000, group: null }, reason: null });
  });

  it('gives no norm, with the reason, where the table has none', () => {
    expect(leachingNorm('none', 'loam')).toEqual({ norm: null, reason: 'not_saline' });
    expect(leachingNorm(null, 'loam')).toEqual({ norm: null, reason: 'level_unknown' });
    expect(leachingNorm('kuchli', 'loam')).toEqual({ norm: null, reason: 'level_unknown' });
    expect(leachingNorm('high', 'clay')).toEqual({ norm: null, reason: 'capital_leaching' });
  });
});

describe('groundwaterRisk', () => {
  it('warns above the critical range, cautions inside it, and is silent below', () => {
    expect(groundwaterRisk(0.8)).toBe('shallow');
    expect(groundwaterRisk(1.49)).toBe('shallow');
    expect(groundwaterRisk(1.5)).toBe('within_critical_range');
    expect(groundwaterRisk(3)).toBe('within_critical_range');
    expect(groundwaterRisk(3.01)).toBeNull();
    expect(groundwaterRisk(null)).toBeNull();
    expect(groundwaterRisk(-1)).toBeNull();
  });
});
