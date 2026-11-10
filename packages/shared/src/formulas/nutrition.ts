/**
 * Ration balancing by nutrients: what a feed holds, what a sheep needs, how the two compare, and the
 * cheapest mix that meets the need.
 *
 * Units. Feed composition is per kg of dry matter: metabolisable energy (ME) in MJ, crude protein in
 * percent, calcium and phosphorus in grams. A requirement and a supply are per head per day: dry
 * matter in kg, ME in MJ, crude protein, calcium and phosphorus in grams.
 */
import { solveLinearProgram, type LpConstraint } from './linear-program';

// ─── Typical feed composition ────────────────────────────────────────────────────────────────────

export interface FeedComposition {
  /** Percent of the feed as fed. */
  dryMatterPct: number;
  meMjPerKgDm: number;
  crudeProteinPctDm: number;
  calciumGPerKgDm: number;
  phosphorusGPerKgDm: number;
  isRoughage: boolean;
}

export const TYPICAL_FEED_KEYS = [
  'lucerne_hay',
  'cereal_straw',
  'barley_grain',
  'wheat_grain',
  'wheat_bran',
  'cottonseed_cake',
  'maize_silage',
  'maize_grain',
] as const;
export type TypicalFeedKey = (typeof TYPICAL_FEED_KEYS)[number];

/**
 * Typical composition of common feeds: averages of many samples from many countries, not a measurement
 * of this farm's feed. They are a starting point to apply and then correct from a laboratory analysis.
 *
 * Source for every number: Feedipedia, Animal Feed Resources Information System (INRAE, CIRAD, AFZ and
 * FAO), feedipedia.org, "Tables of chemical composition and nutritional value", average values, read
 * on 2026-11-10. Dry matter is "Dry matter, % as fed"; protein is "Crude protein, % DM"; calcium and
 * phosphorus are "g/kg DM"; energy is "ME ruminants, MJ/kg DM". The datasheet used is named per line.
 * Roughage or not is the feed's class in Feedipedia (forage and crop residue against grain and
 * by-product).
 */
export const TYPICAL_FEEDS: Record<TypicalFeedKey, FeedComposition> = {
  // Feedipedia "Alfalfa (Medicago sativa)", datasheet "Alfalfa, hay" (node 275).
  lucerne_hay: { dryMatterPct: 89.4, meMjPerKgDm: 8.4, crudeProteinPctDm: 18.2, calciumGPerKgDm: 16.8, phosphorusGPerKgDm: 2.6, isRoughage: true },
  // Feedipedia "Straws", datasheet "Wheat straw" (node 60).
  cereal_straw: { dryMatterPct: 91.0, meMjPerKgDm: 6.8, crudeProteinPctDm: 4.2, calciumGPerKgDm: 4.8, phosphorusGPerKgDm: 0.7, isRoughage: true },
  // Feedipedia "Barley grain" (node 227).
  barley_grain: { dryMatterPct: 87.1, meMjPerKgDm: 12.4, crudeProteinPctDm: 11.8, calciumGPerKgDm: 0.8, phosphorusGPerKgDm: 3.9, isRoughage: false },
  // Feedipedia "Wheat grain" (node 223).
  wheat_grain: { dryMatterPct: 87.0, meMjPerKgDm: 13.1, crudeProteinPctDm: 12.6, calciumGPerKgDm: 0.7, phosphorusGPerKgDm: 3.6, isRoughage: false },
  // Feedipedia "Wheat bran" (node 726).
  wheat_bran: { dryMatterPct: 87.0, meMjPerKgDm: 11.0, crudeProteinPctDm: 17.3, calciumGPerKgDm: 1.4, phosphorusGPerKgDm: 11.1, isRoughage: false },
  // Feedipedia "Cottonseed meal", datasheet "Cottonseed meal, high fibre, high oil" (node 550): the
  // expeller cake of undecorticated seed, which is what a local oil mill sells.
  cottonseed_cake: { dryMatterPct: 92.9, meMjPerKgDm: 11.9, crudeProteinPctDm: 37.4, calciumGPerKgDm: 2.2, phosphorusGPerKgDm: 11.9, isRoughage: false },
  // Feedipedia "Maize silage", datasheet "Maize silage, dry matter 30-35%" (node 13883).
  maize_silage: { dryMatterPct: 32.5, meMjPerKgDm: 10.8, crudeProteinPctDm: 6.9, calciumGPerKgDm: 1.9, phosphorusGPerKgDm: 1.7, isRoughage: true },
  // Feedipedia "Maize grain", datasheet "Maize grain, Europe" (node 556).
  maize_grain: { dryMatterPct: 86.3, meMjPerKgDm: 13.6, crudeProteinPctDm: 9.4, calciumGPerKgDm: 0.5, phosphorusGPerKgDm: 3.0, isRoughage: false },
};

// ─── Requirements ────────────────────────────────────────────────────────────────────────────────

/** Megajoules in one megacalorie (the thermochemical calorie, as NRC uses it). */
export const MJ_PER_MCAL = 4.184;

/** weight kg, weight change g/day, dry matter kg, ME Mcal, crude protein g, calcium g, phosphorus g */
type RequirementRow = readonly [number, number, number, number, number, number, number];

/**
 * Daily nutrient requirements of sheep, per animal.
 *
 * Source: National Research Council, "Nutrient Requirements of Sheep", Sixth Revised Edition, National
 * Academy Press, Washington DC, 1985, Table 1 "Daily nutrient requirements of sheep". One system is
 * used throughout. The equations behind the table are not reproduced here: the printed rows are kept
 * and read by straight-line interpolation between the two nearest printed weights.
 *
 * The dry matter column is the amount the table expects the animal to eat, so it serves as the intake
 * limit. Energy is the table's ME in Mcal, converted with MJ_PER_MCAL.
 *
 * Checked against the reproduction by Oregon State University Extension, "Nutrient requirements of
 * sheep" (adapted from NRC 1985, in pounds): dry matter, protein, calcium and phosphorus agree row by
 * row. That page has no ME column, so the ME figures here were not checked against a printed page:
 * they agree with its TDN column at NRC 1985's own factor (1 kg TDN = 4.4 Mcal DE, ME = 0.82 DE) to
 * within 0.2 Mcal, TDN being printed there to 0.1 lb. One figure differs: the page prints 0.38 lb of
 * protein for a 10 kg early-weaned lamb of moderate growth, more than the 0.35 lb of the rapid-growth
 * lamb beside it and 35 % of the diet; 127 g (0.28 lb, 25 %) is kept.
 */
export const NRC_1985_SHEEP = {
  // "Ewes: Maintenance"
  maintenance: [
    [50, 10, 1.0, 2.0, 95, 2.0, 1.8],
    [60, 10, 1.1, 2.2, 104, 2.3, 2.1],
    [70, 10, 1.2, 2.4, 113, 2.5, 2.4],
    [80, 10, 1.3, 2.6, 122, 2.7, 2.8],
    [90, 10, 1.4, 2.8, 131, 2.9, 3.1],
  ],
  // "Ewes: Nonlactating, first 15 weeks gestation"
  early_pregnancy: [
    [50, 30, 1.2, 2.4, 112, 2.9, 2.1],
    [60, 30, 1.3, 2.6, 121, 3.2, 2.5],
    [70, 30, 1.4, 2.8, 130, 3.5, 2.9],
    [80, 30, 1.5, 3.0, 139, 3.8, 3.3],
    [90, 30, 1.6, 3.2, 148, 4.1, 3.6],
  ],
  // "Ewes: Last 4 weeks gestation (130-150% lambing rate expected)": read as one foetus.
  late_pregnancy_1: [
    [50, 180, 1.6, 3.4, 175, 5.9, 4.8],
    [60, 180, 1.7, 3.6, 184, 6.0, 5.2],
    [70, 180, 1.8, 3.8, 193, 6.2, 5.6],
    [80, 180, 1.9, 4.0, 202, 6.3, 6.1],
    [90, 180, 2.0, 4.2, 212, 6.4, 6.5],
  ],
  // "Ewes: Last 4 weeks gestation (180-225% lambing rate expected)": read as two foetuses.
  late_pregnancy_2: [
    [50, 225, 1.7, 4.0, 196, 6.2, 3.4],
    [60, 225, 1.8, 4.2, 205, 6.9, 4.0],
    [70, 225, 1.9, 4.4, 214, 7.6, 4.5],
    [80, 225, 2.0, 4.7, 223, 8.3, 5.1],
    [90, 225, 2.1, 5.0, 232, 8.9, 5.7],
  ],
  // "Ewes: First 6-8 weeks lactation suckling singles"
  lactation_1: [
    [50, -25, 2.1, 4.9, 304, 8.9, 6.1],
    [60, -25, 2.3, 5.4, 319, 9.1, 6.6],
    [70, -25, 2.5, 5.9, 334, 9.3, 7.0],
    [80, -25, 2.6, 6.1, 344, 9.5, 7.4],
    [90, -25, 2.7, 6.3, 353, 9.6, 7.8],
  ],
  // "Ewes: First 6-8 weeks lactation suckling twins"
  lactation_2: [
    [50, -60, 2.4, 5.6, 389, 10.5, 7.3],
    [60, -60, 2.6, 6.1, 405, 10.7, 7.7],
    [70, -60, 2.8, 6.6, 420, 11.0, 8.1],
    [80, -60, 3.0, 7.0, 435, 11.2, 8.6],
    [90, -60, 3.2, 7.5, 450, 11.4, 9.0],
  ],
  // "Replacement ewe lambs"
  replacement_ewe_lamb: [
    [30, 227, 1.2, 2.8, 185, 6.4, 2.6],
    [40, 182, 1.4, 3.3, 176, 5.9, 2.6],
    [50, 120, 1.5, 3.2, 136, 4.8, 2.4],
    [60, 100, 1.5, 3.2, 134, 4.5, 2.5],
    [70, 100, 1.5, 3.2, 132, 4.6, 2.8],
  ],
  // "Lambs finishing, 4 to 7 months old"
  finishing_lamb: [
    [30, 295, 1.3, 3.4, 191, 6.6, 3.2],
    [40, 275, 1.6, 4.4, 185, 6.6, 3.3],
    [50, 205, 1.6, 4.4, 160, 5.6, 3.0],
  ],
  // "Early weaned lambs, moderate growth potential"
  early_weaned_moderate: [
    [10, 200, 0.5, 1.4, 127, 4.0, 1.9],
    [20, 250, 1.0, 2.9, 167, 5.4, 2.5],
    [30, 300, 1.3, 3.6, 191, 6.7, 3.2],
    [40, 345, 1.5, 4.2, 202, 7.7, 3.9],
    [50, 300, 1.5, 4.2, 181, 7.0, 3.8],
  ],
  // "Early weaned lambs, rapid growth potential"
  early_weaned_rapid: [
    [10, 250, 0.6, 1.7, 157, 4.9, 2.2],
    [20, 300, 1.2, 3.3, 205, 6.5, 2.9],
    [30, 325, 1.4, 4.0, 216, 7.2, 3.4],
    [40, 400, 1.5, 4.1, 234, 8.6, 4.3],
    [50, 425, 1.7, 4.7, 240, 9.4, 4.8],
    [60, 350, 1.7, 4.7, 240, 8.2, 4.5],
  ],
} as const satisfies Record<string, readonly RequirementRow[]>;

export type RequirementRows = keyof typeof NRC_1985_SHEEP;

export const LAMB_ROWS = ['replacement_ewe_lamb', 'finishing_lamb', 'early_weaned_moderate', 'early_weaned_rapid'] as const;
export type LambRows = (typeof LAMB_ROWS)[number];

export const FEEDING_STATES = ['maintenance', 'early_pregnancy', 'late_pregnancy', 'lactation', 'growing'] as const;
export type FeedingState = (typeof FEEDING_STATES)[number];

/** Species the requirement table covers. NRC 1985 is a sheep table; goats are not in it. */
export const REQUIREMENT_SPECIES = ['sheep'] as const;

export interface RequirementInput {
  /** Species key, e.g. "sheep". Anything the table does not cover gives null. */
  species: string | null | undefined;
  weightKg: number | null | undefined;
  state: FeedingState;
  /** Foetuses carried, or lambs suckled. The table has rows for one and for two. */
  litter?: 1 | 2;
  /** Growing lamb: the daily gain aimed at, in grams. Without it, the gain printed in `lambRows`. */
  gainG?: number | null;
  /** Growing lamb without a target gain: which printed class to read. */
  lambRows?: LambRows;
}

export interface DailyRequirement {
  /** The dry matter the table expects the animal to eat: the intake limit. */
  dryMatterKg: number;
  meMj: number;
  crudeProteinG: number;
  calciumG: number;
  phosphorusG: number;
  /** The weight the table was read at. Differs from the animal's when that is outside the printed rows. */
  weightUsedKg: number;
  weightClamped: boolean;
  /** The daily weight change the figures assume, grams. */
  gainG: number;
  /** A target gain outside what the table prints for this weight was brought to the nearest printed gain. */
  gainClamped: boolean;
  /** Which printed rows were read. */
  rows: RequirementRows[];
}

type Point = { gainG: number; dryMatterKg: number; meMcal: number; crudeProteinG: number; calciumG: number; phosphorusG: number };

function pointOf(row: RequirementRow): Point {
  return { gainG: row[1], dryMatterKg: row[2], meMcal: row[3], crudeProteinG: row[4], calciumG: row[5], phosphorusG: row[6] };
}

function mix(a: Point, b: Point, share: number): Point {
  const at = (x: number, y: number) => x + (y - x) * share;
  return {
    gainG: at(a.gainG, b.gainG),
    dryMatterKg: at(a.dryMatterKg, b.dryMatterKg),
    meMcal: at(a.meMcal, b.meMcal),
    crudeProteinG: at(a.crudeProteinG, b.crudeProteinG),
    calciumG: at(a.calciumG, b.calciumG),
    phosphorusG: at(a.phosphorusG, b.phosphorusG),
  };
}

/** Straight-line reading of one printed class at a weight inside its range. */
function readRows(rows: readonly RequirementRow[], weightKg: number): Point {
  for (let i = 1; i < rows.length; i += 1) {
    if (weightKg <= rows[i][0]) {
      const [lo, hi] = [rows[i - 1], rows[i]];
      return mix(pointOf(lo), pointOf(hi), (weightKg - lo[0]) / (hi[0] - lo[0]));
    }
  }
  return pointOf(rows[rows.length - 1]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function weightRange(rows: readonly RequirementRow[]): [number, number] {
  return [rows[0][0], rows[rows.length - 1][0]];
}

function finish(point: Point, weightUsedKg: number, weightKg: number, gainClamped: boolean, rows: RequirementRows[]): DailyRequirement {
  return {
    dryMatterKg: point.dryMatterKg,
    meMj: point.meMcal * MJ_PER_MCAL,
    crudeProteinG: point.crudeProteinG,
    calciumG: point.calciumG,
    phosphorusG: point.phosphorusG,
    weightUsedKg,
    weightClamped: weightUsedKg !== weightKg,
    gainG: point.gainG,
    gainClamped,
    rows,
  };
}

function growingRequirement(weightKg: number, input: RequirementInput): DailyRequirement {
  if (input.gainG === null || input.gainG === undefined) {
    const key = input.lambRows ?? 'early_weaned_moderate';
    const rows = NRC_1985_SHEEP[key];
    const used = clamp(weightKg, ...weightRange(rows));
    return finish(readRows(rows, used), used, weightKg, false, [key]);
  }
  // With a target gain: read every lamb class that prints this weight, then go between the two classes
  // whose gains bracket the target. This is interpolation between printed rows, not an NRC equation.
  const all = LAMB_ROWS.map((key) => weightRange(NRC_1985_SHEEP[key]));
  const used = clamp(weightKg, Math.min(...all.map((r) => r[0])), Math.max(...all.map((r) => r[1])));
  const classes = LAMB_ROWS.filter((key) => {
    const [min, max] = weightRange(NRC_1985_SHEEP[key]);
    return used >= min && used <= max;
  })
    .map((key) => ({ key, point: readRows(NRC_1985_SHEEP[key], used) }))
    .sort((a, b) => a.point.gainG - b.point.gainG);

  const [lowest, highest] = [classes[0], classes[classes.length - 1]];
  if (input.gainG <= lowest.point.gainG) return finish(lowest.point, used, weightKg, input.gainG < lowest.point.gainG, [lowest.key]);
  if (input.gainG >= highest.point.gainG) return finish(highest.point, used, weightKg, input.gainG > highest.point.gainG, [highest.key]);
  const above = classes.findIndex((c) => c.point.gainG >= input.gainG!);
  const [lo, hi] = [classes[above - 1], classes[above]];
  const share = (input.gainG - lo.point.gainG) / (hi.point.gainG - lo.point.gainG);
  return finish(mix(lo.point, hi.point, share), used, weightKg, false, [lo.key, hi.key]);
}

/**
 * What one sheep needs in a day (NRC 1985, Table 1). Null for a species the table does not cover and
 * when the weight is not known: a requirement is never guessed.
 *
 * A weight outside the printed rows (ewes 50 to 90 kg, lambs 10 to 70 kg) is read at the nearest
 * printed weight, and `weightClamped` says so; nothing is extrapolated.
 */
export function dailyRequirement(input: RequirementInput): DailyRequirement | null {
  if (!input.species || !(REQUIREMENT_SPECIES as readonly string[]).includes(input.species)) return null;
  const weightKg = input.weightKg;
  if (weightKg === null || weightKg === undefined || !Number.isFinite(weightKg) || weightKg <= 0) return null;

  if (input.state === 'growing') return growingRequirement(weightKg, input);

  const twins = input.litter === 2;
  const key: RequirementRows =
    input.state === 'maintenance'
      ? 'maintenance'
      : input.state === 'early_pregnancy'
        ? 'early_pregnancy'
        : input.state === 'late_pregnancy'
          ? twins
            ? 'late_pregnancy_2'
            : 'late_pregnancy_1'
          : twins
            ? 'lactation_2'
            : 'lactation_1';
  const rows = NRC_1985_SHEEP[key];
  const used = clamp(weightKg, ...weightRange(rows));
  return finish(readRows(rows, used), used, weightKg, false, [key]);
}

export const PREGNANCY_STAGES = ['early', 'late'] as const;
export type PregnancyStage = (typeof PREGNANCY_STAGES)[number];

export interface RequirementChoice {
  /** For a "pregnant" ration: the first 15 weeks or the last 4. Late when not said, the heavier demand. */
  stage?: PregnancyStage | null;
  litter?: 1 | 2 | null;
  gainG?: number | null;
}

/**
 * Which rows of the table a ration's physiological state stands for. A ration says "pregnant" or
 * "lactating" and no more, so the stage and the number of lambs are a choice: without one, late
 * pregnancy and a single lamb. Lamb rations read "early weaned, moderate growth", fattening rations
 * "lambs finishing", unless a target gain is given. Null for a state the table has no rows for.
 */
export function requirementInputFor(
  physiologicalState: string,
  choice: RequirementChoice = {},
): Pick<RequirementInput, 'state' | 'litter' | 'gainG' | 'lambRows'> | null {
  const litter = choice.litter === 2 ? 2 : 1;
  switch (physiologicalState) {
    case 'maintenance':
      return { state: 'maintenance' };
    case 'pregnant':
      return choice.stage === 'early' ? { state: 'early_pregnancy' } : { state: 'late_pregnancy', litter };
    case 'lactating':
      return { state: 'lactation', litter };
    case 'lamb':
      return { state: 'growing', gainG: choice.gainG ?? null, lambRows: 'early_weaned_moderate' };
    case 'fattening':
      return { state: 'growing', gainG: choice.gainG ?? null, lambRows: 'finishing_lamb' };
    default:
      return null;
  }
}

// ─── Supply and balance ──────────────────────────────────────────────────────────────────────────

export const NUTRIENTS = ['dryMatter', 'energy', 'protein', 'calcium', 'phosphorus'] as const;
export type Nutrient = (typeof NUTRIENTS)[number];

/** Per head per day: dry matter kg, energy MJ ME, protein g, calcium g, phosphorus g. Null: not known. */
export type NutrientAmounts = Record<Nutrient, number | null>;

export const FEED_NUTRIENT_FIELDS = ['dryMatterPct', 'meMjPerKgDm', 'crudeProteinPctDm', 'calciumGPerKgDm', 'phosphorusGPerKgDm'] as const;
export type FeedNutrientField = (typeof FEED_NUTRIENT_FIELDS)[number];

export type FeedNutrients = { [K in FeedNutrientField]: number | null | undefined };

export interface RationNutrientLine extends FeedNutrients {
  kgPerHeadDay: number;
}

function known(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

/** The composition fields a feed still lacks. Dry matter must be above zero; a nutrient may be zero (salt). */
export function missingFeedNutrients(feed: FeedNutrients): FeedNutrientField[] {
  return FEED_NUTRIENT_FIELDS.filter((field) => {
    const value = feed[field];
    if (!known(value) || value < 0) return true;
    return field === 'dryMatterPct' && (value <= 0 || value > 100);
  });
}

/**
 * What a ration gives one head in a day. A nutrient is null as soon as one feed lacks its figure (or
 * its dry matter): a sum over the feeds that happen to be filled in would read as the whole ration.
 */
export function rationNutrientSupply(lines: readonly RationNutrientLine[]): NutrientAmounts {
  const supply: NutrientAmounts = { dryMatter: null, energy: null, protein: null, calcium: null, phosphorus: null };
  if (lines.length === 0) return supply;

  const dm = lines.map((line) =>
    known(line.dryMatterPct) && line.dryMatterPct > 0 && line.dryMatterPct <= 100 ? (line.kgPerHeadDay * line.dryMatterPct) / 100 : null,
  );
  if (dm.some((v) => v === null)) return supply;
  const total = (per: (line: RationNutrientLine) => number | null | undefined, factor = 1): number | null => {
    let sum = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const value = per(lines[i]);
      if (!known(value) || value < 0) return null;
      sum += dm[i]! * value * factor;
    }
    return sum;
  };
  supply.dryMatter = dm.reduce<number>((sum, v) => sum + v!, 0);
  supply.energy = total((l) => l.meMjPerKgDm);
  // Percent of dry matter to grams per kg of dry matter.
  supply.protein = total((l) => l.crudeProteinPctDm, 10);
  supply.calcium = total((l) => l.calciumGPerKgDm);
  supply.phosphorus = total((l) => l.phosphorusGPerKgDm);
  return supply;
}

export function requirementAmounts(requirement: DailyRequirement): Record<Nutrient, number> {
  return {
    dryMatter: requirement.dryMatterKg,
    energy: requirement.meMj,
    protein: requirement.crudeProteinG,
    calcium: requirement.calciumG,
    phosphorus: requirement.phosphorusG,
  };
}

/**
 * Where "short" and "over" begin, in percent of the requirement. These are starting values chosen for
 * this product, not figures from a feeding standard: the tables print rounded numbers and feed analyses
 * vary, so a few percent either way is not a finding. Dry matter is an intake limit rather than a need,
 * so its "over" starts sooner and its "short" later.
 */
export const RATION_BALANCE_THRESHOLDS = {
  shortBelowPct: 95,
  overAbovePct: 120,
  dryMatterShortBelowPct: 80,
  dryMatterOverAbovePct: 110,
} as const;

export type BalanceFlag = 'short' | 'enough' | 'over';

export interface BalanceLine {
  nutrient: Nutrient;
  supply: number | null;
  requirement: number | null;
  coveredPct: number | null;
  flag: BalanceFlag | null;
}

/** Supply against requirement, nutrient by nutrient. A line with either side unknown carries nulls. */
export function nutrientBalance(supply: NutrientAmounts, requirement: DailyRequirement | null): BalanceLine[] {
  const need = requirement ? requirementAmounts(requirement) : null;
  return NUTRIENTS.map((nutrient) => {
    const have = supply[nutrient];
    const want = need ? need[nutrient] : null;
    if (have === null || want === null || !(want > 0)) return { nutrient, supply: have, requirement: want, coveredPct: null, flag: null };
    const coveredPct = (have / want) * 100;
    const t = RATION_BALANCE_THRESHOLDS;
    const [shortBelow, overAbove] = nutrient === 'dryMatter' ? [t.dryMatterShortBelowPct, t.dryMatterOverAbovePct] : [t.shortBelowPct, t.overAbovePct];
    const flag: BalanceFlag = coveredPct < shortBelow ? 'short' : coveredPct > overAbove ? 'over' : 'enough';
    return { nutrient, supply: have, requirement: want, coveredPct, flag };
  });
}

/** Roughage as a percent of the ration's dry matter. Null when a feed's dry matter or class is unknown. */
export function roughageSharePct(lines: readonly { kgPerHeadDay: number; dryMatterPct: number | null | undefined; isRoughage: boolean | null | undefined }[]): number | null {
  let total = 0;
  let roughage = 0;
  for (const line of lines) {
    if (!known(line.dryMatterPct) || line.dryMatterPct <= 0 || line.isRoughage === null || line.isRoughage === undefined) return null;
    const dm = (line.kgPerHeadDay * line.dryMatterPct) / 100;
    total += dm;
    if (line.isRoughage) roughage += dm;
  }
  return total > 0 ? (roughage / total) * 100 : null;
}

// ─── Least-cost mix ──────────────────────────────────────────────────────────────────────────────

/**
 * Starting values for the mix, chosen for this product. A sheep is a ruminant and needs long fibre for
 * the rumen to work, so a ration is not allowed to be mostly grain; half the dry matter as roughage is
 * a cautious floor for breeding ewes that the zootechnician can change per calculation.
 */
export const LEAST_COST_DEFAULTS = {
  minRoughageSharePct: 50,
} as const;

export interface MixFeed extends FeedComposition {
  id: string;
  /** Money per kg as fed. */
  costPerKg: number;
  /** Most of this feed one head may get in a day, kg as fed. */
  maxKgPerHeadDay?: number | null;
}

export const MIX_NUTRIENTS = ['energy', 'protein', 'calcium', 'phosphorus'] as const;
export type MixNutrient = (typeof MIX_NUTRIENTS)[number];

export interface MixShortfall {
  nutrient: MixNutrient;
  required: number;
  /** The most the feeds can give within the limits. */
  best: number;
  /** True: out of reach on its own. False: reachable alone, but not together with the other requirements. */
  alone: boolean;
}

export interface MixResult {
  status: 'optimal' | 'infeasible';
  /** Kg as fed per head per day, one line per feed that is used. Empty when no mix exists. */
  lines: { id: string; kgPerHeadDay: number }[];
  costPerHeadDay: number | null;
  /** Why no mix exists: the requirements that cannot be met. Empty when one does. */
  shortfalls: MixShortfall[];
}

/** Per kg as fed: dry matter kg, then what MIX_NUTRIENTS lists. */
function perKgFed(feed: MixFeed): Record<'dryMatter' | MixNutrient, number> {
  const dm = feed.dryMatterPct / 100;
  return {
    dryMatter: dm,
    energy: dm * feed.meMjPerKgDm,
    protein: dm * feed.crudeProteinPctDm * 10,
    calcium: dm * feed.calciumGPerKgDm,
    phosphorus: dm * feed.phosphorusGPerKgDm,
  };
}

/**
 * The cheapest amounts of the given feeds, kg as fed per head per day, that meet the requirement for
 * energy, protein, calcium and phosphorus without going over the dry matter the animal can eat, with at
 * least `minRoughageSharePct` of the dry matter from roughage and no feed above its own maximum.
 *
 * When no such mix exists the answer names the requirement in the way: first any that the feeds cannot
 * reach even alone, otherwise each that cannot be reached while the others are met.
 * Null when there is nothing to choose from.
 */
export function leastCostRation(
  feeds: readonly MixFeed[],
  requirement: Pick<DailyRequirement, 'dryMatterKg' | 'meMj' | 'crudeProteinG' | 'calciumG' | 'phosphorusG'>,
  options: { minRoughageSharePct?: number } = {},
): MixResult | null {
  if (feeds.length === 0) return null;
  const share = (options.minRoughageSharePct ?? LEAST_COST_DEFAULTS.minRoughageSharePct) / 100;
  const per = feeds.map(perKgFed);
  const need: Record<MixNutrient, number> = {
    energy: requirement.meMj,
    protein: requirement.crudeProteinG,
    calcium: requirement.calciumG,
    phosphorus: requirement.phosphorusG,
  };

  const limits: LpConstraint[] = [
    { coefficients: per.map((p) => p.dryMatter), relation: '<=', rhs: requirement.dryMatterKg },
    // roughage DM ≥ share × all DM, written as Σ (roughage − share) × DM ≥ 0
    { coefficients: feeds.map((feed, i) => ((feed.isRoughage ? 1 : 0) - share) * per[i].dryMatter), relation: '>=', rhs: 0 },
  ];
  feeds.forEach((feed, i) => {
    if (feed.maxKgPerHeadDay === null || feed.maxKgPerHeadDay === undefined) return;
    limits.push({ coefficients: feeds.map((_, j) => (j === i ? 1 : 0)), relation: '<=', rhs: Math.max(0, feed.maxKgPerHeadDay) });
  });
  const atLeast = (nutrient: MixNutrient): LpConstraint => ({ coefficients: per.map((p) => p[nutrient]), relation: '>=', rhs: need[nutrient] });

  const solved = solveLinearProgram(feeds.map((feed) => feed.costPerKg), [...limits, ...MIX_NUTRIENTS.map(atLeast)]);
  if (solved.status === 'optimal' && solved.values) {
    const lines = feeds.map((feed, i) => ({ id: feed.id, kgPerHeadDay: solved.values![i] })).filter((line) => line.kgPerHeadDay > 1e-6);
    return { status: 'optimal', lines, costPerHeadDay: solved.objective, shortfalls: [] };
  }

  const most = (nutrient: MixNutrient, others: readonly MixNutrient[]): number | null => {
    const result = solveLinearProgram(per.map((p) => p[nutrient]), [...limits, ...others.map(atLeast)], 'max');
    return result.status === 'optimal' ? result.objective : null;
  };
  const falls = (best: number | null, nutrient: MixNutrient): best is number => best !== null && best < need[nutrient] * (1 - 1e-6);

  const alone = MIX_NUTRIENTS.map((nutrient) => ({ nutrient, best: most(nutrient, []) }));
  let shortfalls: MixShortfall[] = alone
    .filter((a) => falls(a.best, a.nutrient))
    .map((a) => ({ nutrient: a.nutrient, required: need[a.nutrient], best: a.best!, alone: true }));
  if (shortfalls.length === 0) {
    shortfalls = MIX_NUTRIENTS.flatMap((nutrient) => {
      const best = most(nutrient, MIX_NUTRIENTS.filter((other) => other !== nutrient));
      return falls(best, nutrient) ? [{ nutrient, required: need[nutrient], best, alone: false }] : [];
    });
  }
  if (shortfalls.length === 0) {
    // Three of the four already clash with each other, whichever one is left out: name them all.
    shortfalls = alone.map((a) => ({ nutrient: a.nutrient, required: need[a.nutrient], best: a.best ?? 0, alone: false }));
  }
  return { status: 'infeasible', lines: [], costPerHeadDay: null, shortfalls };
}
