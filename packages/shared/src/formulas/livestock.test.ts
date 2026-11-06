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

describe('wasInHerdOn', () => {
  const stay = (over: Partial<f.HerdHistory> = {}): f.HerdHistory => ({
    herdId: 'B',
    birthDate: null,
    purchaseDate: null,
    exitDate: null,
    transfers: [],
    ...over,
  });
  const aToB = [{ date: '2026-06-10', fromHerdId: 'A', toHerdId: 'B' }];

  it('with no transfers, the animal has always been in its current herd', () => {
    expect(f.wasInHerdOn(stay(), 'B', '2026-01-01')).toBe(true);
    expect(f.wasInHerdOn(stay(), 'A', '2026-01-01')).toBe(false);
    expect(f.wasInHerdOn(stay({ herdId: null }), 'A', '2026-01-01')).toBe(false);
  });

  it('before the first transfer, it was in the herd that transfer took it from', () => {
    expect(f.wasInHerdOn(stay({ transfers: aToB }), 'A', '2026-06-09')).toBe(true);
    expect(f.wasInHerdOn(stay({ transfers: aToB }), 'B', '2026-06-09')).toBe(false);
  });

  it('from the day of a transfer, it is in the new herd', () => {
    expect(f.wasInHerdOn(stay({ transfers: aToB }), 'B', '2026-06-10')).toBe(true);
    expect(f.wasInHerdOn(stay({ transfers: aToB }), 'A', '2026-06-10')).toBe(false);
    expect(f.wasInHerdOn(stay({ transfers: aToB }), 'B', '2026-06-11')).toBe(true);
    expect(f.wasInHerdOn(stay({ transfers: aToB }), 'A', '2026-06-11')).toBe(false);
  });

  it('follows an animal that went away and came back', () => {
    const transfers = [
      { date: '2026-03-01', fromHerdId: 'A', toHerdId: 'B' },
      { date: '2026-05-01', fromHerdId: 'B', toHerdId: 'A' },
    ];
    const animal = stay({ herdId: 'A', transfers });
    expect(f.wasInHerdOn(animal, 'A', '2026-02-01')).toBe(true);
    expect(f.wasInHerdOn(animal, 'A', '2026-04-01')).toBe(false);
    expect(f.wasInHerdOn(animal, 'B', '2026-04-01')).toBe(true);
    expect(f.wasInHerdOn(animal, 'A', '2026-06-01')).toBe(true);
    expect(f.wasInHerdOn(animal, 'B', '2026-06-01')).toBe(false);
  });

  it('takes the last of two transfers on one day', () => {
    const transfers = [
      { date: '2026-03-01', fromHerdId: 'A', toHerdId: 'B' },
      { date: '2026-03-01', fromHerdId: 'B', toHerdId: 'C' },
    ];
    const animal = stay({ herdId: 'C', transfers });
    expect(f.wasInHerdOn(animal, 'B', '2026-03-01')).toBe(false);
    expect(f.wasInHerdOn(animal, 'C', '2026-03-01')).toBe(true);
  });

  it('an animal that had no herd before its first transfer was in none of them', () => {
    const transfers = [{ date: '2026-03-01', fromHerdId: null, toHerdId: 'B' }];
    expect(f.wasInHerdOn(stay({ transfers }), 'B', '2026-02-01')).toBe(false);
  });

  it('counts neither the days before it was born nor before it was bought', () => {
    expect(f.wasInHerdOn(stay({ birthDate: '2026-04-01' }), 'B', '2026-03-31')).toBe(false);
    expect(f.wasInHerdOn(stay({ birthDate: '2026-04-01' }), 'B', '2026-04-01')).toBe(true);
    expect(f.wasInHerdOn(stay({ purchaseDate: '2026-04-01' }), 'B', '2026-03-31')).toBe(false);
    expect(f.wasInHerdOn(stay({ purchaseDate: '2026-04-01' }), 'B', '2026-04-01')).toBe(true);
    // Bought as an adult: born long ago, but not on this farm until the purchase.
    expect(f.wasInHerdOn(stay({ birthDate: '2024-01-01', purchaseDate: '2026-04-01' }), 'B', '2025-01-01')).toBe(false);
  });

  it('counts the day it left, not the days after', () => {
    expect(f.wasInHerdOn(stay({ exitDate: '2026-04-01' }), 'B', '2026-04-01')).toBe(true);
    expect(f.wasInHerdOn(stay({ exitDate: '2026-04-01' }), 'B', '2026-04-02')).toBe(false);
  });

  it('a herd changed by an edit leaves no date, so both herds count from the last transfer on', () => {
    const animal = stay({ herdId: 'C', transfers: aToB });
    expect(f.wasInHerdOn(animal, 'B', '2026-07-01')).toBe(true);
    expect(f.wasInHerdOn(animal, 'C', '2026-07-01')).toBe(true);
    expect(f.wasInHerdOn(animal, 'A', '2026-07-01')).toBe(false);
    expect(f.wasInHerdOn(animal, 'C', '2026-06-09')).toBe(false);
  });

  it('an edit between two transfers leaves both herds possible for that gap only', () => {
    const transfers = [
      { date: '2026-03-01', fromHerdId: 'A', toHerdId: 'B' },
      { date: '2026-05-01', fromHerdId: 'C', toHerdId: 'D' },
    ];
    const animal = stay({ herdId: 'D', transfers });
    expect(f.wasInHerdOn(animal, 'B', '2026-04-01')).toBe(true);
    expect(f.wasInHerdOn(animal, 'C', '2026-04-01')).toBe(true);
    expect(f.wasInHerdOn(animal, 'C', '2026-06-01')).toBe(false);
  });
});
