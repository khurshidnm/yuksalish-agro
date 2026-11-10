/**
 * Where the flock spent its time: a grid of cells for the map, and hours and animal-days for each
 * field (docs/tracking.md). All of it is counted from GPS fixes, so it says where the animals
 * were, by day and by night; it does not know whether a sheep was eating.
 *
 * Same convention as index.ts: a period without positions is `null`, never a map of zeros.
 */
import { insideArea, type AreaGeometry, type Fix, type LatLng } from './tracking';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Coordinates are snapped to 1e-7 of a degree (about a centimetre) so a cell edge is exact. */
const E7 = 10_000_000;

/** Starting values, to be tuned on the pilot flock. */
export const GRAZING_RULES = {
  /** Side of a grid cell in 1e-7 degrees: 0.0005°, which is 55.6 m north to south and about 43 m east to west at 39.5° N. */
  cellE7: 5000,
  /** A fix stands for the time until the next one, but never for longer than this: a collar that was silent for hours was not seen there. */
  maxFixGapMs: 30 * MINUTE,
  /** An animal counts towards a field's animal-days on a day it spent at least this long there, hours. */
  minAnimalDayHours: 1,
  /** Shades on the map, from the least used cells to the most. */
  heatLevels: 5,
  /** Cells sent to the map at most, the most used first. */
  maxCells: 4000,
  /** Days of raw readings looked back for a day that has no summary yet. */
  lookbackDays: 30,
  /** The grid is kept this long; the longest period on the map is 90 days. */
  keepCellDays: 100,
} as const;

export interface Cell {
  x: number;
  y: number;
}

/** The grid cell a position falls in. Cells are counted east from the prime meridian and north from the equator. */
export function cellOf(point: LatLng): Cell {
  return {
    x: Math.floor(Math.round(point.lng * E7) / GRAZING_RULES.cellE7),
    y: Math.floor(Math.round(point.lat * E7) / GRAZING_RULES.cellE7),
  };
}

export interface CellBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function cellBounds(cell: Cell): CellBounds {
  const side = GRAZING_RULES.cellE7;
  return {
    south: (cell.y * side) / E7,
    west: (cell.x * side) / E7,
    north: ((cell.y + 1) * side) / E7,
    east: ((cell.x + 1) * side) / E7,
  };
}

// ─── One day ────────────────────────────────────────────────────────────────

export interface GrazingAnimal {
  animalId: string;
  herdId: string | null;
  /** The day's fixes, any order. */
  fixes: readonly Fix[];
}

export interface GrazingField {
  id: string;
  geometry: AreaGeometry | null;
}

export interface GrazingDay {
  /** Fixes counted that day. */
  fixes: number;
  cells: { herdId: string | null; x: number; y: number; fixes: number }[];
  fields: {
    herdId: string | null;
    fieldId: string;
    fixes: number;
    /** Animals that spent at least `minAnimalDayHours` in the field: its animal-days for the day. */
    animals: number;
    /** Hours spent in the field, summed over every animal. */
    animalHours: number;
  }[];
}

/**
 * One day of a farm's fixes, counted into grid cells and fields, per herd. Each fix stands for the
 * time until the animal's next fix, or until `dayEnd` for its last one, capped at `maxFixGapMs`.
 * A fix inside two overlapping fields counts in both.
 */
export function grazingDay(animals: readonly GrazingAnimal[], fields: readonly GrazingField[], dayEnd: number): GrazingDay {
  const g = GRAZING_RULES;
  const cells = new Map<string, { herdId: string | null; x: number; y: number; fixes: number }>();
  const byField = new Map<string, { herdId: string | null; fieldId: string; fixes: number; animals: number; animalHours: number }>();
  let total = 0;

  for (const animal of animals) {
    const fixes = [...animal.fixes].sort((a, b) => a.at - b.at);
    const hoursIn = new Map<string, { fixes: number; ms: number }>();
    fixes.forEach((fix, i) => {
      total += 1;
      const cell = cellOf(fix);
      const key = `${animal.herdId ?? ''}|${cell.x}|${cell.y}`;
      const counted = cells.get(key) ?? { herdId: animal.herdId, ...cell, fixes: 0 };
      counted.fixes += 1;
      cells.set(key, counted);

      const worthMs = Math.min(g.maxFixGapMs, Math.max(0, (fixes[i + 1]?.at ?? dayEnd) - fix.at));
      for (const field of fields) {
        if (insideArea(fix, field.geometry) !== true) continue;
        const here = hoursIn.get(field.id) ?? { fixes: 0, ms: 0 };
        here.fixes += 1;
        here.ms += worthMs;
        hoursIn.set(field.id, here);
      }
    });
    for (const [fieldId, here] of hoursIn) {
      const key = `${animal.herdId ?? ''}|${fieldId}`;
      const row = byField.get(key) ?? { herdId: animal.herdId, fieldId, fixes: 0, animals: 0, animalHours: 0 };
      row.fixes += here.fixes;
      row.animalHours += here.ms / HOUR;
      if (here.ms / HOUR >= g.minAnimalDayHours) row.animals += 1;
      byField.set(key, row);
    }
  }
  return { fixes: total, cells: [...cells.values()], fields: [...byField.values()] };
}

// ─── A period ───────────────────────────────────────────────────────────────

export interface HeatCell extends CellBounds {
  fixes: number;
  /** This cell's share of every fix in the period, 0 to 1. */
  share: number;
  /** 1 (least used) to `heatLevels` (most used). */
  level: number;
}

export interface Heatmap {
  totalFixes: number;
  cells: HeatCell[];
}

/**
 * The grid for the map, the most used cells first. `totalFixes` is every fix of the period, which
 * may be more than the cells given when the list was cut to the most used ones. The shade is the
 * cell's rank among the cells, not its share: a pen where the flock sleeps holds half of all fixes
 * and on a straight scale would leave every pasture blank. Cells with equal counts share a shade.
 * `null` when the period has no fixes.
 */
export function heatmap(cells: readonly (Cell & { fixes: number })[], totalFixes?: number): Heatmap | null {
  const used = cells.filter((c) => c.fixes > 0);
  const total = totalFixes ?? used.reduce((sum, c) => sum + c.fixes, 0);
  if (used.length === 0 || total <= 0) return null;
  const levels = GRAZING_RULES.heatLevels;
  // How many cells are used no more than a cell with this count: the most used cell always gets the full shade.
  const rank = new Map<number, number>();
  used
    .map((c) => c.fixes)
    .sort((a, b) => a - b)
    .forEach((fixes, i) => rank.set(fixes, i + 1));
  return {
    totalFixes: total,
    cells: [...used]
      .sort((a, b) => b.fixes - a.fixes || a.y - b.y || a.x - b.x)
      .map((c) => ({
        ...cellBounds(c),
        fixes: c.fixes,
        share: c.fixes / total,
        level: Math.ceil((rank.get(c.fixes)! * levels) / used.length),
      })),
  };
}

/** Animal-days on each hectare; `null` without an area. */
export function animalDaysPerHa(animalDays: number, areaHa: number | null | undefined): number | null {
  return areaHa && areaHa > 0 ? animalDays / areaHa : null;
}
