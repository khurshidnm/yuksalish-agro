import { describe, expect, it } from 'vitest';
import { depreciationGaps } from './depreciationGaps';

const tractor = { rented: false, purchasePrice: 120_000_000, purchaseDate: '2026-03-15', depreciationMethod: 'straight_line', usefulLifeMonths: 120, totalUnits: null };

describe('depreciationGaps', () => {
  it('a machine with a price, a date and a life has nothing missing', () => {
    expect(depreciationGaps(tractor)).toEqual([]);
  });

  it('a straight-line machine with a price needs a useful life, and zero months is none', () => {
    expect(depreciationGaps({ ...tractor, usefulLifeMonths: null })).toEqual(['usefulLifeMonths']);
    expect(depreciationGaps({ ...tractor, usefulLifeMonths: 0 })).toEqual(['usefulLifeMonths']);
  });

  it('a machine depreciated by hours needs its total hours, not a useful life', () => {
    expect(depreciationGaps({ ...tractor, depreciationMethod: 'units', usefulLifeMonths: null })).toEqual(['totalUnits']);
    expect(depreciationGaps({ ...tractor, depreciationMethod: 'units', usefulLifeMonths: null, totalUnits: 8000 })).toEqual([]);
  });

  it('every missing fact is named at once', () => {
    expect(depreciationGaps({ ...tractor, usefulLifeMonths: null, purchaseDate: null })).toEqual(['usefulLifeMonths', 'purchaseDate']);
  });

  it('nothing is asked of a rented machine, or of one with no price to depreciate', () => {
    expect(depreciationGaps({ ...tractor, rented: true, usefulLifeMonths: null })).toEqual([]);
    expect(depreciationGaps({ ...tractor, purchasePrice: null, usefulLifeMonths: null })).toEqual([]);
    expect(depreciationGaps({ ...tractor, purchasePrice: 0, usefulLifeMonths: null })).toEqual([]);
  });
});
