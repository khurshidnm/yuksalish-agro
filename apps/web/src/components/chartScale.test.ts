import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { decimalsOf, formatAxisValue, formatEndValue, plottedValues, valueAxis } from './chartScale';

// Group separators, and the space before mln or so'm, are no-break spaces.
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
const labels = (values: number[], bounds: Parameters<typeof valueAxis>[1]) => {
  const axis = valueAxis(values, bounds);
  if (!axis) throw new Error('no axis');
  return axis.ticks.map((tick) => plain(formatAxisValue(tick, axis.step)));
};

describe('chart value axis', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('uz');
  });
  afterAll(async () => {
    await i18n.changeLanguage('uz');
  });

  it('counts the decimals a step needs', () => {
    expect(decimalsOf(500)).toBe(0);
    expect(decimalsOf(2.5)).toBe(1);
    expect(decimalsOf(0.25)).toBe(2);
    expect(decimalsOf(0.05)).toBe(2);
    expect(decimalsOf(0.025)).toBe(3);
  });

  it('labels a narrow pH range without repeating a label (was 7,9 · 7,9 · 7,8 · 7,8)', () => {
    const axis = valueAxis([7.7, 7.78, 7.9, 7.85], ['auto', 'auto']);
    expect(axis).toEqual({ ticks: [7.7, 7.75, 7.8, 7.85, 7.9], step: 0.05, domain: [7.7, 7.9] });
    expect(labels([7.7, 7.78, 7.9, 7.85], ['auto', 'auto'])).toEqual(['7,70', '7,75', '7,80', '7,85', '7,90']);
  });

  it('labels humus 1.05 to 1.18 with two decimals', () => {
    expect(labels([1.05, 1.12, 1.18], ['auto', 'auto'])).toEqual(['1,05', '1,10', '1,15', '1,20']);
  });

  it('keeps a fixed NDVI scale of 0 to 1 and never rounds 0.25 to 0,3', () => {
    const axis = valueAxis([0.21, 0.55, 0.78], [0, 1]);
    expect(axis).toEqual({ ticks: [0, 0.2, 0.4, 0.6, 0.8, 1], step: 0.2, domain: [0, 1] });
    expect(labels([0.21, 0.55, 0.78], [0, 1])).toEqual(['0,0', '0,2', '0,4', '0,6', '0,8', '1,0']);
  });

  it('gives way to data beyond a fixed end, as Recharts draws it', () => {
    const axis = valueAxis([-0.1, 0.5, 0.9], [0, 1]);
    expect(axis?.ticks).toEqual([-0.25, 0, 0.25, 0.5, 0.75, 1]);
    expect(axis?.domain).toEqual([-0.25, 1]);
  });

  it('rounds the feed scale to 500s instead of 550s, from zero', () => {
    const axis = valueAxis([0, 812, 2134], [0, 0]);
    expect(axis).toEqual({ ticks: [0, 500, 1000, 1500, 2000, 2500], step: 500, domain: [0, 2500] });
    expect(labels([0, 812, 2134], [0, 0])).toEqual(['0', '500', '1 ming', '1,5 ming', '2 ming', '2,5 ming']);
  });

  it('never splits a whole count: lambs per week step by one', () => {
    expect(valueAxis([0, 1, 2], [0, 0])?.ticks).toEqual([0, 1, 2]);
    expect(valueAxis([3, 5, 9], [0, 0])?.ticks).toEqual([0, 2, 4, 6, 8, 10]);
    // Fractional data may use halves.
    expect(valueAxis([0.4, 1.9], [0, 0])?.ticks).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it('keeps zero on the axis for money that goes both ways, and for losses only', () => {
    expect(valueAxis([-300e6, 120e6, 500e6], [0, 0])?.ticks).toEqual([-400e6, -200e6, 0, 200e6, 400e6, 600e6]);
    expect(valueAxis([-50, -10], [0, 0])?.ticks).toEqual([-50, -40, -30, -20, -10, 0]);
    expect(labels([-300e6, 500e6], [0, 0])).toEqual(['-400 mln', '-200 mln', '0', '200 mln', '400 mln', '600 mln']);
  });

  it('shortens large values with the decimals their step needs', () => {
    expect(labels([0, 2.1e9], [0, 0])).toEqual(['0', '500 mln', '1 mlrd', '1,5 mlrd', '2 mlrd', '2,5 mlrd']);
    expect(labels([0, 1240], [0, 0])).toEqual(['0', '250', '500', '750', '1 ming', '1,25 ming']);
  });

  it('labels the end of a line as a reading, never coarser than before or than the axis', () => {
    // A 1 mlrd step would round the balance to "3 mlrd".
    expect(plain(formatEndValue(2_829_782_169, 1e9))).toBe('2,8 mlrd');
    expect(plain(formatEndValue(712, 200))).toBe('712');
    expect(plain(formatEndValue(7.823, 0.05))).toBe('7,82');
    expect(plain(formatEndValue(1_250_000, 250_000))).toBe('1,25 mln');
    expect(plain(formatEndValue(2_829_782_169, null))).toBe('2,8 mlrd');
  });

  it('gives a chart its own fixed-decimal formatter only steps it writes exactly', () => {
    // formatCompact keeps one decimal: a 1.25 mlrd tick would read "1,3 mlrd".
    expect(valueAxis([0, 1.2e9], [0, 0])?.ticks).toEqual([0, 0.25e9, 0.5e9, 0.75e9, 1e9, 1.25e9]);
    expect(valueAxis([0, 1.2e9], [0, 0], false)?.ticks).toEqual([0, 0.5e9, 1e9, 1.5e9]);
    // formatNumber(v, 0) on a weight trend: no 2.5 kg ticks printed as 3.
    expect(valueAxis([0, 12.3], [0, 0], false)?.ticks).toEqual([0, 5, 10, 15]);
    // formatNumber(v, 1) on a temperature: 0.5 rather than 0.25.
    expect(valueAxis([38.5, 39.6], ['auto', 'auto'], false)?.ticks).toEqual([38.5, 39, 39.5, 40]);
  });

  it('scales a stack by its running totals', () => {
    const rows = [
      { a: 3, b: 4 },
      { a: 5, b: null },
      { a: '2', b: '' },
    ];
    expect(plottedValues(rows, ['a', 'b'], true)).toEqual([0, 3, 7, 0, 5, 0, 2]);
    expect(plottedValues(rows, ['a', 'b'], false)).toEqual([3, 4, 5, 2]);
  });

  it('leaves nothing and one repeated value to Recharts', () => {
    expect(valueAxis([], [0, 0])).toBeNull();
    expect(valueAxis([7.8, 7.8], ['auto', 'auto'])).toBeNull();
    expect(valueAxis([0, 0], [0, 0])).toBeNull();
    expect(valueAxis([0.1, 0.1 + 1e-15], ['auto', 'auto'])).toBeNull();
    // With zero on the axis, one value still gets a scale.
    expect(valueAxis([5, 5], [0, 0])?.ticks).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plain(formatAxisValue(2_100_000, null))).toBe('2,1 mln');
  });

  it('covers the data with two to six distinct labels, whatever the range', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 2000; i++) {
      const magnitude = 10 ** Math.floor(random() * 14 - 4);
      const low = (random() - 0.5) * magnitude * 20;
      const high = low + random() * magnitude + magnitude * 1e-6;
      const bounds = i % 3 === 0 ? ([0, 0] as const) : (['auto', 'auto'] as const);
      const axis = valueAxis([low, high], [...bounds]);
      if (!axis) throw new Error(`no axis for ${low}..${high}`);
      expect(axis.ticks.length).toBeGreaterThanOrEqual(2);
      expect(axis.ticks.length).toBeLessThanOrEqual(6);
      expect(axis.domain[0]).toBeLessThanOrEqual(Math.min(low, bounds[0] === 0 ? 0 : low));
      expect(axis.domain[1]).toBeGreaterThanOrEqual(Math.max(high, bounds[1] === 0 ? 0 : high));
      const text = axis.ticks.map((tick) => formatAxisValue(tick, axis.step));
      expect(new Set(text).size, `${low}..${high}: ${text.join(' | ')}`).toBe(text.length);
    }
  });
});
