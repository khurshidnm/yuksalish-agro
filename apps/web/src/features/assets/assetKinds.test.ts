import { ASSET_TYPES } from '@yap/shared';
import { describe, expect, it } from 'vitest';
import { assetKind } from './assetKinds';

describe('assetKind', () => {
  it('a generator or a pump runs for hours on fuel but works no field', () => {
    for (const type of ['generator', 'pump']) {
      expect(assetKind(type)).toEqual({ worksFields: false, hasEngine: true, logsWork: true, stationary: true });
    }
  });

  it('a tractor or combine has every measure', () => {
    for (const type of ['tractor', 'combine']) {
      expect(assetKind(type)).toEqual({ worksFields: true, hasEngine: true, logsWork: true, stationary: false });
    }
  });

  it('a plough or seeder works fields on the tractor engine', () => {
    for (const type of ['plough', 'seeder']) expect(assetKind(type)).toMatchObject({ worksFields: true, hasEngine: false, logsWork: true });
  });

  it('a scale or camera has nothing to log', () => {
    for (const type of ['scale', 'camera']) expect(assetKind(type)).toMatchObject({ worksFields: false, hasEngine: false, logsWork: false });
  });

  it('a vehicle or excavator has shifts and hours but no hectares', () => {
    for (const type of ['vehicle', 'excavator']) expect(assetKind(type)).toMatchObject({ worksFields: false, hasEngine: true, stationary: false });
  });

  it('keeps every measure for "other" and for a type it does not know', () => {
    for (const type of ['other', 'sprayer']) expect(assetKind(type)).toEqual({ worksFields: true, hasEngine: true, logsWork: true, stationary: false });
  });

  it('knows every asset type the app offers', () => {
    const decided = ASSET_TYPES.filter((type) => type !== 'other');
    // Every listed type except "other" lacks at least one measure or has them all for a reason stated above.
    expect(decided.map((type) => [type, assetKind(type).worksFields, assetKind(type).hasEngine])).toEqual([
      ['tractor', true, true],
      ['combine', true, true],
      ['excavator', false, true],
      ['seeder', true, false],
      ['plough', true, false],
      ['pump', false, true],
      ['generator', false, true],
      ['scale', false, false],
      ['camera', false, false],
      ['vehicle', false, true],
    ]);
  });
});
