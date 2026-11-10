import { describe, expect, it } from 'vitest';
import { cropFamilyOf, rotationNotes, rotationPenalised, type RotationCrop } from './rotation';

const wheat: RotationCrop = { key: 'wheat', family: 'cereal' };
const barley: RotationCrop = { key: 'barley', family: 'cereal' };
const rice: RotationCrop = { key: 'rice', family: 'cereal' };
const lucerne: RotationCrop = { key: 'alfalfa', family: 'perennial_grass' };
const corn: RotationCrop = { key: 'corn', family: 'row_crop' };
const cotton: RotationCrop = { key: 'cotton', family: 'row_crop' };
const mung: RotationCrop = { key: 'mung', family: 'legume' };
const pea: RotationCrop = { key: 'pea', family: 'legume' };

const rules = (crop: RotationCrop, history: RotationCrop[]) => rotationNotes(crop, history).map((n) => `${n.level}:${n.rule}`);

describe('rotationNotes', () => {
  it('says nothing about a field with no history', () => {
    expect(rotationNotes(wheat, [])).toEqual([]);
  });

  it('warns about the same crop after itself', () => {
    expect(rules(wheat, [wheat])).toEqual(['warning:same_crop']);
    expect(rules(cotton, [cotton])).toEqual(['warning:same_crop']);
    // A crop the farm added without a family still gets this rule.
    expect(rules({ key: 'sesame', family: null }, [{ key: 'sesame', family: null }])).toEqual(['warning:same_crop']);
  });

  it('never warns about lucerne kept for several years', () => {
    expect(rotationNotes(lucerne, [lucerne])).toEqual([]);
    expect(rotationNotes(lucerne, [lucerne, lucerne, lucerne, lucerne])).toEqual([]);
    expect(rotationPenalised(lucerne, [lucerne, lucerne])).toBe(false);
  });

  it('warns about a cereal after another cereal, and more strongly about a third in a row', () => {
    expect(rules(wheat, [barley])).toEqual(['warning:cereal_after_cereal']);
    expect(rules(wheat, [barley, wheat])).toEqual(['warning:cereal_run']);
    expect(rules(wheat, [wheat, wheat])).toEqual(['warning:same_crop', 'warning:cereal_run']);
    // A break two seasons back resets the run.
    expect(rules(wheat, [barley, cotton, wheat])).toEqual(['warning:cereal_after_cereal']);
  });

  it('leaves maize and rice alone: the textbook names them as tolerating repeat sowing', () => {
    expect(rotationNotes(corn, [corn])).toEqual([]);
    expect(rotationNotes(rice, [rice])).toEqual([]);
    expect(rotationNotes(rice, [wheat, barley])).toEqual([]);
  });

  it('warns about a grain legume after another grain legume', () => {
    expect(rules(pea, [mung])).toEqual(['warning:legume_after_legume']);
    expect(rules(mung, [mung])).toEqual(['warning:same_crop']);
  });

  it('marks good predecessors without penalising', () => {
    expect(rules(wheat, [mung])).toEqual(['good:after_legume']);
    expect(rules(cotton, [lucerne])).toEqual(['good:after_perennial_grass']);
    expect(rotationPenalised(wheat, [mung])).toBe(false);
    expect(rotationPenalised(wheat, [barley])).toBe(true);
  });

  it('names its source on every note', () => {
    for (const note of [...rotationNotes(wheat, [wheat, barley]), ...rotationNotes(wheat, [mung])]) {
      expect(note.source).toMatch(/Баздырев/);
    }
  });
});

describe('cropFamilyOf', () => {
  it("takes the farm's family first, then the typical one for the starting crops", () => {
    expect(cropFamilyOf('wheat', null)).toBe('cereal');
    expect(cropFamilyOf('alfalfa', undefined)).toBe('perennial_grass');
    expect(cropFamilyOf('wheat', 'other')).toBe('other');
    expect(cropFamilyOf('sesame', null)).toBeNull();
  });
});
