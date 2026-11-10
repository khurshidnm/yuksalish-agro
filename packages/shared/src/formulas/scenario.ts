/**
 * Three years ahead, month by month: what the flock, the profit and the cash do under one stated
 * set of assumptions. A person changes an assumption and sees the three years change, so every step
 * is plain arithmetic that can be checked by hand.
 *
 * How a month runs. Everything happens at the start of the month, in this order, and the month's
 * costs are charged on the flock as it stands afterwards:
 *   1. replacement ewe lambs old enough to lamb join the ewes;
 *   2. a twelfth of the year's ewe deaths and culls leave, counted on the ewes then in the flock;
 *   3. in the lambing month the ewes lamb: of the lambs alive at weaning, the kept share of the
 *      ewe lambs become replacements and the rest are held for sale;
 *   4. lambs that have reached the sale age are sold.
 *
 * What the model leaves out, so nobody reads more into it: rams stay at their opening number,
 * lambs lost after weaning, wool, and a price for the kilograms of a cull ewe (she sells by the
 * head). Opening lambs and replacements are taken as born in the last lambing month before the
 * plan starts (a year back when the plan starts in the lambing month itself).
 *
 * Missing data is `null`, never 0: an assumption left empty makes every figure that rests on it
 * `null`. Head counts stay fractional here and are rounded only where they are shown.
 */
import { lambsFromPregnancies } from './lambing';
import { lambCohort } from './outlook';

export const SCENARIO_MONTHS = 36;
export const SCENARIO_YEARS = 3;

/** Half the lambs born are ewe lambs. */
export const EWE_LAMB_SHARE = 0.5;

/**
 * Starting values chosen for the pilot, not figures from a book. They are offered as suggestions,
 * apart from the farm's own figures, and each farm should set its own.
 */
export const SCENARIO_DEFAULTS = {
  /** Age at which a kept ewe lamb first lambs: mated in her second autumn. */
  firstLambingAgeMonths: 24,
  /** Months on stall feed: those outside the outlook's grazing months, April to October. */
  stallMonths: [11, 12, 1, 2, 3],
  /**
   * What an adult's feed costs in a grazing month, as a share of a stall month. The outlook takes
   * the same half for the forage that pasture replaces (dashboard/outlook.service PASTURE_SHARE).
   */
  grazingFeedShare: 0.5,
  /** Share of the ewes that die in a year, and that are culled in a year. */
  eweDeathsPerYear: 0.03,
  eweCullsPerYear: 0.15,
} as const;

/** Every assumption that is one number, in the order the screens list them. */
export const SCENARIO_NUMBER_KEYS = [
  'openingEwes',
  'openingRams',
  'openingReplacements',
  'openingLambs',
  'lambingMonth',
  'lambingShare',
  'lambsPerEweLambing',
  'lambSurvival',
  'eweDeathsPerYear',
  'eweCullsPerYear',
  'replacementShare',
  'firstLambingAgeMonths',
  'saleAgeMonths',
  'saleWeightKg',
  'pricePerKg',
  'cullEwePrice',
  'feedAdultStallPerMonth',
  'feedAdultGrazingPerMonth',
  'feedLambPerMonth',
  'otherCostPerHeadPerMonth',
  'fixedCostPerMonth',
  'openingCash',
] as const;
export type ScenarioNumberKey = (typeof SCENARIO_NUMBER_KEYS)[number];
export type ScenarioAssumptionKey = ScenarioNumberKey | 'stallMonths';

export interface ScenarioOneOff {
  /** Month of the plan, 0 for its first month. */
  month: number;
  /** Money going out. */
  amount: number;
}

/**
 * - `openingEwes`, `openingRams`, `openingReplacements`, `openingLambs`: head at the start, where
 *   replacements are ewe lambs kept for the flock and lambs are those held for sale.
 * - `lambingMonth`: calendar month, 1 to 12. `stallMonths`: calendar months on stall feed.
 * - Shares are 0 to 1: `lambingShare` of the ewes lamb, `lambSurvival` of the lambs born live to
 *   weaning, `eweDeathsPerYear` and `eweCullsPerYear` of the ewes leave in a year,
 *   `replacementShare` of the ewe lambs weaned are kept.
 * - `lambsPerEweLambing`: lambs born per ewe that lambs.
 * - `firstLambingAgeMonths`, `saleAgeMonths`: whole months from birth.
 * - Money is in the farm's base currency: `pricePerKg` of live weight, `cullEwePrice` per head,
 *   feed per head per month (a growing lamb is one held for sale, or a replacement younger than
 *   the sale age), `otherCostPerHeadPerMonth` on every head, `fixedCostPerMonth` whatever the flock.
 */
export type ScenarioAssumptions = Record<ScenarioNumberKey, number | null> & {
  /** First month of the plan, YYYY-MM. */
  startMonth: string;
  stallMonths: number[] | null;
  oneOffs: ScenarioOneOff[];
};

type N = number | null;

export interface ScenarioHerd {
  ewes: N;
  rams: N;
  replacements: N;
  lambs: N;
  total: N;
}

export interface ScenarioRevenue {
  lambs: N;
  culls: N;
  total: N;
}

export interface ScenarioCosts {
  feed: N;
  /** The cost per head, on every head. */
  other: N;
  fixed: N;
  oneOff: number;
  total: N;
}

export interface ScenarioMonth {
  index: number;
  /** YYYY-MM. */
  month: string;
  /** The flock after the month's events. */
  herd: ScenarioHerd;
  lambsBorn: N;
  lambsSold: N;
  ewesCulled: N;
  ewesDied: N;
  /** Lambs and cull ewes together. */
  animalsSold: N;
  kgSold: N;
  revenue: ScenarioRevenue;
  costs: ScenarioCosts;
  net: N;
  closingCash: N;
}

export interface ScenarioYear {
  /** 1, 2 or 3: twelve months from the plan's start, not a calendar year. */
  year: number;
  from: string;
  to: string;
  herd: ScenarioHerd;
  lambsBorn: N;
  lambsSold: N;
  ewesCulled: N;
  kgSold: N;
  revenue: ScenarioRevenue;
  costs: ScenarioCosts;
  profit: N;
  closingCash: N;
  lowestCash: N;
  lowestCashMonth: string | null;
}

export interface ScenarioSummary {
  revenue: N;
  costs: N;
  profit: N;
  kgSold: N;
  lambsSold: N;
  /** All cost of the three years over all kilograms sold. Null when nothing is sold. */
  breakEvenPricePerKg: N;
  /** Profit of an average year over the average number of ewes. */
  profitPerEwePerYear: N;
  /** False while a month's closing cash is unknown: the two cash answers below are then unknown too. */
  cashKnown: boolean;
  /** First month that closes below zero. Null when cash never does, or is not known. */
  firstNegativeCashMonth: string | null;
  lowestCash: N;
  lowestCashMonth: string | null;
  /** False while a month's net is unknown. */
  netKnown: boolean;
  /** First month in which everything earned since the start exceeds everything spent. Null when never, or not known. */
  paybackMonth: string | null;
}

export interface ScenarioResult {
  months: ScenarioMonth[];
  years: ScenarioYear[];
  summary: ScenarioSummary;
  /** Assumptions left empty that a figure was waiting for. */
  missing: ScenarioAssumptionKey[];
}

/** Null as soon as one part is unknown. */
const sum = (...values: N[]): N => values.reduce<N>((total, v) => (total === null || v === null ? null : total + v), 0);

/** A known zero settles a product whatever the other side is: no ewes culled need no cull price. */
const times = (a: N, b: N): N => (a === 0 || b === 0 ? 0 : a === null || b === null ? null : a * b);

const minus = (a: N, b: N): N => (a === null || b === null ? null : a - b);

/** `n` months after a YYYY-MM month. */
export function scenarioMonthAt(startMonth: string, n: number): string {
  const [year, month] = startMonth.split('-').map(Number);
  const index = year * 12 + (month - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

interface Cohort {
  /** Month of the plan the lambs were born in; negative for those on the farm at the start. */
  born: number;
  replacements: N;
  forSale: N;
}

export function runScenario(a: ScenarioAssumptions): ScenarioResult {
  const missing = new Set<ScenarioAssumptionKey>();
  const need = (key: ScenarioNumberKey): N => {
    const value = a[key];
    if (value === null) missing.add(key);
    return value;
  };
  /** `count` head or kilograms at the rate an assumption gives. Nothing to count asks for no rate. */
  const by = (count: N, key: ScenarioNumberKey): N => (count === 0 ? 0 : times(count, need(key)));

  const startCalendar = Number(a.startMonth.split('-')[1]);
  const calendarOf = (index: number) => ((startCalendar - 1 + index) % 12) + 1;

  const lambingMonth = need('lambingMonth');
  const saleAge = need('saleAgeMonths');
  const firstLambingAge = need('firstLambingAgeMonths');
  // Without these three nobody can say which month a lamb is born, sold or joins the ewes.
  const timed = lambingMonth !== null && saleAge !== null && firstLambingAge !== null;
  if (a.stallMonths === null) missing.add('stallMonths');

  const rams = need('openingRams');
  let ewes: N = need('openingEwes');
  const openingReplacements = need('openingReplacements');
  const openingLambs = need('openingLambs');
  const cohorts: Cohort[] = [];
  if (timed) {
    const sinceLambing = (startCalendar - lambingMonth + 12) % 12 || 12;
    cohorts.push({ born: -sinceLambing, replacements: openingReplacements, forSale: openingLambs });
  } else {
    ewes = null;
  }

  let cash: N = need('openingCash');
  let cumulativeNet: N = 0;
  let paybackMonth: string | null = null;
  const months: ScenarioMonth[] = [];

  for (let index = 0; index < SCENARIO_MONTHS; index++) {
    const calendar = calendarOf(index);
    const month = scenarioMonthAt(a.startMonth, index);
    let lambsBorn: N = timed ? 0 : null;
    let lambsSold: N = timed ? 0 : null;

    if (timed) {
      for (const cohort of cohorts) {
        if (index - cohort.born >= firstLambingAge && cohort.replacements !== 0) {
          ewes = sum(ewes, cohort.replacements);
          cohort.replacements = 0;
        }
      }
    }

    const ewesDied = times(by(ewes, 'eweDeathsPerYear'), 1 / 12);
    const ewesCulled = times(by(ewes, 'eweCullsPerYear'), 1 / 12);
    ewes = minus(ewes, sum(ewesDied, ewesCulled));

    if (timed) {
      if (calendar === lambingMonth) {
        const ewesLambing = by(ewes, 'lambingShare');
        const perEwe = ewesLambing === 0 ? 0 : need('lambsPerEweLambing');
        lambsBorn = ewesLambing === null ? null : lambsFromPregnancies({ ewes: ewesLambing }, perEwe);
        if (lambsBorn === 0) {
          cohorts.push({ born: index, replacements: 0, forSale: 0 });
        } else {
          const survival = need('lambSurvival');
          const kept = need('replacementShare');
          const cohort = lambsBorn === null || survival === null || kept === null ? null : lambCohort(lambsBorn, { survival, keepShare: EWE_LAMB_SHARE * kept });
          cohorts.push({ born: index, replacements: cohort?.kept ?? null, forSale: cohort?.forSale ?? null });
        }
      }
      for (const cohort of cohorts) {
        if (index - cohort.born >= saleAge && cohort.forSale !== 0) {
          lambsSold = sum(lambsSold, cohort.forSale);
          cohort.forSale = 0;
        }
      }
    }

    const lambs = timed ? sum(...cohorts.map((cohort) => cohort.forSale)) : null;
    const replacements = timed ? sum(...cohorts.map((cohort) => cohort.replacements)) : null;
    // A replacement eats as a growing lamb until the age her brothers are sold at, then as an adult.
    const youngReplacements = timed ? sum(...cohorts.filter((cohort) => index - cohort.born < saleAge).map((cohort) => cohort.replacements)) : null;
    const growing = sum(lambs, youngReplacements);
    const adults = sum(ewes, rams, minus(replacements, youngReplacements));
    const herd: ScenarioHerd = { ewes, rams, replacements, lambs, total: sum(ewes, rams, replacements, lambs) };

    const kgSold = by(lambsSold, 'saleWeightKg');
    const lambRevenue = by(kgSold, 'pricePerKg');
    const cullRevenue = by(ewesCulled, 'cullEwePrice');
    const revenue: ScenarioRevenue = { lambs: lambRevenue, culls: cullRevenue, total: sum(lambRevenue, cullRevenue) };

    const adultFeed =
      a.stallMonths === null
        ? times(adults, null)
        : by(adults, a.stallMonths.includes(calendar) ? 'feedAdultStallPerMonth' : 'feedAdultGrazingPerMonth');
    const feed = sum(adultFeed, by(growing, 'feedLambPerMonth'));
    const other = by(herd.total, 'otherCostPerHeadPerMonth');
    const fixed = need('fixedCostPerMonth');
    const oneOff = a.oneOffs.filter((item) => item.month === index).reduce((total, item) => total + item.amount, 0);
    const costs: ScenarioCosts = { feed, other, fixed, oneOff, total: sum(feed, other, fixed, oneOff) };

    const net = minus(revenue.total, costs.total);
    cash = sum(cash, net);
    cumulativeNet = sum(cumulativeNet, net);
    if (paybackMonth === null && cumulativeNet !== null && cumulativeNet > 0) paybackMonth = month;

    months.push({
      index,
      month,
      herd,
      lambsBorn,
      lambsSold,
      ewesCulled,
      ewesDied,
      animalsSold: sum(lambsSold, ewesCulled),
      kgSold,
      revenue,
      costs,
      net,
      closingCash: cash,
    });
  }

  const total = (rows: ScenarioMonth[], pick: (row: ScenarioMonth) => N): N => sum(...rows.map(pick));
  const lowest = (rows: ScenarioMonth[]): { cash: N; month: string | null } => {
    let low: ScenarioMonth | null = null;
    for (const row of rows) {
      if (row.closingCash === null) return { cash: null, month: null };
      if (low === null || row.closingCash < low.closingCash!) low = row;
    }
    return { cash: low?.closingCash ?? null, month: low?.month ?? null };
  };

  const years: ScenarioYear[] = [];
  for (let year = 1; year <= SCENARIO_YEARS; year++) {
    const rows = months.slice((year - 1) * 12, year * 12);
    const last = rows[rows.length - 1];
    const low = lowest(rows);
    years.push({
      year,
      from: rows[0].month,
      to: last.month,
      herd: last.herd,
      lambsBorn: total(rows, (row) => row.lambsBorn),
      lambsSold: total(rows, (row) => row.lambsSold),
      ewesCulled: total(rows, (row) => row.ewesCulled),
      kgSold: total(rows, (row) => row.kgSold),
      revenue: {
        lambs: total(rows, (row) => row.revenue.lambs),
        culls: total(rows, (row) => row.revenue.culls),
        total: total(rows, (row) => row.revenue.total),
      },
      costs: {
        feed: total(rows, (row) => row.costs.feed),
        other: total(rows, (row) => row.costs.other),
        fixed: total(rows, (row) => row.costs.fixed),
        oneOff: rows.reduce((all, row) => all + row.costs.oneOff, 0),
        total: total(rows, (row) => row.costs.total),
      },
      profit: total(rows, (row) => row.net),
      closingCash: last.closingCash,
      lowestCash: low.cash,
      lowestCashMonth: low.month,
    });
  }

  const costs = total(months, (row) => row.costs.total);
  const kgSold = total(months, (row) => row.kgSold);
  const profit = total(months, (row) => row.net);
  const ewesSum = total(months, (row) => row.herd.ewes);
  const averageEwes = ewesSum === null ? null : ewesSum / SCENARIO_MONTHS;
  const cashKnown = months.every((row) => row.closingCash !== null);
  const low = lowest(months);

  return {
    months,
    years,
    summary: {
      revenue: total(months, (row) => row.revenue.total),
      costs,
      profit,
      kgSold,
      lambsSold: total(months, (row) => row.lambsSold),
      breakEvenPricePerKg: costs === null || kgSold === null || kgSold <= 0 ? null : costs / kgSold,
      profitPerEwePerYear: profit === null || averageEwes === null || averageEwes <= 0 ? null : profit / SCENARIO_YEARS / averageEwes,
      cashKnown,
      firstNegativeCashMonth: cashKnown ? (months.find((row) => row.closingCash! < 0)?.month ?? null) : null,
      lowestCash: low.cash,
      lowestCashMonth: low.month,
      netKnown: profit !== null,
      paybackMonth: profit !== null ? paybackMonth : null,
    },
    missing: ([...SCENARIO_NUMBER_KEYS, 'stallMonths'] as ScenarioAssumptionKey[]).filter((key) => missing.has(key)),
  };
}
