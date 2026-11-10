/**
 * Ewe score and culling reasons: one number that ranks the ewes of a flock by what their own
 * records show, and the reasons a ewe may be put on the culling list. Pure functions; the service
 * gathers the facts (modules/livestock/ewe-score.service.ts) and nothing here reads a database.
 *
 * The score is a working tool of this product, not a breeding value and not a standard. It ranks
 * ewes inside one farm; it does not compare farms.
 */
import { CULL_REASONS, EWE_SCORE_COMPONENTS } from '../enums';
import { BODY_CONDITION_RULES } from './body-condition';
import { progenyIndex } from './reproduction';

export type EweScoreComponent = (typeof EWE_SCORE_COMPONENTS)[number];

/** A straight line between two values: `zeroAt` gives 0 points, `fullAt` gives 100, beyond either end it stays flat. */
export interface Scale {
  zeroAt: number;
  fullAt: number;
}

/**
 * Starting values chosen for this product, not figures from a book. The weights say how much each
 * part counts, the scales say what earns 0 and what earns 100. A farm should change them once its
 * own flock has shown what separates a good ewe from a poor one.
 */
export const EWE_SCORE = {
  /** How much each part counts. They need not add up to 100: the parts with data share the total. */
  weights: {
    prolificacy: 25,
    rearing: 25,
    lamb_growth: 20,
    lambing_interval: 10,
    age: 10,
    condition: 10,
  } satisfies Record<EweScoreComponent, number>,
  scales: {
    /** Lambs born per lambing: a single every time earns 50, twins every time 100. */
    prolificacy: { zeroAt: 0, fullAt: 2 },
    /** Share of her lambs that she herself reared to weaning, 0 to 1. */
    rearing: { zeroAt: 0, fullAt: 1 },
    /** Her lambs' 100-day weight as an index of the farm average (100 = average, which earns 50). */
    lamb_growth: { zeroAt: 80, fullAt: 120 },
    /** Average days between her lambings: yearly earns 100, every second year 0. */
    lambing_interval: { zeroAt: 730, fullAt: 365 },
    /** Age in years: full points up to six, none from ten. */
    age: { zeroAt: 10, fullAt: 6 },
    /** Latest body condition score: thin loses points, fat gains none over a middle score. */
    condition: { zeroAt: 1, fullAt: 3 },
  } satisfies Record<EweScoreComponent, Scale>,
  /** A body condition score older than this many days says little about her today: the part is left out. */
  conditionMaxAgeDays: 180,
} as const;

/** Points from 0 to 100 on a scale. The line may run downwards (a shorter interval is better). */
export function scalePoints(value: number, scale: Scale): number {
  const share = (value - scale.zeroAt) / (scale.fullAt - scale.zeroAt);
  return Math.min(1, Math.max(0, share)) * 100;
}

export interface EweScoreInput {
  /** Lambings on record. With none there is nothing to score. */
  lambings: number;
  /** Lambs born over those lambings, dead or alive. */
  lambsBorn: number;
  /** Lambs born in lambings old enough for their lambs to have reached weaning. */
  lambsDueAtWeaning: number;
  /**
   * Of those, the lambs alive at weaning that she reared herself. A lamb fostered to another ewe or
   * raised on the bottle was born to her and counts in `lambsBorn`, but she did not rear it.
   */
  lambsReared: number;
  /** Average 100-day weight of her lambs, and of all the farm's lambs. */
  lambWeight100Kg: number | null;
  farmWeight100Kg: number | null;
  /** Average days between her lambings; null with fewer than two. */
  lambingIntervalDays: number | null;
  ageYears: number | null;
  /** Her latest body condition score and how many days old it is. */
  bodyCondition: number | null;
  bodyConditionAgeDays: number | null;
}

export interface EweScorePart {
  key: EweScoreComponent;
  /** The fact behind the part, in its own unit: lambs per lambing, share, index, days, years, score. */
  value: number;
  /** 0 to 100 on the part's scale. */
  points: number;
  /** This part's share of the score, 0 to 1, after the missing parts gave up theirs. */
  weight: number;
}

export interface EweScoreResult {
  /** 0 to 100, not rounded. Null when she has no lambing on record. */
  score: number | null;
  parts: EweScorePart[];
  /** Parts left out for want of data. Their weight went to the others. */
  missing: EweScoreComponent[];
}

/** The fact behind each part, or null where the records cannot give one. */
function componentValues(i: EweScoreInput): Record<EweScoreComponent, number | null> {
  const conditionKnown =
    i.bodyCondition !== null && i.bodyConditionAgeDays !== null && i.bodyConditionAgeDays <= EWE_SCORE.conditionMaxAgeDays;
  return {
    prolificacy: i.lambings > 0 ? i.lambsBorn / i.lambings : null,
    rearing: i.lambsDueAtWeaning > 0 ? i.lambsReared / i.lambsDueAtWeaning : null,
    lamb_growth: progenyIndex(i.lambWeight100Kg, i.farmWeight100Kg),
    lambing_interval: i.lambingIntervalDays !== null && i.lambingIntervalDays > 0 ? i.lambingIntervalDays : null,
    age: i.ageYears !== null && i.ageYears >= 0 ? i.ageYears : null,
    condition: conditionKnown ? i.bodyCondition : null,
  };
}

/**
 * Score one ewe. A part with no data is left out and the rest share its weight, so a young ewe is
 * not marked down for what she has not had time to show. `missing` says which parts those were.
 */
export function eweScore(i: EweScoreInput): EweScoreResult {
  if (i.lambings <= 0) return { score: null, parts: [], missing: [...EWE_SCORE_COMPONENTS] };

  const values = componentValues(i);
  const present = EWE_SCORE_COMPONENTS.filter((key) => values[key] !== null && EWE_SCORE.weights[key] > 0);
  const missing = EWE_SCORE_COMPONENTS.filter((key) => !present.includes(key));
  const totalWeight = present.reduce((sum, key) => sum + EWE_SCORE.weights[key], 0);
  if (totalWeight <= 0) return { score: null, parts: [], missing };

  const parts = present.map((key) => {
    const value = values[key] as number;
    return { key, value, points: scalePoints(value, EWE_SCORE.scales[key]), weight: EWE_SCORE.weights[key] / totalWeight };
  });
  return { score: parts.reduce((sum, part) => sum + part.points * part.weight, 0), parts, missing };
}

/** Average days between consecutive lambings; null with fewer than two dates. */
export function lambingIntervalDays(dates: string[]): number | null {
  if (dates.length < 2) return null;
  const sorted = [...dates].sort();
  const first = Date.parse(`${sorted[0]}T00:00:00Z`);
  const last = Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`);
  return (last - first) / 86_400_000 / (sorted.length - 1);
}

// ─── Culling ────────────────────────────────────────────────────────────────

/** The reasons worked out from records. The other values of CULL_REASONS only a person can give. */
export const COMPUTED_CULL_REASONS = ['old_age', 'empty_twice', 'no_lamb_reared', 'low_score', 'thin_twice', 'lambing_complications'] as const satisfies readonly (typeof CULL_REASONS)[number][];
export type ComputedCullReason = (typeof COMPUTED_CULL_REASONS)[number];

/**
 * Starting values chosen for this product, not figures from a book. They only put a ewe on the list
 * of suggestions; a person decides, and a farm should set its own once it has culled by this list.
 */
export const CULLING = {
  /** `old_age`: at or above this many years. */
  oldAgeYears: 7,
  /** `empty_twice`: this many seasons running in which she was mated and found empty. */
  emptySeasons: 2,
  /** Two empty matings closer together than this many days are the same season, not two. */
  seasonGapDays: 200,
  /** `no_lamb_reared`: this many of her latest lambings, each ending with no lamb reared by her. */
  lambingsWithoutRearing: 2,
  /** `low_score`: her score is among this share of the flock's lowest. */
  lowScoreShare: 0.1,
  /** Below this many scored ewes a "lowest share" means nothing, and nobody is flagged for it. */
  lowScoreMinFlock: 20,
  /** `thin_twice`: this many of her latest scorings, each at or below BODY_CONDITION_RULES.thinAtOrBelow. */
  thinScorings: 2,
  /** `lambing_complications`: at least this many lambings with a complication on record. */
  complicatedLambings: 2,
} as const;

export interface BreedingOutcome {
  /** Mating date of a pregnancy record, or the date of a lambing entered without one. */
  date: string;
  /** `empty`: mated and found not pregnant. Anything else shows she conceived, or is carrying now. */
  outcome: 'empty' | 'pregnant' | 'lambed' | 'aborted';
}

/**
 * Seasons running, up to today, in which she was mated and found empty. An open pregnancy, a
 * lambing or an abortion ends the run: she conceived. Two empty matings in one season count once.
 */
export function emptySeasonsRunning(outcomes: BreedingOutcome[], seasonGapDays: number = CULLING.seasonGapDays): number {
  const newestFirst = [...outcomes].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  let seasons = 0;
  let lastCounted: string | null = null;
  for (const o of newestFirst) {
    if (o.outcome !== 'empty') break;
    const gap = lastCounted === null ? Infinity : (Date.parse(`${lastCounted}T00:00:00Z`) - Date.parse(`${o.date}T00:00:00Z`)) / 86_400_000;
    if (gap >= seasonGapDays) {
      seasons += 1;
      lastCounted = o.date;
    }
  }
  return seasons;
}

/**
 * The score at or below which a ewe is among the flock's lowest `lowScoreShare`. Null when the flock
 * is too small for a share to mean anything, or when every ewe scores the same.
 */
export function lowScoreCutoff(scores: (number | null)[]): number | null {
  const known = scores.filter((s): s is number => typeof s === 'number' && Number.isFinite(s)).sort((a, b) => a - b);
  if (known.length < CULLING.lowScoreMinFlock) return null;
  const count = Math.floor(known.length * CULLING.lowScoreShare);
  if (count < 1) return null;
  const cutoff = known[count - 1];
  return cutoff === known[known.length - 1] ? null : cutoff;
}

export interface CullInput {
  ageYears: number | null;
  /** From emptySeasonsRunning(). */
  emptySeasons: number;
  /**
   * Lambs she herself reared to weaning from each lambing, newest first. Null for a lambing whose
   * lambs are still with her and not yet weaned: the outcome is not known.
   */
  rearedByLambing: (number | null)[];
  score: number | null;
  /** From lowScoreCutoff(); null when no cutoff applies. */
  lowScoreCutoff: number | null;
  /** Her body condition scores, newest first. */
  conditionScores: number[];
  /** Lambings with a complication on record. */
  complicatedLambings: number;
}

/** Why the records suggest culling this ewe, in the order of COMPUTED_CULL_REASONS. Empty when nothing does. */
export function cullReasons(i: CullInput): ComputedCullReason[] {
  const lastLambings = i.rearedByLambing.slice(0, CULLING.lambingsWithoutRearing);
  const lastScorings = i.conditionScores.slice(0, CULLING.thinScorings);
  const found: Record<ComputedCullReason, boolean> = {
    old_age: i.ageYears !== null && i.ageYears >= CULLING.oldAgeYears,
    empty_twice: i.emptySeasons >= CULLING.emptySeasons,
    no_lamb_reared: lastLambings.length === CULLING.lambingsWithoutRearing && lastLambings.every((reared) => reared === 0),
    low_score: i.score !== null && i.lowScoreCutoff !== null && i.score <= i.lowScoreCutoff,
    thin_twice: lastScorings.length === CULLING.thinScorings && lastScorings.every((s) => s <= BODY_CONDITION_RULES.thinAtOrBelow),
    lambing_complications: i.complicatedLambings >= CULLING.complicatedLambings,
  };
  return COMPUTED_CULL_REASONS.filter((reason) => found[reason]);
}
