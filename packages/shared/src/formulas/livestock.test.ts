import { describe, expect, it } from 'vitest';
import * as f from './livestock';

describe('livestock formulas', () => {
  it('stockingRate', () => {
    expect(f.stockingRate(500, 100)).toBe(5);
    expect(f.stockingRate(500, 0)).toBeNull();
  });

  it('meatYieldPercent', () => {
    expect(f.meatYieldPercent(24, 50)).toBe(48);
    expect(f.meatYieldPercent(24, 0)).toBeNull();
  });

  it('converts between kg and the item unit', () => {
    expect(f.kgToItemUnit(600, 'kg')).toBe(600);
    expect(f.kgToItemUnit(600, 't')).toBe(0.6);
    expect(f.itemUnitToKg(0.6, 't')).toBe(600);
    expect(f.itemUnitToKg(600, 'bale')).toBe(600);
  });

  it('ageInMonths counts completed months only', () => {
    expect(f.ageInMonths('2024-03-15', '2026-03-15')).toBe(24);
    expect(f.ageInMonths('2024-03-15', '2026-03-14')).toBe(23);
    expect(f.ageInMonths('2026-12-01', '2026-11-04')).toBeNull();
    expect(f.ageInMonths(null, '2026-11-04')).toBeNull();
  });

  it('animalBookValue treats unknown as unknown', () => {
    expect(f.animalBookValue(4_200_000, 150_000)).toBe(4_350_000);
    expect(f.animalBookValue(4_200_000, null)).toBe(4_200_000);
    expect(f.animalBookValue(null, 150_000)).toBe(150_000);
    expect(f.animalBookValue(null, null)).toBeNull();
  });

  it('averageHead', () => {
    expect(f.averageHead(500, 480)).toBe(490);
  });
});
