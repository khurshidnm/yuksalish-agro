import { describe, expect, it } from 'vitest';
import {
  cellsInsidePolygon,
  checkRecordedWork,
  DEFAULT_PASTURE_MODEL,
  detectEvents,
  erodeMask,
  fitBiomassModel,
  grazingDays,
  MIN_VEGETATED_NDVI,
  ndvi,
  ndviStats,
  pastureBiomassKgHa,
  reflectance,
  SCL_CLEAR,
  sclIsClear,
  weakZones,
  weakZoneThreshold,
  type NdviPoint,
  type Ring,
} from './vegetation';

/** Render a mask as rows of '#' (inside) and '.' (outside), north first, for readable expectations. */
function picture(mask: boolean[], width: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < mask.length; i += width) rows.push(mask.slice(i, i + width).map((v) => (v ? '#' : '.')).join(''));
  return rows;
}

function fromPicture(rows: string[]): boolean[] {
  return rows.flatMap((row) => [...row].map((ch) => ch === '#'));
}

function points(rows: [string, number][]): NdviPoint[] {
  return rows.map(([date, mean]) => ({ date, mean }));
}

describe('reflectance and NDVI', () => {
  it('converts DN with the baseline 04.00 offset (control numbers)', () => {
    const red = reflectance(1787);
    const nir = reflectance(2832);
    expect(red).toBeCloseTo(0.0787, 10);
    expect(nir).toBeCloseTo(0.1832, 10);
    // (0.1832 − 0.0787) / (0.1832 + 0.0787) = 0.1045 / 0.2619 = 0.39900
    expect(ndvi(red, nir)).toBeCloseTo(0.399, 4);
    // Forgetting the offset gives 1045 / 4619 = 0.2262: the offset matters.
    expect(ndvi(reflectance(1787, 0.0001, 0), reflectance(2832, 0.0001, 0))).toBeCloseTo(0.2262, 4);
  });

  it('treats DN 0 and saturated DN as missing', () => {
    expect(reflectance(0)).toBeNull();
    expect(reflectance(65535)).toBeNull();
    expect(reflectance(Number.NaN)).toBeNull();
    expect(reflectance(1000)).toBeCloseTo(0, 12);
    expect(reflectance(950)).toBeCloseTo(-0.005, 12);
  });

  it('ndvi is null without signal and clamped to [-1, 1]', () => {
    expect(ndvi(null, 0.2)).toBeNull();
    expect(ndvi(0.1, null)).toBeNull();
    expect(ndvi(0, 0)).toBeNull();
    expect(ndvi(-0.05, 0.02)).toBeNull();
    expect(ndvi(0.1, 0.1)).toBe(0);
    expect(ndvi(0.05, 0.45)).toBeCloseTo(0.8, 12);
    // Slightly negative red after the offset would give 1.105; clamped.
    expect(ndvi(-0.01, 0.2)).toBe(1);
    expect(ndvi(0.2, -0.01)).toBe(-1);
  });

  it('SCL: only vegetation, not vegetated, water and unclassified are clear', () => {
    expect([...SCL_CLEAR]).toEqual([4, 5, 6, 7]);
    const clear = Array.from({ length: 12 }, (_, code) => code).filter(sclIsClear);
    expect(clear).toEqual([4, 5, 6, 7]);
    expect(sclIsClear(null)).toBe(false);
    expect(sclIsClear(undefined)).toBe(false);
    expect(sclIsClear(255)).toBe(false);
  });
});

describe('grid masks', () => {
  // 4 × 3 cells of 10 m; centres at x 105..135, y 1025 (row 0, north), 1015, 1005.
  const grid = { originX: 100, originY: 1030, cellSize: 10, width: 4, height: 3 };

  it('a triangle: row 0 is north and y decreases downwards', () => {
    const mask = cellsInsidePolygon([[[100, 1000], [140, 1000], [100, 1030]]], grid);
    // Hypotenuse x = 140 − (y − 1000) · 4/3: 106.7 at row 0, 120 at row 1, 133.3 at row 2.
    expect(picture(mask, 4)).toEqual(['#...', '##..', '###.']);
  });

  it('a hole is another ring (even-odd), whatever its orientation or closure', () => {
    const outer: Ring = [[100, 1000], [140, 1000], [140, 1030], [100, 1030], [100, 1000]];
    const hole: Ring = [[110, 1010], [120, 1010], [120, 1020], [110, 1020]];
    const expected = ['####', '#.##', '####'];
    expect(picture(cellsInsidePolygon([outer, hole], grid), 4)).toEqual(expected);
    expect(picture(cellsInsidePolygon([outer, [...hole].reverse()], grid), 4)).toEqual(expected);
  });

  it('a polygon reaching past the grid is clipped to it', () => {
    const mask = cellsInsidePolygon([[[50, 990], [120, 990], [120, 1040], [50, 1040]]], grid);
    expect(picture(mask, 4)).toEqual(['##..', '##..', '##..']);
    expect(cellsInsidePolygon([], grid).every((v) => !v)).toBe(true);
  });

  it('matches a plain point-in-polygon test on a concave star with a hole', () => {
    const star: [number, number][] = [];
    for (let k = 0; k < 14; k++) {
      const r = k % 2 === 0 ? 200 : 80;
      const a = 0.1 + (k * Math.PI) / 7;
      star.push([500 + r * Math.cos(a), 500 + r * Math.sin(a)]);
    }
    const hole: [number, number][] = [[480.3, 470.1], [530.7, 482.9], [512.2, 531.4]];
    const rings = [star, hole];
    const g = { originX: 280, originY: 720, cellSize: 10, width: 44, height: 44 };

    const naive = (x: number, y: number) => {
      let inside = false;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
        }
      }
      return inside;
    };
    const expected: boolean[] = [];
    for (let row = 0; row < g.height; row++) {
      for (let col = 0; col < g.width; col++) expected.push(naive(285 + col * 10, 715 - row * 10));
    }
    const mask = cellsInsidePolygon(rings, g);
    expect(mask).toEqual(expected);
    expect(mask.filter(Boolean).length).toBeGreaterThan(200);
  });

  it('rejects a grid that does not add up', () => {
    expect(() => cellsInsidePolygon([], { ...grid, cellSize: 0 })).toThrow(RangeError);
    expect(() => erodeMask([true, true], 3, 1)).toThrow(RangeError);
  });

  it('erodeMask drops cells next to the outside, diagonals and the grid edge included', () => {
    const full = new Array<boolean>(25).fill(true);
    expect(picture(erodeMask(full, 5, 5), 5)).toEqual(['.....', '.###.', '.###.', '.###.', '.....']);
    expect(picture(erodeMask(full, 5, 5, 2), 5)).toEqual(['.....', '.....', '..#..', '.....', '.....']);
    expect(erodeMask(full, 5, 5, 3).some(Boolean)).toBe(false);
    expect(erodeMask(full, 5, 5, 1e9).some(Boolean)).toBe(false);

    // A one-cell gap in the middle (a canal crossing) eats its 8 neighbours too: 25 − 9 = 16 left.
    const withGap = fromPicture(['#######', '#######', '#######', '###.###', '#######', '#######', '#######']);
    const eroded = erodeMask(withGap, 7, 7);
    expect(picture(eroded, 7)).toEqual(['.......', '.#####.', '.#...#.', '.#...#.', '.#...#.', '.#####.', '.......']);
    expect(eroded.filter(Boolean).length).toBe(16);
  });

  it('erodeMask with 0 cells returns a copy', () => {
    const mask = fromPicture(['#.', '##']);
    const copy = erodeMask(mask, 2, 2, 0);
    expect(copy).toEqual(mask);
    expect(copy).not.toBe(mask);
  });
});

describe('field statistics', () => {
  it('ndviStats: mean and type-7 percentiles on a known list', () => {
    // Sorted 0.2 0.4 0.5 0.6 0.8, n = 5, rank h = 4p.
    const stats = ndviStats([0.6, null, 0.2, 0.8, Number.NaN, 0.4, 0.5]);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(5);
    expect(stats!.mean).toBeCloseTo(0.5, 12);
    expect(stats!.p10).toBeCloseTo(0.28, 12); // h 0.4: 0.2 + 0.4 · 0.2
    expect(stats!.p50).toBeCloseTo(0.5, 12); // h 2
    expect(stats!.p90).toBeCloseTo(0.72, 12); // h 3.6: 0.6 + 0.6 · 0.2
  });

  it('ndviStats: one value, typed arrays, nothing', () => {
    expect(ndviStats([0.42])).toEqual({ mean: 0.42, p10: 0.42, p50: 0.42, p90: 0.42, count: 1 });
    expect(ndviStats(new Float32Array([0.5, Number.NaN, 0.5]))?.count).toBe(2);
    expect(ndviStats([])).toBeNull();
    expect(ndviStats([null, null])).toBeNull();
  });

  it('weakZoneThreshold: relative to the median, null for a bare field', () => {
    expect(MIN_VEGETATED_NDVI).toBe(0.3);
    expect(weakZoneThreshold({ p50: 0.6 })).toBeCloseTo(0.45, 12); // 0.6 − 0.15
    expect(weakZoneThreshold({ p50: 0.8 })).toBeCloseTo(0.6, 12); // 0.8 − 0.2
    expect(weakZoneThreshold({ p50: 0.36 })).toBeCloseTo(0.26, 12); // 0.25 · 0.36 = 0.09 < 0.1 floor
    expect(weakZoneThreshold({ p50: 0.3 })).toBeCloseTo(0.2, 12);
    expect(weakZoneThreshold({ p50: 0.29 })).toBeNull();
    expect(weakZoneThreshold(null)).toBeNull();
  });
});

describe('weakZones', () => {
  // threshold 0.4. Zone A links only diagonally: (r0,c1) 0.2, (r1,c2) 0.3, (r2,c3) 0.25; the 0.4 next
  // to it is not below the threshold and the null is never weak. Zone C: (r3,c0) 0.35, (r3,c1) 0.3.
  // Zone B: the single cell (r3,c5) 0.1.
  const values = [
    0.7, 0.2, null, 0.7, 0.7, 0.7,
    0.7, 0.7, 0.3, 0.7, 0.7, 0.7,
    0.7, 0.7, 0.4, 0.25, 0.7, 0.7,
    0.35, 0.3, 0.7, 0.7, 0.7, 0.1,
  ];
  const grid = { width: 6, height: 4, values };

  it('finds 8-connected regions, drops small ones, largest first', () => {
    const zones = weakZones(grid, { threshold: 0.4, minCells: 2 });
    expect(zones).toHaveLength(2);
    const [a, c] = zones;
    expect(a).toMatchObject({ cells: 3, centroidCol: 2, centroidRow: 1, minCol: 1, maxCol: 3, minRow: 0, maxRow: 2 });
    expect(a.meanNdvi).toBeCloseTo(0.25, 12); // (0.2 + 0.3 + 0.25) / 3
    expect(a.deficit).toBeCloseTo(0.15, 12);
    expect(c).toMatchObject({ cells: 2, centroidCol: 0.5, centroidRow: 3, minCol: 0, maxCol: 1, minRow: 3, maxRow: 3 });
    expect(c.meanNdvi).toBeCloseTo(0.325, 12);
    expect(c.deficit).toBeCloseTo(0.075, 12);
  });

  it('keeps the single cell when minCells allows it, and nothing when minCells is too large', () => {
    const zones = weakZones(grid, { threshold: 0.4, minCells: 1 });
    expect(zones.map((z) => z.cells)).toEqual([3, 2, 1]);
    expect(zones[2]).toMatchObject({ centroidCol: 5, centroidRow: 3 });
    expect(zones[2].deficit).toBeCloseTo(0.3, 12);
    expect(weakZones(grid, { threshold: 0.4, minCells: 4 })).toEqual([]);
    expect(weakZones(grid, { threshold: Number.NaN, minCells: 1 })).toEqual([]);
  });

  it('fills a 300 × 300 grid without recursion', () => {
    const big = new Array<number | null>(300 * 300).fill(0.1);
    big[0] = null;
    const zones = weakZones({ width: 300, height: 300, values: big }, { threshold: 0.4, minCells: 10 });
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({ cells: 89_999, minCol: 0, maxCol: 299, minRow: 0, maxRow: 299 });
  });

  it('rejects values that do not fit the grid', () => {
    expect(() => weakZones({ width: 2, height: 2, values: [0.1] }, { threshold: 0.4, minCells: 1 })).toThrow(RangeError);
  });
});

describe('detectEvents', () => {
  // Winter wheat: bare in autumn, green-up in December, harvest in June, bare stubble after.
  const wheat = points([
    ['2026-06-01', 0.3],
    ['2025-10-01', 0.12],
    ['2025-10-11', 0.15],
    ['2025-11-20', 0.25],
    ['2025-12-10', 0.32],
    ['2026-03-01', 0.55],
    ['2026-04-10', 0.8],
    ['2026-05-20', 0.7],
    ['2026-06-11', 0.15],
    ['2026-06-21', 0.14],
    ['2026-07-01', 0.12],
  ]);

  it('finds bare, green_up and harvest in a season, in date order', () => {
    expect(detectEvents(wheat)).toEqual([
      { type: 'bare', date: '2025-10-01' }, // two lows in a row, dated at the first
      { type: 'green_up', date: '2025-12-10' }, // first ≥ 0.3 after the lows (0.25 is not enough)
      { type: 'harvest', date: '2026-06-01' }, // 0.8 → 0.3: ≤ 0.48 and ≤ 0.6, 12 days apart
      { type: 'bare', date: '2026-06-11' }, // re-armed by 0.32 in December; not repeated on 06-21, 07-01
    ]);
  });

  it('harvest: both the 60 % rule and the 0.2 drop must hold', () => {
    // Peak 0.5: limit min(0.3, 0.3). 0.29 qualifies, 0.32 does not.
    expect(detectEvents(points([['2026-05-01', 0.5], ['2026-05-10', 0.29]]))).toEqual([
      { type: 'harvest', date: '2026-05-10' },
    ]);
    expect(detectEvents(points([['2026-05-01', 0.5], ['2026-05-10', 0.32]]))).toEqual([]);
    // Peak 0.45: 60 % is 0.27 but 0.2 lower is 0.25, so 0.26 is not a harvest.
    expect(detectEvents(points([['2026-05-01', 0.45], ['2026-05-10', 0.26]]))).toEqual([]);
    // Peak below 0.45 is never a harvest.
    expect(detectEvents(points([['2026-05-01', 0.44], ['2026-05-10', 0.21]]))).toEqual([]);
  });

  it('harvest: the running peak counts, not just the previous observation', () => {
    const series = points([
      ['2026-04-01', 0.85],
      ['2026-04-10', 0.7],
      ['2026-04-20', 0.55], // 0.55 > 0.51 (60 % of 0.85): still standing
      ['2026-04-30', 0.45], // ≤ 0.51 and ≤ 0.65: harvest
      ['2026-05-10', 0.3], // peak reset: no second harvest
    ]);
    expect(detectEvents(series)).toEqual([{ type: 'harvest', date: '2026-04-30' }]);
  });

  it('harvest: a fall across a gap over 20 days is not dated, and the peak still resets', () => {
    const series = points([
      ['2026-05-01', 0.8],
      ['2026-06-01', 0.3], // 31 days later
      ['2026-06-10', 0.25], // already low: no harvest here either
    ]);
    expect(detectEvents(series).filter((e) => e.type === 'harvest')).toEqual([]);
    // At exactly 20 days it is dated.
    expect(detectEvents(points([['2026-05-01', 0.8], ['2026-05-21', 0.3]]))).toEqual([
      { type: 'harvest', date: '2026-05-21' },
    ]);
  });

  it('a second crop after harvest gets its own green_up', () => {
    const series = points([
      ['2026-04-01', 0.75],
      ['2026-06-05', 0.7],
      ['2026-06-15', 0.18], // harvest (wheat)
      ['2026-06-25', 0.22],
      ['2026-07-15', 0.35], // green_up (second crop)
      ['2026-08-15', 0.7],
    ]);
    expect(detectEvents(series)).toEqual([
      { type: 'harvest', date: '2026-06-15' },
      { type: 'green_up', date: '2026-07-15' },
    ]);
  });

  it('bare is not repeated until NDVI rises above 0.3', () => {
    const series = points([
      ['2026-01-01', 0.15],
      ['2026-01-20', 0.12], // bare 01-01
      ['2026-02-10', 0.3], // 0.3 is not above 0.3: still disarmed
      ['2026-02-20', 0.1],
      ['2026-03-01', 0.1],
      ['2026-03-20', 0.31], // above 0.3: re-armed (and a green_up)
      ['2026-04-01', 0.1],
      ['2026-04-10', 0.1], // bare 04-01
    ]);
    expect(detectEvents(series).filter((e) => e.type === 'bare')).toEqual([
      { type: 'bare', date: '2026-01-01' },
      { type: 'bare', date: '2026-04-01' },
    ]);
  });

  it('points on the same date are averaged, not read as a drop', () => {
    const series = points([
      ['2026-05-01', 0.8],
      ['2026-05-01', 0.2],
    ]);
    expect(detectEvents(series)).toEqual([]);
    expect(detectEvents([])).toEqual([]);
  });
});

describe('checkRecordedWork', () => {
  describe('no_green_up', () => {
    const sowing = '2026-03-01';
    const flat = points([
      ['2026-02-01', 0.4], // previous crop before sowing does not count
      ['2026-02-20', 0.12],
      ['2026-03-05', 0.13],
      ['2026-03-25', 0.14], // day 24
      ['2026-04-10', 0.16],
      ['2026-04-25', 0.18],
      ['2026-05-05', 0.17], // day 65
    ]);
    const recorded = { sowingDate: sowing, harvestDates: [] };

    it('flags a sown field that never greened', () => {
      expect(checkRecordedWork(flat, recorded, '2026-05-15')).toEqual([{ kind: 'no_green_up', date: sowing }]);
      expect(checkRecordedWork(flat, recorded, '2026-04-30')).toEqual([{ kind: 'no_green_up', date: sowing }]); // day 60
    });

    it('waits 60 days, needs 3 observations from day 20, and clears when NDVI reaches 0.3', () => {
      expect(checkRecordedWork(flat, recorded, '2026-04-29')).toEqual([]); // day 59
      const sparse = flat.filter((p) => p.date !== '2026-03-25' && p.date !== '2026-04-25');
      expect(checkRecordedWork(sparse, recorded, '2026-05-15')).toEqual([]);
      const greened = flat.map((p) => (p.date === '2026-05-05' ? { ...p, mean: 0.3 } : p));
      expect(checkRecordedWork(greened, recorded, '2026-05-15')).toEqual([]);
      expect(checkRecordedWork(flat, { sowingDate: null, harvestDates: [] }, '2026-05-15')).toEqual([]);
    });
  });

  // A crop standing at about 0.7 through May.
  const standing: [string, number][] = [
    ['2026-05-01', 0.7],
    ['2026-05-15', 0.75],
    ['2026-05-28', 0.72],
  ];
  // The same crop harvested: event on 06-08 (0.2 ≤ 0.45, 11 days after 05-28).
  const harvested = points([...standing, ['2026-06-08', 0.2], ['2026-06-20', 0.15]]);

  describe('harvest_not_seen', () => {
    it('flags a recorded harvest while the crop still looks standing', () => {
      const series = points([...standing, ['2026-06-08', 0.7], ['2026-06-20', 0.65]]);
      expect(checkRecordedWork(series, { sowingDate: null, harvestDates: ['2026-06-01'] }, '2026-07-01')).toEqual([
        { kind: 'harvest_not_seen', date: '2026-06-01' },
      ]);
    });

    it('not when the satellite saw the harvest', () => {
      expect(checkRecordedWork(harvested, { sowingDate: null, harvestDates: ['2026-06-01'] }, '2026-07-01')).toEqual([]);
    });

    it('not without a high observation in [H + 3, H + 25]', () => {
      // 06-03 is H + 2 and 06-27 is H + 26: both just outside.
      const series = points([...standing, ['2026-06-03', 0.7], ['2026-06-27', 0.7]]);
      expect(checkRecordedWork(series, { sowingDate: null, harvestDates: ['2026-06-01'] }, '2026-07-01')).toEqual([]);
    });
  });

  describe('unrecorded_harvest', () => {
    const none = { sowingDate: null, harvestDates: [] as string[] };

    it('flags a harvest seen from orbit once 10 days have passed', () => {
      expect(checkRecordedWork(harvested, none, '2026-06-18')).toEqual([{ kind: 'unrecorded_harvest', date: '2026-06-08' }]);
      expect(checkRecordedWork(harvested, none, '2026-06-17')).toEqual([]);
    });

    it('accepts a record from D − 20 to D + 10', () => {
      const at = (h: string) => checkRecordedWork(harvested, { sowingDate: null, harvestDates: [h] }, '2026-07-01');
      expect(at('2026-06-18')).toEqual([]); // recorded 10 days late
      expect(at('2026-05-19')).toEqual([]); // 20 days early
      expect(at('2026-06-19')).toEqual([{ kind: 'unrecorded_harvest', date: '2026-06-08' }]);
      // 21 days early: the event is unrecorded, and the record finds the crop still standing on 05-28.
      expect(at('2026-05-18')).toEqual([
        { kind: 'harvest_not_seen', date: '2026-05-18' },
        { kind: 'unrecorded_harvest', date: '2026-06-08' },
      ]);
    });
  });

  it('says nothing about a series of fewer than 3 observations', () => {
    const short = points([['2026-05-28', 0.72], ['2026-06-08', 0.2], ['2026-06-08', 0.2]]);
    expect(checkRecordedWork(short, { sowingDate: '2026-01-01', harvestDates: ['2026-03-01'] }, '2026-12-01')).toEqual([]);
  });
});

describe('pasture', () => {
  it('default model: 0 at NDVI 0.15, 1500 kg DM/ha at 0.45, 3000 at 0.75', () => {
    expect(DEFAULT_PASTURE_MODEL).toEqual({ slope: 5000, intercept: -750 });
    expect(pastureBiomassKgHa(0.45)).toBeCloseTo(1500, 9);
    expect(pastureBiomassKgHa(0.15, DEFAULT_PASTURE_MODEL)).toBeCloseTo(0, 9);
    expect(pastureBiomassKgHa(0.75)).toBeCloseTo(3000, 9);
    expect(pastureBiomassKgHa(0.05)).toBe(0); // never below 0
    expect(pastureBiomassKgHa(null)).toBeNull();
    expect(pastureBiomassKgHa(0.5, { slope: 4000, intercept: 0 })).toBe(2000);
  });

  it('fitBiomassModel recovers a perfect line', () => {
    const fit = fitBiomassModel([0.2, 0.4, 0.6, 0.75].map((x) => ({ ndvi: x, biomassKgHa: 5000 * x - 750 })));
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(5000, 6);
    expect(fit!.intercept).toBeCloseTo(-750, 6);
    expect(fit!.r2).toBeCloseTo(1, 12);
    expect(fit!.n).toBe(4);
  });

  it('fitBiomassModel on a hand-computed imperfect fit', () => {
    // x̄ 0.4, ȳ 1233.33; Sxx 0.08, Sxy 400, Syy 18 240 000 / 9 → slope 5000, intercept −766.67, R² 75/76.
    const fit = fitBiomassModel([
      { ndvi: 0.2, biomassKgHa: 300 },
      { ndvi: 0.4, biomassKgHa: 1100 },
      { ndvi: 0.6, biomassKgHa: 2300 },
    ]);
    expect(fit!.slope).toBeCloseTo(5000, 6);
    expect(fit!.intercept).toBeCloseTo(-766.6667, 3);
    expect(fit!.r2).toBeCloseTo(75 / 76, 12);
    expect(fit!.n).toBe(3);
  });

  it('fitBiomassModel is null without enough or varied samples', () => {
    expect(fitBiomassModel([{ ndvi: 0.2, biomassKgHa: 300 }, { ndvi: 0.4, biomassKgHa: 1100 }])).toBeNull();
    expect(fitBiomassModel([0.1, 0.1, 0.1].map((x, i) => ({ ndvi: x, biomassKgHa: 100 * i })))).toBeNull();
    expect(fitBiomassModel([0.2, 0.4, 0.6].map((x) => ({ ndvi: x, biomassKgHa: 900 })))).toBeNull();
    expect(
      fitBiomassModel([
        { ndvi: 0.2, biomassKgHa: 300 },
        { ndvi: Number.NaN, biomassKgHa: 1100 },
        { ndvi: 0.6, biomassKgHa: 2300 },
      ]),
    ).toBeNull();
  });

  it('grazingDays: 1500 kg/ha × 20 ha × 0.5 / (700 head × 1.8) = 11.9 days', () => {
    expect(grazingDays({ biomassKgHa: 1500, areaHa: 20, head: 700 })).toBeCloseTo(15_000 / 1260, 12);
    expect(grazingDays({ biomassKgHa: 1500, areaHa: 20, head: 700 })).toBeCloseTo(11.9, 1);
    expect(grazingDays({ biomassKgHa: 1500, areaHa: 20, head: 700, utilisation: 1, intakeKgDmPerHeadDay: 2 })).toBeCloseTo(
      30_000 / 1400,
      12,
    );
    expect(grazingDays({ biomassKgHa: 0, areaHa: 20, head: 700 })).toBe(0);
  });

  it('grazingDays is null when it cannot be known', () => {
    expect(grazingDays({ biomassKgHa: null, areaHa: 20, head: 700 })).toBeNull();
    expect(grazingDays({ biomassKgHa: 1500, areaHa: 20, head: 0 })).toBeNull();
    expect(grazingDays({ biomassKgHa: 1500, areaHa: 0, head: 700 })).toBeNull();
    expect(grazingDays({ biomassKgHa: 1500, areaHa: 20, head: 700, utilisation: 0 })).toBeNull();
    expect(grazingDays({ biomassKgHa: 1500, areaHa: 20, head: 700, utilisation: 1.2 })).toBeNull();
    expect(grazingDays({ biomassKgHa: 1500, areaHa: 20, head: 700, intakeKgDmPerHeadDay: 0 })).toBeNull();
  });
});
