/** Livestock calculations that go beyond the ones listed in spec 25.1. Same conventions as index.ts. */
import { round } from './index';

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

/** Mean of opening and closing head, the base for mortality percent. */
export function averageHead(opening: number, closing: number): number {
  return (opening + closing) / 2;
}
