/** Livestock calculations that go beyond the ones listed in spec 25.1. Same conventions as index.ts. */
import { addDays } from '../dates';
import { round } from './index';

/**
 * Young born before this share of the species' gestation cannot live: such a birth is an abortion.
 * 90 % is 135 days for sheep and goats (lambs survive from about 138), 254 for cattle, 306 for horses.
 */
export const VIABLE_GESTATION_SHARE = 0.9;

/**
 * The first day a live birth is plausible after a mating, or `null` without a gestation length.
 * A lambing with live lambs before it is a typing mistake or an abortion, never a lambing.
 */
export function earliestLiveBirth(matingDate: string, gestationDays: number | null | undefined): string | null {
  if (!gestationDays || gestationDays <= 0) return null;
  return addDays(matingDate, Math.floor(gestationDays * VIABLE_GESTATION_SHARE));
}

/** Yaylov yuklamasi: head per hectare (spec 8.4). */
export function stockingRate(head: number, areaHa: number): number | null {
  if (areaHa <= 0) return null;
  return head / areaHa;
}

/** Go'sht chiqishi (%): carcass weight as a share of live weight (spec 8.5). */
export function meatYieldPercent(carcassKg: number, liveKg: number): number | null {
  if (liveKg <= 0) return null;
  return (carcassKg / liveKg) * 100;
}

/** Rations are in kg; stock is kept in the item's own unit. */
export function kgToItemUnit(kg: number, unit: string): number {
  return unit === 't' ? kg / 1000 : kg;
}

export function itemUnitToKg(qty: number, unit: string): number {
  return unit === 't' ? qty * 1000 : qty;
}

/** Whole months between two YYYY-MM-DD dates. */
export function ageInMonths(birthDate: string | null | undefined, onDate: string): number | null {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  const months = (y - by) * 12 + (m - bm) - (d < bd ? 1 : 0);
  return months < 0 ? null : months;
}

/**
 * Book value of one animal: purchase price plus its share of the herd's accumulated cost.
 * `null` when neither is known, because an unknown value is not a value of zero.
 */
export function animalBookValue(purchasePrice: number | null, accumulatedPerHead: number | null): number | null {
  if (purchasePrice === null && accumulatedPerHead === null) return null;
  return round((purchasePrice ?? 0) + (accumulatedPerHead ?? 0), 2);
}

/** Heaviest believable live weight per species, in kg: far above any real animal, well below a typing slip. */
const MAX_LIVE_WEIGHT_KG: Record<string, number> = { sheep: 250, goat: 200, cattle: 1800, horse: 1500, poultry: 40 };

export function maxLiveWeightKg(speciesKey: string): number {
  return MAX_LIVE_WEIGHT_KG[speciesKey] ?? 2000;
}

/**
 * Mean of opening and closing head, the base for mortality percent. Animals bought in the period
 * count as present from its start: a flock bought in one go would otherwise halve the average and
 * double the rate. Lambs are not included, because they arrive through the period.
 */
export function averageHead(opening: number, closing: number, purchased = 0): number {
  return (opening + purchased + closing) / 2;
}

export interface HerdHistory {
  /** The herd the animal is in now. */
  herdId: string | null;
  birthDate: string | null;
  purchaseDate: string | null;
  exitDate: string | null;
  /** Oldest first, and in the order they happened within a day. */
  transfers: { date: string; fromHerdId: string | null; toHerdId: string | null }[];
}

/**
 * Was this animal in this herd on this day? A whole-herd record names no animals, so this decides
 * which of them it reached. A transfer dated that day counts as already made. Where the data cannot
 * say, the animal counts as present: no birth or purchase date means no known start.
 *
 * The herd is the one it last moved into, or the one it next moved out of. Those two are the same
 * unless an edit moved it before edits left a transfer: then either of them may be true.
 */
export function wasInHerdOn(animal: HerdHistory, herdId: string, date: string): boolean {
  if (animal.birthDate && date < animal.birthDate) return false;
  if (animal.purchaseDate && date < animal.purchaseDate) return false;
  if (animal.exitDate && date > animal.exitDate) return false;

  const movedIn = animal.transfers.filter((t) => t.date <= date).at(-1);
  const movesOut = animal.transfers.find((t) => t.date > date);
  return herdId === movedIn?.toHerdId || herdId === (movesOut ? movesOut.fromHerdId : animal.herdId);
}
