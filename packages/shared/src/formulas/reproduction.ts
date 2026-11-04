/**
 * Reproduction and veterinary calculations (spec 8.2, 8.3). Same conventions as index.ts:
 * pure functions, and `null` when there is not enough data to answer.
 */
import { withdrawalUntil } from './index';

/** Lamb ages accepted as a "100-day" weighing: closest record inside this window is used. */
export const WEIGHT_100_WINDOW = { minDays: 70, maxDays: 130 } as const;

/** Age at weaning used for survival (Hisori lambs wean at about four months). */
export const WEANING_DAYS = 120;

/** Below this many weighed lambs a ram's rating is shown as low confidence. */
export const MIN_PROGENY_FOR_RATING = 5;

/** Number of lambs per ewe that lambed. */
export function lambsPerEwe(lambsBorn: number, ewesLambed: number): number | null {
  if (ewesLambed <= 0) return null;
  return lambsBorn / ewesLambed;
}

/**
 * Weight standardised to exactly 100 days of age, by straight-line growth from birth to the
 * nearest weighing. Null when the weighing is outside the accepted window.
 */
export function adjustedWeight100(birthKg: number, weightKg: number, ageDays: number): number | null {
  if (ageDays < WEIGHT_100_WINDOW.minDays || ageDays > WEIGHT_100_WINDOW.maxDays) return null;
  return birthKg + ((weightKg - birthKg) / ageDays) * 100;
}

/** Average daily gain from birth, grams per day. */
export function gainFromBirthGrams(birthKg: number, weightKg: number, ageDays: number): number | null {
  if (ageDays <= 0) return null;
  return ((weightKg - birthKg) / ageDays) * 1000;
}

/** Group average relative to the farm average: 100 means average, 110 means 10 % better. */
export function progenyIndex(groupAverage: number | null, farmAverage: number | null): number | null {
  if (groupAverage === null || farmAverage === null || farmAverage <= 0) return null;
  return (groupAverage / farmAverage) * 100;
}

/** Mean of the numbers that exist; null when there are none. */
export function averageOf(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (known.length === 0) return null;
  return known.reduce((sum, v) => sum + v, 0) / known.length;
}

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface VaccinationDueInput {
  /** Last time this vaccine reached the animal. */
  lastDate: string | null;
  intervalDays: number | null;
  birthDate: string | null;
  /** Age of the first dose. Null means the plan applies at any age. */
  ageDays: number | null;
  /** When the animal arrived on the farm, if bought. */
  arrivalDate: string | null;
  today: string;
}

/**
 * Next date a vaccine is due for one animal, or null when no further dose is planned.
 * A bought animal cannot be due before it arrived, so arrival is the floor for a first dose.
 */
export function nextVaccinationDue(i: VaccinationDueInput): string | null {
  if (i.lastDate) return i.intervalDays ? addDaysIso(i.lastDate, i.intervalDays) : null;

  const byAge = i.ageDays !== null && i.birthDate ? addDaysIso(i.birthDate, i.ageDays) : null;
  if (byAge && i.arrivalDate) return byAge > i.arrivalDate ? byAge : i.arrivalDate;
  return byAge ?? i.arrivalDate ?? i.birthDate ?? i.today;
}

/**
 * Earliest date meat or milk may be sold after a treatment. A course counts from its final dose,
 * so a 5-day course with a 14-day withdrawal started on the 1st ends on the 19th.
 */
export function withdrawalEnd(firstDoseDate: string, courseDays: number | null, withdrawalDays: number): string {
  const lastDose = addDaysIso(firstDoseDate, Math.max(1, courseDays ?? 1) - 1);
  return withdrawalUntil(lastDose, withdrawalDays);
}

export interface ParentLinks {
  damId: string | null;
  sireId: string | null;
}

/** An animal and its ancestors with their distance: 0 is itself, 1 a parent, 2 a grandparent. */
export function ancestorsWithin(
  parents: ReadonlyMap<string, ParentLinks>,
  id: string,
  generations: number,
): Map<string, number> {
  const found = new Map<string, number>([[id, 0]]);
  let frontier = [id];
  for (let distance = 1; distance <= generations; distance++) {
    const next: string[] = [];
    for (const current of frontier) {
      const links = parents.get(current);
      for (const parent of [links?.damId, links?.sireId]) {
        if (parent && !found.has(parent)) {
          found.set(parent, distance);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return found;
}

export interface CommonAncestor {
  id: string;
  /** Generations back from the first and second animal; 0 means the animal itself. */
  distanceA: number;
  distanceB: number;
}

/**
 * Relatives within `generations`, for the inbreeding warning (spec 8.2). Each animal counts as
 * its own ancestor at distance 0, so a ram mated with his daughter is caught as well as half
 * siblings. Closest relationships come first.
 */
export function commonAncestors(
  parents: ReadonlyMap<string, ParentLinks>,
  a: string,
  b: string,
  generations = 3,
): CommonAncestor[] {
  if (a === b) return [];
  const ofA = ancestorsWithin(parents, a, generations);
  const ofB = ancestorsWithin(parents, b, generations);
  const common: CommonAncestor[] = [];
  for (const [id, distanceA] of ofA) {
    const distanceB = ofB.get(id);
    if (distanceB !== undefined) common.push({ id, distanceA, distanceB });
  }
  return common.sort((x, y) => x.distanceA + x.distanceB - (y.distanceA + y.distanceB));
}
