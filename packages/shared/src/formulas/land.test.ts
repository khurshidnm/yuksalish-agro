import { describe, expect, it } from 'vitest';
import { capacityUsePercent, expiryState, unassignedAreaHa, waterLimitUsePercent } from './land';

describe('land formulas', () => {
  it('capacityUsePercent', () => {
    expect(capacityUsePercent(500, 1000)).toBe(50);
    expect(capacityUsePercent(1100, 1000)).toBe(110);
    expect(capacityUsePercent(10, 0)).toBeNull();
    expect(capacityUsePercent(10, null)).toBeNull();
  });

  it('waterLimitUsePercent', () => {
    expect(waterLimitUsePercent(750, 1000)).toBe(75);
    expect(waterLimitUsePercent(1100, 1000)).toBe(110);
    expect(waterLimitUsePercent(750, undefined)).toBeNull();
    expect(waterLimitUsePercent(750, 0)).toBeNull();
  });

  it('unassignedAreaHa keeps float noise out of the answer', () => {
    expect(unassignedAreaHa(210, [70, 110, 20, 6, 4])).toBe(0);
    expect(unassignedAreaHa(210, [70])).toBe(140);
    expect(unassignedAreaHa(0.3, [0.1, 0.2])).toBe(0);
    expect(unassignedAreaHa(100, [70.1234, 40])).toBe(-10.1234);
    expect(unassignedAreaHa(null, [70])).toBeNull();
  });

  it('expiryState', () => {
    expect(expiryState('2026-11-03', '2026-11-04')).toBe('expired');
    expect(expiryState('2026-11-04', '2026-11-04')).toBe('expiring');
    expect(expiryState('2026-12-04', '2026-11-04')).toBe('expiring');
    expect(expiryState('2026-12-05', '2026-11-04')).toBe('valid');
    expect(expiryState('2026-11-10', '2026-11-04', 3)).toBe('valid');
    expect(expiryState(null, '2026-11-04')).toBeNull();
  });
});
