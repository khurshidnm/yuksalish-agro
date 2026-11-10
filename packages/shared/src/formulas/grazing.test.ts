import { describe, expect, it } from 'vitest';
import { animalDaysPerHa, cellBounds, cellOf, grazingDay, heatmap } from './grazing';
import type { AreaGeometry, Fix } from './tracking';

const LAT = 39.5;
const LNG = 64.8;
const MIN = 60_000;
const DAY_START = Date.UTC(2026, 5, 1, 19, 0); // midnight in Tashkent
const DAY_END = DAY_START + 24 * 60 * MIN;

describe('grid', () => {
  it('a cell is 0.0005° on a side, counted from the equator and the prime meridian', () => {
    // 64.8 / 0.0005 = 129 600 and 39.5 / 0.0005 = 79 000
    expect(cellOf({ lat: LAT, lng: LNG })).toEqual({ x: 129_600, y: 79_000 });
    expect(cellOf({ lat: 39.50049, lng: 64.80049 })).toEqual({ x: 129_600, y: 79_000 });
    expect(cellOf({ lat: 39.5005, lng: 64.8005 })).toEqual({ x: 129_601, y: 79_001 });
    expect(cellOf({ lat: -0.0001, lng: -0.0001 })).toEqual({ x: -1, y: -1 });
  });

  it('cellBounds gives the cell back as a rectangle', () => {
    expect(cellBounds({ x: 129_600, y: 79_000 })).toEqual({ south: 39.5, west: 64.8, north: 39.5005, east: 64.8005 });
  });
});

describe('grazingDay', () => {
  const field: AreaGeometry = {
    type: 'Polygon',
    coordinates: [[[LNG, LAT], [LNG + 0.002, LAT], [LNG + 0.002, LAT + 0.002], [LNG, LAT + 0.002], [LNG, LAT]]],
  };
  const inField = (minute: number): Fix => ({ lat: LAT + 0.001, lng: LNG + 0.001, at: DAY_START + minute * MIN });
  const away = (minute: number): Fix => ({ lat: LAT + 0.01, lng: LNG + 0.01, at: DAY_START + minute * MIN });

  const day = grazingDay(
    [
      // Four fixes in the field a quarter of an hour apart, then gone: 4 × 15 min = 1 h, an animal-day.
      { animalId: 'a', herdId: 'h', fixes: [inField(480), inField(495), inField(510), inField(525), away(540)] },
      // Two fixes in the field: 30 min, short of the hour.
      { animalId: 'b', herdId: 'h', fixes: [inField(495), inField(480), away(510)] },
      // No herd. A fix three hours before the next stands for 30 min at most; the last one, 10 minutes
      // before midnight, for those 10 minutes: 40 min = 0.667 h.
      { animalId: 'c', herdId: null, fixes: [inField(600), inField(1430)] },
    ],
    [{ id: 'f', geometry: field }, { id: 'no-outline', geometry: null }],
    DAY_END,
  );

  it('counts every fix into its cell, per herd', () => {
    expect(day.fixes).toBe(10);
    expect(day.cells).toEqual(
      expect.arrayContaining([
        { herdId: 'h', x: 129_602, y: 79_002, fixes: 6 },
        { herdId: 'h', x: 129_620, y: 79_020, fixes: 2 },
        { herdId: null, x: 129_602, y: 79_002, fixes: 2 },
      ]),
    );
    expect(day.cells).toHaveLength(3);
    expect(day.cells.reduce((sum, c) => sum + c.fixes, 0)).toBe(day.fixes);
  });

  it('gives each field its hours and animal-days', () => {
    expect(day.fields).toHaveLength(2);
    const herd = day.fields.find((f) => f.herdId === 'h')!;
    expect(herd).toMatchObject({ fieldId: 'f', fixes: 6, animals: 1 });
    expect(herd.animalHours).toBeCloseTo(1.5, 6);
    const loose = day.fields.find((f) => f.herdId === null)!;
    expect(loose).toMatchObject({ fieldId: 'f', fixes: 2, animals: 0 });
    expect(loose.animalHours).toBeCloseTo(40 / 60, 6);
  });

  it('a day without fixes is empty', () => {
    expect(grazingDay([], [{ id: 'f', geometry: field }], DAY_END)).toEqual({ fixes: 0, cells: [], fields: [] });
  });
});

describe('heatmap', () => {
  const cells = [1, 1, 2, 6, 10].map((fixes, x) => ({ x: 129_600 + x, y: 79_000, fixes }));

  it('gives each cell its share of 20 fixes and a shade by rank, most used first', () => {
    const map = heatmap(cells)!;
    expect(map.totalFixes).toBe(20);
    expect(map.cells.map((c) => c.fixes)).toEqual([10, 6, 2, 1, 1]);
    expect(map.cells.map((c) => c.share)).toEqual([0.5, 0.3, 0.1, 0.05, 0.05]);
    // Of five cells, 5, 4, 3, 2 and 2 are used no more than each: on five shades that is the shade
    // itself. The two equal cells share one, and the most used cell is always the darkest.
    expect(map.cells.map((c) => c.level)).toEqual([5, 4, 3, 2, 2]);
    expect(heatmap([{ x: 1, y: 1, fixes: 3 }])!.cells[0]!.level).toBe(5);
    // Two cells: ceil(1 x 5 / 2) = 3 and 5.
    expect(heatmap(cells.slice(3))!.cells.map((c) => c.level)).toEqual([5, 3]);
    expect(map.cells[0]).toMatchObject({ south: 39.5, west: 64.802, north: 39.5005, east: 64.8025 });
  });

  it('keeps the true total when the list was cut to the most used cells', () => {
    expect(heatmap(cells, 40)!.cells[0]!.share).toBe(0.25);
  });

  it('is null without fixes, never a map of zeros', () => {
    expect(heatmap([])).toBeNull();
    expect(heatmap([{ x: 1, y: 1, fixes: 0 }])).toBeNull();
  });
});

describe('animalDaysPerHa', () => {
  it('700 animal-days on 35 ha is 20 per hectare; no area, no answer', () => {
    expect(animalDaysPerHa(700, 35)).toBe(20);
    expect(animalDaysPerHa(700, 0)).toBeNull();
    expect(animalDaysPerHa(700, null)).toBeNull();
  });
});
