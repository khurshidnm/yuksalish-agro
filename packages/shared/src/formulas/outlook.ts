/**
 * The farm's year ahead: what the herd, the feed and the money will do if nothing unusual happens.
 * Pure projections from records plus stated assumptions, so a person can check them by hand.
 */
import { round } from './index';
import { lambsFromPregnancies } from './lambing';

export interface OutlookAssumptions {
  /** Lambs born per ewe that lambs. Hisori ewes mostly carry one. */
  lambsPerEwe: number;
  /** Share of lambs born that live to be sold or kept, 0 to 1. */
  survival: number;
  /** Months from birth to sale. */
  monthsToSale: number;
  /** Share of surviving lambs kept for the flock, 0 to 1. */
  keepShare: number;
  /** Live weight at sale. */
  saleWeightKg: number;
}

/**
 * The one set of lamb assumptions, for a farm without lambings of its own on record. The outlook,
 * the cash-flow forecast, the lambing plan and the assistant all read these, so they cannot
 * expect different numbers of lambs from the same ewes.
 */
export const OUTLOOK_ASSUMPTIONS: OutlookAssumptions = {
  lambsPerEwe: 1.1,
  survival: 0.92,
  monthsToSale: 6,
  keepShare: 0.2,
  saleWeightKg: 45,
};

/** How long a ewe nurses her lambs on the richer ration, in months. */
export const LACTATION_MONTHS = 3;

/** Whole lambs expected to be born to this many ewes: the count every screen shows. */
export function expectedLambs(ewes: number, lambsPerEwe = OUTLOOK_ASSUMPTIONS.lambsPerEwe): number {
  return round(ewes * lambsPerEwe, 0);
}

/**
 * What becomes of the lambs born in one month, not rounded: those alive at weaning, the ones kept
 * for the flock and the ones that go to market. The outlook and the three-year scenario both read
 * this, so they cannot count a lamb crop two ways.
 */
export function lambCohort(born: number, { survival, keepShare }: Pick<OutlookAssumptions, 'survival' | 'keepShare'>) {
  const weaned = born * survival;
  return { weaned, kept: weaned * keepShare, forSale: weaned * (1 - keepShare) };
}

/** Lambs from this many ewes that live and are not kept for the flock: what goes to market. */
export function lambsForSale(ewes: number, assumptions: OutlookAssumptions = OUTLOOK_ASSUMPTIONS): number {
  return ewes * assumptions.lambsPerEwe * assumptions.survival * (1 - assumptions.keepShare);
}

export interface HerdOutlookInput {
  /** Consecutive months, oldest first. */
  months: string[];
  /** Animals on the farm now. */
  head: number;
  /** Ewes expected to lamb in each month. */
  ewesDue: Record<string, number>;
  /** Of those ewes, the ones a pregnancy scan has counted, and the foetuses it found. */
  scanned?: Record<string, { ewes: number; fetuses: number }>;
  assumptions: OutlookAssumptions;
}

export interface HerdOutlookRow {
  month: string;
  ewesLambing: number;
  lambsBorn: number;
  lambsSold: number;
  lambsOnFarm: number;
  /** Ewes still to lamb, so on the pregnant ration. */
  carrying: number;
  /** Ewes nursing, so on the lactating ration. */
  nursing: number;
  head: number;
}

export function projectHerd({ months, head, ewesDue, scanned = {}, assumptions }: HerdOutlookInput): HerdOutlookRow[] {
  const { lambsPerEwe, survival, monthsToSale, keepShare } = assumptions;
  const lambing = months.map((month) => ewesDue[month] ?? 0);
  // A scanned ewe counts what the scan found; the rest take the assumption (formulas/lambing.ts).
  const tally = months.map((month, i) => ({ ewes: lambing[i], scannedEwes: scanned[month]?.ewes ?? 0, scannedFetuses: scanned[month]?.fetuses ?? 0 }));
  const born = tally.map((t) => lambsFromPregnancies(t, lambsPerEwe) ?? 0);
  const cohorts = born.map((lambs) => lambCohort(lambs, { survival, keepShare }));
  const sold = months.map((_, i) => (i >= monthsToSale ? cohorts[i - monthsToSale].forSale : 0));

  let lambsOnFarm = 0;
  let carrying = lambing.reduce((sum, ewes) => sum + ewes, 0);
  // Rounded on the running total, so the months add up to the count for all the ewes together.
  const soFar = { ewes: 0, scannedEwes: 0, scannedFetuses: 0 };
  const bornSoFar = () => round(lambsFromPregnancies(soFar, lambsPerEwe) ?? 0, 0);
  return months.map((month, i) => {
    lambsOnFarm += cohorts[i].weaned - sold[i];
    carrying -= lambing[i];
    const bornBefore = bornSoFar();
    soFar.ewes += tally[i].ewes;
    soFar.scannedEwes += Math.min(tally[i].scannedEwes, tally[i].ewes);
    soFar.scannedFetuses += tally[i].scannedEwes > 0 ? tally[i].scannedFetuses : 0;
    const nursing = lambing.slice(Math.max(0, i - LACTATION_MONTHS + 1), i + 1).reduce((sum, ewes) => sum + ewes, 0);
    return {
      month,
      ewesLambing: lambing[i],
      lambsBorn: bornSoFar() - bornBefore,
      lambsSold: Math.round(sold[i]),
      lambsOnFarm: Math.round(lambsOnFarm),
      carrying,
      nursing,
      head: Math.round(head + lambsOnFarm),
    };
  });
}

export interface FeedCoverage {
  /** Kilograms needed up to, and not including, the month the feed is next harvested. */
  needKg: number;
  /** Stock left at that point. Below zero is what must be bought. */
  surplusKg: number;
  /** The first month the stock does not cover in full. Null when it lasts. */
  runsOutMonth: string | null;
}

/**
 * Walk the months until the stock runs out or the next harvest arrives. With no harvest ahead, as
 * for feed that is only ever bought, every month given counts.
 */
export function feedCoverage(stockKg: number, needs: { month: string; kg: number }[], nextHarvestMonth: string | null): FeedCoverage {
  let left = stockKg;
  let needKg = 0;
  let runsOutMonth: string | null = null;
  for (const { month, kg } of needs) {
    if (nextHarvestMonth !== null && month >= nextHarvestMonth) break;
    needKg += kg;
    left -= kg;
    if (left < 0 && runsOutMonth === null) runsOutMonth = month;
  }
  return { needKg, surplusKg: left, runsOutMonth };
}
