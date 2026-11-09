import { formatCompact, intlLocale } from '@/lib/format';

/**
 * The value axis of a ChartCard, worked out here rather than by Recharts, so each label can carry
 * exactly the decimals its step needs. Recharts' own steps (550, 0.75) and a fixed one decimal gave
 * repeated labels on small ranges: pH 7,9 · 7,9 · 7,8 · 7,8.
 */

export type AxisBound = number | 'auto';

export interface ValueAxis {
  ticks: number[];
  domain: [number, number];
  /** The distance between two ticks: it decides how many decimals a label needs. */
  step: number;
}

/** At most six labels, which still sit apart on the shortest chart in the app (180 px). */
const MAX_GAPS = 5;
/** Steps people read at a glance: 1, 2, 2.5 and 5 times a power of ten. */
const MANTISSAS = [1, 2, 2.5, 5];
/** 2.5 needs a decimal more than the others (0.25, 1,25 mlrd), so labels of fixed precision go without it. */
const MANTISSAS_WITHOUT_QUARTERS = [1, 2, 5];
const EPSILON = 1e-9;
/** The sizes formatCompact shortens to: trillion, billion, million, thousand. */
const COMPACT_SIZES = [1e12, 1e9, 1e6, 1e3];

/** How many decimals write `value` exactly, up to 10: 0.25 → 2, 2.5 → 1, 500 → 0. */
export function decimalsOf(value: number): number {
  for (let digits = 0; digits < 10; digits++) {
    const scaled = Math.abs(value) * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < EPSILON * Math.max(1, scaled)) return digits;
  }
  return 10;
}

/** Rounds away floating-point noise (0.30000000000000004) and turns -0, which prints as "-0", into 0. */
function clean(value: number, digits: number): number {
  return Number(value.toFixed(digits)) + 0;
}

/**
 * The numbers a chart draws, read the way the table view reads them: null and blanks are left out.
 * A stack is drawn as running totals from zero, so its axis has to reach those, not the single values.
 */
export function plottedValues(rows: Record<string, unknown>[], keys: string[], stacked: boolean): number[] {
  const values: number[] = [];
  for (const row of rows) {
    let total = 0;
    if (stacked) values.push(0);
    for (const key of keys) {
      const raw = row[key];
      if (raw === null || raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      total += value;
      values.push(stacked ? total : value);
    }
  }
  return values;
}

/**
 * Round ticks for the value axis and the range they span. `bounds` is the chart's domain: a number
 * keeps that end where it is unless the data goes past it, 'auto' rounds the data out to the next tick.
 * [0, 0] keeps zero on the axis whichever side the data lies. Whole-number data gets whole-number
 * steps: no half a lamb. `quarters` allows steps of 2.5; leave it off when the labels come from a
 * chart's own formatter with fixed decimals, or 1,25 mlrd prints as "1,3 mlrd".
 * Null when there is nothing to scale (no values, or one value repeated).
 */
export function valueAxis(values: number[], bounds: [AxisBound, AxisBound], quarters = true): ValueAxis | null {
  if (values.length === 0) return null;
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const value of values) {
    if (value < dataMin) dataMin = value;
    if (value > dataMax) dataMax = value;
  }
  const [lowBound, highBound] = bounds;
  const fixedLow = lowBound !== 'auto' && lowBound <= dataMin;
  const fixedHigh = highBound !== 'auto' && highBound >= dataMax;
  const low = fixedLow ? lowBound : dataMin;
  const high = fixedHigh ? highBound : dataMax;
  // One value, or one value with rounding noise on it: Recharts centres it better than a scale could.
  if (!Number.isFinite(high - low) || high - low <= EPSILON * Math.max(Math.abs(low), Math.abs(high))) return null;
  const whole = values.every(Number.isInteger);

  const rough = (high - low) / MAX_GAPS;
  const firstExponent = Math.floor(Math.log10(rough));
  for (let exponent = firstExponent; exponent < firstExponent + 12; exponent++) {
    for (const mantissa of quarters ? MANTISSAS : MANTISSAS_WITHOUT_QUARTERS) {
      const step = Number((mantissa * 10 ** exponent).toPrecision(12));
      if (step < rough * (1 - EPSILON) || (whole && !Number.isInteger(step))) continue;
      const first = fixedLow ? Math.ceil(low / step - EPSILON) : Math.floor(low / step + EPSILON);
      const last = fixedHigh ? Math.floor(high / step + EPSILON) : Math.ceil(high / step - EPSILON);
      // Rounding out added a gap too many: try the next step.
      if (last - first > MAX_GAPS) continue;
      // Fixed ends too close for two ticks; a bigger step only has fewer.
      if (last - first < 1) return null;
      const digits = decimalsOf(step);
      if (digits >= 10) return null;
      const ticks = Array.from({ length: last - first + 1 }, (_, i) => clean((first + i) * step, digits));
      return { ticks, step, domain: [fixedLow ? low : ticks[0], fixedHigh ? high : ticks[ticks.length - 1]] };
    }
  }
  return null;
}

/**
 * A value-axis label with the decimals its step needs, so two labels never read the same:
 * 7,70 · 7,75 · 7,80. From a thousand up it shortens as formatCompact does: 1,25 mln. Without a
 * step (Recharts placed the ticks) it falls back to formatCompact.
 */
export function formatAxisValue(value: number, step: number | null): string {
  if (step === null) return formatCompact(value);
  const size = COMPACT_SIZES.find((s) => Math.abs(value) >= s);
  if (size) return formatCompact(value, decimalsOf(step / size));
  const digits = decimalsOf(step);
  return new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/**
 * The label at the end of a line is a reading, not a tick: up to one decimal as in formatCompact,
 * more when the axis has more. 2 829 782 169 on a 1 mlrd axis is "2,8 mlrd", never "3 mlrd".
 */
export function formatEndValue(value: number, step: number | null): string {
  const size = COMPACT_SIZES.find((s) => Math.abs(value) >= s) ?? 1;
  return formatCompact(value, step === null ? 1 : Math.max(1, decimalsOf(step / size)));
}
