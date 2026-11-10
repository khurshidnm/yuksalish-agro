import { describe, expect, it } from 'vitest';
import { lambingWorkload } from './ai';
import { LAMBING_DESK, expectedLambCrop, lambAttention, lambsFromPregnancies, minHoursSinceBirth, penReleaseDate } from './lambing';
import { OUTLOOK_ASSUMPTIONS, expectedLambs, projectHerd } from './outlook';

describe('expected lambs once ewes are scanned', () => {
  it('with no scan it is the old figure: ewes × lambs per ewe', () => {
    // 700 × 1.1 = 770
    expect(expectedLambCrop({ ewes: 700 }, 1.1)).toBe(770);
    expect(expectedLambCrop({ ewes: 700 }, 1.1)).toBe(expectedLambs(700));
  });

  it('scanned ewes count their foetuses, the rest take the rate (hand-worked)', () => {
    // 700 ewes. 400 scanned: 60 empty were closed already, so of the 400 open ones
    // 250 carry one, 130 carry two, 20 carry three: 250 + 260 + 60 = 570 foetuses.
    // 300 unscanned × 1.1 = 330. Total 900.
    expect(lambsFromPregnancies({ ewes: 700, scannedEwes: 400, scannedFetuses: 570 }, 1.1)).toBeCloseTo(900, 9);
    expect(expectedLambCrop({ ewes: 700, scannedEwes: 400, scannedFetuses: 570 }, 1.1)).toBe(900);
    // 3 ewes: one scanned with twins, two unscanned at 1.24: 2 + 2.48 = 4.48, shown as 4.
    expect(expectedLambCrop({ ewes: 3, scannedEwes: 1, scannedFetuses: 2 }, 1.24)).toBe(4);
  });

  it('a whole flock scanned needs no rate at all', () => {
    expect(expectedLambCrop({ ewes: 10, scannedEwes: 10, scannedFetuses: 14 }, null)).toBe(14);
  });

  it('missing data is null, never 0', () => {
    // Unscanned ewes and no rate to give them.
    expect(expectedLambCrop({ ewes: 10, scannedEwes: 4, scannedFetuses: 6 }, null)).toBeNull();
    // Nothing scanned and no rate: nothing to go by, even for no ewes.
    expect(expectedLambCrop({ ewes: 10 }, null)).toBeNull();
    expect(expectedLambCrop({ ewes: 0 }, null)).toBeNull();
    // No ewes due, with a rate known, is a real zero.
    expect(expectedLambCrop({ ewes: 0 }, 1.1)).toBe(0);
  });

  it('never counts more scanned ewes than there are ewes', () => {
    expect(expectedLambCrop({ ewes: 2, scannedEwes: 5, scannedFetuses: 3 }, 1.1)).toBe(3);
  });
});

describe('the outlook and the workload use the same count', () => {
  const months = ['2027-02', '2027-03', '2027-04'];

  it('projectHerd without scans is unchanged', () => {
    const rows = projectHerd({ months, head: 700, ewesDue: { '2027-03': 400, '2027-04': 300 }, assumptions: OUTLOOK_ASSUMPTIONS });
    expect(rows.map((row) => row.lambsBorn)).toEqual([0, 440, 330]);
  });

  it('projectHerd takes the scanned count for scanned ewes', () => {
    // March: 400 ewes, all scanned, 570 foetuses. April: 300 unscanned × 1.1 = 330.
    const rows = projectHerd({
      months,
      head: 700,
      ewesDue: { '2027-03': 400, '2027-04': 300 },
      scanned: { '2027-03': { ewes: 400, fetuses: 570 } },
      assumptions: OUTLOOK_ASSUMPTIONS,
    });
    expect(rows.map((row) => row.lambsBorn)).toEqual([0, 570, 330]);
    expect(rows.reduce((sum, row) => sum + row.lambsBorn, 0)).toBe(expectedLambCrop({ ewes: 700, scannedEwes: 400, scannedFetuses: 570 }, 1.1));
    // 570 × 0.92 survive = 524.4 on the farm at the end of March.
    expect(rows[1].lambsOnFarm).toBe(524);
  });

  it('lambingWorkload counts a scanned week by its foetuses', () => {
    const options = { lambsPerEwe: 1.1, lactationWeeks: 1, extraKgPerEweDay: null, laborHoursPerLambing: 1, shiftHours: 8 };
    const [plain, scanned] = lambingWorkload(
      [
        { weekStart: '2027-03-01', ewes: 10 },
        { weekStart: '2027-03-08', ewes: 10, scannedEwes: 6, scannedFetuses: 11 },
      ],
      options,
    );
    expect(plain.lambs).toBe(11);
    // 11 scanned + 4 × 1.1 = 15.4
    expect(scanned.lambs).toBe(15.4);
  });
});

describe('lambs needing attention', () => {
  const at = (iso: string) => new Date(iso);

  it('counts hours from the moment the form was saved, when the device said', () => {
    // Saved at 02:00 Tashkent (21:00 UTC the day before), read at 09:30 Tashkent: 7.5 hours.
    const hours = minHoursSinceBirth({
      birthDate: '2027-03-10',
      bornAt: at('2027-03-09T21:00:00Z'),
      recordedAt: at('2027-03-10T04:00:00Z'),
      now: at('2027-03-10T04:30:00Z'),
    });
    expect(hours).toBe(7.5);
  });

  it('without that moment, a record that arrived on the birth date counts from its arrival', () => {
    const hours = minHoursSinceBirth({
      birthDate: '2027-03-10',
      bornAt: null,
      recordedAt: at('2027-03-10T04:00:00Z'),
      now: at('2027-03-10T07:00:00Z'),
    });
    expect(hours).toBe(3);
  });

  it('a record entered days later adds the whole days in between', () => {
    // Born on the 10th, entered on the 12th at 09:00 Tashkent, read an hour later.
    // The 11th lies wholly in between: 24 h + 1 h = 25 h at the least.
    const hours = minHoursSinceBirth({
      birthDate: '2027-03-10',
      bornAt: null,
      recordedAt: at('2027-03-12T04:00:00Z'),
      now: at('2027-03-12T05:00:00Z'),
    });
    expect(hours).toBe(25);
  });

  it('flags no colostrum only after the threshold and only in the first days', () => {
    const lamb = { colostrumGiven: false, mothering: null, ageDays: 0 };
    expect(lambAttention({ ...lamb, hoursOld: LAMBING_DESK.colostrumHours - 0.1 }).noColostrum).toBe(false);
    expect(lambAttention({ ...lamb, hoursOld: LAMBING_DESK.colostrumHours }).noColostrum).toBe(true);
    expect(lambAttention({ ...lamb, hoursOld: 200, ageDays: LAMBING_DESK.colostrumWatchDays + 1 }).noColostrum).toBe(false);
    expect(lambAttention({ ...lamb, hoursOld: 30, colostrumGiven: true }).noColostrum).toBe(false);
    // The farm's own threshold wins over the starting value.
    expect(lambAttention({ ...lamb, hoursOld: 3 }, { colostrumHours: 2, colostrumWatchDays: 3 }).noColostrum).toBe(true);
  });

  it('keeps an orphan on the bottle on the list until weaning', () => {
    const lamb = { colostrumGiven: true, hoursOld: 500 };
    expect(lambAttention({ ...lamb, mothering: 'bottle', ageDays: 20 })).toEqual({ noColostrum: false, bottle: true });
    expect(lambAttention({ ...lamb, mothering: 'bottle', ageDays: 120 }).bottle).toBe(false);
    expect(lambAttention({ ...lamb, mothering: 'fostered', ageDays: 20 }).bottle).toBe(false);
    expect(lambAttention({ ...lamb, mothering: null, ageDays: 20 }).bottle).toBe(false);
  });
});

describe('pens', () => {
  it('plans the release a set number of days after the ewe went in', () => {
    expect(penReleaseDate('2027-03-10')).toBe('2027-03-13');
    expect(penReleaseDate('2027-02-27', 5)).toBe('2027-03-04');
  });
});
