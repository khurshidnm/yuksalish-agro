import { describe, expect, it } from 'vitest';
import {
  canBreed,
  adjustedWeight100,
  ancestorsWithin,
  averageOf,
  commonAncestors,
  gainFromBirthGrams,
  lambsPerEwe,
  nextVaccinationDue,
  progenyIndex,
  withdrawalEnd,
} from './reproduction';

describe('reproduction formulas', () => {
  it('lambsPerEwe', () => {
    expect(lambsPerEwe(620, 500)).toBe(1.24);
    expect(lambsPerEwe(0, 0)).toBeNull();
  });

  it('adjustedWeight100 scales growth to 100 days', () => {
    // 4 kg at birth, 34 kg at 120 days: 0.25 kg/day, so 29 kg at 100 days.
    expect(adjustedWeight100(4, 34, 120)).toBe(29);
    expect(adjustedWeight100(4, 24, 100)).toBe(24);
  });

  it('adjustedWeight100 refuses weighings outside the window', () => {
    expect(adjustedWeight100(4, 20, 69)).toBeNull();
    expect(adjustedWeight100(4, 40, 131)).toBeNull();
    expect(adjustedWeight100(4, 20, 70)).not.toBeNull();
    expect(adjustedWeight100(4, 40, 130)).not.toBeNull();
  });

  it('gainFromBirthGrams', () => {
    expect(gainFromBirthGrams(4, 34, 120)).toBe(250);
    expect(gainFromBirthGrams(4, 34, 0)).toBeNull();
  });

  it('progenyIndex is relative to the farm average', () => {
    expect(progenyIndex(275, 250)).toBeCloseTo(110, 8);
    expect(progenyIndex(null, 250)).toBeNull();
    expect(progenyIndex(250, null)).toBeNull();
    expect(progenyIndex(250, 0)).toBeNull();
  });

  it('averageOf ignores unknown values', () => {
    expect(averageOf([10, null, 20, undefined])).toBe(15);
    expect(averageOf([null])).toBeNull();
    expect(averageOf([])).toBeNull();
  });
});

describe('canBreed', () => {
  const on = '2026-11-05';
  it('refuses a newborn, whatever its category says', () => {
    expect(canBreed({ category: 'lamb_female', birthDate: on }, on)).toBe(false);
    expect(canBreed({ category: 'ewe', birthDate: '2026-10-01' }, on)).toBe(false);
  });
  it('turns on the day the animal is old enough', () => {
    expect(canBreed({ category: 'lamb_female', birthDate: '2026-05-10' }, on)).toBe(false); // 179 days
    expect(canBreed({ category: 'lamb_female', birthDate: '2026-05-09' }, on)).toBe(true); // 180 days
  });
  it('without a birth date, trusts the category', () => {
    expect(canBreed({ category: 'ewe', birthDate: null }, on)).toBe(true);
    expect(canBreed({ category: 'ram', birthDate: null }, on)).toBe(true);
    expect(canBreed({ category: 'lamb_male', birthDate: null }, on)).toBe(false);
  });
  it('never a wether', () => {
    expect(canBreed({ category: 'wether', birthDate: '2020-01-01' }, on)).toBe(false);
  });
});

describe('nextVaccinationDue', () => {
  const base = { lastDate: null, intervalDays: null, birthDate: null, ageDays: null, arrivalDate: null, today: '2026-11-04' };

  it('repeats by interval after a dose', () => {
    expect(nextVaccinationDue({ ...base, lastDate: '2026-05-01', intervalDays: 180 })).toBe('2026-10-28');
  });

  it('a single-dose vaccine is finished after one dose', () => {
    expect(nextVaccinationDue({ ...base, lastDate: '2026-05-01' })).toBeNull();
  });

  it('first dose by age', () => {
    expect(nextVaccinationDue({ ...base, birthDate: '2026-10-01', ageDays: 30 })).toBe('2026-10-31');
  });

  it('a bought animal cannot be due before it arrived', () => {
    expect(
      nextVaccinationDue({ ...base, birthDate: '2024-03-01', ageDays: 30, arrivalDate: '2026-10-28' }),
    ).toBe('2026-10-28');
    expect(
      nextVaccinationDue({ ...base, birthDate: '2026-10-20', ageDays: 30, arrivalDate: '2026-10-28' }),
    ).toBe('2026-11-19');
  });

  it('any-age plan falls due on arrival, then birth, then today', () => {
    expect(nextVaccinationDue({ ...base, arrivalDate: '2026-10-28' })).toBe('2026-10-28');
    expect(nextVaccinationDue({ ...base, birthDate: '2026-10-01' })).toBe('2026-10-01');
    expect(nextVaccinationDue(base)).toBe('2026-11-04');
  });

  it('an unknown birth date with an age plan uses arrival', () => {
    expect(nextVaccinationDue({ ...base, ageDays: 30, arrivalDate: '2026-10-28' })).toBe('2026-10-28');
  });
});

describe('withdrawalEnd', () => {
  it('counts from the single dose', () => {
    expect(withdrawalEnd('2026-11-01', null, 14)).toBe('2026-11-15');
    expect(withdrawalEnd('2026-11-01', 1, 14)).toBe('2026-11-15');
  });

  it('counts from the last dose of a course', () => {
    expect(withdrawalEnd('2026-11-01', 5, 14)).toBe('2026-11-19');
  });

  it('ignores a negative withdrawal', () => {
    expect(withdrawalEnd('2026-11-01', 3, -2)).toBe('2026-11-03');
  });
});

describe('pedigree', () => {
  /*
   * ggs (great-grandsire)
   *  └ gs ── mother ── ewe
   *  └ gs2 ─ father ── ram1
   * bigRam is the sire of ewe and of half
   */
  const parents = new Map([
    ['ewe', { damId: 'mother', sireId: 'bigRam' }],
    ['half', { damId: 'other', sireId: 'bigRam' }],
    ['mother', { damId: null, sireId: 'gs' }],
    ['gs', { damId: null, sireId: 'ggs' }],
    ['ram1', { damId: null, sireId: 'father' }],
    ['father', { damId: null, sireId: 'gs2' }],
    ['gs2', { damId: null, sireId: 'ggs' }],
    ['cousinFar', { damId: null, sireId: 'x1' }],
    ['x1', { damId: null, sireId: 'x2' }],
    ['x2', { damId: null, sireId: 'x3' }],
    ['x3', { damId: null, sireId: 'x4' }],
    ['y0', { damId: null, sireId: 'y1' }],
    ['y1', { damId: null, sireId: 'y2' }],
    ['y2', { damId: null, sireId: 'x3' }],
  ]);

  it('ancestorsWithin stops at the requested generation', () => {
    expect([...ancestorsWithin(parents, 'ewe', 1).keys()].sort()).toEqual(['bigRam', 'ewe', 'mother']);
    const three = ancestorsWithin(parents, 'ewe', 3);
    expect(three.get('gs')).toBe(2);
    expect(three.get('ggs')).toBe(3);
    expect(three.has('ewe')).toBe(true);
  });

  it('survives a cycle in bad data', () => {
    const cyclic = new Map([
      ['a', { damId: 'b', sireId: null }],
      ['b', { damId: 'a', sireId: null }],
    ]);
    expect(ancestorsWithin(cyclic, 'a', 5).size).toBe(2);
  });

  it('finds half siblings through the shared sire', () => {
    expect(commonAncestors(parents, 'ewe', 'half')).toEqual([{ id: 'bigRam', distanceA: 1, distanceB: 1 }]);
  });

  it('finds a ram mated with his own daughter', () => {
    expect(commonAncestors(parents, 'ewe', 'bigRam')).toEqual([{ id: 'bigRam', distanceA: 1, distanceB: 0 }]);
  });

  it('finds a shared great-grandsire at exactly three generations', () => {
    expect(commonAncestors(parents, 'ewe', 'ram1')).toEqual([{ id: 'ggs', distanceA: 3, distanceB: 3 }]);
  });

  it('ignores relatives further back than the limit', () => {
    expect(commonAncestors(parents, 'cousinFar', 'y0', 2)).toEqual([]);
    expect(commonAncestors(parents, 'cousinFar', 'y0', 3)).toEqual([{ id: 'x3', distanceA: 3, distanceB: 3 }]);
  });

  it('unrelated animals and an animal with itself give nothing', () => {
    expect(commonAncestors(parents, 'ewe', 'y0')).toEqual([]);
    expect(commonAncestors(parents, 'ewe', 'ewe')).toEqual([]);
  });
});
