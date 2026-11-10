/**
 * Satellite vegetation formulas: Sentinel-2 L2A reflectance, NDVI, field masks, weak zones,
 * crop events seen from orbit, checks of recorded field work, and pasture biomass.
 *
 * The API reads the bands of each scene over each field and builds the grids; everything here is
 * pure arithmetic on what it hands over, so a figure on a field card can be checked by hand.
 * Same convention as index.ts: missing data is null, never 0, and a zero denominator gives null.
 *
 * Grids are row-major: cell (col, row) sits at index `row * width + col`. Row 0 is the north edge
 * and y decreases downwards, as in a GeoTIFF in projected metres.
 */
import { diffDays } from '../dates';

// ─── Reflectance and NDVI ───────────────────────────────────────────────────

/**
 * Sentinel-2 L2A digital number to bottom-of-atmosphere reflectance: `dn · scale + offset`.
 *
 * Processing baseline 04.00 and later (scenes from 25 January 2022) store reflectance as
 * (DN + BOA_ADD_OFFSET) / QUANTIFICATION_VALUE = DN · 0.0001 − 0.1, hence the defaults; pass
 * `offset = 0` for an older scene. DN 0 is nodata and DN 65535 is saturated (the two special values
 * in the product metadata), so both give null, as does anything that is not a positive number.
 * Very dark targets can come out slightly negative; that is kept, and `ndvi` copes with it.
 */
export function reflectance(dn: number, scale = 0.0001, offset = -0.1): number | null {
  if (!Number.isFinite(dn) || dn <= 0 || dn >= 65535) return null;
  return dn * scale + offset;
}

/**
 * Normalised difference vegetation index, (nir − red) / (nir + red), clamped to [−1, 1].
 * Null when either band is missing or the sum is not positive (no usable signal).
 */
export function ndvi(red: number | null, nir: number | null): number | null {
  if (red == null || nir == null || !Number.isFinite(red) || !Number.isFinite(nir)) return null;
  const sum = nir + red;
  if (sum <= 0) return null;
  return Math.min(1, Math.max(-1, (nir - red) / sum));
}

/**
 * NDMI, the moisture index: (B8A − B11) / (B8A + B11), narrow near infrared against short-wave
 * infrared, both 20 m bands of Sentinel-2. Water in the leaves absorbs the short-wave band, so a
 * canopy drying out falls on this index before it loses its green.
 * Source: Gao B.-C., 1996, «NDWI — a normalized difference water index for remote sensing of
 * vegetation liquid water from space», Remote Sensing of Environment 58: 257-266.
 * The same rules as `ndvi`: null on a missing band or an empty sum, never 0.
 */
export function ndmi(nir8a: number | null, swir: number | null): number | null {
  if (nir8a == null || swir == null || !Number.isFinite(nir8a) || !Number.isFinite(swir)) return null;
  const sum = nir8a + swir;
  if (sum <= 0) return null;
  return Math.min(1, Math.max(-1, (nir8a - swir) / sum));
}

/**
 * Scene classification (SCL) codes whose pixels are usable: 4 vegetation, 5 not vegetated,
 * 6 water, 7 unclassified. Every other code is not clear: 0 nodata, 1 saturated or defective,
 * 2 dark area (topographic or cast shadow), 3 cloud shadow, 8 and 9 cloud, 10 thin cirrus, 11 snow or ice.
 */
export const SCL_CLEAR = [4, 5, 6, 7] as const;

/** Whether an SCL pixel can be used for NDVI. A missing code is not clear. */
export function sclIsClear(code: number | null | undefined): boolean {
  return code != null && (SCL_CLEAR as readonly number[]).includes(code);
}

// ─── Grid masks ─────────────────────────────────────────────────────────────

/** A raster grid in projected metres. `originX`, `originY` is the top-left corner of cell (0, 0). */
export interface GridSpec {
  originX: number;
  originY: number;
  /** Side of a square cell, in the same units as the coordinates. */
  cellSize: number;
  width: number;
  height: number;
}

/** One flag per cell, row-major (`row * width + col`). */
export type GridMask = boolean[];

/** A polygon ring as `[x, y]` positions, closed (last = first, as in GeoJSON) or not. */
export type Ring = ReadonlyArray<readonly number[]>;

function assertGrid(length: number, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`Invalid grid size: ${width} × ${height}`);
  }
  if (length !== width * height) {
    throw new RangeError(`Grid of ${width} × ${height} needs ${width * height} cells, got ${length}`);
  }
}

/**
 * Cells whose centre lies inside the polygon, by the even-odd rule over all `rings`, so a hole is
 * simply another ring and ring orientation does not matter. Several non-overlapping polygons can be
 * passed as one list of rings. Coordinates must be in the grid's projected system.
 *
 * Scanline per row: O(height · edges + cells), which stays cheap for a few hundred cells a side.
 */
export function cellsInsidePolygon(rings: ReadonlyArray<Ring>, grid: GridSpec): GridMask {
  const { originX, originY, cellSize, width, height } = grid;
  assertGrid(width * height, width, height);
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) throw new RangeError(`Invalid cell size: ${cellSize}`);

  const mask: GridMask = new Array<boolean>(width * height).fill(false);
  const crossings: number[] = [];
  for (let row = 0; row < height; row++) {
    const y = originY - (row + 0.5) * cellSize;
    crossings.length = 0;
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % n];
        // Half-open rule: an edge counts when exactly one end is above the line, so a vertex on the
        // line is counted once and a horizontal edge never.
        if (y1 > y !== y2 > y) crossings.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    crossings.sort((a, b) => a - b);
    // Even-odd: a centre x is inside when crossings[2k] <= x < crossings[2k + 1].
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil((crossings[k] - originX) / cellSize - 0.5));
      const to = Math.min(width, Math.ceil((crossings[k + 1] - originX) / cellSize - 0.5));
      for (let col = from; col < to; col++) mask[row * width + col] = true;
    }
  }
  return mask;
}

/**
 * Drops every cell within `cells` cells of the outside, counting diagonals (8-neighbourhood), so
 * mixed pixels along roads, canals and field edges are left out. Cells beyond the grid count as
 * outside. `cells = 0` returns a copy.
 */
export function erodeMask(mask: readonly boolean[], width: number, height: number, cells = 1): GridMask {
  assertGrid(mask.length, width, height);
  // Past max(width, height) passes nothing is left, so a huge `cells` cannot spin.
  const passes = Math.min(Math.max(0, Math.floor(cells)), Math.max(width, height));
  let current: GridMask = mask.slice();
  for (let pass = 0; pass < passes; pass++) {
    // A 3 × 3 erosion is a 3-wide pass along rows followed by one along columns.
    const across: GridMask = new Array<boolean>(current.length);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const i = row * width + col;
        across[i] = current[i] && col > 0 && current[i - 1] && col < width - 1 && current[i + 1];
      }
    }
    const next: GridMask = new Array<boolean>(current.length);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const i = row * width + col;
        next[i] = across[i] && row > 0 && across[i - width] && row < height - 1 && across[i + width];
      }
    }
    current = next;
  }
  return current;
}

// ─── Field statistics and weak zones ────────────────────────────────────────

/** NDVI distribution over the clear cells of a field. */
export interface NdviStats {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  /** Cells that had a value. */
  count: number;
}

/**
 * Percentile of an ascending list by linear interpolation between order statistics: rank
 * h = (n − 1) · p, value = x[⌊h⌋] + (h − ⌊h⌋) · (x[⌊h⌋ + 1] − x[⌊h⌋]). This is Hyndman–Fan type 7,
 * the default of NumPy, R and Excel PERCENTILE.INC.
 */
function percentileSorted(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Mean and the 10th, 50th and 90th percentiles of the values that are present (null and NaN are
 * skipped). Percentiles interpolate linearly between order statistics (type 7, as NumPy's default).
 * Null when no value is present.
 */
export function ndviStats(values: Iterable<number | null>): NdviStats | null {
  const sorted: number[] = [];
  for (const value of values) if (value != null && Number.isFinite(value)) sorted.push(value);
  if (sorted.length === 0) return null;
  sorted.sort((a, b) => a - b);
  let sum = 0;
  for (const value of sorted) sum += value;
  return {
    mean: sum / sorted.length,
    p10: percentileSorted(sorted, 0.1),
    p50: percentileSorted(sorted, 0.5),
    p90: percentileSorted(sorted, 0.9),
    count: sorted.length,
  };
}

/** Median NDVI below which a field counts as bare or sparse, with no meaningful weak zones. */
export const MIN_VEGETATED_NDVI = 0.3;

/**
 * NDVI under which a cell is weak, relative to the field's own median: p50 − max(0.1, 0.25 · p50).
 * The 0.1 floor keeps a uniform field from flagging ordinary noise. Null when there are no stats or
 * the median is below MIN_VEGETATED_NDVI.
 */
export function weakZoneThreshold(stats: Pick<NdviStats, 'p50'> | null): number | null {
  if (stats == null || !Number.isFinite(stats.p50) || stats.p50 < MIN_VEGETATED_NDVI) return null;
  return stats.p50 - Math.max(0.1, 0.25 * stats.p50);
}

/** A connected patch of cells below the weak-zone threshold. Positions are in cell units. */
export interface WeakZone {
  cells: number;
  meanNdvi: number;
  /** threshold − meanNdvi, always positive. The field median is not known here. */
  deficit: number;
  /**
   * Mean column and row of the zone's cells; the centre of cell (c, r) is at
   * x = originX + (c + 0.5) · cellSize, y = originY − (r + 0.5) · cellSize.
   * For a curved zone the centroid can fall outside the zone itself.
   */
  centroidCol: number;
  centroidRow: number;
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

/**
 * Patches of 8-connected cells with a value below `threshold`. A null (or NaN) cell is never part of
 * a zone. Patches smaller than `minCells` are dropped. Sorted largest first; equal sizes put the
 * larger deficit first, then keep north-west-first scan order.
 *
 * Iterative flood fill with an explicit stack, so a 300 × 300 grid cannot overflow the call stack.
 */
export function weakZones(
  grid: { width: number; height: number; values: ArrayLike<number | null> },
  opts: { threshold: number; minCells: number },
): WeakZone[] {
  const { width, height, values } = grid;
  const { threshold, minCells } = opts;
  assertGrid(values.length, width, height);
  if (!Number.isFinite(threshold)) return [];

  const total = width * height;
  const weak = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const value = values[i];
    if (value != null && Number.isFinite(value) && value < threshold) weak[i] = 1;
  }

  const seen = new Uint8Array(total);
  // Each cell is pushed at most once (it is marked when pushed), so `total` slots suffice.
  const stack = new Int32Array(total);
  const zones: WeakZone[] = [];
  for (let start = 0; start < total; start++) {
    if (!weak[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let cells = 0;
    let sum = 0;
    let sumCol = 0;
    let sumRow = 0;
    let minCol = width;
    let maxCol = -1;
    let minRow = height;
    let maxRow = -1;
    while (top > 0) {
      const i = stack[--top];
      const row = Math.floor(i / width);
      const col = i - row * width;
      cells++;
      sum += values[i] as number;
      sumCol += col;
      sumRow += row;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      for (let r = Math.max(0, row - 1); r <= Math.min(height - 1, row + 1); r++) {
        for (let c = Math.max(0, col - 1); c <= Math.min(width - 1, col + 1); c++) {
          const j = r * width + c;
          if (weak[j] && !seen[j]) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }
    if (cells < minCells) continue;
    const meanNdvi = sum / cells;
    zones.push({
      cells,
      meanNdvi,
      deficit: threshold - meanNdvi,
      centroidCol: sumCol / cells,
      centroidRow: sumRow / cells,
      minCol,
      maxCol,
      minRow,
      maxRow,
    });
  }
  return zones.sort((a, b) => b.cells - a.cells || b.deficit - a.deficit);
}

// ─── Events in the NDVI time series ─────────────────────────────────────────

/** Field mean NDVI on the date of one clear observation. */
export interface NdviPoint {
  date: string;
  mean: number;
}

export type SatelliteEventType = 'green_up' | 'harvest' | 'bare';

/** Something the time series shows happened on a field. */
export interface SatelliteEvent {
  type: SatelliteEventType;
  date: string;
}

/** Every number the event rules use, in one place. */
export const NDVI_EVENT_RULES = {
  /** green_up is armed by an observation below this. */
  greenUpArmBelow: 0.2,
  /** ...and fires on the first later observation at or above this. */
  greenUpAtLeast: 0.3,
  /** harvest needs a running peak at least this high... */
  harvestMinPeak: 0.45,
  /** ...a fall to at most this share of the peak... */
  harvestMaxShareOfPeak: 0.6,
  /** ...that is also at least this much below it... */
  harvestMinDrop: 0.2,
  /** ...between consecutive observations at most this many days apart. */
  harvestMaxGapDays: 20,
  /** bare is two consecutive observations below this... */
  bareBelow: 0.2,
  /** ...and is not repeated until NDVI has risen above this. */
  bareRearmAbove: 0.3,
} as const;

/**
 * Clean series: points with a finite mean, one per date (points sharing a date, such as two
 * overlapping tiles, are averaged), oldest first.
 */
function cleanSeries(series: readonly NdviPoint[]): NdviPoint[] {
  const byDate = new Map<string, { sum: number; n: number }>();
  for (const point of series) {
    if (!Number.isFinite(point.mean)) continue;
    const entry = byDate.get(point.date);
    if (entry) {
      entry.sum += point.mean;
      entry.n++;
    } else {
      byDate.set(point.date, { sum: point.mean, n: 1 });
    }
  }
  return [...byDate]
    .map(([date, { sum, n }]) => ({ date, mean: sum / n }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function byDate<T extends { date: string }>(a: T, b: T): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

/**
 * Green-up, harvest and bare-soil events in a series of clear observations (any order; points on the
 * same date are averaged). Numbers in NDVI_EVENT_RULES:
 * - green_up: the first observation ≥ 0.3 after an observation < 0.2. Re-armed by the next one < 0.2,
 *   so a second crop after harvest gets its own green-up.
 * - harvest: a fall from the running peak (≥ 0.45) to ≤ 60 % of it and at least 0.2 below it, between
 *   two consecutive observations ≤ 20 days apart; dated at the low observation. The peak then resets.
 *   A fall across a longer gap cannot be dated, so it gives no event, but the peak still resets: the
 *   crop cycle is over and the next crop is judged against its own peak.
 * - bare: two consecutive observations < 0.2, dated at the first; not repeated until NDVI rises above 0.3.
 * Events come out oldest first.
 */
export function detectEvents(series: readonly NdviPoint[]): SatelliteEvent[] {
  const rules = NDVI_EVENT_RULES;
  const points = cleanSeries(series);
  const events: SatelliteEvent[] = [];
  let greenUpArmed = false;
  let bareArmed = true;
  let peak = -Infinity;

  for (let i = 0; i < points.length; i++) {
    const { date, mean } = points[i];
    const prev = i > 0 ? points[i - 1] : null;

    if (mean < rules.greenUpArmBelow) greenUpArmed = true;
    else if (greenUpArmed && mean >= rules.greenUpAtLeast) {
      events.push({ type: 'green_up', date });
      greenUpArmed = false;
    }

    if (
      peak >= rules.harvestMinPeak &&
      mean <= peak * rules.harvestMaxShareOfPeak &&
      mean <= peak - rules.harvestMinDrop
    ) {
      if (prev && diffDays(prev.date, date) <= rules.harvestMaxGapDays) events.push({ type: 'harvest', date });
      peak = -Infinity;
    }
    peak = Math.max(peak, mean);

    if (mean > rules.bareRearmAbove) bareArmed = true;
    else if (bareArmed && prev && prev.mean < rules.bareBelow && mean < rules.bareBelow) {
      events.push({ type: 'bare', date: prev.date });
      bareArmed = false;
    }
  }
  // A bare event is dated one observation back, so restore date order (the sort is stable).
  return events.sort(byDate);
}

// ─── Recorded work against what the satellite saw ───────────────────────────

export type WorkCheckKind = 'no_green_up' | 'harvest_not_seen' | 'unrecorded_harvest';

/** A disagreement between the field records and the satellite series, worth a person's look. */
export interface WorkCheck {
  kind: WorkCheckKind;
  date: string;
}

/** Every number checkRecordedWork uses, in one place. Offsets are days. */
export const WORK_CHECK_RULES = {
  /** A series shorter than this says nothing. */
  minPoints: 3,
  /** no_green_up: only once today is at least this many days after sowing... */
  greenUpWaitDays: 60,
  /** ...with at least `greenUpMinObservations` clear observations from this day after sowing on. */
  greenUpObservedFromDay: 20,
  greenUpMinObservations: 3,
  /** harvest_not_seen: no harvest event in [H − before, H + after] for a recorded harvest H... */
  harvestSeenBeforeDays: 10,
  harvestSeenAfterDays: 20,
  /** ...and an observation in [H + from, H + to] still at or above `standingMinNdvi`. */
  standingFromDays: 3,
  standingToDays: 25,
  standingMinNdvi: 0.5,
  /** unrecorded_harvest: no recorded harvest in [D − before, D + after] for a harvest event D... */
  recordBeforeDays: 20,
  recordAfterDays: 10,
  /** ...reported only once today is this many days after D, so a harvest recorded late is not flagged. */
  unrecordedWaitDays: 10,
} as const;

function within(from: string, to: string, minDays: number, maxDays: number): boolean {
  const days = diffDays(from, to);
  return days >= minDays && days <= maxDays;
}

const KIND_ORDER: Record<WorkCheckKind, number> = { no_green_up: 0, harvest_not_seen: 1, unrecorded_harvest: 2 };

/**
 * Compares recorded sowing and harvest dates with the NDVI series (numbers in WORK_CHECK_RULES):
 * - no_green_up: sown, today ≥ sowing + 60 days, at least 3 clear observations from sowing + 20 days
 *   on, and NDVI never reached 0.3 after sowing (so no green_up event either). Dated at sowing.
 * - harvest_not_seen: for a recorded harvest H, no harvest event in [H − 10, H + 20] and at least one
 *   observation in [H + 3, H + 25] with NDVI ≥ 0.5, so the crop still looked standing. Dated at H.
 * - unrecorded_harvest: a harvest event D with no recorded harvest in [D − 20, D + 10], reported once
 *   today ≥ D + 10. Dated at D.
 * Nothing for a series of fewer than 3 observations. Sorted by date.
 *
 * The rules know nothing of the crop. Winter wheat sown late can stay under 0.3 until spring, and
 * cotton defoliation reads as a harvest, so these are prompts to look, never conclusions.
 */
export function checkRecordedWork(
  series: readonly NdviPoint[],
  recorded: { sowingDate: string | null; harvestDates: readonly string[] },
  today: string,
): WorkCheck[] {
  const rules = WORK_CHECK_RULES;
  const points = cleanSeries(series);
  if (points.length < rules.minPoints) return [];
  const events = detectEvents(points);
  const harvestEvents = events.filter((e) => e.type === 'harvest').map((e) => e.date);
  const checks: WorkCheck[] = [];

  const sowing = recorded.sowingDate;
  if (sowing && diffDays(sowing, today) >= rules.greenUpWaitDays) {
    const afterSowing = points.filter((p) => diffDays(sowing, p.date) > 0);
    const observed = afterSowing.filter((p) => diffDays(sowing, p.date) >= rules.greenUpObservedFromDay).length;
    const greened =
      afterSowing.some((p) => p.mean >= NDVI_EVENT_RULES.greenUpAtLeast) ||
      events.some((e) => e.type === 'green_up' && diffDays(sowing, e.date) > 0);
    if (observed >= rules.greenUpMinObservations && !greened) checks.push({ kind: 'no_green_up', date: sowing });
  }

  const recordedHarvests = [...new Set(recorded.harvestDates)].sort();
  for (const h of recordedHarvests) {
    const seen = harvestEvents.some((d) => within(h, d, -rules.harvestSeenBeforeDays, rules.harvestSeenAfterDays));
    if (seen) continue;
    const standing = points.some(
      (p) => p.mean >= rules.standingMinNdvi && within(h, p.date, rules.standingFromDays, rules.standingToDays),
    );
    if (standing) checks.push({ kind: 'harvest_not_seen', date: h });
  }

  for (const d of harvestEvents) {
    if (diffDays(d, today) < rules.unrecordedWaitDays) continue;
    const isRecorded = recordedHarvests.some((h) => within(d, h, -rules.recordBeforeDays, rules.recordAfterDays));
    if (!isRecorded) checks.push({ kind: 'unrecorded_harvest', date: d });
  }

  return checks.sort((a, b) => byDate(a, b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

// ─── Pasture ────────────────────────────────────────────────────────────────

/** Linear NDVI to green dry matter: kg DM per ha = slope · NDVI + intercept. */
export interface BiomassModel {
  slope: number;
  intercept: number;
}

/**
 * Pasture model used until the farm calibrates its own. We have no local calibration, so this is an
 * assumption, stated plainly: zero green biomass at NDVI 0.15 (bare soil) rising linearly to
 * 3000 kg DM/ha at NDVI 0.75 (dense pasture), which gives slope 5000 and intercept −750. Every figure
 * from it is an estimate and the UI labels it so. NDVI sees green material only: dry standing grass
 * in a Bukhara summer reads as nearly bare, and above about 0.75 NDVI saturates, so the line is
 * extrapolating there. Replace it with `fitBiomassModel` over clipped and weighed quadrats.
 */
export const DEFAULT_PASTURE_MODEL: BiomassModel = { slope: 5000, intercept: -750 };

/** Green dry matter in kg/ha from a field's NDVI, never below 0. Null when NDVI is missing. */
export function pastureBiomassKgHa(
  ndviValue: number | null,
  model: BiomassModel = DEFAULT_PASTURE_MODEL,
): number | null {
  if (ndviValue == null || !Number.isFinite(ndviValue)) return null;
  return Math.max(0, model.slope * ndviValue + model.intercept);
}

/**
 * Ordinary least squares of biomass on NDVI from clipped quadrats, with R² (the squared correlation,
 * which equals 1 − SSres / SStot for a line with intercept) and the number of samples used.
 * Null with fewer than 3 usable samples, when the NDVI values do not vary (no slope can be fitted),
 * or when every sample weighed the same (R² is undefined and the samples cannot tell pastures apart).
 */
export function fitBiomassModel(
  samples: readonly { ndvi: number; biomassKgHa: number }[],
): (BiomassModel & { r2: number; n: number }) | null {
  const usable = samples.filter((s) => Number.isFinite(s.ndvi) && Number.isFinite(s.biomassKgHa));
  const n = usable.length;
  if (n < 3) return null;
  let sumX = 0;
  let sumY = 0;
  for (const s of usable) {
    sumX += s.ndvi;
    sumY += s.biomassKgHa;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const s of usable) {
    const dx = s.ndvi - meanX;
    const dy = s.biomassKgHa - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // Tolerances absorb float noise: equal inputs can leave a residue near 1e-30 instead of 0.
  if (sxx <= 1e-12 || syy <= 1e-9) return null;
  const slope = sxy / sxx;
  return {
    slope,
    intercept: meanY - slope * meanX,
    r2: Math.min(1, (sxy * sxy) / (sxx * syy)),
    n,
  };
}

/** Defaults for grazingDays: take half and leave half; an adult ewe eats about 3 % of a 60 kg body weight. */
export const GRAZING_DEFAULTS = { utilisation: 0.5, intakeKgDmPerHeadDay: 1.8 } as const;

export interface GrazingInput {
  biomassKgHa: number | null;
  areaHa: number;
  /** Share of the standing biomass the flock may take, 0 to 1. Default 0.5. */
  utilisation?: number;
  head: number;
  /** Dry matter one animal eats per day. Default 1.8 kg for an adult ewe. */
  intakeKgDmPerHeadDay?: number;
}

/**
 * Days a flock can graze a pasture: biomass · area · utilisation / (head · intake).
 * Null for missing biomass, no animals, no area, a utilisation outside (0, 1] or an intake that is
 * not positive. Zero biomass is real data and gives 0 days.
 */
export function grazingDays({
  biomassKgHa,
  areaHa,
  utilisation = GRAZING_DEFAULTS.utilisation,
  head,
  intakeKgDmPerHeadDay = GRAZING_DEFAULTS.intakeKgDmPerHeadDay,
}: GrazingInput): number | null {
  if (biomassKgHa == null || !Number.isFinite(biomassKgHa)) return null;
  if (!(head > 0) || !(areaHa > 0)) return null;
  if (!(utilisation > 0 && utilisation <= 1) || !(intakeKgDmPerHeadDay > 0)) return null;
  return (Math.max(0, biomassKgHa) * areaHa * utilisation) / (head * intakeKgDmPerHeadDay);
}
